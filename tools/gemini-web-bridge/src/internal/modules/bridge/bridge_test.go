package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"gemini-web-to-api/internal/modules/providers"
	"gemini-web-to-api/internal/server"

	"github.com/gofiber/fiber/v3"
	"go.uber.org/zap"
)

type fakeClient struct {
	healthy bool
	gotConv *providers.SessionMetadata
	gotOpts int
	served  string
	err     error
	panic   bool
}

func (f *fakeClient) IsHealthy() bool         { return f.healthy }
func (f *fakeClient) ListModelsIDs() []string { return []string{"gemini-3.1-pro"} }
func (f *fakeClient) ResolveModel(m string) (providers.ModelInfo, error) {
	if m != "gemini-3.1-pro" {
		return providers.ModelInfo{}, errors.New("unknown model")
	}
	return providers.ModelInfo{ID: m}, nil
}
func (f *fakeClient) GenerateInConversation(_ context.Context, _ string, conv *providers.SessionMetadata, opts ...providers.GenerateOption) (*providers.Response, error) {
	f.gotConv, f.gotOpts = conv, len(opts)
	if f.panic {
		var m map[string]int
		m["boom"] = 1
	}
	if f.err != nil {
		return nil, f.err
	}
	model := f.served
	if model == "" {
		model = "gemini-3.1-pro"
	}
	return &providers.Response{Text: "ok", Model: model, Metadata: map[string]any{"cid": "c_1", "rid": "r_2", "rcid": "rc_3"}}, nil
}

func call(t *testing.T, app *fiber.App, body any, token string) (int, map[string]any) {
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/bridge/v1/generate", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	_ = json.Unmarshal(data, &out)
	return resp.StatusCode, out
}

func TestBridgeGenerate(t *testing.T) {
	dir := t.TempDir()
	video := filepath.Join(dir, "chunk.mp4")
	_ = os.WriteFile(video, []byte("x"), 0o600)
	fake := &fakeClient{healthy: true}
	app := fiber.New()
	app.Use(server.RequireToken("s3cret"))
	Register(app, fake, zap.NewNop())

	if status, _ := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi"}, ""); status != 401 {
		t.Fatalf("no token must be rejected, got %d", status)
	}
	status, out := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi", Files: []FileRef{{Path: video}},
		Conversation: &Conversation{ConversationID: "c_0", ResponseID: "r_0", ChoiceID: "rc_0"}}, "s3cret")
	if status != 200 {
		t.Fatalf("status %d %v", status, out)
	}
	conv := out["conversation"].(map[string]any)
	if conv["cid"] != "c_1" || conv["rid"] != "r_2" || conv["rcid"] != "rc_3" {
		t.Fatalf("conversation ids not returned: %v", conv)
	}
	if fake.gotConv == nil || fake.gotConv.ResponseID != "r_0" || fake.gotOpts != 2 {
		t.Fatalf("continuation/files not passed: %+v %d", fake.gotConv, fake.gotOpts)
	}
	if status, out := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi", Files: []FileRef{{Path: filepath.Join(dir, "missing.mp4")}}}, "s3cret"); status != 400 || out["error"].(map[string]any)["code"] != "file_not_found" {
		t.Fatalf("missing file: %d %v", status, out)
	}
	fake.served = "gemini-3.6-flash"
	if _, out := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi"}, "s3cret"); out["downgraded"] != true {
		t.Fatalf("downgrade not flagged: %v", out)
	}
	fake.err = errors.New("generate failed with status: 429")
	if status, out := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi"}, "s3cret"); status != 429 || out["error"].(map[string]any)["code"] != "rate_limited" {
		t.Fatalf("429: %d %v", status, out)
	}
	fake.err = nil
	fake.panic = true
	if status, out := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi"}, "s3cret"); status != 500 || out["error"].(map[string]any)["code"] != "bridge_panic" {
		t.Fatalf("panic: %d %v", status, out)
	}
	fake.panic = false
	fake.healthy = false
	if status, out := call(t, app, GenerateRequest{Model: "gemini-3.1-pro", Prompt: "hi"}, "s3cret"); status != 503 || out["error"].(map[string]any)["code"] != "auth_expired" {
		t.Fatalf("unhealthy: %d %v", status, out)
	}
}
