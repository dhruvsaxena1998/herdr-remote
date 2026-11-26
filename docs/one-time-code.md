# Spec: one-time code for sharing the invite

Status: implemented in helper v0.4.0, release pending (2026-11-26)

## Problem

The invite is a `tc…` address: two 32-byte keys, a 32-byte pre-shared key and the
DERP region, base64url-encoded, a couple hundred characters. Pairing assumes you
copy it from one computer and paste it into the other. Two real setups have no
shared clipboard:

- **A cloud Windows VM opened through Windows App** (Azure). Clipboard redirection is
  off, and the VM is on another network, so local discovery can't reach it.
- **A second physical computer on the same network.** There's no clipboard between them.

Typing the invite by hand isn't realistic, and it can't be made short enough. The
two keys alone take more than 60 random characters.

## Decision

The sharing side can hand out a **one-time code** like `WDJB-MJHT` (the shape GitHub uses for device login). The other
computer types it in place of the invite. The two computers meet through a
magic-wormhole rendezvous server and run a PAKE (SPAKE2) keyed by the code. The full
invite then crosses encrypted with the resulting key. After that, pairing is
unchanged: the connecting side asks, the person checks the pairing code and clicks **Allow**.

Library: `github.com/psanford/wormhole-william` v1.0.8 (pure Go, builds for Windows,
only `SendText`/`Receive` used). Rendezvous: the public magic-wormhole server
(`ws://relay.magic-wormhole.io:4000/v1`, the library default), with our own AppID
`github.com/dhruvsaxena1998/herdr-remote/invite`, so these codes never collide with the
`wormhole` CLI's. The transit relay isn't used, because text messages go through the
rendezvous mailbox only.

Checked on 2026-11-26 from macOS: a code arrives in about 2 s and a full round trip
takes about 6 s. A wrong code fails on both sides (`decrypt message failed`).

Rejected:
- Shorter invite (region by ID, hybrid 128-bit PSK): still about 70 characters,
  breaks every existing invite, and the first connect depends on tailcat.dev.
- LAN discovery: doesn't reach the Azure VM. It may come back later as a
  no-typing option for same-network computers.
