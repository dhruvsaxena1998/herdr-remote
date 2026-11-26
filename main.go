// herdr-remote lets hc (herdr-core) reach another machine, such as a Windows
// VM, over Tailcat (Tailscale's data plane, no account) instead of SSH. The
// serving side runs `herdr-core connect` for each allowlisted client; the
// client side is a byte pipe that hc uses as its `machine add --via` transport.
// See SECURITY.md before deploying.
//
//	Mac: herdr-remote key                          (prints this machine's nodekey)
//	VM:  herdr-remote serve -allow nodekey:...     (prints a stable tc… address)
//	Mac: hc machine add --via 'herdr-remote pipe tc…' --name winvm
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"
)

const (
	port           = 7100
	maxRefusalLogs = 100 // distinct refused keys logged before going quiet (log-flood guard)
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) < 2 {
		usage(2)
	}
	switch os.Args[1] {
	case "-h", "-help", "--help", "help":
		usage(0)
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	allow := fs.String("allow", "", "comma-separated client nodekeys allowed to connect (serve)")
	herdr := fs.String("herdr", "herdr-core", "herdr-core binary to run (serve)")
	logFile := fs.String("log", "", "append the audit log to this file as well as stderr (serve)")
	maxConns := fs.Int("max-conns", 16, "most connections served at once (serve)")
	timeout := fs.Duration("timeout", 5*time.Minute, "how long to wait for approval (wait)")
	fs.Parse(os.Args[2:])

	// HERDR_REMOTE_PROFILE keeps separate identities side by side, e.g. one per client site.
	profile := os.Getenv("HERDR_REMOTE_PROFILE")
	if profile == "" {
		profile = "default"
	}
	if !regexp.MustCompile(`^[a-z0-9-]{1,32}$`).MatchString(profile) {
		log.Fatal("HERDR_REMOTE_PROFILE must be 1-32 of a-z, 0-9, -")
	}

	var err error
	switch os.Args[1] {
	case "key":
		k, err := loadClientKey(profile + "-client")
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(k.Public().String())
		return
	case "code":
		k, err := loadClientKey(profile + "-client")
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(pairCode(k.Public()))
		return
	case "wait":
		if fs.NArg() < 1 {
			usage(2)
		}
		err = wait(profile+"-client", fs.Arg(0), *timeout)
	case "clients":
		err = printClients(profile)
	case "offer":
		var addr tailcat.Addr
		if addr, err = savedAddr(profile + "-server"); err == nil {
			err = offer(addr, offerTTL)
		}
	case "redeem":
		if fs.NArg() < 1 {
			usage(2)
		}
		var addr tailcat.Addr
		if addr, err = redeem(strings.Join(fs.Args(), " "), redeemTimeout); err == nil {
			fmt.Println(addr)
		}
	case "allow", "deny", "revoke":
		if fs.NArg() < 1 {
			usage(2)
		}
		var k key.NodePublic
		var path string
		if k, err = parseKey(fs.Arg(0)); err == nil {
			if path, err = statePath(profile, "clients"); err == nil {
				err = editClients(path, os.Args[1], k)
			}
		}
	case "addr":
		var addr tailcat.Addr
		if addr, err = savedAddr(profile + "-server"); err == nil {
			fmt.Println(addr)
		}
	case "serve":
		err = serve(profile, *allow, *herdr, *logFile, *maxConns)
	case "pipe":
		// shortcut: hc appends the shell line it wants run remotely; the server
		// always runs `herdr-core connect`, so hc's --session is not passed through.
		if fs.NArg() < 1 {
			usage(2)
		}
		if err = pipe(profile+"-client", tailcat.Addr(fs.Arg(0))); err == nil {
			return
		}
	default:
		usage(2)
	}
	if err != nil {
		log.Fatal(err)
	}
}

