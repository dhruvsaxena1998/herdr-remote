// PROTOTYPE, throwaway. Question: what's the simplest UI for adding a device?
// Three structurally different variants of the Tailcat bridge dialog, switched
// with the bottom bar (← →, or the arrow keys). Every action is a stub: nothing
// here calls hc or herdr-tsbridge. Open: herdr-app do mod.open --name tsbridge-prototype

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const VARIANTS = [["A", "One box: copy yours, paste theirs"], ["B", "Wizard: one step per screen"], ["C", "List first, add inline"]];
const KEY = "nodekey:ff3c55af59e2c53de6a16b87a1f1d0c3fec2d207d2ca0ed93f2c6646168bb705";
const ADDR = "tcpGFwWCBaAsYVrR3zDmdkUDVntXqzINEFQtLIPSXSfqPOSwcBN2FrWCAXDWweRjwUulo59MmQ";

export default class Proto extends View {
  init(_p, cx) {
    this.v = Number(localStorage.getItem("v") ?? 0);
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.reset();
  }

  // All fake state, shown in the bar so you can see what each click changed.
  reset() {
    this.s = { machines: [{ name: "win", state: "unreachable" }], sharing: false, allowed: [], copied: null, error: null, pendingAddr: null, wiz: { role: null, step: 0 }, shareOpen: false };
    this.box = InputState.new({ placeholder: "Paste the code from the other computer" });
    this.name = InputState.new({ placeholder: "name, e.g. winvm" });
    this.addr = InputState.new({ placeholder: "tc… address from the other computer" });
    this.keyIn = InputState.new({ placeholder: "nodekey:… from the other computer" });
  }

  go(d, cx) {
    this.v = (this.v + d + VARIANTS.length) % VARIANTS.length;
    localStorage.setItem("v", String(this.v));
    this.reset();
    cx.notify();
  }

  copy(id, cx) {
    this.s.copied = id;
    cx.notify();
    cx.timer.after(1200, (cx) => { if (this.s.copied === id) this.s.copied = null; cx.notify(); });
  }

