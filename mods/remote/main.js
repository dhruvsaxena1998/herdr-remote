// Herdr Remote: use another computer's herdr-core over Tailcat instead of
// SSH (github.com/dhruvsaxena1998/herdr-remote). One page, both sides:
// "Your computers" lists and adds machines (`hc machine add --via`), and
// "Share this computer" runs `herdr-remote serve` as a herdr-core terminal,
// so it outlives this window. Pairing takes one string: the sharing side's
// invite code goes to the other computer, which asks to connect; the sharing
// side approves it by its short pairing code. Without a shared clipboard, a
// one-time code (`offer`/`redeem`) carries the invite instead. Opened with
// `mod.open {name: "remote"}`, the command palette, or the key in keys.json.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, theme, checking, keys, props, closeOverlay } from "herdr";

// Pinned release. A binary runs only after its SHA-256 matches this table.
const VERSION = "v0.4.0";
const SHA256 = {
  "darwin-amd64": "4c9b73d537c20027f2e6de00b3bd80b3b73d54d2a78396a024fd2eb77a0133b0",
  "darwin-arm64": "99b3640e1a6361c174e29acad591c19175168ff6b8c09e69356ef58b0ed45cdb",
  "linux-amd64": "70b5aadbdf9841fcf03519cb8b07fdde7224ebb21ee1447e0ad90feabbeb2b47",
  "linux-arm64": "28cfd79e34d141bceb7c544ed7797bfd3fa0dec13e9828c5d6e20c3272df0f43",
  "windows-amd64": "12ac584c0071a5329069b003fc499f208c4362ac1a92a8dccb8da8f8ff2a4a5e",
  "windows-arm64": "d1d2305191408818b973253eea84c1dea01ae4d65ce0c3afc176ff13a5bfc3be",
};
const REPO = "https://github.com/dhruvsaxena1998/herdr-remote";
const URL = `${REPO}/releases/download/${VERSION}/`;
const SERVE = "remote-serve"; // the herdr-core terminal running serve
const OFFER = "remote-offer"; // the one running offer, while a one-time code is out
const I = (name) => `mods/workspace-chrome/${name}.svg`; // Herdr's shipped icons

const ADDR_RE = /^tc[A-Za-z0-9_-]+$/; // base64url: safe inside the --via line unquoted
const NAME_RE = /^[a-z0-9-]{1,32}$/;
const KEY_RE = /^nodekey:[0-9a-f]{64}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}[- ]?[A-HJ-NP-Z2-9]{4}$/i; // a one-time code, like WDJB-MJHT

const win = () => /^[a-z]:[\\/]/i.test(home()); // window() is null during checks
const unstamp = (s) => s.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, ""); // log.Fatal's timestamp
const out = (r) => (r.code === 0 ? r.stdout.trim() : Promise.reject(new Error(unstamp((r.stderr || r.stdout).trim()) || `exit ${r.code}`)));
const isOurs = (m) => typeof m.target === "string" && m.target.includes("herdr-remote") && m.target.includes(" pipe ");
const day = (iso) => { const d = new Date(iso); return `${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getMonth()]} ${d.getDate()}`; }; // toLocaleDateString ignores options here

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

