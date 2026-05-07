package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/termlive/termlive/core/internal/daemon"
)

func TestCreateSessionViaAPISendsCwd(t *testing.T) {
	const token = "test-token"
	const cwd = "D:\\work\\project"

	requests := make(chan daemon.CreateSessionRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Fatalf("expected Authorization header %q, got %q", "Bearer "+token, got)
		}

		var req daemon.CreateSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		json.NewEncoder(w).Encode(daemon.CreateSessionResponse{ID: "session-id", Command: req.Command})
	}))
	defer server.Close()

	_, portString, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portString)
	if err != nil {
		t.Fatal(err)
	}

	id, err := createSessionViaAPI(port, token, "claude", []string{"--model", "opus"}, 24, 80, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if id != "session-id" {
		t.Fatalf("expected session ID %q, got %q", "session-id", id)
	}

	req := <-requests
	if req.Cwd != cwd {
		t.Fatalf("expected cwd %q, got %q", cwd, req.Cwd)
	}
	if req.Command != "claude" {
		t.Fatalf("expected command %q, got %q", "claude", req.Command)
	}
}
