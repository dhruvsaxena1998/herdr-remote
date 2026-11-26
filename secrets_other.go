//go:build !darwin && !windows

package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// shortcut: plain owner-only (0600) files; use a keyring if this side ever runs on Linux in production.
func secretPath(name string) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "herdr-remote", name), nil
}

func loadSecret(name string) ([]byte, bool, error) {
	path, err := secretPath(name)
	if err != nil {
		return nil, false, err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	return b, err == nil, err
}

func saveSecret(name string, data []byte) error {
	path, err := secretPath(name)
	if err != nil {
		return err
	}
	return writeSecretFile(path, data)
}