export default class Remote extends View {
  init(_props, cx) {
    this.bin = win() ? `${home()}\\AppData\\Local\\herdr-remote\\herdr-remote.exe` : `${home()}/.local/bin/herdr-remote`;
    this.ready = false; // binary present and verified
    this.stale = false; // a binary is there but isn't the pinned one
    this.busy = null; // the action running now; every button waits for it
    this.msg = {}; // section -> { text, error }
    this.code = null; // this computer's pairing code
    this.machines = []; // computers added through this bridge
    this.adding = null; // null | "form" | { name, token, fetching } while redeeming a code, then waiting for approval
    this.serve = null; // { live, tail } of the serve terminal
    this.addr = null; // the invite code while sharing
    this.offer = null; // { code } while a one-time code is out (code is null until it's printed)
    this.offering = false; // this window started the offer, so it reports how it ended
    this.offerGen = 0; // bumped on start/cancel, so a refresh begun before then ignores what it read
    this.redeemed = {}; // one-time code -> its redeem promise: a code works once, so a retry after Cancel reuses it
    this.clients = { pending: [], allow: [] };
    this.confirm = null; // id of a Remove button waiting for its second click
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.addrInput = InputState.new({ placeholder: "Paste the invite code, or type the one-time code" });
    this.nameInput = InputState.new({ placeholder: "e.g. work-pc" });
    this.nameInput.on("submit", (_e, cx) => this.connect(cx));
    if (checking()) return;
    cx.spawn(async (cx) => {
      // Sharing started before the rename runs as tsbridge-serve, which this page can't see or turn off.
      await hc(["kill", "tsbridge-serve"]).catch(() => null);
      await hc(["rm", "tsbridge-serve"]).catch(() => null);
      await this.check().catch((e) => this.say("setup", e));
      cx.notify();
    });
    cx.timer.every(2000, (cx) => {
      if (!this.ready || this.refreshing) return; // a slow hc call must not stack refreshes
      this.refreshing = true;
      cx.spawn(async (cx) => {
        try {
          await this.refresh();
        } finally {
          this.refreshing = false;
        }
        cx.notify();
      });
    });
  }

  say(section, e, ok) {
    this.msg[section] = e == null ? null : { text: e instanceof Error ? e.message : String(e), error: !ok };
  }

  async check() {
    this.target = await target();
    if (!SHA256[this.target]) throw new Error(`There's no ${VERSION} build for ${this.target}. You can build it from source: ${REPO}`);
    const sum = await sha256(this.bin).catch(() => null);
    this.ready = sum === SHA256[this.target];
    this.stale = !!sum && !this.ready;
    if (!this.ready) return;
    this.code = await exec(this.bin, ["code"]).then(out).catch((e) => (this.say("mine", new Error(`Couldn't read this computer's identity: ${e.message}`)), null));
    await this.refresh();
  }

  async download() {
    const name = `herdr-remote-${this.target}${win() ? ".exe" : ""}`;
    const tmp = `${this.bin}.download`;
    const rm = () => (win() ? exec("cmd", ["/c", "del", "/f", "/q", tmp]) : exec("rm", ["-f", tmp])).catch(() => null);
    // Into a temp file first: only a verified binary ever takes this.bin's place.
    await exec("curl", ["-fsSL", "--create-dirs", "-o", tmp, URL + name], { timeout: 180000 }).then(out)
      .catch((e) => (rm(), Promise.reject(new Error(`Download failed: ${e.message} (${URL + name})`))));
    if ((await sha256(tmp).catch(() => null)) !== SHA256[this.target]) {
      await rm();
      throw new Error("The download didn't match the expected checksum, so it was deleted.");
    }
    if (win()) {
      // Windows can't replace an .exe that's running (sharing, or a connection to an added computer).
      await exec("cmd", ["/c", "move", "/y", tmp, this.bin]).then(out)
        .catch(async () => (await rm(), Promise.reject(new Error(`It's in use, so it couldn't be replaced. Turn off sharing (hc kill ${SERVE}) and close connections to your computers, then try again.`))));
    } else {
      await exec("chmod", ["755", tmp]).then(out);
      await exec("mv", ["-f", tmp, this.bin]).then(out);
    }
    await this.check();
  }

