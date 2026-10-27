package providers

import (
	"context"
	"os"
	"strconv"
	"time"
)

// generateTimeout bounds one Gemini Web generate round trip. Long video
// analyses with thinking can exceed the upstream 5 minute default.
func generateTimeout() time.Duration {
	if v, err := strconv.Atoi(os.Getenv("GEMINI_GENERATE_TIMEOUT_SEC")); err == nil && v >= 60 {
		return time.Duration(v) * time.Second
	}
	return 10 * time.Minute
}

// GenerateInConversation sends one message, optionally continuing an existing
// Gemini Web conversation at a given response (cid/rid/rcid). Passing the ids
// of an earlier response replies to that point of the conversation.
func (c *Client) GenerateInConversation(ctx context.Context, prompt string, conversation *SessionMetadata, options ...GenerateOption) (*Response, error) {
	var metadata []interface{}
	if conversation != nil && conversation.ConversationID != "" {
		metadata = []interface{}{conversation.ConversationID, conversation.ResponseID, conversation.ChoiceID}
	}
	return c.generateContent(ctx, prompt, metadata, options...)
}

// ConversationOf extracts the ids needed to continue after this response.
func ConversationOf(response *Response) SessionMetadata {
	out := SessionMetadata{}
	if response == nil {
		return out
	}
	if v, ok := response.Metadata["cid"].(string); ok {
		out.ConversationID = v
	}
	if v, ok := response.Metadata["rid"].(string); ok {
		out.ResponseID = v
	}
	if v, ok := response.Metadata["rcid"].(string); ok {
		out.ChoiceID = v
	}
	if out.ConversationID == "" {
		out.ConversationID = response.ConversationID
	}
	if out.ResponseID == "" {
		out.ResponseID = response.ResponseID
	}
	return out
}
