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
| Client authentication | Only keys listed with `-allow` are admitted. A key the relay authenticated but that isn't listed is refused. WireGuard also requires the pre-shared key embedded in the address. An empty or unparsable allowlist refuses to start. |
| Encryption | WireGuard, end to end. Relays see node public keys, IP addresses, timing, and traffic volume, never content. |
| Exposed surface | Only TCP port 7100 is admitted by the tunnel's packet filter. No UDP, forwarding, SSH, or file service. |
| Secrets at rest | Windows: encrypted with DPAPI for the current user, stored under `%LocalAppData%` (never in roaming profiles). macOS: login Keychain. The address and keys are never written to the log. |
| Audit log | `-log FILE` appends UTC-timestamped start, open/close (with the client key and duration), refusals, and herdr-core failures. Refusals are logged once per key, for up to 100 keys (protects against log flooding). |
| Limits | `-max-conns` (default 16) concurrent sessions. |
| Binary hijack | `-herdr` is resolved once at startup to an absolute path, and that path is logged. Pass an absolute path anyway. |
| Relay pinning | After the first run, the relay is taken from the saved identity, so restarts don't fetch `tailcat.dev`. |

## Secrets to protect

- **The `tc…` address** contains the server's pre-shared key. Share it only with
  the client machine (it sits in hc's `--via` setting). It is not enough on its
  own: the connecting key must also be on the allowlist.
- **The client key** (macOS Keychain item `herdr-tsbridge` / `<profile>-client`)
  is what grants access. Anyone running as your Mac user can use it, just as with
  an unencrypted SSH key.

## Revoking access and rotating keys

- Revoke a client: remove its key from `-allow` and restart `serve`. Restarting
  also drops sessions that are already connected.
- Rotate the server identity: delete `%LocalAppData%\herdr-tsbridge\<profile>-server.dpapi`
  and restart. You get a new address, and the old one stops working.

## Known gaps / options

- Traffic goes through Tailscale's public DERP relays (free, rate-limited)
  until a direct path is found. For full control, run your own DERP server
  (not wired into this tool yet).
- The `tc…` address is long-lived. Tailcat's experimental `Hybrid`
  (post-quantum handshake) mode, not enabled here, would stop post-quantum
  protection from depending on the address staying secret.
- The audit log is a local file, with no Windows Event Log or tamper protection.
  If the client needs a tamper-evident log, forward it to their SIEM.
