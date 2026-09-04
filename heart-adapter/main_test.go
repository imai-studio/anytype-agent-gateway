package main

import (
	"encoding/base64"
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

func TestNormalizeCredentialRejectsEmptySession(t *testing.T) {
	if _, err := normalizeCredential(" \n"); err == nil {
		t.Fatal("expected an empty sessionToken to fail")
	}
}

func TestNormalizeCredentialDecodesGoKeyringValue(t *testing.T) {
	wrapper := "go-keyring-base64:" + base64.StdEncoding.EncodeToString([]byte("header.payload.signature"))
	token, err := normalizeCredential(wrapper)
	if err != nil {
		t.Fatal(err)
	}
	if token != "header.payload.signature" {
		t.Fatalf("unexpected token %q", token)
	}
}

func TestNormalizeCredentialKeepsPlainToken(t *testing.T) {
	token, err := normalizeCredential(" plain-session-token \n")
	if err != nil {
		t.Fatal(err)
	}
	if token != "plain-session-token" {
		t.Fatalf("unexpected token %q", token)
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

func TestRenderMessageRebasesMultiBlockMentionsInUTF16(t *testing.T) {
	message := &model.ChatMessage{HasMention: true}
	for _, value := range []struct {
		text  string
		marks []*model.BlockContentTextMark
	}{
		{text: "Héllo • 😀 中文"},
		{text: "Anya 👋", marks: []*model.BlockContentTextMark{{
			Type: model.BlockContentTextMark_Mention, Param: "peer-one", Range: &model.Range{From: 0, To: 4},
		}}},
		{text: "é 中 Raj", marks: []*model.BlockContentTextMark{{
			Type: model.BlockContentTextMark_Mention, Param: "peer-two", Range: &model.Range{From: 4, To: 7},
		}}},
	} {
		message.Blocks = append(message.Blocks, &model.ChatMessageMessageBlock{
			Content: &model.ChatMessageMessageBlockContentOfText{Text: &model.ChatMessageMessageBlockText{
				Text: value.text, Marks: value.marks,
			}},
		})
	}
	rendered := renderMessage(message)
	if rendered.Content.Text != "Héllo • 😀 中文\nAnya 👋\né 中 Raj" {
		t.Fatalf("unexpected text %q", rendered.Content.Text)
	}
	// The first line has 13 UTF-16 code units; the second has seven.
	want := []textMark{
		{Type: "mention", Param: "peer-one", From: 14, To: 18},
		{Type: "mention", Param: "peer-two", From: 26, To: 29},
	}
	if len(rendered.Content.Marks) != len(want) {
		t.Fatalf("unexpected marks %#v", rendered.Content.Marks)
	}
	for i, mark := range rendered.Content.Marks {
		if mark != want[i] {
			t.Fatalf("mark %d: got %#v, want %#v", i, mark, want[i])
		}
	}
}

func TestOutboundMessageUsesBlockContent(t *testing.T) {
	message := outboundMessage(mutationRequest{
		Text:    "Working...",
		ReplyTo: "trigger",
		Marks:   []textMark{{Type: "mention", From: 0, To: 4, Param: "peer"}},
	})
	if message.GetMessage() == nil || message.GetMessage().GetText() != "Working..." {
		t.Fatal("Heart compatibility content is required alongside blocks")
	}
	if message.GetReplyToMessageId() != "trigger" || len(message.GetBlocks()) != 1 {
		t.Fatalf("unexpected outbound message %#v", message)
	}
	text := message.GetBlocks()[0].GetText()
	if text == nil || text.GetText() != "Working..." || len(text.GetMarks()) != 1 || text.GetMarks()[0].GetType() != model.BlockContentTextMark_Mention {
		t.Fatalf("unexpected block content %#v", text)
	}
}

func TestOutboundMessageIncludesObjectCardAttachment(t *testing.T) {
	message := outboundMessage(mutationRequest{
		Text:        "Studio Main Changelog",
		Attachments: []chatAttachment{{Target: "object-id", Type: "file"}},
	})
	if len(message.GetAttachments()) != 1 {
		t.Fatalf("expected one attachment, got %d", len(message.GetAttachments()))
	}
	attachment := message.GetAttachments()[0]
	if attachment.GetTarget() != "object-id" || attachment.GetType() != model.ChatMessageAttachment_FILE {
		t.Fatalf("unexpected attachment %#v", attachment)
	}
}

func TestOutboundMessageCreatesParagraphBlocksAndRebasesMarks(t *testing.T) {
	message := outboundMessage(mutationRequest{
		Text:  "First line\n• Bold item",
		Marks: []textMark{{Type: "bold", From: 13, To: 22}},
	})
	if len(message.GetBlocks()) != 2 {
		t.Fatalf("expected two blocks, got %d", len(message.GetBlocks()))
	}
	second := message.GetBlocks()[1].GetText()
	if second.GetText() != "• Bold item" || len(second.GetMarks()) != 1 {
		t.Fatalf("unexpected second block %#v", second)
	}
	mark := second.GetMarks()[0]
	if mark.GetType() != model.BlockContentTextMark_Bold || mark.GetRange().GetFrom() != 2 || mark.GetRange().GetTo() != 11 {
		t.Fatalf("unexpected rebased mark %#v", mark)
	}
}