  add(name, cx) {
    name = (name || "").trim() || `computer-${this.s.machines.length + 1}`;
    this.s.machines.push({ name, state: "connected" });
    this.s.pendingAddr = null;
    this.s.error = null;
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const s = this.s;
    const btn = (id, label, primary, onClick, big) =>
      h_flex().id(id).h(big ? 38 : 30).px(big ? 16 : 12).flex_none().items_center().justify_center().rounded(7).text_size(big ? 13 : 12).cursor_pointer()
        .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).border_1().border_color(primary ? t.solid : t.input)
        .hover((st) => st.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(label);
    const field = (state, big) => h_flex().items_center().flex_1().min_w(0).h(big ? 38 : 30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).child(Input.new(state));
    const mono = (text, big) => div().flex_1().min_w(0).truncate().px(10).py(big ? 10 : 6).rounded(7).bg(t.background).border_1().border_color(t.border).text_size(big ? 13 : 12).child(text);
    const muted = (text) => div().text_size(12).line_height("18px").text_color(t.muted).child(text);
    const err = () => (s.error ? div().text_size(12).text_color(t.blocked).child(s.error) : div());
    const dot = (c) => div().flex_none().size(7).rounded(4).bg(c);
    const machineRow = (m) => h_flex().gap(8).items_center().px(10).py(7).rounded(7).bg(t.background).border_1().border_color(t.border)
      .child(svg(I("server")).size(14).text_color(t.muted)).child(div().flex_1().text_size(13).child(m.name))
      .child(h_flex().gap(5).items_center().text_size(11.5).text_color(m.state === "connected" ? t.muted : t.blocked).child(dot(m.state === "connected" ? t.done : t.blocked)).child(m.state));
    const copyBtn = (id) => btn(id, s.copied === id ? "Copied" : "Copy", false, (cx) => this.copy(id, cx));

    const body = [this.variantA, this.variantB, this.variantC][this.v].call(this, { t, s, btn, field, mono, muted, err, dot, machineRow, copyBtn, cx });

    const [k, label] = VARIANTS[this.v];
    const bar = v_flex().flex_none().items_center().gap(4).pt(8)
      .child(h_flex().gap(10).items_center().px(6).py(4).rounded(20).bg(t.foreground).text_color(t.background).text_size(12)
        .child(div().id("p-prev").px(8).cursor_pointer().on_click((_e, cx) => this.go(-1, cx)).child("←"))
        .child(div().font_semibold().child(`${k} (${label})`))
        .child(div().id("p-next").px(8).cursor_pointer().on_click((_e, cx) => this.go(1, cx)).child("→")))
      .child(div().text_size(10.5).text_color(t.dim).child(`state: sharing=${s.sharing} allowed=${s.allowed.length} machines=[${s.machines.map((m) => m.name).join(", ")}]${s.pendingAddr ? " pendingAddr" : ""}${this.v === 1 ? ` wiz=${s.wiz.role ?? "-"}/${s.wiz.step}` : ""}`));

    return v_flex().id("proto").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
        else if (e.key === "left" && this.handle.is_focused?.()) this.go(-1, cx);
        else if (e.key === "right" && this.handle.is_focused?.()) this.go(1, cx);
      })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Tailcat bridge")).child(div().text_size(11).text_color(t.dim).child("PROTOTYPE")))
      .child(v_flex().flex_1().min_h(0).gap(12).overflow_y_scrollbar().child(body))
      .child(bar);
  }

  // A: no tabs, no roles. "Your code" is the client key, and becomes the address
  // once you're sharing. One box takes whatever the other side sends and does the right thing.
  variantA({ t, s, btn, field, mono, muted, err, machineRow, copyBtn, cx }) {
    const paste = (cx) => {
      const v = this.box.value().trim();
      s.error = null;
      if (v.startsWith("nodekey:")) { s.sharing = true; s.allowed.push(v); this.box.set_value(""); }
      else if (v.startsWith("tc")) { s.pendingAddr = v; this.box.set_value(""); }
      else s.error = "That isn't a Tailcat bridge code. Codes start with nodekey: or tc.";
      cx.notify();
    };
    return v_flex().gap(14)
      .child(muted("Open this on both computers. On each: copy your code, paste theirs."))
      .child(v_flex().gap(8).p(14).rounded(9).bg(t.background).border_1().border_color(t.border)
        .child(h_flex().items_center().child(div().flex_1().text_size(12).font_semibold().text_color(t.muted).child(s.sharing ? "YOUR CODE (sharing: send this back)" : "YOUR CODE")))
        .child(h_flex().gap(8).child(mono(s.sharing ? ADDR : KEY, true)).child(copyBtn("a-copy")))
        .when(s.sharing, (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
          .child(div().size(7).rounded(4).bg(t.working)).child(`Sharing this computer with ${s.allowed.length} other. They get full control as you.`)
          .child(div().flex_1()).child(btn("a-stop", "Stop", false, (cx) => { s.sharing = false; s.allowed = []; cx.notify(); })))))
      .child(v_flex().gap(8)
        .child(div().text_size(12).font_semibold().text_color(t.muted).child("THEIR CODE"))
        .child(s.pendingAddr
          ? h_flex().gap(8).child(field(this.name, true)).child(btn("a-add", "Add computer", true, (cx) => this.add(this.name.value(), cx), true))
          : h_flex().gap(8).child(field(this.box, true)).child(btn("a-go", "Continue", true, paste, true)))
        .child(s.pendingAddr ? muted("Got their address. Name the computer to add it.") : muted("Their code is the one shown in this same box on the other computer."))
        .child(err()))
      .when(s.machines.length > 0, (el) => el.child(v_flex().gap(6).child(div().text_size(12).font_semibold().text_color(t.muted).child("COMPUTERS YOU CAN REACH"))
        .children(s.machines.map(machineRow))));
  }

  // B: ask the role first, then exactly one thing per screen, with Back/Next.
  variantB({ t, s, btn, field, mono, muted, machineRow, copyBtn, cx }) {
    const w = s.wiz;
    const set = (role, step) => (cx) => { w.role = role; w.step = step; cx.notify(); };
    const dots = (n) => h_flex().gap(6).children(Array.from({ length: n }, (_, i) => div().size(8).rounded(4).bg(i <= w.step ? t.solid : t.border)));
    const choice = (id, icon, title, sub, role) =>
      h_flex().id(id).gap(12).items_center().p(16).rounded(10).bg(t.background).border_1().border_color(t.border).cursor_pointer().hover((st) => st.border_color(t.accent))
        .on_click((_e, cx) => set(role, 0)(cx))
        .child(svg(I(icon)).size(22).text_color(t.muted))
        .child(v_flex().gap(2).child(div().text_size(14).font_semibold().child(title)).child(muted(sub)));
    const screen = (title, content, back, next) => v_flex().gap(14)
      .child(dots(3))
      .child(div().text_size(17).font_semibold().child(title))
      .child(content)
      .child(h_flex().gap(8).pt(6).child(btn("b-back", "Back", false, back)).child(div().flex_1()).child(next ?? div()));

    if (!w.role) {
      return v_flex().gap(12)
        .child(div().text_size(17).font_semibold().child("What do you want to do?"))
        .child(choice("b-reach", "monitor", "Reach another computer from here", "Use its terminals in this Herdr window.", "reach"))
        .child(choice("b-share", "server", "Let another computer reach this one", "It gets full control of this computer, as you.", "share"))
        .when(s.machines.length > 0, (el) => el.child(v_flex().gap(6).pt(10).child(muted("Already added:")).children(s.machines.map(machineRow))));
    }
    if (w.role === "reach") {
      if (w.step === 0) return screen("Send this code to the other computer", h_flex().gap(8).child(mono(KEY, true)).child(copyBtn("b-copy")), set(null, 0), btn("b-n1", "I sent it", true, set("reach", 1)));
      if (w.step === 1) return screen("Paste the address it sends back", field(this.addr, true), set("reach", 0), btn("b-n2", "Next", true, set("reach", 2)));
      if (w.step === 2) return screen("Name it", field(this.name, true), set("reach", 1), btn("b-n3", "Add computer", true, (cx) => { this.add(this.name.value(), cx); set("reach", 3)(cx); }));
      return v_flex().gap(12).items_center().pt(40).child(svg(I("circle-check")).size(36).text_color(t.done)).child(div().text_size(17).font_semibold().child("Added")).child(muted("It's in the sidebar now.")).child(btn("b-done", "Done", true, set(null, 0)));
    }
    if (w.step === 0) return screen("Paste the code from the other computer", field(this.keyIn, true), set(null, 0), btn("b-s1", "Start sharing", true, (cx) => { s.sharing = true; s.allowed.push("key"); set("share", 1)(cx); }));
    return screen("Send this address back", v_flex().gap(8).child(h_flex().gap(8).child(mono(ADDR, true)).child(copyBtn("b-copy2"))).child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted).child(div().size(7).rounded(4).bg(t.working)).child("Sharing. Keep this window's Herdr running.")),
      set("share", 0), btn("b-s2", "Stop sharing", false, (cx) => { s.sharing = false; s.allowed = []; set(null, 0)(cx); }));
  }

  // C: the machines are the page. Your code is a chip, adding is one row,
  // sharing is a toggle row that expands only when on.
  variantC({ t, s, btn, field, muted, machineRow, cx }) {
    return v_flex().gap(12)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(13).font_semibold().child("Your computers"))
        .child(h_flex().id("c-chip").gap(6).items_center().px(10).h(26).rounded(13).bg(t.raised).border_1().border_color(t.border).text_size(11.5).cursor_pointer()
          .on_click((_e, cx) => this.copy("c-chip", cx))
          .child(s.copied === "c-chip" ? "Copied your code" : `My code ${KEY.slice(8, 14)}… · copy`)))
      .child(s.machines.length ? v_flex().gap(6).children(s.machines.map(machineRow)) : muted("None yet."))
      .child(v_flex().gap(6).p(10).rounded(9).bg(t.background).border_1().border_color(t.border)
        .child(h_flex().gap(8).child(field(this.addr)).child(div().w(140).flex_none().child(field(this.name))).child(btn("c-add", "Add", true, (cx) => { this.add(this.name.value(), cx); this.addr.set_value(""); this.name.set_value(""); })))
        .child(muted("Get the address from the other computer: open this there and turn on Share.")))
      .child(v_flex().gap(8).pt(4)
        .child(h_flex().id("c-share").gap(10).items_center().cursor_pointer().on_click((_e, cx) => { s.shareOpen = !s.shareOpen; if (!s.shareOpen) s.sharing = false; cx.notify(); })
          .child(div().w(34).h(20).rounded(10).p(2).bg(s.shareOpen ? t.solid : t.raised).border_1().border_color(t.border)
            .child(div().size(14).rounded(7).bg(s.shareOpen ? t.solid_foreground : t.muted).when(s.shareOpen, (el) => el.ml(14))))
          .child(v_flex().child(div().text_size(13).child("Share this computer")).child(muted(s.sharing ? "On. Allowed computers have full control as you." : "Let another computer reach this one."))))
        .when(s.shareOpen, (el) => el.child(v_flex().gap(6).pl(44)
          .child(h_flex().gap(8).child(field(this.keyIn)).child(btn("c-start", s.sharing ? "Update" : "Start", true, (cx) => { s.sharing = true; s.allowed = ["key"]; cx.notify(); })))
          .when(s.sharing, (el) => el.child(h_flex().gap(8).items_center().child(div().flex_1().truncate().text_size(12).text_color(t.muted).child(`Send back: ${ADDR}`)).child(btn("c-copy", s.copied === "c-copy" ? "Copied" : "Copy", false, (cx) => this.copy("c-copy", cx))))))));
  }
}
