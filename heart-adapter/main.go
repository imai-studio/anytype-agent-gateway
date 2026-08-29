package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/anyproto/anytype-heart/pb"
	"github.com/anyproto/anytype-heart/pb/service"
	"github.com/anyproto/anytype-heart/pkg/lib/pb/model"
	"github.com/gogo/protobuf/types"
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
type chatAttachment struct {
	Target string `json:"target"`
	Type   string `json:"type"`
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
	ChatID      string           `json:"chatId"`
	MessageID   string           `json:"messageId,omitempty"`
	Text        string           `json:"text,omitempty"`
	ReplyTo     string           `json:"replyTo,omitempty"`
	Marks       []textMark       `json:"marks,omitempty"`
	Attachments []chatAttachment `json:"attachments,omitempty"`
}
type mutationResponse struct {
	MessageID string `json:"messageId,omitempty"`
}
type profileRequest struct {
	ProfileObjectID string `json:"profileObjectId"`
	Name            string `json:"name"`
	IconImage       string `json:"iconImage,omitempty"`
}
type profileImageRequest struct {
	SpaceID   string `json:"spaceId"`
	LocalPath string `json:"localPath"`
}
type approveRequest struct {
	SpaceID    string `json:"spaceId"`
	Identity   string `json:"identity"`
	Permission string `json:"permission"`
}

func main() {
	if len(os.Args) < 2 {
		fatal(errors.New("usage: aag-heart-adapter <resolve|hydrate|send|edit|delete|profile|profile-image|space-approve> [flags]"))
	}
	switch os.Args[1] {
	case "resolve":
		runResolve(os.Args[2:])
	case "hydrate":
		runHydrate(os.Args[2:])
	case "send", "edit", "delete":
		runMutation(os.Args[1], os.Args[2:])
	case "profile":
		runProfile(os.Args[2:])
	case "profile-image":
		runProfileImage(os.Args[2:])
	case "space-approve":
		runSpaceApprove(os.Args[2:])
	default:
		fatal(errors.New("usage: aag-heart-adapter <resolve|hydrate|send|edit|delete|profile|profile-image|space-approve> [flags]"))
	}
}

func runProfileImage(args []string) {
	flags := flag.NewFlagSet("profile-image", flag.ExitOnError)
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	allowUnauthenticated := flags.Bool("allow-unauthenticated", false, "allow a loopback Heart connection when the config has no session token")
	_ = flags.Parse(args)
	var input profileImageRequest
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(fmt.Errorf("decode request: %w", err))
	}
	if input.SpaceID == "" || input.LocalPath == "" {
		fatal(errors.New("spaceId and localPath are required"))
	}
	if info, err := os.Stat(input.LocalPath); err != nil || !info.Mode().IsRegular() {
		fatal(errors.New("localPath must be a readable regular file"))
	}
	client, ctx, closeClient := heartClientWithTimeout(*address, *configPath, *allowUnauthenticated, 60*time.Second)
	defer closeClient()
	opened, err := client.WorkspaceOpen(ctx, &pb.RpcWorkspaceOpenRequest{SpaceId: input.SpaceID})
	if err != nil {
		fatal(fmt.Errorf("open workspace: %w", err))
	}
	if opened.GetError().GetCode() != pb.RpcWorkspaceOpenResponseError_NULL {
		fatal(errors.New(opened.GetError().GetDescription()))
	}
	account := opened.GetInfo()
	if account.GetProfileObjectId() == "" || account.GetAccountSpaceId() == "" {
		fatal(errors.New("Heart returned no profile object or account space"))
	}
	uploaded, err := client.FileUpload(ctx, &pb.RpcFileUploadRequest{
		SpaceId:   account.GetAccountSpaceId(),
		LocalPath: input.LocalPath,
		Type:      model.BlockContentFile_Image,
		ImageKind: model.ImageKind_Icon,
	})
	if err != nil {
		fatal(fmt.Errorf("upload profile image: %w", err))
	}
	if uploaded.GetError().GetCode() != pb.RpcFileUploadResponseError_NULL {
		fatal(errors.New(uploaded.GetError().GetDescription()))
	}
	if uploaded.GetObjectId() == "" {
		fatal(errors.New("Heart returned no uploaded image object ID"))
	}
	set, err := client.ObjectSetDetails(ctx, &pb.RpcObjectSetDetailsRequest{
		ContextId: account.GetProfileObjectId(),
		Details: []*model.Detail{{
			Key:   "iconImage",
			Value: stringValue(uploaded.GetObjectId()),
		}},
	})
	if err != nil {
		fatal(fmt.Errorf("set profile image: %w", err))
	}
	if set.GetError().GetCode() != pb.RpcObjectSetDetailsResponseError_NULL {
		fatal(errors.New(set.GetError().GetDescription()))
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]interface{}{
		"updated":         true,
		"profileObjectId": account.GetProfileObjectId(),
		"fileObjectId":    uploaded.GetObjectId(),
	})
}

