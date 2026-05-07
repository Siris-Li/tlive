package pty

import "io"

type StartOptions struct {
	Cwd string
}

// Process wraps a command running in a pseudo-terminal.
type Process interface {
	io.Reader
	io.Writer
	Resize(rows, cols uint16) error
	Wait() (int, error)
	// Kill forcefully terminates the process and its entire child tree.
	// Safe to call multiple times or on an already-exited process.
	Kill() error
	// Close releases PTY handles and resources. Idempotent.
	Close() error
	Pid() int
}
