package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/anyproto/anytype-heart/pb"
	"github.com/anyproto/anytype-heart/pb/service"
	"github.com/anyproto/anytype-heart/pkg/lib/pb/model"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type configFile struct {
	SessionToken string `json:"sessionToken"`
}
type request struct {
	ObjectIDs []string `json:"objectIds"`
}
type result struct {
	ObjectID     string `json:"objectId"`
	DiscussionID string `json:"discussionId,omitempty"`
	Error        string `json:"error,omitempty"`
}
type response struct {
	Discussions []result `json:"discussions"`
}
type hydrateRequest struct {
	ChatID     string   `json:"chatId"`
	MessageIDs []string `json:"messageIds"`
}
type textMark struct {
	Type  string `json:"type"`
	From  int32  `json:"from,omitempty"`
	To    int32  `json:"to,omitempty"`
	Param string `json:"param,omitempty"`
}
type messageContent struct {
	Text  string     `json:"text"`
	Style string     `json:"style"`
	Marks []textMark `json:"marks,omitempty"`
}
type hydratedMessage struct {
	ID               string         `json:"id"`
	OrderID          string         `json:"order_id,omitempty"`
	Creator          string         `json:"creator,omitempty"`
	CreatedAt        int64          `json:"created_at,omitempty"`
	ModifiedAt       int64          `json:"modified_at,omitempty"`
	ReplyToMessageID string         `json:"reply_to_message_id,omitempty"`
	Content          messageContent `json:"content"`
	Mentioned        bool           `json:"mentioned,omitempty"`
}
type hydrateResponse struct {
	Messages []hydratedMessage `json:"messages"`
}
type mutationRequest struct {
	ChatID    string     `json:"chatId"`
	MessageID string     `json:"messageId,omitempty"`
	Text      string     `json:"text,omitempty"`
	ReplyTo   string     `json:"replyTo,omitempty"`
	Marks     []textMark `json:"marks,omitempty"`
}
type mutationResponse struct {
	MessageID string `json:"messageId,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fatal(errors.New("usage: aag-heart-adapter <resolve|hydrate> [flags]"))
	}
	switch os.Args[1] {
	case "resolve":
		runResolve(os.Args[2:])
	case "hydrate":
		runHydrate(os.Args[2:])
	case "send", "edit", "delete":
		runMutation(os.Args[1], os.Args[2:])
	default:
		fatal(errors.New("usage: aag-heart-adapter <resolve|hydrate|send|edit|delete> [flags]"))
	}
}

func runMutation(action string, args []string) {
	flags := flag.NewFlagSet(action, flag.ExitOnError)
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	_ = flags.Parse(args)
	var input mutationRequest
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(fmt.Errorf("decode request: %w", err))
	}
	if input.ChatID == "" {
		fatal(errors.New("chatId is required"))
	}
	if action != "send" && input.MessageID == "" {
		fatal(errors.New("messageId is required"))
	}
	token, err := readToken(*configPath)
	if err != nil {
		fatal(err)
	}
	conn, err := grpc.NewClient("dns:///"+*address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		fatal(fmt.Errorf("connect: %w", err))
	}
	defer conn.Close()
	client := service.NewClientCommandsClient(conn)
	ctx, cancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), metadata.Pairs("token", token)), 15*time.Second)
	defer cancel()
	out := mutationResponse{}
	switch action {
	case "send":
		got, callErr := client.ChatAddMessage(ctx, &pb.RpcChatAddMessageRequest{ChatObjectId: input.ChatID, Message: outboundMessage(input)})
		if callErr != nil {
			fatal(fmt.Errorf("send chat message: %w", callErr))
		}
		if got.GetError().GetCode() != pb.RpcChatAddMessageResponseError_NULL {
			fatal(errors.New(got.GetError().GetDescription()))
		}
		out.MessageID = got.GetMessageId()
	case "edit":
		got, callErr := client.ChatEditMessageContent(ctx, &pb.RpcChatEditMessageContentRequest{ChatObjectId: input.ChatID, MessageId: input.MessageID, EditedMessage: outboundMessage(input)})
		if callErr != nil {
			fatal(fmt.Errorf("edit chat message: %w", callErr))
		}
		if got.GetError().GetCode() != pb.RpcChatEditMessageContentResponseError_NULL {
			fatal(errors.New(got.GetError().GetDescription()))
		}
	case "delete":
		got, callErr := client.ChatDeleteMessage(ctx, &pb.RpcChatDeleteMessageRequest{ChatObjectId: input.ChatID, MessageId: input.MessageID})
		if callErr != nil {
			fatal(fmt.Errorf("delete chat message: %w", callErr))
		}
		if got.GetError().GetCode() != pb.RpcChatDeleteMessageResponseError_NULL {
			fatal(errors.New(got.GetError().GetDescription()))
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fatal(err)
	}
}

func outboundMessage(input mutationRequest) *model.ChatMessage {
	marks := make([]*model.BlockContentTextMark, 0, len(input.Marks))
	for _, mark := range input.Marks {
		kind, ok := markType(mark.Type)
		if !ok {
			continue
		}
		marks = append(marks, &model.BlockContentTextMark{Type: kind, Param: mark.Param, Range: &model.Range{From: mark.From, To: mark.To}})
	}
	return &model.ChatMessage{
		ReplyToMessageId: input.ReplyTo,
		Blocks: []*model.ChatMessageMessageBlock{{
			Content: &model.ChatMessageMessageBlockContentOfText{Text: &model.ChatMessageMessageBlockText{Text: input.Text, Style: model.BlockContentText_Paragraph, Marks: marks}},
		}},
	}
}

func markType(value string) (model.BlockContentTextMarkType, bool) {
	switch strings.ToLower(value) {
	case "mention":
		return model.BlockContentTextMark_Mention, true
	case "object":
		return model.BlockContentTextMark_Object, true
	case "link":
		return model.BlockContentTextMark_Link, true
	case "bold":
		return model.BlockContentTextMark_Bold, true
	case "italic":
		return model.BlockContentTextMark_Italic, true
	case "strikethrough":
		return model.BlockContentTextMark_Strikethrough, true
	default:
		return model.BlockContentTextMark_Strikethrough, false
	}
}

func runResolve(args []string) {
	flags := flag.NewFlagSet("resolve", flag.ExitOnError)
	spaceID := flags.String("space-id", "", "Anytype space ID")
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	createMissing := flags.Bool("create-missing", false, "create discussions where missing")
	_ = flags.Parse(args)
	if *spaceID == "" {
		fatal(errors.New("--space-id is required"))
	}
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(fmt.Errorf("decode request: %w", err))
	}
	token, err := readToken(*configPath)
	if err != nil {
		fatal(err)
	}
	conn, err := grpc.NewClient("dns:///"+*address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		fatal(fmt.Errorf("connect: %w", err))
	}
	defer conn.Close()
	client := service.NewClientCommandsClient(conn)
	out := response{Discussions: make([]result, 0, len(input.ObjectIDs))}
	for _, objectID := range input.ObjectIDs {
		out.Discussions = append(out.Discussions, resolve(client, token, *spaceID, objectID, *createMissing))
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fatal(err)
	}
}

func runHydrate(args []string) {
	flags := flag.NewFlagSet("hydrate", flag.ExitOnError)
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	_ = flags.Parse(args)
	var input hydrateRequest
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(fmt.Errorf("decode request: %w", err))
	}
	if input.ChatID == "" {
		fatal(errors.New("chatId is required"))
	}
	token, err := readToken(*configPath)
	if err != nil {
		fatal(err)
	}
	conn, err := grpc.NewClient("dns:///"+*address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		fatal(fmt.Errorf("connect: %w", err))
	}
	defer conn.Close()
	client := service.NewClientCommandsClient(conn)
	ctx, cancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), metadata.Pairs("token", token)), 15*time.Second)
	defer cancel()
	got, err := client.ChatGetMessagesByIds(ctx, &pb.RpcChatGetMessagesByIdsRequest{ChatObjectId: input.ChatID, MessageIds: input.MessageIDs})
	if err != nil {
		fatal(fmt.Errorf("get chat messages: %w", err))
	}
	if got.GetError().GetCode() != pb.RpcChatGetMessagesByIdsResponseError_NULL {
		fatal(errors.New(got.GetError().GetDescription()))
	}
	out := hydrateResponse{Messages: make([]hydratedMessage, 0, len(got.GetMessages()))}
	for _, message := range got.GetMessages() {
		out.Messages = append(out.Messages, renderMessage(message))
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fatal(err)
	}
}

func renderMessage(message *model.ChatMessage) hydratedMessage {
	text, style, marks := renderContent(message)
	return hydratedMessage{
		ID:               message.GetId(),
		OrderID:          message.GetOrderId(),
		Creator:          message.GetCreator(),
		CreatedAt:        message.GetCreatedAt(),
		ModifiedAt:       message.GetModifiedAt(),
		ReplyToMessageID: message.GetReplyToMessageId(),
		Content:          messageContent{Text: text, Style: style, Marks: marks},
		Mentioned:        message.GetHasMention(),
	}
}

func renderContent(message *model.ChatMessage) (string, string, []textMark) {
	if content := message.GetMessage(); content != nil && (content.GetText() != "" || len(content.GetMarks()) > 0) {
		return content.GetText(), strings.ToLower(content.GetStyle().String()), renderMarks(content.GetMarks(), 0)
	}
	var text strings.Builder
	marks := make([]textMark, 0)
	style := "paragraph"
	for _, block := range message.GetBlocks() {
		blockText := block.GetText()
		if blockText == nil {
			continue
		}
		if text.Len() > 0 {
			text.WriteByte('\n')
		}
		offset := int32(text.Len())
		text.WriteString(blockText.GetText())
		style = strings.ToLower(blockText.GetStyle().String())
		marks = append(marks, renderMarks(blockText.GetMarks(), offset)...)
	}
	return text.String(), style, marks
}

func renderMarks(marks []*model.BlockContentTextMark, offset int32) []textMark {
	out := make([]textMark, 0, len(marks))
	for _, mark := range marks {
		item := textMark{Type: strings.ToLower(mark.GetType().String()), Param: mark.GetParam()}
		if value := mark.GetRange(); value != nil {
			item.From = offset + value.GetFrom()
			item.To = offset + value.GetTo()
		}
		out = append(out, item)
	}
	return out
}

func resolve(client service.ClientCommandsClient, token, spaceID, objectID string, create bool) result {
	ctx, cancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), metadata.Pairs("token", token)), 10*time.Second)
	defer cancel()
	shown, err := client.ObjectShow(ctx, &pb.RpcObjectShowRequest{ContextId: objectID, ObjectId: objectID, SpaceId: spaceID})
	if err != nil {
		return result{ObjectID: objectID, Error: err.Error()}
	}
	if shown.GetError().GetCode() != pb.RpcObjectShowResponseError_NULL {
		return result{ObjectID: objectID, Error: shown.GetError().GetDescription()}
	}
	defer func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer closeCancel()
		_, _ = client.ObjectClose(closeCtx, &pb.RpcObjectCloseRequest{ContextId: objectID, ObjectId: objectID, SpaceId: spaceID})
	}()
	if view := shown.GetObjectView(); view != nil {
		for _, set := range view.GetDetails() {
			if set.GetId() != objectID && set.GetId() != view.GetRootId() {
				continue
			}
			if value, ok := set.GetDetails().GetFields()["discussionId"]; ok && value.GetStringValue() != "" {
				return result{ObjectID: objectID, DiscussionID: value.GetStringValue()}
			}
		}
	}
	if !create {
		return result{ObjectID: objectID}
	}
	created, err := client.ObjectAddDiscussion(ctx, &pb.RpcObjectDiscussionAddRequest{ObjectId: objectID})
	if err != nil {
		return result{ObjectID: objectID, Error: err.Error()}
	}
	if created.GetError().GetCode() != pb.RpcObjectDiscussionAddResponseError_NULL {
		return result{ObjectID: objectID, Error: created.GetError().GetDescription()}
	}
	return result{ObjectID: objectID, DiscussionID: created.GetDiscussionId()}
}

func readToken(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read Anytype config: %w", err)
	}
	var cfg configFile
	if err := json.Unmarshal(data, &cfg); err != nil {
		return "", fmt.Errorf("parse Anytype config: %w", err)
	}
	if cfg.SessionToken == "" {
		return "", errors.New("Anytype config has no sessionToken (headless keyring-backed configs are not supported by this adapter)")
	}
	return cfg.SessionToken, nil
}

func defaultConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".anytype", "config.json")
	}
	return filepath.Join(home, ".anytype", "config.json")
}
func fatal(err error) { fmt.Fprintln(os.Stderr, "error:", err); os.Exit(1) }
