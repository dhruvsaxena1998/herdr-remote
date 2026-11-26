// herdr-tsbridge lets hc (herdr-core) reach another machine, such as a Windows
// VM, over Tailcat (Tailscale's data plane, no account) instead of SSH. The
// serving side runs `herdr-core connect` for each allowlisted client; the
// client side is a byte pipe that hc uses as its `machine add --via` transport.
// See SECURITY.md before deploying.
//
//	Mac: herdr-tsbridge key                          (prints this machine's nodekey)
//	VM:  herdr-tsbridge serve -allow nodekey:...     (prints a stable tc… address)
//	Mac: hc machine add --via 'herdr-tsbridge pipe tc…' --name winvm
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
	"path/filepath"
	"regexp"
	"strings"
	"sync"
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
		usage()
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	allow := fs.String("allow", "", "comma-separated client nodekeys allowed to connect (serve)")
	herdr := fs.String("herdr", "herdr-core", "herdr-core binary to run (serve)")
	logFile := fs.String("log", "", "append the audit log to this file as well as stderr (serve)")
	maxConns := fs.Int("max-conns", 16, "most connections served at once (serve)")
	fs.Parse(os.Args[2:])

	// HERDR_TSBRIDGE_PROFILE keeps separate identities side by side, e.g. one per client site.
	profile := os.Getenv("HERDR_TSBRIDGE_PROFILE")
	if profile == "" {
		profile = "default"
	}
	if !regexp.MustCompile(`^[a-z0-9-]{1,32}$`).MatchString(profile) {
		log.Fatal("HERDR_TSBRIDGE_PROFILE must be 1-32 of a-z, 0-9, -")
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
	case "addr":
		id, saved, err := loadIdentity(profile + "-server")
		if err != nil {
			log.Fatal(err)
		}
		if !saved {
			log.Fatal("no server identity yet: run serve once")
		}
		fmt.Println(id.Public.Addr())
		return
	case "serve":
		err = serve(profile+"-server", *allow, *herdr, *logFile, *maxConns)
	case "pipe":
		// shortcut: hc appends the shell line it wants run remotely; the server
		// always runs `herdr-core connect`, so hc's --session is not passed through.
		if fs.NArg() < 1 {
			usage()
		}
		if err = pipe(profile+"-client", tailcat.Addr(fs.Arg(0))); err == nil {
			return
		}
	default:
		usage()
	}
	log.Fatal(err)
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  herdr-tsbridge key                                     print this machine's client nodekey
  herdr-tsbridge addr                                    print the saved server address (secret)
  herdr-tsbridge addr                                    print the saved server address (secret)
  herdr-tsbridge serve -allow nodekey:...[,...] [-herdr PATH] [-log FILE] [-max-conns N]
  herdr-tsbridge pipe ADDRESS [ignored...]               stdin/stdout to the server (hc --via)`)
	os.Exit(2)
}

func serve(secretName, allowList, herdr, logFile string, maxConns int) error {
	if logFile != "" {
		f, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		defer f.Close()
		log.SetOutput(io.MultiWriter(os.Stderr, f))
	}
	if allowList == "" {
		return errors.New("serve needs -allow nodekey:... (run `herdr-tsbridge key` on the client)")
	}
	var allow tailcat.KeySet
	for _, s := range strings.Split(allowList, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		var k key.NodePublic
		if err := k.UnmarshalText([]byte(s)); err != nil {
			return fmt.Errorf("-allow %q: %w", s, err)
		}
		allow.Add(k)
	}
	if maxConns < 1 {
		return errors.New("-max-conns must be at least 1")
	}

	// Resolve once, so a later PATH change can't swap the program clients reach.
	herdrPath, err := exec.LookPath(herdr)
	if err == nil {
		herdrPath, err = filepath.Abs(herdrPath)
	}
	if err != nil {
		return fmt.Errorf("finding %s: %w", herdr, err)
	}

	id, saved, err := loadIdentity(secretName)
	if err != nil {
		return err
	}
	if !saved {
		id = *tailcat.NewPrivateKey()
	}

	var mu sync.Mutex
	refused := map[key.NodePublic]bool{}
	s := &tailcat.Server{
		Key:            id.Private,
		PresharedKey:   id.Public.PresharedKey,
		ServedTCPPorts: []filter.PortRange{{First: port, Last: port}},
		Logf: func(format string, args ...any) {
			if strings.HasPrefix(format, "exec ") { // herdr-core failures; the rest is debug noise
				log.Printf("tailcat: "+format, args...)
			}
		},
		AllowClient: func(k key.NodePublic) bool {
			if allow.Contains(k) {
				return true
			}
			mu.Lock()
			defer mu.Unlock()
			if !refused[k] && len(refused) <= maxRefusalLogs {
				refused[k] = true
				if len(refused) > maxRefusalLogs {
					log.Printf("more than %d distinct clients refused; no longer logging refusals", maxRefusalLogs)
				} else {
					log.Printf("refused %s", k)
				}
			}
			return false
		},
	}
	if saved {
		s.Region = id.Public.Region[0] // pinned: restarts don't depend on fetching tailcat.dev's relay map
	}

	run := s.ExecConnHandler([]string{herdrPath, "connect"})
	slots := make(chan struct{}, maxConns)
	handler := func(c net.Conn) {
		peer, _ := s.PeerKey(c.RemoteAddr())
		select {
		case slots <- struct{}{}:
		default:
			log.Printf("rejected connection from %s: %d already open", peer, maxConns)
			c.Close()
			return
		}
		defer func() { <-slots }()
		start := time.Now()
		log.Printf("open %s", peer)
		run(c)
		log.Printf("close %s after %s", peer, time.Since(start).Round(time.Second))
	}
	s.OnTCP = func(p uint16) func(net.Conn) {
		if p == port {
			return handler
		}
		return nil
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
	log.Printf("serving %s connect for %d allowed client(s)", herdrPath, len(strings.Split(allowList, ",")))
	fmt.Println("address (secret, share only with the client machine):", addr)
	select {}
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
	return k, saveSecret(name, txt)
}
