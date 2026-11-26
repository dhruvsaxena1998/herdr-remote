// Tailcat bridge: reach another machine's herdr-core over Tailcat instead
// of SSH (github.com/dhruvsaxena1998/herdr-tsbridge). One dialog for both
// sides: "Connect to a machine" adds it with `hc machine add --via`, and
// "Let machines connect here" runs `herdr-tsbridge serve` as a herdr-core
// terminal, so it outlives this window. Opened with `mod.open tsbridge`.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, theme, checking } from "herdr";

// Pinned release. A binary runs only after its SHA-256 matches this table.
const VERSION = "v0.1.0";
const SHA256 = {
  "darwin-amd64": "91ef1255ff0f5acd222caa9ea8ad6e557a7485f4b311ef52bc17180453b18871",
  "darwin-arm64": "e2f23f7cd143ae3d2f25fcc58dc041f82f1ecdcdd329a874127d66dc7e049a57",
  "linux-amd64": "ef66bf6af11aa3bb0732c11d627d299b94078c7d4dbc9871d52af2a441adbfd1",
  "linux-arm64": "61c1fef3e918d4b3046cec78a92e5c968b3d3981b875360fe650ec73dc08d146",
  "windows-amd64": "a5739726a4f92ec9c7fcad9ba1a54c517a437d3c80f669dc26058cd405f73669",
  "windows-arm64": "927f7bee5b157196f89cf16a828064e72eefe90873e43a12314626c18478164c",
};
const URL = `https://github.com/dhruvsaxena1998/herdr-tsbridge/releases/download/${VERSION}/herdr-tsbridge-`;
const SERVE = "tsbridge-serve"; // the herdr-core terminal running serve

const KEY_RE = /^nodekey:[0-9a-f]{64}$/;
const ADDR_RE = /^tc[A-Za-z0-9_-]+$/; // base64url: safe inside the --via line unquoted
const NAME_RE = /^[a-z0-9-]{1,32}$/;