func usage(code int) {
	fmt.Fprintln(os.Stderr, `usage:
client side:
  herdr-remote key                     print this machine's client nodekey
  herdr-remote code                    print its short pairing code (shown on the server when it asks)
  herdr-remote wait [-timeout 5m] ADDRESS
                                         ask the server to connect; exit 0 once it's approved
  herdr-remote redeem CODE             print the invite sent with a one-time code
  herdr-remote pipe ADDRESS [ignored...]
                                         stdin/stdout to the server (hc --via)
server side:
  herdr-remote serve [-allow nodekey:...[,...]] [-herdr PATH] [-log FILE] [-max-conns N]
                                         serve herdr-core; unknown clients wait for approval
  herdr-remote addr                    print the saved server address (the invite; secret)
  herdr-remote offer                   print a one-time code that delivers the invite once (10 min)
  herdr-remote clients                 JSON: clients asking to connect, and approved ones
  herdr-remote allow|deny|revoke KEY   approve, refuse, or remove a client (serve applies it live)

HERDR_REMOTE_PROFILE=name keeps a separate set of keys (default: "default").`)
	os.Exit(code)
}

func serve(profile, allowList, herdr, logFile string, maxConns int) error {
	secretName := profile + "-server"
	if logFile != "" {
		f, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		log.SetOutput(io.MultiWriter(f, os.Stderr)) // file first: MultiWriter stops at the first failing writer, and stderr dies with the terminal
	}
	clientsPath, err := statePath(profile, "clients")
	if err != nil {
		return err
	}
	pendingPath, err := statePath(profile, "pending")
	if err != nil {
		return err
	}
	g, err := newGate(clientsPath, pendingPath, allowList, maxConns)
	if err != nil {
		return err
	}

	// Resolve once, so a later PATH change can't swap the program clients reach.
	herdrPath, err := exec.LookPath(herdr)
	if err == nil {
		herdrPath, err = filepath.Abs(herdrPath)
	}
	if err != nil {
		return fmt.Errorf("finding %s: %w; install herdr-core or pass -herdr /absolute/path", herdr, err)
	}

	id, saved, err := loadIdentity(secretName)
	if err != nil {
		return err
	}
	if !saved {
		id = *tailcat.NewPrivateKey()
	}

	s := &tailcat.Server{
		Key:            id.Private,
		PresharedKey:   id.Public.PresharedKey,
		ServedTCPPorts: []filter.PortRange{{First: port, Last: port}},
		Logf: func(format string, args ...any) {
			if strings.HasPrefix(format, "exec ") { // herdr-core failures; the rest is debug noise
				log.Printf("tailcat: "+format, args...)
			}
		},
		AllowClient: g.admit,
	}
	if err := g.reload(s.DisconnectClient); err != nil {
		return fmt.Errorf("reading %s: %w", clientsPath, err)
	}
	if saved {
		s.Region = id.Public.Region[0] // pinned: restarts don't depend on fetching tailcat.dev's relay map
	}

	run := s.ExecConnHandler([]string{herdrPath, "connect"})
	handler := func(c net.Conn) {
		peer, _ := s.PeerKey(c.RemoteAddr())
		g.serveConn(peer, c, run)
	}
	s.OnTCP = func(p uint16) func(net.Conn) {
		if p == port {
			return handler
		}
		return nil
	}

	if !saved {
		log.Printf("starting; the first run fetches the relay map from tailcat.dev")
	}
	if err := s.Start(); err != nil {
		return err
	}
	defer s.Close()

	addr := s.TailcatAddr()
	if !saved {
		if id.Public, err = tailcat.ParseAddr(addr); err != nil {
			return err
		}
		b, err := json.Marshal(id)
		if err != nil {
			return err
		}
		if err := saveSecret(secretName, b); err != nil {
			return err
		}
	}
	log.Printf("serving %s connect; %d client(s) from -allow, approved ones from %s", herdrPath, g.nStatic, clientsPath)
	fmt.Println("address (secret, share only with the client machine):", addr)
	// Return on Ctrl-C / hc kill (SIGHUP, then SIGTERM) so the deferred closes run and the log records the stop.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGHUP, syscall.SIGTERM)
	defer stop()
	g.run(ctx, s.DisconnectClient)
	log.Printf("stopping")
	return nil
}

