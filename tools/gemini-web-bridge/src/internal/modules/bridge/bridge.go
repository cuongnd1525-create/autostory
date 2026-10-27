// Package bridge is the CineViral (RecapTool Studio) endpoint: one message per
// call, optional continuation of a Gemini Web conversation, attachments read
// from local file paths (no base64 in JSON), and machine-readable error codes.
package bridge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"gemini-web-to-api/internal/modules/providers"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/fx"
	"go.uber.org/zap"
)

const Version = "cineviral-bridge-1"

var Module = fx.Options(fx.Invoke(RegisterRoutes))

type Conversation struct {
	ConversationID string `json:"cid"`
	ResponseID     string `json:"rid"`
	ChoiceID       string `json:"rcid"`
}

type FileRef struct {
	Path string `json:"path"`
}

type GenerateRequest struct {
	Model        string        `json:"model"`
	Prompt       string        `json:"prompt"`
	Files        []FileRef     `json:"files"`
	Conversation *Conversation `json:"conversation"`
	Thinking     string        `json:"thinking"`
}

type GenerateResponse struct {
	Text           string       `json:"text"`
	Model          string       `json:"model"`
	RequestedModel string       `json:"requestedModel"`
	Downgraded     bool         `json:"downgraded"`
	Conversation   Conversation `json:"conversation"`
	ElapsedMs      int64        `json:"elapsedMs"`
	Files          int          `json:"files"`
}

type generator interface {
	IsHealthy() bool
	ListModelsIDs() []string
	ResolveModel(string) (providers.ModelInfo, error)
	GenerateInConversation(context.Context, string, *providers.SessionMetadata, ...providers.GenerateOption) (*providers.Response, error)
}

func RegisterRoutes(app *fiber.App, client *providers.Client, log *zap.Logger) {
	Register(app, client, log)
}

func Register(app *fiber.App, client generator, log *zap.Logger) {
	group := app.Group("/bridge/v1")
	group.Get("/status", func(c fiber.Ctx) error {
		return c.JSON(fiber.Map{"version": Version, "healthy": client.IsHealthy(), "models": client.ListModelsIDs()})
	})
	group.Post("/generate", func(c fiber.Ctx) (handlerErr error) {
		// A panic inside the upstream client (e.g. an unexpected Gemini Web
		// response shape) must come back as a coded, logged error, not a bare 500.
		defer func() {
			if r := recover(); r != nil {
				log.Error("bridge generate panic", zap.String("panic", fmt.Sprint(r)), zap.ByteString("stack", debug.Stack()))
				handlerErr = fail(c, fiber.StatusInternalServerError, "bridge_panic", fmt.Sprint(r))
			}
		}()
		var req GenerateRequest
		if err := c.Bind().Body(&req); err != nil {
			return fail(c, fiber.StatusBadRequest, "bad_request", err.Error())
		}
		if strings.TrimSpace(req.Prompt) == "" && len(req.Files) == 0 {
			return fail(c, fiber.StatusBadRequest, "bad_request", "prompt or files required")
		}
		if !client.IsHealthy() {
			return fail(c, fiber.StatusServiceUnavailable, "auth_expired", "Gemini Web session is not healthy (cookies expired or not initialized)")
		}
		info, err := client.ResolveModel(req.Model)
		if err != nil {
			return fail(c, fiber.StatusBadRequest, "unknown_model", err.Error())
		}
		paths := make([]string, 0, len(req.Files))
		var totalBytes int64
		for _, f := range req.Files {
			p := filepath.Clean(f.Path)
			st, statErr := os.Stat(p)
			if statErr != nil || st.IsDir() {
				return fail(c, fiber.StatusBadRequest, "file_not_found", "cannot read "+p)
			}
			totalBytes += st.Size()
			paths = append(paths, p)
		}
		opts := []providers.GenerateOption{providers.WithModel(info.ID)}
		if len(paths) > 0 {
			opts = append(opts, providers.WithFiles(paths))
		}
		if strings.TrimSpace(req.Thinking) != "" {
			opts = append(opts, providers.WithThinkingLevel(req.Thinking))
		}
		var conv *providers.SessionMetadata
		if req.Conversation != nil && req.Conversation.ConversationID != "" {
			conv = &providers.SessionMetadata{ConversationID: req.Conversation.ConversationID, ResponseID: req.Conversation.ResponseID, ChoiceID: req.Conversation.ChoiceID}
		}
		started := time.Now()
		log.Info("bridge generate start", zap.String("model", info.ID), zap.Int("files", len(paths)), zap.Int64("file_bytes", totalBytes),
			zap.Int("prompt_chars", len(req.Prompt)), zap.Bool("continues_conversation", conv != nil))
		resp, err := client.GenerateInConversation(c.Context(), req.Prompt, conv, opts...)
		if err != nil {
			code, status := classify(err)
			log.Warn("bridge generate failed", zap.String("code", code), zap.Duration("elapsed", time.Since(started)), zap.Error(err))
			return fail(c, status, code, err.Error())
		}
		log.Info("bridge generate done", zap.String("served_model", resp.Model), zap.Int("text_chars", len(resp.Text)), zap.Duration("elapsed", time.Since(started)))
		next := providers.ConversationOf(resp)
		return c.JSON(GenerateResponse{
			Text:           resp.Text,
			Model:          resp.Model,
			RequestedModel: info.ID,
			Downgraded:     resp.Model != "" && resp.Model != info.ID,
			Conversation:   Conversation{ConversationID: next.ConversationID, ResponseID: next.ResponseID, ChoiceID: next.ChoiceID},
			ElapsedMs:      time.Since(started).Milliseconds(),
			Files:          len(paths),
		})
	})
}

func classify(err error) (string, int) {
	msg := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, context.Canceled):
		return "cancelled", 499
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(msg, "timeout"):
		return "timeout", fiber.StatusGatewayTimeout
	case strings.Contains(msg, "429") || strings.Contains(msg, "unusual traffic") || strings.Contains(msg, "rate"):
		return "rate_limited", fiber.StatusTooManyRequests
	case strings.Contains(msg, "status: 401") || strings.Contains(msg, "status: 403") || strings.Contains(msg, "not initialized"):
		return "auth_expired", fiber.StatusUnauthorized
	case strings.Contains(msg, "upload"):
		return "upload_failed", fiber.StatusBadGateway
	default:
		return "generate_failed", fiber.StatusBadGateway
	}
}

func fail(c fiber.Ctx, status int, code, message string) error {
	return c.Status(status).JSON(fiber.Map{"error": fiber.Map{"code": code, "message": message}})
}
