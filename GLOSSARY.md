# herdr-remote

Lets one computer use another computer's herdr-core over Tailcat instead of SSH, after a person on the sharing side approves it.

## Language

**Sharing side**:
The computer whose herdr-core is being used; it runs serve.
_Avoid_: host, VM, remote

**Connecting side**:
The computer that uses the sharing side's terminals through hc.
_Avoid_: Mac, local, controller

**Invite**:
The sharing side's long-lived, secret `tc…` address; a connecting side needs it to reach the sharing side at all.
_Avoid_: address (in user-facing text), token, link

**One-time code**:
Eight characters like `WDJB-MJHT` that deliver the invite to one computer, once, within 10 minutes; for computers with no shared clipboard.
_Avoid_: PIN, short code, wormhole code (and don't confuse it with the pairing code)

**Pairing code**:
A short fingerprint of a connecting side's key, shown on both computers so a person can tell a request is their own computer's.
_Avoid_: PIN, verification code

**Pending request**:
A connecting side that has announced itself but that nobody has allowed or refused yet.
_Avoid_: invite, join request

**Approved client**:
A connecting side's key that the sharing side admits, either allowed by a person or given with `-allow`.
_Avoid_: trusted device, allowlisted machine

**Gate**:
The sharing side's admission authority: it decides who may connect, how many sessions may run, and ends the sessions of a client whose approval is revoked.
_Avoid_: firewall, auth

**Profile**:
A named, separate set of keys and client lists on one computer.
_Avoid_: account, workspace