func runProfile(args []string) {
	flags := flag.NewFlagSet("profile", flag.ExitOnError)
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	allowUnauthenticated := flags.Bool("allow-unauthenticated", false, "allow a loopback Heart connection when the config has no session token")
	_ = flags.Parse(args)
	var input profileRequest
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(fmt.Errorf("decode request: %w", err))
	}
	if input.ProfileObjectID == "" || input.Name == "" {
		fatal(errors.New("profileObjectId and name are required"))
	}
	client, ctx, closeClient := heartClient(*address, *configPath, *allowUnauthenticated)
	defer closeClient()
	details := []*model.Detail{{Key: "name", Value: stringValue(input.Name)}}
	if input.IconImage != "" {
		details = append(details, &model.Detail{Key: "iconImage", Value: stringValue(input.IconImage)})
	}
	got, err := client.ObjectSetDetails(ctx, &pb.RpcObjectSetDetailsRequest{ContextId: input.ProfileObjectID, Details: details})
	if err != nil {
		fatal(fmt.Errorf("set profile: %w", err))
	}
	if got.GetError().GetCode() != pb.RpcObjectSetDetailsResponseError_NULL {
		fatal(errors.New(got.GetError().GetDescription()))
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]bool{"updated": true})
}

func runSpaceApprove(args []string) {
	flags := flag.NewFlagSet("space-approve", flag.ExitOnError)
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	allowUnauthenticated := flags.Bool("allow-unauthenticated", false, "allow a loopback Heart connection when the config has no session token")
	_ = flags.Parse(args)
	var input approveRequest
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fatal(fmt.Errorf("decode request: %w", err))
	}
	if input.SpaceID == "" || input.Identity == "" {
		fatal(errors.New("spaceId and identity are required"))
	}
	permission := model.ParticipantPermissions_Writer
	if input.Permission == "reader" {
		permission = model.ParticipantPermissions_Reader
	}
	if input.Permission == "admin" {
		permission = model.ParticipantPermissions_Admin
	}
	client, ctx, closeClient := heartClient(*address, *configPath, *allowUnauthenticated)
	defer closeClient()
	got, err := client.SpaceRequestApprove(ctx, &pb.RpcSpaceRequestApproveRequest{SpaceId: input.SpaceID, Identity: input.Identity, Permissions: permission})
	if err != nil {
		fatal(fmt.Errorf("approve space request: %w", err))
	}
	if got.GetError().GetCode() != pb.RpcSpaceRequestApproveResponseError_NULL {
		fatal(errors.New(got.GetError().GetDescription()))
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]bool{"approved": true})
}

func heartClient(address, configPath string, allowUnauthenticated bool) (service.ClientCommandsClient, context.Context, func()) {
	return heartClientWithTimeout(address, configPath, allowUnauthenticated, 15*time.Second)
}

