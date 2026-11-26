package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"runtime"
	"testing"

	"github.com/tailscale/tailcat"
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
