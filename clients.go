package main

// Pairing: a client that isn't approved yet still announces itself to serve,
// which records it as a request in <profile>-pending.json. A person approves
// or refuses it (`allow` / `deny`), which edits <profile>-clients.json, and a
// running serve picks that up within a second. `revoke` removes an approved
// client and serve drops its sessions. Admission still needs the invite
// address too: its pre-shared key is checked in the WireGuard handshake.

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
)

const (
	maxPending = 10               // requests shown at once; more are ignored until some expire
	pendingTTL = 30 * time.Second // a waiting client retries about once a second; silence means it gave up
)

type clientEntry struct {
	Key   string    `json:"key"`
	Code  string    `json:"code"`
	Since time.Time `json:"since"`
}

type clientsFile struct {
	Allow []clientEntry `json:"allow"`
	Deny  []clientEntry `json:"deny"`
}

// statePath is where serve's client lists live: next to the secrets
// (%LocalAppData% on Windows, the user config dir elsewhere). Not secret: public keys only.
func statePath(profile, kind string) (string, error) {
	dir, err := os.UserConfigDir()
	if runtime.GOOS == "windows" {
		dir, err = os.UserCacheDir()
	}
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "herdr-remote", profile+"-"+kind+".json"), nil
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeSecretFile(path, append(b, '\n'))
}

func parseKey(s string) (key.NodePublic, error) {
	var k key.NodePublic
	return k, k.UnmarshalText([]byte(strings.TrimSpace(s)))
}

// pairCode is a short fingerprint of a client key that both computers show,
// so a person approving a request can tell it's their own computer asking.
func pairCode(k key.NodePublic) string {
	t, _ := k.MarshalText()
	h := sha256.Sum256(t)
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32: no I, L, O, U
	v := binary.BigEndian.Uint64(h[:8])
	var b [6]byte
	for i := range b {
		b[i] = alphabet[v>>(64-5*(i+1))&31]
	}
	return string(b[:3]) + "-" + string(b[3:])
}

// editClients applies one change from the CLI: "allow", "deny" or "revoke".
func editClients(path, op string, k key.NodePublic) error {
	var c clientsFile
	if err := readJSON(path, &c); err != nil {
		return err
	}
	ks := k.String()
	drop := func(l []clientEntry) (out []clientEntry) {
		for _, e := range l {
			if e.Key != ks {
				out = append(out, e)
			}
		}
		return out
	}
	c.Allow, c.Deny = drop(c.Allow), drop(c.Deny)
	e := clientEntry{Key: ks, Code: pairCode(k), Since: time.Now().UTC()}
	switch op {
	case "allow":
		c.Allow = append(c.Allow, e)
	case "deny":
		c.Deny = append(c.Deny, e)
	}
	return writeJSON(path, c)
}

type pendingReq struct{ since, seen time.Time }

// gate decides admission for serve: keys from -allow, plus the clients file,
// re-read when it changes. It also owns the open connections: it caps how
// many run at once and closes a revoked client's sessions.
type gate struct {
	static                   tailcat.KeySet
	nStatic                  int
	clientsPath, pendingPath string
	slots                    chan struct{}

	mu      sync.Mutex
	allow   map[key.NodePublic]bool
	deny    map[key.NodePublic]bool
	pending map[key.NodePublic]*pendingReq
	logged  map[key.NodePublic]bool
	dirty   bool // pending changed since the last write
	stamp   string
	conns   map[key.NodePublic]map[net.Conn]bool
}

// newGate checks serve's -allow list (comma-separated nodekeys) and -max-conns.
func newGate(clientsPath, pendingPath, allowList string, maxConns int) (*gate, error) {
	if maxConns < 1 {
		return nil, errors.New("-max-conns must be at least 1")
	}
	g := &gate{
		clientsPath: clientsPath, pendingPath: pendingPath, slots: make(chan struct{}, maxConns),
		allow: map[key.NodePublic]bool{}, deny: map[key.NodePublic]bool{},
		pending: map[key.NodePublic]*pendingReq{}, logged: map[key.NodePublic]bool{},
		conns: map[key.NodePublic]map[net.Conn]bool{}, dirty: true, stamp: "unread",
	}
	for _, s := range strings.Split(allowList, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		var k key.NodePublic
		if err := k.UnmarshalText([]byte(s)); err != nil {
			return nil, fmt.Errorf("-allow %q: %w", s, err)
		}
		if !g.static.Contains(k) {
			g.static.Add(k)
			g.nStatic++
		}
	}
	if strings.TrimSpace(allowList) != "" && g.nStatic == 0 {
		return nil, errors.New("-allow has no keys in it")
	}
	return g, nil
}

