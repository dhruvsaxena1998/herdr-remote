# herdr-tsbridge security notes

What it is: a remote-control channel. `serve` gives every allowlisted client
full control of herdr-core on the serving machine, which means running
commands as the user that runs `serve`. Treat it like an SSH server with key
authentication, deployed outside the client's managed remote-access tooling.

## Before deploying on a client's machine

1. **Get written approval from the client's security/IT owner.** The tunnel goes
   out through NAT to Tailscale's relays, so their firewall, VPN, and network
   monitoring do not see or inspect the sessions.
2. **Know the dependency's status.** Tailcat (github.com/tailscale/tailcat,
   v0.8.0, released 2026-11-22) calls itself "an early experimental tool"
   whose "threat model hasn't historically included malicious adversaries",
   and advises care when serving shells (its SECURITY.md). Its transport
   pieces (WireGuard, magicsock, DERP, netstack) are Tailscale's production code.
   The module is pinned in go.sum; review its changelog before you upgrade it.
3. **Run `serve` as a dedicated, non-administrator Windows account** that has
   only the access the work needs. Never run it as SYSTEM or as an admin.
4. **Run it only while you need it.** Stop it when the engagement or session ends.

## What the code enforces

| Control | How |
|---|---|
| Client authentication | Two locks. (1) **Approval:** only keys given with `-allow`, or approved on the serving machine (`allow`, the dialog's **Allow**), are admitted. Approved keys are in `<profile>-clients.json` (next to the secrets: `%LocalAppData%\herdr-tsbridge\` on Windows, `~/Library/Application Support/herdr-tsbridge/` on macOS, `~/.config/herdr-tsbridge/` on Linux), which serve re-reads every second. (2) **Invite:** WireGuard requires the pre-shared key inside the `tc…` address, so even an approved key can't connect without the invite. An `-allow` with no valid keys (only commas and spaces) or an unparsable key refuses to start. |
| Pairing requests | An unapproved key that announces itself becomes a request, listed in `<profile>-pending.json` with its pairing code (a 6-character SHA-256 fingerprint of the key, also shown on the asking computer). Requests are decided before the WireGuard handshake, so anyone who knows the server's public key (for example, a relay) could make one appear; approving a stranger's request still doesn't let them in without the invite. Check the pairing code matches before you click **Allow**. At most 10 requests are listed; one disappears 30 s after its client stops asking. **Don't allow** records the key as refused, and it isn't listed again. |
| Encryption | WireGuard, end to end. Relays see node public keys, IP addresses, timing, and traffic volume, never content. |
| Exposed surface | Only TCP port 7100 is admitted by the tunnel's packet filter. No UDP, forwarding, SSH, or file service. |
| Secrets at rest | Windows: encrypted with DPAPI for the current user, stored under `%LocalAppData%` (never in roaming profiles). macOS: login Keychain. Linux: owner-only (0600) files under `~/.config/herdr-tsbridge/`, replaced atomically. Private keys and the address are never written to the audit log; client *public* keys are. The address is printed once to `serve`'s stdout, so it stays in that terminal's scrollback (the `tsbridge-serve` herdr-core terminal when started from the mod). |
| Audit log | `-log FILE` appends UTC-timestamped start, pairing requests, approvals and removals (with the key and pairing code), open/close (with the client key and duration), herdr-core exit statuses, and a stop line on Ctrl-C or `hc kill` (on macOS/Linux; on Windows only if herdr-core signals rather than terminates the process). herdr-core's own error output goes to `serve`'s stderr, not the log file. Requests are logged once per key, for up to 100 keys (protects against log flooding). |
| Limits | `-max-conns` (default 16) concurrent sessions. |
| Binary hijack | `-herdr` is resolved once at startup to an absolute path, and that path is logged. Pass an absolute path anyway. |
| Relay pinning | After the first run, the relay is taken from the saved identity, so restarts don't fetch `tailcat.dev`. |

## Secrets to protect

- **The `tc…` address** contains the server's pre-shared key. Share it only with
  the client machine (it sits in hc's `--via` setting). The dialog calls it the
  **invite code**. It is not enough on its own: the connecting key must also be approved.
- **The client key** (macOS Keychain item `herdr-tsbridge` / `<profile>-client`)
  is what grants access. Anyone running as your Mac user can use it, just as with
  an unencrypted SSH key.

## Revoking access and rotating keys

- Revoke an approved client: **Remove** under **Computers allowed to connect here**
  (`herdr-tsbridge revoke KEY`). The running serve rejects it within a second, closes
  its sessions and disconnects it; it can't reconnect unless approved again. A key
  given with `-allow` needs removing from `-allow` and a restart.
- Rotate the server identity, then restart `serve`. You get a new address, and the old one stops working.
  - Windows: delete `%LocalAppData%\herdr-tsbridge\<profile>-server.dpapi`.
  - macOS: `security delete-generic-password -s herdr-tsbridge -a <profile>-server`.
  - Linux: delete `~/.config/herdr-tsbridge/<profile>-server`.
- `<profile>` is `default` unless `HERDR_TSBRIDGE_PROFILE` is set.

## Known gaps / options

- Traffic goes through Tailscale's public DERP relays (free, rate-limited)
  until a direct path is found. For full control, run your own DERP server
  (not wired into this tool yet).
- The `tc…` address is long-lived. Tailcat's experimental `Hybrid`
  (post-quantum handshake) mode, not enabled here, would stop post-quantum
  protection from depending on the address staying secret.
- The audit log is a local file, with no Windows Event Log or tamper protection.
  If the client needs a tamper-evident log, forward it to their SIEM.
