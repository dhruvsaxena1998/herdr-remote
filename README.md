# herdr-tsbridge

Lets Herdr (`hc`) reach herdr-core on another machine, such as a Windows VM, over [Tailcat](https://github.com/tailscale/tailcat) instead of SSH. You don't need SSH, open ports, or a Tailscale account. Read [SECURITY.md](SECURITY.md) before serving.

![Tailcat bridge](preview.png)

## Install the Herdr mod

Give your agent this prompt, on each machine:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dhruvsaxena1998/herdr-tsbridge
```

Open it with **cmd-alt-t** on macOS or **ctrl-shift-y** on Windows/Linux (from the mod's `keys.json`), **Tailcat bridge** in the command palette, or `herdr-app do mod.open --name tsbridge`. On first open, it downloads the pinned, hash-checked binary.

## Use

Open Tailcat bridge on both computers. You copy one thing, once.

1. On the computer you want to use from elsewhere (for example, the Windows VM), turn on **Share this computer** and copy its **invite code**.
2. On the computer you're sitting at (for example, your Mac), click **Add a computer**, paste the invite code, give it a name, and click **Connect**. It shows a short pairing code, like `K7Q-4XM`.
3. Back on the first computer, a request with the same pairing code appears. Click **Allow**.

The computer is now under **Your computers** and in Herdr's sidebar. Approved computers reconnect without asking again.

**Removing a computer:**
- On the computer you use it from, click **Remove** under **Your computers**. Herdr forgets it, but its terminals keep running there.
- On the sharing computer, click **Remove** under **Computers allowed to connect here**. It's disconnected at once and can't connect again unless you allow it.

## Troubleshooting

- **A computer shows "Offline".** On that computer, check **Share this computer** is on and your computer is under **Computers allowed to connect here**.
- **"The other computer didn't allow it in time".** No one clicked Allow within 5 minutes. Keep Tailcat bridge open on the sharing computer, then click **Connect** again.
- **No request shows up when connecting.** Check the invite code was copied whole, and that sharing is on there. Both computers need internet access.
- **Sharing stopped on its own.** The dialog shows the last lines it printed. The audit log is `~/.local/state/herdr-tsbridge-audit.log` (Windows: `%LocalAppData%\herdr-tsbridge\audit.log`).
- **Update says it couldn't replace the helper (Windows).** Windows can't overwrite a running `.exe`. Turn off sharing (`hc kill tsbridge-serve`), close connections to your computers, then retry.

## CLI

```
client side:
  herdr-tsbridge key                     print this machine's client nodekey
  herdr-tsbridge code                    print its short pairing code
  herdr-tsbridge wait [-timeout 5m] ADDRESS
                                         ask the server to connect; exit 0 once it's approved
  herdr-tsbridge pipe ADDRESS [ignored...]
                                         stdin/stdout to the server (hc --via)
server side:
  herdr-tsbridge serve [-allow nodekey:...[,...]] [-herdr PATH] [-log FILE] [-max-conns N]
                                         serve herdr-core; unknown clients wait for approval
  herdr-tsbridge addr                    print the saved server address (the invite; secret)
  herdr-tsbridge clients                 JSON: clients asking to connect, and approved ones
  herdr-tsbridge allow|deny|revoke KEY   approve, refuse, or remove a client (serve applies it live)
```

`HERDR_TSBRIDGE_PROFILE=name` keeps a separate set of keys side by side (default `default`).

Build: `CGO_ENABLED=0 GOOS=… GOARCH=… go build -trimpath -ldflags '-s -w' -o dist/herdr-tsbridge-<os>-<arch>[.exe]`. The builds are reproducible: with the same Go version, the SHA-256s match the table in `mods/tsbridge/main.js`. Upload those files to the GitHub release named by `VERSION` there.
