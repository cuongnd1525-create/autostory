package providers

import (
	"encoding/json"
	"testing"

	"go.uber.org/zap"
)

func frame(t *testing.T, payload any) string {
	inner, _ := json.Marshal(payload)
	outer, _ := json.Marshal([]any{[]any{"wrb.fr", nil, string(inner)}})
	return string(outer)
}

// Short status frames must not panic, and [cid, rid] must both be kept.
func TestParseResponseShortFrameAndRid(t *testing.T) {
	c := &Client{log: zap.NewNop()}
	text := ")]}'\n" + frame(t, []any{nil, []any{"c_1", "r_1"}}) + "\n" +
		frame(t, []any{nil, []any{"c_1", "r_1"}, nil, nil, []any{[]any{"rc_1", []any{"hello"}}}}) + "\n"
	resp, err := c.parseResponse(text)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Text != "hello" {
		t.Fatalf("text %q", resp.Text)
	}
	got := ConversationOf(resp)
	if got.ConversationID != "c_1" || got.ResponseID != "r_1" || got.ChoiceID != "rc_1" {
		t.Fatalf("conversation ids %+v", got)
	}
}
