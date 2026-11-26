package main

// One-time codes: the sharing side hands its invite to whoever types a short
// code like WDJB-MJHT, once, through a magic-wormhole rendezvous
// server and a PAKE keyed by the code. For computers with no shared clipboard.
// See docs/one-time-code.md.

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/psanford/wormhole-william/wormhole"
	"github.com/tailscale/tailcat"
)

const (
	offerTTL      = 10 * time.Minute
	redeemTimeout = time.Minute
	wormholeAppID = "github.com/dhruvsaxena1998/herdr-remote/invite" // keeps our codes apart from the wormhole CLI's
	codeAlphabet  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"               // 32 symbols: no 0/O or 1/I to confuse
)

var (
	rendezvousURL = ""                                       // empty: the library's public magic-wormhole server; tests point it at a local one
	inviteRE      = regexp.MustCompile(`^tc[A-Za-z0-9_-]+$`) // what main.js puts unquoted in the --via line
)

// offer prints a one-time code and delivers addr (the invite) to the first
// computer that redeems it. A wrong attempt uses the code up.
func offer(addr tailcat.Addr, ttl time.Duration) error {
	b := make([]byte, 8)
	rand.Read(b)
	for i := range b {
		b[i] = codeAlphabet[b[i]%32] // 256 is a multiple of 32: no bias
	}
	code := string(b[:4]) + "-" + string(b[4:])
	wc, _ := wormholeCode(code)
	ctx, cancel := context.WithTimeout(context.Background(), ttl)
	defer cancel()
	c := wormhole.Client{AppID: wormholeAppID, RendezvousURL: rendezvousURL}
	// shortcut: we claim the nameplate instead of letting the server allocate one, so two codes
	// out at once with the same first 3 characters (1 in 32,768) break each other; the person gets a new code.
	_, res, err := c.SendText(ctx, string(addr), wormhole.WithCode(wc))
	if err != nil {
		return fmt.Errorf("couldn't get a one-time code (is the internet reachable?): %w", err)
	}
	fmt.Println("one-time code:", code)
	select {
	case r := <-res:
		if r.Error != nil {
			return fmt.Errorf("the code didn't work, and it can't be used again; get a new one (%w)", r.Error)
		}
		fmt.Println("sent")
		return nil
	case <-ctx.Done():
		return errors.New("the code expired; get a new one")
	}
}

// wormholeCode turns a one-time code (any case, dash or space optional) into
// the wormhole code: the first 3 characters, read as a base-32 number, are the
// nameplate, which the rendezvous server lists publicly; the last 5 (25 bits)
// are the PAKE secret.
func wormholeCode(code string) (string, error) {
	code = strings.NewReplacer("-", "", " ", "").Replace(strings.ToUpper(strings.TrimSpace(code)))
	if len(code) != 8 || strings.Trim(code, codeAlphabet) != "" {
		return "", errors.New("that isn't a one-time code; it looks like WDJB-MJHT")
	}
	n := 0
	for _, c := range code[:3] {
		n = n*32 + strings.IndexRune(codeAlphabet, c)
	}
	return strconv.Itoa(n) + "-" + code[3:], nil
}

// redeem fetches the invite for a one-time code.
func redeem(code string, timeout time.Duration) (tailcat.Addr, error) {
	code, err := wormholeCode(code)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c := wormhole.Client{AppID: wormholeAppID, RendezvousURL: rendezvousURL}
	// The library ignores ctx partway through Receive (a sender that went quiet,
	// such as an expired code, hangs it forever), so the deadline is enforced here.
	type received struct {
		msg *wormhole.IncomingMessage
		err error
	}
	got := make(chan received, 1)
	go func() {
		m, err := c.Receive(ctx, code)
		got <- received{m, err}
	}()
	var msg *wormhole.IncomingMessage
	select {
	case g := <-got:
		msg, err = g.msg, g.err
	case <-ctx.Done():
		err = ctx.Err()
	}
	if err != nil {
		return "", fmt.Errorf("couldn't get the invite with that code (%w); a code works once, so if it was mistyped, get a new one on the other computer", err)
	}
	if msg.Type != wormhole.TransferText {
		msg.Reject()
		return "", errors.New("the other side sent something that isn't an invite")
	}
	// Untrusted: require exactly an invite. (The library has already read the whole
	// message, bounded by its websocket limit; this cap only bounds what we copy.)
	b, err := io.ReadAll(io.LimitReader(msg, 4096))
	if err != nil {
		return "", err
	}
	addr := tailcat.Addr(strings.TrimSpace(string(b)))
	if !inviteRE.MatchString(string(addr)) {
		return "", errors.New("the other side sent something that isn't an invite")
	}
	if _, err := tailcat.ParseAddr(addr); err != nil {
		return "", fmt.Errorf("the other side sent something that isn't an invite: %w", err)
	}
	return addr, nil
}