func heartClientWithTimeout(address, configPath string, allowUnauthenticated bool, timeout time.Duration) (service.ClientCommandsClient, context.Context, func()) {
	token := os.Getenv("ANYTYPE_SESSION_TOKEN")
	if token == "" {
		var err error
		token, err = readToken(configPath)
		if err != nil && !allowUnauthenticated {
			fatal(err)
		}
	}
	conn, err := grpc.NewClient("dns:///"+address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		fatal(fmt.Errorf("connect: %w", err))
	}
	ctx := context.Background()
	if token != "" {
		ctx = metadata.NewOutgoingContext(ctx, metadata.Pairs("token", token))
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	return service.NewClientCommandsClient(conn), ctx, func() { cancel(); _ = conn.Close() }
}

func stringValue(value string) *types.Value {
	return &types.Value{Kind: &types.Value_StringValue{StringValue: value}}
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
	token, err := sessionToken(*configPath)
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
	attachments := make([]*model.ChatMessageAttachment, 0, len(input.Attachments))
	for _, attachment := range input.Attachments {
		kind, ok := attachmentType(attachment.Type)
		if !ok || attachment.Target == "" {
			continue
		}
		attachments = append(attachments, &model.ChatMessageAttachment{Target: attachment.Target, Type: kind})
	}
	return &model.ChatMessage{
		ReplyToMessageId: input.ReplyTo,
		// Heart v0.50.10 serializes this field even when Blocks are present.
		// Populate both representations to avoid a nil-message panic while still
		// giving object discussions their block-based content.
		Message:     &model.ChatMessageMessageContent{Text: input.Text, Style: model.BlockContentText_Paragraph, Marks: marks},
		Blocks:      outboundBlocks(input.Text, marks),
		Attachments: attachments,
	}
}

func attachmentType(value string) (model.ChatMessageAttachmentAttachmentType, bool) {
	switch strings.ToLower(value) {
	case "file":
		return model.ChatMessageAttachment_FILE, true
	case "image":
		return model.ChatMessageAttachment_IMAGE, true
	case "link":
		return model.ChatMessageAttachment_LINK, true
	default:
		return model.ChatMessageAttachment_FILE, false
	}
}

func outboundBlocks(text string, marks []*model.BlockContentTextMark) []*model.ChatMessageMessageBlock {
	lines := strings.Split(text, "\n")
	blocks := make([]*model.ChatMessageMessageBlock, 0, len(lines))
	start := int32(0)
	for _, line := range lines {
		length := utf16Length(line)
		localMarks := make([]*model.BlockContentTextMark, 0)
		for _, mark := range marks {
			rangeValue := mark.GetRange()
			if rangeValue == nil || rangeValue.GetTo() <= start || rangeValue.GetFrom() >= start+length {
				continue
			}
			from := max(rangeValue.GetFrom(), start) - start
			to := min(rangeValue.GetTo(), start+length) - start
			localMarks = append(localMarks, &model.BlockContentTextMark{Type: mark.GetType(), Param: mark.GetParam(), Range: &model.Range{From: from, To: to}})
		}
		blocks = append(blocks, &model.ChatMessageMessageBlock{Content: &model.ChatMessageMessageBlockContentOfText{Text: &model.ChatMessageMessageBlockText{Text: line, Style: model.BlockContentText_Paragraph, Marks: localMarks}}})
		start += length + 1
	}
	return blocks
}

func utf16Length(value string) int32 { return int32(len(utf16.Encode([]rune(value)))) }

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
	case "keyboard", "code":
		return model.BlockContentTextMark_Keyboard, true
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
	token, err := sessionToken(*configPath)
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
	token, err := sessionToken(*configPath)
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
		closeParent := metadata.NewOutgoingContext(context.Background(), metadata.Pairs("token", token))
		closeCtx, closeCancel := context.WithTimeout(closeParent, 3*time.Second)
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
	createCtx, createCancel := context.WithTimeout(metadata.NewOutgoingContext(context.Background(), metadata.Pairs("token", token)), 10*time.Second)
	defer createCancel()
	created, err := client.ObjectAddDiscussion(createCtx, &pb.RpcObjectDiscussionAddRequest{ObjectId: objectID})
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
	if cfg.SessionToken != "" {
		return normalizeCredential(cfg.SessionToken)
	}
	return readKeychainToken()
}

func sessionToken(path string) (string, error) {
	if token := strings.TrimSpace(os.Getenv("ANYTYPE_SESSION_TOKEN")); token != "" {
		return normalizeCredential(token)
	}
	return readToken(path)
}

func normalizeCredential(value string) (string, error) {
	const keyringPrefix = "go-keyring-base64:"
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, keyringPrefix) {
		if value == "" {
			return "", errors.New("Anytype session token is empty")
		}
		return value, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, keyringPrefix))
	if err != nil {
		return "", fmt.Errorf("decode Anytype keyring credential: %w", err)
	}
	token := strings.TrimSpace(string(decoded))
	if token == "" {
		return "", errors.New("Anytype keyring session token is empty")
	}
	return token, nil
}

func readKeychainToken() (string, error) {
	if runtime.GOOS != "darwin" {
		return "", errors.New("Anytype config has no sessionToken and no supported system keychain is available")
	}
	output, err := exec.Command(
		"security",
		"find-generic-password",
		"-s",
		"anytype-cli",
		"-a",
		"session-token",
		"-w",
	).Output()
	if err != nil {
		return "", errors.New("Anytype config has no sessionToken and the anytype-cli token was not found in Keychain")
	}
	return normalizeCredential(string(output))
}

func defaultConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", ".anytype", "config.json")
	}
	return filepath.Join(home, ".anytype", "config.json")
}
func fatal(err error) { fmt.Fprintln(os.Stderr, "error:", err); os.Exit(1) }
