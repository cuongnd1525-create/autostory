# gemini-web-bridge (CineViral fork)

Local bridge that lets RecapTool Studio talk to gemini.google.com with a browser cookie
(experimental provider **Gemini Web** in Settings > AI). Fork of
[ntthanh2603/gemini-web-to-api](https://github.com/ntthanh2603/gemini-web-to-api)
at commit `a9fc60c216d53e524c6eced96dbc70b94ea33089` (MIT, see `src/LICENSE`).

Not an official Google API. It may break when Google changes the Gemini web app, and
automated use can get an account rate-limited or suspended: use a secondary Google account.

## What the fork changes (`CINEVIRAL-PATCH.patch`, ~360 lines)

| Change | Why |
| --- | --- |
| Listen on `HOST` (default `127.0.0.1`) instead of all interfaces | upstream exposed the signed-in account to the LAN |
| `BRIDGE_TOKEN`: every request except `GET /health` needs `Authorization: Bearer <token>`; CORS disabled when a token is set | upstream had CORS `*`, so any web page could drive the account |
| `BODY_LIMIT_MB` (default 32) | upstream used Fiber's 4 MB default |
| `POST /bridge/v1/generate` `{model, prompt, files:[{path}], conversation:{cid,rid,rcid}, thinking}` | attachments read from local paths (no base64), continue a real conversation, machine-readable errors (`auth_expired`, `rate_limited`, `upload_failed`, `timeout`, `file_not_found`, `unknown_model`), `downgraded` flag when Gemini serves a lower model |
| `GET /bridge/v1/status` | health + the account's model list |
| `GEMINI_GENERATE_TIMEOUT_SEC` (default 600) | long video analyses exceeded the upstream 5 min |

The app starts `bin/gemini-web-bridge.exe` itself (random port, random token, cookie
passed only through the child's environment) — see `electron/services/geminiWebBridgeProcess.js`.

## Rebuild

Requires Go 1.25+.

```
cd src
go test ./internal/...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ../bin/gemini-web-bridge.exe ./cmd/server
```

The app runs the NEWEST `bin/gemini-web-bridge*.exe` (a running bridge locks its exe on Windows,
so updates ship under a new name). Built 2026-10-21 with go1.25.1, dependencies verified against
upstream `go.sum`:

| File | SHA-256 | Notes |
| --- | --- | --- |
| `gemini-web-bridge-2.exe` | `0564ae87de7731c4cb5937a85b0c3002af860cc942ddcd777a025e80ac59682d` | fixes a panic on short Gemini Web status frames (bare HTTP 500), keeps `rid` for conversation continuation, panic -> `bridge_panic` error, request logs |
| `gemini-web-bridge.exe` | `a252b2078ea0efc58d7f84c8007867720e021f093bc5bc81d2d8b07098e4cd5b` | first build (superseded; delete when the app is closed) |
