package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// Secrets live in the login Keychain. Values go to `security` on stdin
// (interactive mode), never argv, so they don't show up in ps.
const keychainService = "herdr-remote"

func loadSecret(name string) ([]byte, bool, error) {
	out, err := exec.Command("/usr/bin/security", "find-generic-password",
		"-s", keychainService, "-a", name, "-w").Output()
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 44 { // errSecItemNotFound
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("keychain read %s: %w", name, err)
	}
	b, err := hex.DecodeString(strings.TrimSpace(string(out)))
	return b, true, err
}

func saveSecret(name string, data []byte) error {
	cmd := exec.Command("/usr/bin/security", "-i")
	// name is ours (alphanumeric); data is hex, so neither needs quoting.
	cmd.Stdin = strings.NewReader(fmt.Sprintf("add-generic-password -U -s %s -a %s -w %s\n",
		keychainService, name, hex.EncodeToString(data)))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil || stderr.Len() > 0 {
		return fmt.Errorf("keychain write %s: %v %s", name, err, stderr.String())
	}
	return nil
}
