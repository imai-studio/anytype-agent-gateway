package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/anyproto/anytype-heart/pkg/lib/pb/model"
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

func TestRenderMessageHydratesBlockBasedComment(t *testing.T) {
	message := &model.ChatMessage{
		Id:         "message",
		HasMention: true,
		Blocks: []*model.ChatMessageMessageBlock{{
			Content: &model.ChatMessageMessageBlockContentOfText{Text: &model.ChatMessageMessageBlockText{
				Text: "Anya can u see this note?",
				Marks: []*model.BlockContentTextMark{{
					Type:  model.BlockContentTextMark_Mention,
					Param: "anya-participant",
					Range: &model.Range{From: 0, To: 4},
				}},
			}},
		}},
	}
	rendered := renderMessage(message)
	if rendered.Content.Text != "Anya can u see this note?" {
		t.Fatalf("unexpected text %q", rendered.Content.Text)
	}
	if !rendered.Mentioned {
		t.Fatal("expected current-user mention signal")
	}
	if len(rendered.Content.Marks) != 1 || rendered.Content.Marks[0].Type != "mention" || rendered.Content.Marks[0].Param != "anya-participant" {
		t.Fatalf("unexpected marks %#v", rendered.Content.Marks)
	}
}

func TestOutboundMessageUsesBlockContent(t *testing.T) {
	message := outboundMessage(mutationRequest{
		Text:    "Working...",
		ReplyTo: "trigger",
		Marks:   []textMark{{Type: "mention", From: 0, To: 4, Param: "peer"}},
	})
	if message.GetMessage() != nil {
		t.Fatal("legacy message content is invisible in object discussions")
	}
	if message.GetReplyToMessageId() != "trigger" || len(message.GetBlocks()) != 1 {
		t.Fatalf("unexpected outbound message %#v", message)
	}
	text := message.GetBlocks()[0].GetText()
	if text == nil || text.GetText() != "Working..." || len(text.GetMarks()) != 1 || text.GetMarks()[0].GetType() != model.BlockContentTextMark_Mention {
		t.Fatalf("unexpected block content %#v", text)
	}
}