// printClients prints, as JSON, who is asking to connect (while serve runs) and who is approved.
func printClients(profile string) error {
	var out struct {
		Pending []clientEntry `json:"pending"`
		Allow   []clientEntry `json:"allow"`
	}
	pendingPath, err := statePath(profile, "pending")
	if err != nil {
		return err
	}
	clientsPath, err := statePath(profile, "clients")
	if err != nil {
		return err
	}
	var c clientsFile
	if err := readJSON(pendingPath, &out.Pending); err != nil {
		return err
	}
	if err := readJSON(clientsPath, &c); err != nil {
		return err
	}
	out.Allow = c.Allow
	if out.Pending == nil {
		out.Pending = []clientEntry{}
	}
	if out.Allow == nil {
		out.Allow = []clientEntry{}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}

// wait asks the server to admit this client until it does (a person approved
// it there) or the timeout passes. Each ping announces us, which is what puts
// the request on the server's screen.
func wait(secretName, address string, timeout time.Duration) error {
	if _, err := tailcat.ParseAddr(tailcat.Addr(address)); err != nil {
		return fmt.Errorf("that isn't an invite address: %w", err)
	}
	k, err := loadClientKey(secretName)
	if err != nil {
		return err
	}
	c := &tailcat.Client{Server: tailcat.Addr(address), Key: k, Logf: func(string, ...any) {}}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		if _, err := c.Ping(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("no approval within %s: is sharing on there, and was %s allowed?", timeout, pairCode(k.Public()))
		case <-time.After(time.Second):
		}
	}
}

// loadIdentity returns the saved server identity; a damaged one is an error, never silently replaced.
func loadIdentity(name string) (id tailcat.PrivateKey, saved bool, err error) {
	b, saved, err := loadSecret(name)
	if err != nil || !saved {
		return id, saved, err
	}
	if err := json.Unmarshal(b, &id); err != nil {
		return id, true, fmt.Errorf("stored server identity %q: %w", name, err)
	}
	if id.Private.IsZero() || len(id.Public.Region) == 0 {
		return id, true, fmt.Errorf("stored server identity %q is incomplete; refusing to start", name)
	}
	return id, true, nil
}

// savedAddr is the invite of the saved server identity.
func savedAddr(name string) (tailcat.Addr, error) {
	id, saved, err := loadIdentity(name)
	if err != nil {
		return "", err
	}
	if !saved {
		return "", errors.New("no server identity yet: run serve once")
	}
	return id.Public.Addr(), nil
}

// pipe connects stdin/stdout to the server's herdr-core, until the server side ends.
func pipe(secretName string, addr tailcat.Addr) error {
	k, err := loadClientKey(secretName)
	if err != nil {
		return err
	}
	c := &tailcat.Client{Server: addr, Key: k, Logf: func(string, ...any) {}}
	defer c.Close()
	ctx := context.Background()
	conn, err := c.DialTCPPort(ctx, port)
	if err != nil {
		return fmt.Errorf("reaching server (is %s allowed?): %w", k.Public(), err)
	}
	go func() {
		io.Copy(conn, os.Stdin)
		if cw, ok := conn.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		}
	}()
	_, err = io.Copy(os.Stdout, conn)
	conn.Close()
	c.DrainTCP(ctx) // the TCP stack is in-process; let the FIN go out before exiting
	return err
}

// loadClientKey returns the persistent client identity, creating it on first use.
func loadClientKey(name string) (key.NodePrivate, error) {
	var k key.NodePrivate
	b, ok, err := loadSecret(name)
	if err != nil {
		return k, err
	}
	if ok {
		return k, k.UnmarshalText(b)
	}
	k = key.NewNode()
	txt, err := k.MarshalText()
	if err != nil {
		return k, err
	}
	if err := saveSecret(name, txt); err != nil {
		return k, err
	}
	// Read back: if another process created a key at the same moment, theirs may be the one stored.
	// shortcut: narrows the first-run race but doesn't close it; add a lock file if two first-ever pipes ever collide in practice.
	if b, _, err = loadSecret(name); err != nil {
		return k, err
	}
	return k, k.UnmarshalText(b)
}

// writeSecretFile replaces path in one step (temp file + rename), so a crash
// never leaves a truncated secret, and forces owner-only permissions.
func writeSecretFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // no-op once renamed
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