const win = () => /^[a-z]:[\\/]/i.test(home()); // window() is null during checks
const out = (r) => (r.code === 0 ? r.stdout.trim() : Promise.reject(new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`)));

async function target() {
  if (win()) {
    const a = await exec("cmd", ["/c", "echo %PROCESSOR_ARCHITECTURE%"]).then(out);
    return `windows-${a.toUpperCase() === "ARM64" ? "arm64" : "amd64"}`;
  }
  const [os, m] = (await exec("uname", ["-sm"]).then(out)).split(/\s+/);
  return `${os.toLowerCase()}-${/^(arm64|aarch64)$/.test(m) ? "arm64" : "amd64"}`;
}

async function sha256(path) {
  if (win()) {
    // certutil: a header line, then the hex (spaced on old Windows).
    const lines = (await exec("certutil", ["-hashfile", path, "SHA256"]).then(out)).split(/\r?\n/);
    return (lines[1] ?? "").replace(/\s/g, "").toLowerCase();
  }
  const s = await exec("sh", ["-c", 'sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"', "sh", path]).then(out);
  return s.split(/\s/)[0];
}

export default class Tsbridge extends View {
  init(_props, cx) {
    this.bin = win() ? `${home()}\\AppData\\Local\\herdr-tsbridge\\herdr-tsbridge.exe` : `${home()}/.local/bin/herdr-tsbridge`;
    this.ready = false; // binary present and verified
    this.busy = null; // what's running now, shown on the buttons
    this.msg = {}; // section -> { text, error }
    this.key = null;
    this.serve = null; // { live, tail } of the serve terminal
    this.addr = null;
    this.addrInput = InputState.new({ placeholder: "tc… address from the other machine" });
    this.nameInput = InputState.new({ placeholder: "name, e.g. winvm" });
    this.allowInput = InputState.new({ placeholder: "nodekey:… (comma-separated)", value: localStorage.getItem("allow") ?? "" });
    this.allowInput.on("change", () => localStorage.setItem("allow", this.allowInput.value()));
    if (checking()) return;
    cx.spawn(async (cx) => {
      await this.check().catch((e) => this.say("bin", e));
      cx.notify();
    });
    cx.timer.every(3000, (cx) => {
      if (!this.ready) return;
      cx.spawn(async (cx) => {
        await this.refreshServe();
        cx.notify();
      });
    });
  }

  say(section, e, ok) {
    this.msg[section] = e == null ? null : { text: e instanceof Error ? e.message : String(e), error: !ok };
  }

  async check() {
    this.target = await target();
    if (!SHA256[this.target]) throw new Error(`No ${VERSION} build for ${this.target}.`);
    const sum = await sha256(this.bin).catch(() => null);
    this.ready = sum === SHA256[this.target];
    if (!this.ready) return;
    this.key = await exec(this.bin, ["key"]).then(out);
    await this.refreshServe();
  }

  async download() {
    const name = `herdr-tsbridge-${this.target}${win() ? ".exe" : ""}`;
    await exec("curl", ["-fsSL", "--create-dirs", "-o", this.bin, URL + name], { timeout: 180000 }).then(out)
      .catch((e) => Promise.reject(new Error(`${e.message} (${URL + name})`)));
    if (!win()) await exec("chmod", ["755", this.bin]).then(out);
    if ((await sha256(this.bin)) !== SHA256[this.target]) throw new Error("The download's SHA-256 doesn't match; not using it.");
    await this.check();
  }

  async refreshServe() {
    const r = await hc(["get", SERVE, "--json"]).catch(() => null);
    let t = null;
    try {
      t = r?.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {}
    const live = t?.state === "live";
    let tail = "";
    if (t && !live && !this.stopped) tail = (await hc(["read", SERVE, "--lines", "6"]).then(out).catch(() => "")).split("\n").filter(Boolean).slice(-3).join("\n");
    this.serve = t ? { live, tail } : null;
    // The identity is saved a moment after serve starts; ask until it is.
    if (live && !this.addr) this.addr = await exec(this.bin, ["addr"]).then(out).catch(() => null);
  }

  // Runs one action, reporting into its section.
  act(section, label, fn, cx) {
    if (this.busy) return;
    this.busy = label;
    this.say(section, null);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const done = await fn();
        if (done) this.say(section, done, true);
      } catch (e) {
        this.say(section, e);
      }
      this.busy = null;
      cx.notify();
    });
  }

  addMachine(cx) {
    const addr = this.addrInput.value().trim();
    const name = this.nameInput.value().trim();
    if (!ADDR_RE.test(addr)) return this.say("connect", "Paste the tc… address that serve printed on the other machine."), cx.notify();
    if (!NAME_RE.test(name)) return this.say("connect", "Name: 1-32 of a-z, 0-9, -."), cx.notify();
    // Windows: a program and its arguments (CommandLineToArgvW); elsewhere an sh line.
    const prog = win() ? `"${this.bin}"` : `'${this.bin.replace(/'/g, "'\\''")}'`;
    this.act("connect", "add", async () => {
      const r = await hc(["machine", "add", "--via", `${prog} pipe ${addr}`, "--name", name, "--json"]);
      if (r.code !== 0) {
        let m = (r.stderr || r.stdout).trim();
        try {
          m = JSON.parse(r.stdout || r.stderr).error?.message ?? m;
        } catch {}
        throw new Error(m || "hc machine add failed");
      }
      this.addrInput.set_value("");
      return `Added ${name}. Its spaces and terminals are in Herdr now.`;
    }, cx);
  }

  startServe(cx) {
    const keys = this.allowInput.value().split(",").map((s) => s.trim()).filter(Boolean);
    const bad = keys.find((k) => !KEY_RE.test(k));
    if (!keys.length || bad) return this.say("serve", bad ? `Not a key: ${bad}` : "Add at least one client key."), cx.notify();
    const log = win() ? `${home()}\\AppData\\Local\\herdr-tsbridge\\audit.log` : `${home()}/.local/state/herdr-tsbridge-audit.log`;
    this.act("serve", "start", async () => {
      await hc(["rm", SERVE]).catch(() => null); // a finished one keeps the name
      if (!win()) await exec("mkdir", ["-p", `${home()}/.local/state`]).then(out);
      await hc(["run", "--bg", "--no-parent", "--name", SERVE, "--", this.bin, "serve", "-allow", keys.join(","), "-log", log]).then(out);
      this.addr = null;
      this.stopped = false;
      await this.refreshServe();
    }, cx);
  }

  stopServe(cx) {
    this.act("serve", "stop", async () => {
      await hc(["kill", SERVE]).then(out);
      this.stopped = true; // its exit isn't an error to show
      this.addr = null;
      await this.refreshServe();
    }, cx);
  }

  render(cx) {
    const t = theme();
    const button = (id, label, primary, onClick) =>
      h_flex().id(id).h(30).px(12).items_center().rounded(7).text_size(12).cursor_pointer()
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
        .border_1().border_color(primary ? t.solid : t.input)
        .when(this.busy === id, (el) => el.opacity(0.6))
        .hover((s) => s.opacity(0.88))
        .on_click((_e, cx) => onClick(cx))
        .child(this.busy === id ? "Working…" : label);
    const copy = (id, text) =>
      button(id, this.copied === id ? "Copied" : "Copy", false, (cx) => { cx.write_to_clipboard(text); this.copied = id; cx.notify(); });
    const field = (state) => h_flex().items_center().flex_1().min_w(0).h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).child(Input.new(state));
    const mono = (text) => div().flex_1().min_w(0).truncate().px(8).py(6).rounded(7).bg(t.background).border_1().border_color(t.border).text_size(12).text_color(t.foreground).child(text);
    const note = (s) => (this.msg[s] ? div().text_size(12).text_color(this.msg[s].error ? t.blocked : t.done).child(this.msg[s].text) : div());
    const heading = (text, detail) => v_flex().gap(2).child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(text)).child(div().text_size(12).text_color(t.muted).child(detail));
    const section = (id) => v_flex().id(id).gap(8).pt(12).border_t_1().border_color(t.border);

    const root = v_flex().id("tsbridge").size_full().min_h(0).p(18).gap(12).bg(t.popover).text_size(13).overflow_y_scrollbar()
      .child(heading("Tailcat bridge", "Reach herdr-core on another machine over Tailcat, without SSH or a Tailscale account."));

    if (!this.ready) {
      return root.child(
        section("bin")
          .child(div().text_color(t.muted).child(`Needs herdr-tsbridge ${VERSION} from GitHub, checked against a pinned SHA-256, saved to ${this.bin}.`))
          .child(h_flex().child(this.target ? button("download", "Download", true, (cx) => this.act("bin", "download", () => this.download(), cx)) : div().text_color(t.dim).child("Checking…")))
          .child(note("bin")),
      );
    }

    const s = this.serve;
    return root
      .child(
        section("connect")
          .child(heading("Connect to a machine", "Give the other machine this key, then paste the address it prints."))
          .child(h_flex().gap(8).child(mono(this.key ?? "…")).child(copy("copy-key", this.key ?? "")))
          .child(h_flex().gap(8).child(field(this.addrInput)))
          .child(h_flex().gap(8).child(field(this.nameInput)).child(button("add", "Add machine", true, (cx) => this.addMachine(cx))))
          .child(note("connect")),
      )
      .child(
        section("serve")
          .child(heading("Let machines connect here", "Every allowed key gets full control of this machine as you. Read SECURITY.md first; prefer a non-admin account."))
          .child(h_flex().gap(8).child(field(this.allowInput)).child(
            s?.live ? button("stop", "Stop", false, (cx) => this.stopServe(cx)) : button("start", "Start", true, (cx) => this.startServe(cx))))
          .child(div().text_size(12).text_color(s?.live ? t.working : t.dim).child(s?.live ? `Serving (herdr-core terminal ${SERVE}). Changing keys needs Stop, then Start.` : "Not serving."))
          .when(!!(s?.live && this.addr), (el) => el.child(h_flex().gap(8).child(mono(this.addr ?? "")).child(copy("copy-addr", this.addr ?? ""))).child(div().text_size(12).text_color(t.dim).child("The address is secret: share it only with the connecting machine.")))
          .when(!!s?.tail, (el) => el.child(div().text_size(12).text_color(t.blocked).child(`Serve stopped: ${s.tail}`)))
          .child(note("serve")),
      );
  }
}