- Word-encoding the invite (about 50 words), QR codes (computers can't scan them),
  making the invite public (drops one of the two locks).
- Our own rendezvous over tailcat relays: it would be a custom crypto protocol.

## Behaviour

### Binary (`herdr-remote`)

| Command | Side | What it does | Exit |
|---|---|---|---|
| `offer` | sharing | Reads the saved server identity (as `addr` does). Picks a random code, claims its nameplate on the rendezvous server, and prints `one-time code: <code>`. Waits up to **10 minutes** for one receiver. | 0 and prints `sent` once the invite is delivered. Otherwise non-zero with a reason: no identity yet, rendezvous unreachable, the code was typed wrong (it's now used up), or it expired. |
| `redeem CODE` | connecting | Takes the invite from the rendezvous server with that code. Waits at most **1 minute**, enforced outside the library (its `Receive` stops honouring the deadline once the PAKE message has arrived, so an expired code's leftover message would otherwise hang it forever). Checks that what arrived is a text message made only of `tc` + base64url that `tailcat.ParseAddr` accepts. | 0 and prints the invite on stdout. Otherwise non-zero: bad code format, unreachable, wrong code, timed out, or not an invite. |

- A code works **once**. A wrong attempt that completes the handshake burns it on both
  sides (a property of the wormhole mailbox protocol). See Security for what an attacker gets.
- The code is 8 characters, shown `XXXX-XXXX`, from the 32-symbol alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `0/O`, `1/I`), drawn from `crypto/rand`.
  `redeem` accepts any case, with a dash, a space or nothing in the middle.
- Mapping to the wormhole code (whose nameplate must be numeric): the first 3 characters,
  read as a base-32 number (0–32,767), are the **nameplate**. The last 5 are the
  **PAKE secret** (25 bits). `WDJB-MJHT` becomes the wormhole code `<n>-BMJHT`. The person
  never sees it. Large claimed nameplates were checked live on the public server (2026-11-26).
- Why 3 + 5 and not 4 + 4: nameplates can be listed by anyone using the same AppID, so the
  nameplate part is public. 4 + 4 left only 20 secret bits; 3 + 5 gives 25 (decided 2026-11-27).
- We claim the nameplate ourselves rather than having the server allocate one. Two codes
  out at once whose first 3 characters match (1 in 32,768) break each other, and the
  person gets a new code.
- `offer` requires a saved server identity (sharing has been turned on at least once),
  just like `addr`.

### Mod (`mods/remote/main.js`)

**Sharing side, step 1** (shown while sharing is on): the invite with **Copy** stays
as it is. Below it: *"No copy-paste on the other computer?"* and a secondary button,
**Get a one-time code**.

- Clicking it runs `herdr-remote offer` as the herdr-core terminal `remote-offer`
  (`hc run --bg --no-parent`, the same pattern as `remote-serve`), after removing a
  finished one with that name.
- The 2-second refresh polls `hc get remote-offer --json`. While it's `live`, the
  refresh reads its screen (`hc read`) and shows the code large, with: *"Type this on
  the other computer, in Add a computer. It works once, for 10 minutes."* and a
  **Cancel** button (`hc kill remote-offer`).
- When it finishes: exit 0 shows *"Sent. When the other computer asks to connect, check
  the pairing code matches and click Allow."* Any other exit shows *"One-time code: "* and its
  last output line as an error, plus the button again.
- Starting or cancelling bumps a counter; a refresh that began before that ignores the
  offer state it read, so it can't report the previous offer's ending as the new one's.
- Turning sharing off always kills `remote-offer`, whether or not the window shows it.

**Connecting side, step 2**: the field takes either the invite or the one-time code.
- Placeholder: *"Paste the invite code, or type the one-time code"*.
- Step text: *"Paste the invite code it shows here. No copy-paste between them? Click Get a
  one-time code there, and type that code instead:"*
- On **Connect**: if the input matches `^[A-HJ-NP-Z2-9]{4}[- ]?[A-HJ-NP-Z2-9]{4}$` (case-insensitive),
  run `redeem` first (timeout 70 s), check the result against `ADDR_RE`, then continue
  with the current `wait` and `hc machine add` flow using the invite. The pending view
  shows *"Getting the invite with the one-time code…"* and **Cancel** while `redeem` runs.
- Cancel doesn't stop `redeem`, which uses the code up anyway, so its promise is kept per
  code and a retry with the same code reuses the result instead of failing.
- Errors are `redeem`'s own message, for example *"couldn't get the invite with that code
  (decrypt message failed); a code works once, so if it was mistyped, get a new one on the
  other computer"*. Network failures land here too, so the message doesn't claim the code
  was wrong.
- A code that's already used up doesn't fail fast: `redeem` waits its full minute
  for a sender that's gone. That's acceptable for now.
- Status: v0.4.0 binaries built and pinned. The release is not yet uploaded, and the mod
  hasn't been clicked through in Herdr.

### Release

The new commands need a new helper build, `v0.4.0`. `VERSION` and `SHA256` in
`main.js` are updated from reproducible builds (README build line). The binaries
must be uploaded to the `v0.4.0` GitHub release **before** the mod change ships,
otherwise Download fails the checksum.

## Security

- **What the rendezvous server sees:** IP addresses, the nameplate number, the AppID,
  timing, and ciphertext. Not the invite, and not the second half of the code.
- **The nameplate is public.** The protocol's `list` lets anyone using our AppID see
  claimed nameplates, so a bot can find every outstanding code's first 3 characters. Only
  the last 5 (25 bits) are secret.
- **Off-path attacker** (only talks to the server): one guess per code, 1 in 33,554,432.
  The guess ruins the code. The sharing side doesn't fail fast: an attacker who sends only
  a PAKE message leaves `offer` waiting until it expires, and the real receiver times out.
  A right guess yields the invite only. The attacker would still need a person to click
  **Allow** on a request whose pairing code doesn't match the one on the person's own computer.
- **On-path attacker** (the server operator, or anyone who can tamper with the plain
  `ws://`): can run the PAKE against both sides, about 2 in 33,554,432 per code. A right
  guess against the receiver lets them hand it an invite of their choosing. That passes
  `redeem`'s checks, so the connecting side would add the attacker's computer, and no Allow
  click guards that direction. Mitigation today is the low odds, plus checking that a newly
  added computer is the one you meant. `wss://` on a self-hosted server would remove the
  cheap network-path case.
- **Transport:** `ws://` is plain WebSocket. Confidentiality and integrity come from
  the PAKE, as in magic-wormhole. Someone on the network path sees what the server sees.
- **Trust boundary:** `redeem` treats what arrives as untrusted. It must be a text
  message, and it must be base64url. The library has already read it into memory, bounded only
  by its websocket limit, so the 4 KiB `LimitReader` bounds only what we copy. It's parsed by tailcat before it
  is printed, and `main.js` checks it again with `ADDR_RE` before it goes into the
  `--via` line.
- **Availability:** if the public server is down, or blocked (port 4000 outbound),
  one-time codes fail. Paste still works. Self-hosting a rendezvous server on 443 and
  pointing to it is the upgrade path. That's not built now (see Open items).
- **Long-lived invite:** the invite never expires, so a leaked one stays leaked.
  That's unchanged by this feature, and the approval lock is what covers it.

## Docs to update

- `GLOSSARY.md`: **One-time code**, short-lived characters that deliver the invite once.
  _Avoid_: PIN, short code, wormhole code (and don't confuse it with **Pairing code**).
- `SECURITY.md`: a threat-table row for the one-time code; the public rendezvous
  server under Network.
- `RECIPE.md`: `offer` and `redeem` under "Programs it runs"; the rendezvous server
  under Network.
- `README.md`: one line in the pairing steps.

## Tests

- Go: an `offer` → `redeem` round trip against the library's in-process
  `rendezvousservertest` server. A wrong code fails on both ends. A non-invite payload
  is rejected by `redeem`'s check. An expired code makes `redeem` fail at its deadline
  instead of hanging (this test fails without the fix). The code format and the 3 + 5
  mapping are covered too.
- Reviewed by two independent passes on 2026-11-27 (Go and security; mod and docs).
  Their findings are fixed here or recorded above.
- Live CLI run on 2026-11-26 (macOS, public server, a throwaway profile): a 249-character
  invite arrived intact through a code typed in capitals with spaces, and `offer` exited 0 with `sent`.
  A wrong code failed both sides, and a retry with the burned code timed out.
- Manual (not done yet): the mod on macOS (sharing) + the Azure Windows VM (connecting), code typed
  by hand. This also checks that port 4000 is reachable from the VM.

## Open items

- **Port 4000 from Azure.** If it's blocked, add a `HERDR_REMOTE_RENDEZVOUS` URL override
  and host a rendezvous server on 443. Not built until it's needed.
- LAN discovery for same-network computers, if typing a code still feels like too much.
