package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

// testSecretName returns a throwaway secret name, removed from the store after the test.
func testSecretName(t *testing.T) string {
	if runtime.GOOS != "darwin" {
		t.Skip("secret store test runs against the macOS Keychain")
	}
	b := make([]byte, 6)
	rand.Read(b)
	name := "test-" + hex.EncodeToString(b)
	t.Cleanup(func() {
		exec.Command("/usr/bin/security", "delete-generic-password", "-s", "herdr-tsbridge", "-a", name).Run()
	})
	return name
}

// The client key must survive restarts, or the server's -allow list stops matching.
func TestClientKeyPersists(t *testing.T) {
	name := testSecretName(t)
	a, err := loadClientKey(name)
	if err != nil {
		t.Fatal(err)
	}
	b, err := loadClientKey(name)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Equal(b) {
		t.Fatal("key changed between loads")
	}
}

// A damaged identity must stop serve, not silently mint a new address.
func TestIncompleteIdentityRefused(t *testing.T) {
	name := testSecretName(t)
	if err := saveSecret(name, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadIdentity(name); err == nil {
		t.Fatal("empty identity accepted")
	}

	id := *tailcat.NewPrivateKey()
	b, _ := json.Marshal(id) // no relay region yet: still incomplete
	saveSecret(name, b)
	if _, _, err := loadIdentity(name); err == nil {
		t.Fatal("identity without a relay region accepted")
	}
}

func TestWriteSecretFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "s")
	for _, want := range []string{"first", "second"} {
		if err := writeSecretFile(path, []byte(want)); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("read %q, %v; want %q", got, err, want)
		}
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode %v, want 0600", fi.Mode().Perm())
		}
	}
	if ents, _ := os.ReadDir(filepath.Dir(path)); len(ents) != 1 {
		t.Fatalf("leftover temp files: %v", ents)
	}
}

func TestPairCode(t *testing.T) {
	k := key.NewNode().Public()
	c := pairCode(k)
	if c != pairCode(k) || !regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$`).MatchString(c) {
		t.Fatalf("pairCode = %q", c)
	}
	if c == pairCode(key.NewNode().Public()) {
		t.Fatal("two keys, same code (1 in a billion; rerun)")
	}
}

func TestGateApproveRevoke(t *testing.T) {
	dir := t.TempDir()
	clients, pending := filepath.Join(dir, "c.json"), filepath.Join(dir, "p.json")
	g := newGate(clients, pending)
	var dropped []key.NodePublic
	disc := func(k key.NodePublic) bool { dropped = append(dropped, k); return true }
	reload := func() {
		t.Helper()
		g.stamp = "force" // mtime can repeat within a test
		if err := g.reload(disc); err != nil {
			t.Fatal(err)
		}
	}
	reload()
	a, b := key.NewNode().Public(), key.NewNode().Public()

	// Unknown: refused, and listed as asking.
	if g.admit(a) {
		t.Fatal("unknown key admitted")
	}
	g.flushPending()
	var p []clientEntry
	if err := readJSON(pending, &p); err != nil || len(p) != 1 || p[0].Key != a.String() || p[0].Code != pairCode(a) {
		t.Fatalf("pending = %+v, %v", p, err)
	}

	// Approved: admitted, no longer pending.
	if err := editClients(clients, "allow", a); err != nil {
		t.Fatal(err)
	}
	reload()
	g.flushPending()
	if !g.admit(a) {
		t.Fatal("approved key refused")
	}
	if err := readJSON(pending, &p); err != nil || len(p) != 0 {
		t.Fatalf("pending after approve = %+v, %v", p, err)
	}

	// Denied: refused and never listed.
	editClients(clients, "deny", b)
	reload()
	if g.admit(b) || len(g.pending) != 0 {
		t.Fatal("denied key admitted or listed")
	}

	// Revoked: refused again and disconnected.
	editClients(clients, "revoke", a)
	reload()
	if g.admit(a) || len(dropped) != 1 || dropped[0] != a {
		t.Fatalf("after revoke: admitted or dropped=%v", dropped)
	}
	var c clientsFile
	readJSON(clients, &c)
	if len(c.Allow) != 0 || len(c.Deny) != 1 {
		t.Fatalf("clients file = %+v", c)
	}
}
