package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/anyproto/anytype-heart/pb"
	"github.com/anyproto/anytype-heart/pb/service"
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

func main() {
	if len(os.Args) < 2 || os.Args[1] != "resolve" {
		fatal(errors.New("usage: aag-heart-adapter resolve [flags]"))
	}
	flags := flag.NewFlagSet("resolve", flag.ExitOnError)
	spaceID := flags.String("space-id", "", "Anytype space ID")
	address := flags.String("grpc-address", "127.0.0.1:31010", "Anytype Heart gRPC address")
	configPath := flags.String("config", defaultConfigPath(), "Anytype CLI config file")
	createMissing := flags.Bool("create-missing", false, "create discussions where missing")
	_ = flags.Parse(os.Args[2:])
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
