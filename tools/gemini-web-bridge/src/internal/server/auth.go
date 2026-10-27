package server

import (
	"crypto/subtle"
	"strings"

	"github.com/gofiber/fiber/v3"
)

// RequireToken rejects every request (except GET /health) that does not carry
// the bridge token as "Authorization: Bearer <token>" or "x-api-key: <token>".
func RequireToken(token string) fiber.Handler {
	want := []byte(token)
	return func(c fiber.Ctx) error {
		if c.Method() == fiber.MethodGet && c.Path() == "/health" {
			return c.Next()
		}
		got := strings.TrimSpace(c.Get("x-api-key"))
		if auth := strings.TrimSpace(c.Get("Authorization")); strings.HasPrefix(strings.ToLower(auth), "bearer ") {
			got = strings.TrimSpace(auth[7:])
		}
		if subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": fiber.Map{"code": "unauthorized", "message": "missing or invalid bridge token"}})
		}
		return c.Next()
	}
}
