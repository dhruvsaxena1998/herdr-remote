package main

import (
	"bufio"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/psanford/wormhole-william/rendezvous/rendezvousservertest"
	"github.com/tailscale/tailcat"
)

// startOffer runs offer against a local rendezvous server and returns its code and result.
func startOffer(t *testing.T, addr tailcat.Addr) (string, chan error) {
	rs := rendezvousservertest.NewServer()
	t.Cleanup(rs.Close)
	rendezvousURL = rs.WebSocketURL()
	t.Cleanup(func() { rendezvousURL = "" })

	r, w, _ := os.Pipe()
	stdout := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = stdout })
	done := make(chan error, 1)
	go func() { done <- offer(addr, 10*time.Second) }()
	line, err := bufio.NewReader(r).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	code, ok := strings.CutPrefix(strings.TrimSpace(line), "one-time code: ")
	if !ok {
		t.Fatalf("offer printed %q", line)
	}
	return code, done
}

func TestOneTimeCodeDeliversInvite(t *testing.T) {
	want := tailcat.NewPrivateKey().Public.Addr()
	code, done := startOffer(t, want)
	// Typed by hand: any case, dash or space optional.
	got, err := redeem(strings.ToLower(strings.ReplaceAll(code, "-", " ")), 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if err := <-done; err != nil {
		t.Fatalf("offer: %v", err)
	}
}

// A code whose sender went away fails at the deadline instead of hanging.
func TestRedeemExpiredCodeTimesOut(t *testing.T) {
	rs := rendezvousservertest.NewServer()
	t.Cleanup(rs.Close)
	rendezvousURL = rs.WebSocketURL()
	t.Cleanup(func() { rendezvousURL = "" })
	r, w, _ := os.Pipe()
	stdout := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = stdout })
	done := make(chan error, 1)
	go func() { done <- offer(tailcat.NewPrivateKey().Public.Addr(), time.Second) }()
	line, _ := bufio.NewReader(r).ReadString('\n')
	code := strings.TrimPrefix(strings.TrimSpace(line), "one-time code: ")
	<-done // expired; its message is still in the mailbox

	start := time.Now()
	finished := make(chan error, 1)
	go func() { _, err := redeem(code, 2*time.Second); finished <- err }()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("expired code redeemed")
		}
		if d := time.Since(start); d > 4*time.Second {
			t.Fatalf("took %s", d)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("redeem ignored its timeout")
	}
}

// One wrong attempt uses the code up on both sides.
func TestWrongCodeBurnsIt(t *testing.T) {
	code, done := startOffer(t, tailcat.NewPrivateKey().Public.Addr())
	wrong := code[:8] + string(codeAlphabet[(strings.IndexByte(codeAlphabet, code[8])+1)%32]) // same nameplate, wrong secret
	if _, err := redeem(wrong, 10*time.Second); err == nil {
		t.Fatal("wrong code accepted")
	}
	if err := <-done; err == nil {
		t.Fatal("offer succeeded after a wrong attempt")
	}
}

// What arrives is untrusted: anything but an invite is refused.
func TestRedeemRefusesNonInvite(t *testing.T) {
	for _, payload := range []string{"tc$(rm -rf ~)", "tcAAAA", "hello"} {
		code, done := startOffer(t, tailcat.Addr(payload))
		if a, err := redeem(code, 10*time.Second); err == nil {
			t.Fatalf("%q accepted as %q", payload, a)
		}
		<-done // its "sent" must not land in the next iteration's stdout
	}
	if _, err := redeem("not a code", time.Second); err == nil {
		t.Fatal("malformed code accepted")
	}
}

func TestCodeFormat(t *testing.T) {
	code, _ := startOffer(t, tailcat.NewPrivateKey().Public.Addr())
	if !regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$`).MatchString(code) {
		t.Fatalf("code %q isn't XXXX-XXXX from the alphabet", code)
	}
	for in, want := range map[string]string{
		"AAAA-AAAA": "0-AAAAA",
		"9999 9999": "32767-99999", // highest nameplate
		"baaaWDJB":  "1024-AWDJB",  // B is 1: 1*32^2
	} {
		if got, err := wormholeCode(in); err != nil || got != want {
			t.Errorf("wormholeCode(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"WDJB-MJH", "WDJB-MJHTX", "WDJ0-MJHT", "WDJI-MJHT", "7-crossword-apple"} {
		if _, err := wormholeCode(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}
