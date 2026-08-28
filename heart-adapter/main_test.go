package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"sessionToken":"secret-session"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	token, err := readToken(path)
	if err != nil {
		t.Fatal(err)
	}
	if token != "secret-session" {
		t.Fatalf("unexpected token %q", token)
	}
}

func TestReadTokenRejectsMissingSession(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readToken(path); err == nil {
		t.Fatal("expected missing sessionToken to fail")
	}
}
