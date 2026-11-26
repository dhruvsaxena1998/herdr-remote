package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Secrets are DPAPI-encrypted to the current user and kept under
// %LocalAppData% (os.UserCacheDir), which, unlike %AppData%, never roams.
func secretPath(name string) (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "herdr-tsbridge", name+".dpapi"), nil
}

func loadSecret(name string) ([]byte, bool, error) {
	path, err := secretPath(name)
	if err != nil {
		return nil, false, err
	}
	sealed, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	b, err := dpapi(sealed, false)
	return b, true, err
}

func saveSecret(name string, data []byte) error {
	path, err := secretPath(name)
	if err != nil {
		return err
	}
	sealed, err := dpapi(data, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, sealed, 0o600)
}

func dpapi(in []byte, protect bool) ([]byte, error) {
	if len(in) == 0 {
		return nil, errors.New("dpapi: empty input")
	}
	src := windows.DataBlob{Size: uint32(len(in)), Data: &in[0]}
	var dst windows.DataBlob
	var err error
	if protect {
		err = windows.CryptProtectData(&src, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &dst)
	} else {
		err = windows.CryptUnprotectData(&src, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &dst)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(dst.Data)))
	return append([]byte(nil), unsafe.Slice(dst.Data, dst.Size)...), nil
}
