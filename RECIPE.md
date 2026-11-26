# Tailcat bridge

A dialog that connects Herdr to herdr-core on another machine (a Windows VM, another laptop) over Tailcat, Tailscale's data plane with no account, instead of SSH. The same dialog runs on both sides: one machine serves, the other adds it as an `hc` machine.

![Tailcat bridge](preview.png)

## What you see

A 600×520 dialog on `popover`, 18px padding, 13px text. The title, **Tailcat bridge**, is 13.5px semibold `foreground`, with a 12px `muted` line under it. Below it are sections, each with a 1px `border` line on top and 12px above its content.

Until the binary is in place, one section explains where `herdr-tsbridge v0.1.0` will be saved and shows a **Download** button.

After that, two sections:

1. **Connect to a machine.** This machine's client key (`nodekey:…`) in a 12px box on `background` with a **Copy** button. Then a full-width field for the `tc…` address, and a name field with **Add machine**.
2. **Let machines connect here.** A warning line that every allowed key gets full control of the machine. A field for allowed keys (comma-separated) with **Start**, which becomes **Stop** while serving. A status line: `dim` "Not serving." or `working` "Serving (herdr-core terminal tsbridge-serve)…". While serving, the `tc…` address with **Copy**, and a `dim` note that it is secret.

Buttons are 30px tall with radius 7. The primary one is `solid`, the others `raised` with an `input` border. While an action runs, its button reads "Working…". Results show under each section in 12px: errors in `blocked`, success in `done`.

## How it behaves

- On open it finds the platform (a home path like `C:\…` means Windows) and the architecture (`uname -sm`, or `%PROCESSOR_ARCHITECTURE%`). Then it hashes the binary at `~/.local/bin/herdr-tsbridge` or `%LocalAppData%\herdr-tsbridge\herdr-tsbridge.exe`. It uses the binary only when the SHA-256 matches the table pinned in `main.js`.
- **Download** runs `curl -fsSL --create-dirs` from this repo's GitHub release, does `chmod 755` on Unix, then checks the hash again.
- **Add machine** checks the address (`tc` plus base64url characters) and the name (`[a-z0-9-]{1,32}`). Then it runs `hc machine add --via '<bin> pipe <addr>' --name <name> --json`. On Windows the binary path is double-quoted, because `--via` is split with CommandLineToArgvW there. On Unix it is a single-quoted sh line.
- **Start** checks each key against `^nodekey:[0-9a-f]{64}$` and removes a finished `tsbridge-serve` terminal. It then runs `hc run --bg --no-parent --name tsbridge-serve -- <bin> serve -allow <keys> -log <audit log>`. The server is a herdr-core terminal, so it keeps running when the window closes. The audit log goes to `%LocalAppData%\herdr-tsbridge\audit.log` or `~/.local/state/herdr-tsbridge-audit.log`.
- Every 3 seconds it reads `hc get tsbridge-serve --json`. While the server is live and the address isn't known yet, it runs `<bin> addr`, which prints the saved address. It never parses the terminal screen, where a long address would wrap. If the server ends without **Stop**, its last 3 lines show in `blocked`.
- **Stop** runs `hc kill tsbridge-serve`. The allowed keys persist in `localStorage`.

## Built from

One mod, `mods/tsbridge/`: `main.js` and `mod.json` (`{ "place": "none", "title": "Tailcat bridge", "overlay": { "kind": "dialog", "width": 600, "height": 520 } }`). Open it with `mod.open {name: "tsbridge"}` (`herdr-app do mod.open --name tsbridge`).

It uses `div`, `h_flex`, `v_flex`, `InputState`/`Input` and `cx.write_to_clipboard`. From `herdr` it uses `exec`, `hc`, `home`, `theme` and `checking`.

**Programs it runs:** `herdr-tsbridge` (`key`, `addr`, `serve`), `hc`, `curl`, `uname`/`cmd`, `sha256sum`/`shasum`/`certutil`, `chmod`, `mkdir`.

**Network:** the one-time download from `github.com/dhruvsaxena1998/herdr-tsbridge/releases`. After that, the binary itself reaches Tailscale's DERP relays and `tailcat.dev` (first serve only).

**Files outside its folder:** it writes the binary path and the audit log above. The binary keeps its secrets in the macOS Keychain, or encrypted with DPAPI under `%LocalAppData%` (see SECURITY.md).

The Go source for the binary is at the root of this repo. Build it with `CGO_ENABLED=0 go build -trimpath -ldflags '-s -w'` per GOOS/GOARCH. Publishing a new release means updating `VERSION` and `SHA256` in `main.js`.

## Watch out

- `window()` is null during `herdr-app check`, so platform detection uses `home()`.
- `.child(null)` throws, so an empty note is an empty `div()`.
- `herdr-app check` draws only the "Checking…" state. Its `init` skips every `exec` while `checking()`.
- `hc machine add` refuses a machine that is this same core ("is this core"), so a loopback test proves the tunnel but can't add it.
- Serving gives allowlisted keys a full `herdr-core connect` as the current user. Changing the keys needs Stop, then Start.
- Builds exist for darwin, windows and linux, amd64 and arm64. Linux keeps secrets in 0600 files.

## Done when

- `herdr-app check mods/tsbridge` passes.
- On a fresh machine, **Download** fetches the binary and the dialog shows this machine's `nodekey:`.
- On the serving machine, **Start** with the client's key shows "Serving" and a `tc…` address.
- On the client, pasting that address and a name, then **Add machine**, lists the machine in `hc machine ls`, and `hc exec --on <name> hostname` prints the server's hostname.
- **Stop** ends serve, and the client can no longer reach it.
