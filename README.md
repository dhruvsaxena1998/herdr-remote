# herdr-remote

Lets Herdr (`hc`) reach herdr-core on another machine, such as a Windows VM, over [Tailcat](https://github.com/tailscale/tailcat) instead of SSH. You don't need SSH, open ports, or a Tailscale account. Read [SECURITY.md](SECURITY.md) before serving.

![Herdr Remote](preview.png)

## Install the Herdr mod

Give your agent this prompt, on each machine:

```
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/dhruvsaxena1998/herdr-remote
```

Open it with **cmd-alt-t** on macOS or **ctrl-shift-y** on Windows/Linux (from the mod's `keys.json`), **Herdr Remote** in the command palette, or `herdr-app do mod.open --name remote`. On first open, it downloads the pinned, hash-checked binary.

## Use

Open Herdr Remote on both computers. You copy one thing, once.

1. On the computer you want to use from elsewhere (for example, the Windows VM), turn on **Share this computer** and copy its **invite code**. No copy-paste between the two? Click **Get a one-time code** instead: it shows something like `WDJB-MJHT`, which works once, for 10 minutes.
2. On the computer you're sitting at (for example, your Mac), click **Add a computer**, paste the invite code (or type the one-time code), give it a name, and click **Connect**. It shows a short pairing code, like `K7Q-4XM`.
3. Back on the first computer, a request with the same pairing code appears. Click **Allow**.

The computer is now under **Your computers** and in Herdr's sidebar. Approved computers reconnect without asking again.

**Removing a computer:**
- On the computer you use it from, click **Remove** under **Your computers**. Herdr forgets it, but its terminals keep running there.
- On the sharing computer, click **Remove** under **Computers allowed to connect here**. It's disconnected at once and can't connect again unless you allow it.

## Upgrading from Tailcat bridge (herdr-tsbridge)

The helper was renamed to `herdr-remote`, and it keeps its keys and client lists under the new name. After upgrading, on each computer:

- Opening Herdr Remote stops any sharing the old dialog started (`tsbridge-serve`). Turn **Share this computer** back on if you want it.
- Each computer gets a new identity, so pair your computers again (see **Use**), and remove the old entries under **Your computers**.
- The old keys are no longer used. To delete them: macOS `security delete-generic-password -s herdr-tsbridge -a default-client` (and `-a default-server`); Windows: delete `%LocalAppData%\herdr-tsbridge\`; Linux: delete `~/.config/herdr-tsbridge/`. Also delete the old binary, `~/.local/bin/herdr-tsbridge` (Windows: in `%LocalAppData%\herdr-tsbridge\`).

## Troubleshooting

- **A computer shows "Offline".** On that computer, check **Share this computer** is on and your computer is under **Computers allowed to connect here**.
- **"The other computer didn't allow it in time".** No one clicked Allow within 5 minutes. Keep Herdr Remote open on the sharing computer, then click **Connect** again.
- **No request shows up when connecting.** Check the invite code was copied whole, and that sharing is on there. Both computers need internet access.
- **A one-time code doesn't work.** A code works once and for 10 minutes, and one mistyped attempt uses it up: get a new one. If getting a code fails, the network may block `relay.magic-wormhole.io` on port 4000; paste the invite code instead.
- **Sharing stopped on its own.** The dialog shows the last lines it printed. The audit log is `~/.local/state/herdr-remote-audit.log` (Windows: `%LocalAppData%\herdr-remote\audit.log`).
- **Update says it couldn't replace the helper (Windows).** Windows can't overwrite a running `.exe`. Turn off sharing (`hc kill remote-serve`), close connections to your computers, then retry.

## CLI

```
client side:
  herdr-remote key                     print this machine's client nodekey
  herdr-remote code                    print its short pairing code
  herdr-remote redeem CODE             print the invite sent with a one-time code
  herdr-remote wait [-timeout 5m] ADDRESS
                                         ask the server to connect; exit 0 once it's approved
  herdr-remote pipe ADDRESS [ignored...]
                                         stdin/stdout to the server (hc --via)
server side:
  herdr-remote serve [-allow nodekey:...[,...]] [-herdr PATH] [-log FILE] [-max-conns N]
                                         serve herdr-core; unknown clients wait for approval
  herdr-remote addr                    print the saved server address (the invite; secret)
  herdr-remote offer                   print a one-time code that delivers the invite once (10 min)
  herdr-remote clients                 JSON: clients asking to connect, and approved ones
  herdr-remote allow|deny|revoke KEY   approve, refuse, or remove a client (serve applies it live)
```

`HERDR_REMOTE_PROFILE=name` keeps a separate set of keys side by side (default `default`).

Build: `CGO_ENABLED=0 GOOS=… GOARCH=… go build -trimpath -buildvcs=false -ldflags '-s -w' -o dist/herdr-remote-<os>-<arch>[.exe]`. The builds are reproducible: with the same Go version, the SHA-256s match (`-buildvcs=false` keeps git state out of the binary) the table in `mods/remote/main.js`. Upload those files to the GitHub release named by `VERSION` there.