func (g *gate) admit(k key.NodePublic) bool {
	if g.static.Contains(k) {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.allow[k] {
		return true
	}
	if g.deny[k] {
		return false
	}
	now := time.Now()
	if p := g.pending[k]; p != nil {
		p.seen = now
		return false
	}
	if len(g.pending) >= maxPending {
		return false
	}
	g.pending[k] = &pendingReq{since: now, seen: now}
	g.dirty = true
	if !g.logged[k] && len(g.logged) < maxRefusalLogs { // log-flood guard
		g.logged[k] = true
		log.Printf("asking to connect: %s (pairing code %s)", k, pairCode(k))
	}
	return false
}

// reload re-reads the clients file if it changed, and drops sessions of
// clients that are no longer allowed. A bad file keeps the previous lists.
func (g *gate) reload(disconnect func(key.NodePublic) bool) error {
	stamp := "missing"
	if fi, err := os.Stat(g.clientsPath); err == nil {
		stamp = fmt.Sprint(fi.ModTime().UnixNano(), "/", fi.Size())
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	g.mu.Lock()
	same := stamp == g.stamp
	g.mu.Unlock()
	if same {
		return nil
	}
	var c clientsFile
	if err := readJSON(g.clientsPath, &c); err != nil {
		return err
	}
	allow, deny := map[key.NodePublic]bool{}, map[key.NodePublic]bool{}
	for _, e := range c.Allow {
		if k, err := parseKey(e.Key); err == nil {
			allow[k] = true
		}
	}
	for _, e := range c.Deny {
		if k, err := parseKey(e.Key); err == nil {
			deny[k] = true
			delete(allow, k)
		}
	}
	g.mu.Lock()
	var gone []key.NodePublic
	var drop []net.Conn
	for k := range g.allow {
		if !allow[k] && !g.static.Contains(k) {
			gone = append(gone, k)
			for c := range g.conns[k] {
				drop = append(drop, c)
			}
		}
	}
	for k := range allow {
		if !g.allow[k] {
			log.Printf("approved %s (pairing code %s)", k, pairCode(k))
		}
	}
	for k := range g.pending {
		if allow[k] || deny[k] {
			delete(g.pending, k)
			g.dirty = true
		}
	}
	g.allow, g.deny, g.stamp = allow, deny, stamp
	g.mu.Unlock()
	// The key is already rejected (above). Close its sessions while traffic
	// still flows, so the client sees them end, then disconnect it.
	for _, c := range drop {
		c.Close()
	}
	if len(drop) > 0 {
		time.Sleep(500 * time.Millisecond)
	}
	for _, k := range gone {
		disconnect(k)
		log.Printf("revoked %s (pairing code %s)", k, pairCode(k))
	}
	return nil
}

// flushPending forgets requests whose client stopped retrying and writes the
// list for `clients` to read. Called from one goroutine only.
func (g *gate) flushPending() {
	g.mu.Lock()
	for k, p := range g.pending {
		if time.Since(p.seen) > pendingTTL {
			delete(g.pending, k)
			g.dirty = true
		}
	}
	if !g.dirty {
		g.mu.Unlock()
		return
	}
	g.dirty = false
	list := []clientEntry{}
	for k, p := range g.pending {
		list = append(list, clientEntry{Key: k.String(), Code: pairCode(k), Since: p.since.UTC()})
	}
	g.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].Since.Before(list[j].Since) })
	if err := writeJSON(g.pendingPath, list); err != nil {
		log.Printf("writing %s: %v", g.pendingPath, err)
	}
}

// serveConn runs one admitted connection, if a slot is free, and tracks it
// so that revoking peer closes it.
func (g *gate) serveConn(peer key.NodePublic, c net.Conn, run func(net.Conn)) {
	select {
	case g.slots <- struct{}{}:
	default:
		log.Printf("rejected connection from %s: %d already open", peer, cap(g.slots))
		c.Close()
		return
	}
	defer func() { <-g.slots }()
	g.track(peer, c, true)
	defer g.track(peer, c, false)
	start := time.Now()
	log.Printf("open %s", peer)
	run(c)
	log.Printf("close %s after %s", peer, time.Since(start).Round(time.Second))
}

// run keeps the lists current, once a second, until ctx ends. Call reload
// once before the server starts, so approved clients are known from the first handshake.
func (g *gate) run(ctx context.Context, disconnect func(key.NodePublic) bool) {
	defer os.Remove(g.pendingPath) // nobody is asking once serve is gone
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := g.reload(disconnect); err != nil {
				log.Printf("reading %s: %v (keeping the previous list)", g.clientsPath, err)
			}
			g.flushPending()
		}
	}
}

func (g *gate) track(k key.NodePublic, c net.Conn, open bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if open {
		if g.conns[k] == nil {
			g.conns[k] = map[net.Conn]bool{}
		}
		g.conns[k][c] = true
		return
	}
	delete(g.conns[k], c)
	if len(g.conns[k]) == 0 {
		delete(g.conns, k)
	}
}