  async refresh() {
    const gen = this.offerGen;
    const [r, ms, cl, of] = await Promise.all([
      hc(["get", SERVE, "--json"]).catch(() => null),
      hc(["machine", "ls", "--json"]).catch(() => null),
      exec(this.bin, ["clients"]).catch(() => null),
      hc(["get", OFFER, "--json"]).catch(() => null),
    ]);
    try {
      if (ms?.code === 0) this.machines = (JSON.parse(ms.stdout).machines ?? []).filter((m) => !m.temporary && isOurs(m));
    } catch {}
    try {
      if (cl?.code === 0) this.clients = JSON.parse(cl.stdout);
    } catch {}
    let t = null;
    try {
      t = r?.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {}
    const live = t?.state === "live";
    let tail = "";
    if (t && !live && !this.stopped) tail = (await hc(["read", SERVE, "--lines", "6"]).then(out).catch(() => "")).split("\n").filter(Boolean).slice(-3).join("\n");
    this.serve = t ? { live, tail } : null;
    // The identity is saved a moment after serve starts; ask until it is.
    if (live && !this.addr && !this.stopped) this.addr = await exec(this.bin, ["addr"]).then(out).catch(() => null);
    if (!live) this.addr = null;

    let o = null;
    try {
      o = of?.code === 0 ? JSON.parse(of.stdout) : null;
    } catch {}
    if (gen !== this.offerGen) return; // an offer started or was cancelled meanwhile; the next refresh reads it
    if (o && (o.state === "live" || this.offering)) {
      const screen = (await hc(["read", OFFER, "--lines", "20"]).then(out).catch(() => "")).split("\n").filter((l) => l.trim());
      if (gen !== this.offerGen) return;
      if (o.state === "live") this.offer = { code: screen.join("\n").match(/one-time code: (\S+)/)?.[1] ?? null };
      else {
        this.offer = null;
        this.offering = false;
        const why = unstamp(screen.at(-1)?.trim() ?? `exit ${o.exit_code}`);
        if (o.exit_code === 0) this.say("share", "Sent. When the other computer asks to connect, check the pairing code matches and click Allow.", true);
        else if (!this.offerCancelled) this.say("share", `One-time code: ${why}`);
      }
    } else this.offer = null;
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

  // Remove buttons take two clicks: the first turns them into "Remove?".
  confirmed(id, cx) {
    if (this.confirm === id) return (this.confirm = null), true;
    this.confirm = id;
    cx.notify();
    cx.timer.after(4000, (cx) => { if (this.confirm === id) this.confirm = null; cx.notify(); });
    return false;
  }

  connect(cx) {
    const input = this.addrInput.value().trim();
    const name = this.nameInput.value().trim().toLowerCase();
    const isCode = CODE_RE.test(input);
    if (!isCode && !ADDR_RE.test(input)) return this.say("mine", "That doesn't look like an invite code (starts with tc) or a one-time code (like WDJB-MJHT). Get one from Share this computer on the other computer."), cx.notify();
    if (!NAME_RE.test(name)) return this.say("mine", "Give it a short name using letters, numbers or dashes, like work-pc."), cx.notify();
    if (this.machines.some((m) => m.name === name)) return this.say("mine", `You already have a computer called ${name}. Pick another name.`), cx.notify();
    const token = {};
    this.adding = { name, token, fetching: isCode };
    this.say("mine", null);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let addr = input;
        if (isCode) {
          // Shared by a retry after Cancel: the first redeem uses the code up either way.
          const key = input.toUpperCase().replace(/[- ]/g, "");
          if (!this.redeemed[key]) {
            this.redeemed[key] = exec(this.bin, ["redeem", input], { timeout: 70000 }).then(out);
            this.redeemed[key].catch(() => delete this.redeemed[key]);
          }
          addr = await this.redeemed[key];
        }
        if (this.adding?.token !== token) return; // cancelled
        if (!ADDR_RE.test(addr)) throw new Error("The other computer sent something that isn't an invite code.");
        this.adding.fetching = false;
        cx.notify();
        // Keeps asking until the other computer clicks Allow (or 5 minutes pass).
        // shortcut: Cancel only stops listening; the wait process runs out its 5 minutes. Kill it if that ever matters.
        await exec(this.bin, ["wait", addr], { timeout: 330000 }).then(out);
        if (this.adding?.token !== token) return; // cancelled
        // Windows: a program and its arguments (CommandLineToArgvW); elsewhere an sh line.
        const prog = win() ? `"${this.bin}"` : `'${this.bin.replace(/'/g, "'\\''")}'`;
        const r = await hc(["machine", "add", "--via", `${prog} pipe ${addr}`, "--name", name, "--json"]);
        if (r.code !== 0) {
          let m = (r.stderr || r.stdout).trim();
          try {
            m = JSON.parse(r.stdout || r.stderr).error?.message ?? m;
          } catch {}
          throw new Error(m || "Adding it to Herdr failed.");
        }
        this.addrInput.set_value("");
        this.nameInput.set_value("");
        this.adding = null;
        await this.refresh();
        this.say("mine", `${name} is added. Its terminals are in Herdr's sidebar.`, true);
      } catch (e) {
        if (this.adding?.token !== token) return;
        this.adding = "form";
        this.say("mine", e.message.startsWith("no approval") ? "The other computer didn't allow it in time. Check sharing is on there, then try again." : e);
      }
      cx.notify();
    });
  }

  removeMachine(name, cx) {
    if (!this.confirmed(`m-${name}`, cx)) return;
    this.act("mine", "rm", async () => {
      await hc(["machine", "rm", name]).then(out);
      await this.refresh();
      return `Removed ${name}. To stop it accepting this computer too, remove this computer on that side.`;
    }, cx);
  }

  setSharing(on, cx) {
    if (on) {
      const log = win() ? `${home()}\\AppData\\Local\\herdr-remote\\audit.log` : `${home()}/.local/state/herdr-remote-audit.log`;
      this.act("share", "share", async () => {
        // Keys typed into the old dialog become approved computers.
        const old = (localStorage.getItem("allow") ?? "").split(",").map((s) => s.trim()).filter((k) => KEY_RE.test(k));
        for (const k of old) await exec(this.bin, ["allow", k]).then(out);
        localStorage.removeItem("allow");
        await hc(["rm", SERVE]).catch(() => null); // a finished one keeps the name
        if (!win()) await exec("mkdir", ["-p", `${home()}/.local/state`]).then(out);
        await hc(["run", "--bg", "--no-parent", "--name", SERVE, "--", this.bin, "serve", "-log", log]).then(out);
        this.addr = null;
        this.stopped = false;
        await this.refresh();
      }, cx);
    } else {
      this.act("share", "share", async () => {
        this.stopped = true; // its exit isn't an error to show
        this.addr = null;
        await this.cancelOffer(); // even if this window isn't showing it, it must not outlive sharing
        await hc(["kill", SERVE]).then(out);
        await this.refresh();
      }, cx);
    }
  }

  startOffer(cx) {
    this.act("share", "offer", async () => {
      this.offerGen++;
      await hc(["rm", OFFER]).catch(() => null); // a finished one keeps the name
      await hc(["run", "--bg", "--no-parent", "--name", OFFER, "--", this.bin, "offer"]).then(out);
      this.offerGen++;
      this.offering = true;
      this.offerCancelled = false;
      this.offer = { code: null };
      await this.refresh();
    }, cx);
  }

  async cancelOffer() {
    this.offerGen++;
    this.offerCancelled = true; // its exit isn't an error to show
    this.offer = null;
    await hc(["kill", OFFER]).catch(() => null);
  }

  client(op, entry, cx) {
    if (op === "revoke" && !this.confirmed(`c-${entry.key}`, cx)) return;
    this.act("share", `${op}-${entry.key}`, async () => {
      await exec(this.bin, [op, entry.key]).then(out);
      await this.refresh();
      return { allow: `Allowed ${entry.code}. It's connecting now.`, deny: `Didn't allow ${entry.code}.`, revoke: `Removed ${entry.code}. It's disconnected and can't connect again unless you allow it.` }[op];
    }, cx);
  }

  copy(id, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === id) this.copied = null; cx.notify(); });
  }

  render(cx) {
    const t = theme();
    const button = (id, label, kind, onClick) => {
      const primary = kind === "primary";
      return h_flex().id(id).h(30).px(12).flex_none().items_center().justify_center().rounded(7).text_size(12)
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : kind === "danger" ? t.blocked : t.foreground)
        .border_1().border_color(primary ? t.solid : t.input)
        .when(!!this.busy, (el) => el.opacity(0.5))
        .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)))
        .child(this.busy === id ? "Working…" : label);
    };
    const copyBtn = (id, text) => button(id, this.copied === id ? "Copied" : "Copy", null, (cx) => this.copy(id, text, cx));
    const field = (state) => h_flex().items_center().flex_1().min_w(0).h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).child(Input.new(state));
    const mono = (text) => div().flex_1().min_w(0).truncate().px(8).py(6).rounded(7).bg(t.background).border_1().border_color(t.border).text_size(12).child(text);
    const note = (s) => (this.msg[s] ? div().text_size(12).line_height("18px").text_color(this.msg[s].error ? t.blocked : t.done).child(this.msg[s].text) : div());
    const muted = (text) => div().text_size(12).line_height("18px").text_color(t.muted).child(text);
    const spin = (text) => h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(svg(I("spinner")).size(12).text_color(t.working).spin(900)).child(text);
    const dot = (c) => div().flex_none().size(7).rounded(4).bg(c);
    const heading = (text, right) => h_flex().items_center().pt(4).child(div().flex_1().text_size(13.5).font_semibold().child(text)).child(right ?? div());
    const row = (icon, title, status, statusColor, action) => h_flex().gap(8).items_center().px(10).py(6).rounded(7).bg(t.background).border_1().border_color(t.border)
      .child(svg(I(icon)).size(14).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(13).child(title))
      .child(h_flex().gap(5).items_center().text_size(11.5).text_color(statusColor ?? t.muted).when(!!statusColor, (el) => el.child(dot(statusColor))).child(status))
      .child(action);
    const step = (n, text, body) => h_flex().gap(10).items_start()
      .child(div().flex_none().size(20).rounded(10).bg(t.raised).border_1().border_color(t.border).text_size(11).font_semibold().text_color(t.muted).flex().items_center().justify_center().child(String(n)))
      .child(v_flex().flex_1().min_w(0).gap(6).child(div().text_size(12.5).line_height("18px").child(text)).child(body ?? div()));
    const close = () => closeOverlay(props()?.overlay);

    const bound = keys().filter((k) => k.action === "mod.open:remote").map((k) => k.keys);
    // keys.json ships cmd-alt-t (macOS) and ctrl-shift-y (Windows/Linux); show the one that works here.
    const shortcut = (win() ? bound.filter((k) => !k.startsWith("cmd-")) : [...bound.filter((k) => k.startsWith("cmd-")), ...bound])[0];
    let root = v_flex().id("remote").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13).overflow_y_scrollbar()
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Herdr Remote"))
        .child(div().id("ts-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(close).child("Esc")))
      .child(muted("Use your other computers' terminals right here. No SSH or VPN needed."));
    const footer = div().pt(6).text_size(11.5).text_color(t.dim)
      .child(shortcut ? `Open this again with ${shortcut}, or "Herdr Remote" in the command palette.` : `Open this again from the command palette: "Herdr Remote".`);

    if (!this.ready) {
      return root.child(
        v_flex().gap(10).p(14).rounded(9).bg(t.background).border_1().border_color(t.border)
          .child(div().text_size(13).font_semibold().child(this.stale ? "An update is needed" : "One-time setup"))
          .child(muted(this.stale
            ? `This version of Herdr Remote needs herdr-remote ${VERSION}. Update replaces the one at ${this.bin}.`
            : `Herdr Remote needs a small helper program, herdr-remote ${VERSION}. It's downloaded from GitHub, checked against a known checksum, and saved to ${this.bin}.`))
          .child(this.busy === "download" ? spin("Downloading… this can take a minute on a slow connection.")
            : h_flex().child(this.target ? button("download", this.stale ? "Update" : "Download", "primary", (cx) => this.act("setup", "download", () => this.download(), cx)) : spin("Checking…")))
          .child(note("setup")),
      ).child(footer);
    }

    // Your computers: the ones this computer can use.
    root = root.child(heading("Your computers", this.adding ? null : button("add-open", "Add a computer", "primary", (cx) => { this.adding = "form"; this.say("mine", null); cx.notify(); })));
    if (this.machines.length) {
      root = root.child(v_flex().gap(4).children(this.machines.map((m) => {
        const [label, color] = m.state === "unreachable" ? ["Offline", t.blocked] : m.state === "connected" ? ["Online", t.done] : [m.state ?? "Unknown", null];
        const id = `m-${m.name}`;
        return v_flex().gap(2)
          .child(row("server", m.name, label, color, button(id, this.confirm === id ? "Remove?" : "Remove", this.confirm === id ? "danger" : null, (cx) => this.removeMachine(m.name, cx))))
          .when(m.state === "unreachable", (el) => el.child(div().pl(32).text_size(11.5).text_color(t.dim).child("Can't reach it. Is Share this computer turned on over there?")));
      })));
    } else if (!this.adding) {
      root = root.child(muted("None yet. Add one to use its terminals from here."));
    }

    if (this.adding === "form") {
      root = root.child(v_flex().gap(10).p(12).rounded(9).bg(t.background).border_1().border_color(t.border)
        .child(step(1, "On the other computer, open Herdr Remote and turn on Share this computer."))
        .child(step(2, "Paste the invite code it shows here. No copy-paste between them? Click Get a one-time code there, and type that code instead:", field(this.addrInput)))
        .child(step(3, "Name this computer:", field(this.nameInput)))
        .child(h_flex().gap(8).justify_end()
          .child(button("add-cancel", "Cancel", null, (cx) => { this.adding = null; this.say("mine", null); cx.notify(); }))
          .child(button("add-go", "Connect", "primary", (cx) => this.connect(cx)))));
    } else if (this.adding?.fetching) {
      root = root.child(v_flex().gap(10).p(14).rounded(9).bg(t.background).border_1().border_color(t.accent).items_center()
        .child(spin("Getting the invite with the one-time code…"))
        .child(button("fetch-cancel", "Cancel", null, (cx) => { this.adding = "form"; cx.notify(); })));
    } else if (this.adding) {
      root = root.child(v_flex().gap(10).p(14).rounded(9).bg(t.background).border_1().border_color(t.accent).items_center()
        .child(spin(`Waiting for the other computer to allow ${this.adding.name}…`))
        .child(div().px(16).py(8).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(22).font_semibold().child(this.code ?? "…"))
        .child(muted("On the other computer, click Allow next to this code."))
        .child(button("wait-cancel", "Cancel", null, (cx) => { this.adding = "form"; cx.notify(); })));
    }
    root = root.child(note("mine"));

    // Share this computer: let others use this one.
    const s = this.serve;
    const live = !!s?.live;
    const switching = this.busy === "share";
    root = root.child(h_flex().id("share-toggle").gap(10).items_center().mt(6).pt(12).border_t_1().border_color(t.border)
      .when(!this.busy, (el) => el.cursor_pointer().on_click((_e, cx) => this.setSharing(!live, cx)))
      .child(div().flex_none().w(34).h(20).rounded(10).p(2).bg(live ? t.solid : t.raised).border_1().border_color(t.border).when(switching, (el) => el.opacity(0.5))
        .child(div().size(14).rounded(7).bg(live ? t.solid_foreground : t.muted).when(live, (el) => el.ml(14))))
      .child(v_flex().flex_1()
        .child(div().text_size(13.5).font_semibold().child("Share this computer"))
        .child(muted(switching ? (live ? "Turning off…" : "Turning on…") : live ? "On. Computers you allow can use this one." : "Let your other computers use this one's terminals."))));

    if (live) {
      const pending = this.clients.pending ?? [];
      root = root
        .child(h_flex().gap(4).flex_wrap().px(10).py(8).rounded(8).bg(t.blocked + "14").border_1().border_color(t.blocked + "40").text_size(12).text_color(t.muted)
          .child("Computers you allow can do anything you can do on this computer.")
          .child(div().id("ts-sec").text_color(t.accent).cursor_pointer().hover((st) => st.underline()).on_click((_e, cx) => cx.open_url(`${REPO}/blob/main/SECURITY.md`)).child("Security notes")))
        .child(step(1, "Copy this invite code and paste it on the computer that will connect. Keep it private, like a password.",
          this.addr ? v_flex().gap(8)
            .child(h_flex().gap(8).child(mono(this.addr)).child(copyBtn("copy-addr", this.addr)))
            .child(this.offer
              ? v_flex().gap(8).p(12).rounded(8).bg(t.background).border_1().border_color(t.accent).items_center()
                .child(this.offer.code ? div().px(16).py(8).rounded(8).bg(t.raised).border_1().border_color(t.border).text_size(22).font_semibold().child(this.offer.code) : spin("Getting a one-time code…"))
                .child(muted("Type this on the other computer, in Add a computer. It works once, for 10 minutes."))
                .child(button("offer-cancel", "Cancel", null, (cx) => this.act("share", "offer-cancel", () => this.cancelOffer(), cx)))
              : h_flex().gap(8).items_center().child(muted("No copy-paste on the other computer?")).child(button("offer", "Get a one-time code", null, (cx) => this.startOffer(cx))))
            : spin("Getting the invite code…")))
        .child(step(2, "When it asks to connect, check the pairing code matches and click Allow.",
          pending.length
            ? v_flex().gap(6).children(pending.map((p) => v_flex().gap(8).px(12).py(10).rounded(8).bg(t.background).border_1().border_color(t.accent)
                .child(h_flex().gap(10).items_center()
                  .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12.5).child("A computer wants to connect")).child(muted("Allow it only if the other computer shows this code.")))
                  .child(div().flex_none().px(10).py(4).rounded(6).bg(t.raised).text_size(16).font_semibold().child(p.code)))
                .child(h_flex().gap(8).justify_end()
                  .child(button(`deny-${p.key}`, "Don't allow", null, (cx) => this.client("deny", p, cx)))
                  .child(button(`allow-${p.key}`, "Allow", "primary", (cx) => this.client("allow", p, cx))))))
            : muted("Waiting for a computer to ask. Keep this window open so you can allow it.")));
    } else if (s?.tail) {
      root = root.child(v_flex().gap(4).child(div().text_size(12).text_color(t.blocked).child("Sharing stopped on its own. The last thing it printed:")).child(mono(s.tail)));
    }

    const allowed = this.clients.allow ?? [];
    if (allowed.length) {
      root = root.child(div().pt(4).text_size(11.5).font_medium().text_color(t.dim).child("Computers allowed to connect here"))
        .child(v_flex().gap(4).children(allowed.map((c) => {
          const id = `revoke-${c.key}`;
          return row("monitor", c.code, `allowed ${day(c.since)}`, null,
            button(id, this.confirm === `c-${c.key}` ? "Remove?" : "Remove", this.confirm === `c-${c.key}` ? "danger" : null, (cx) => this.client("revoke", c, cx)));
        })));
    }
    return root.child(note("share")).child(footer);
  }
}
