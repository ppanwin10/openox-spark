# Linux Host

Goal: run OpenOx as an always-on Host on a Linux machine such as a DGX Spark, keep the Profile's conversations, memory and files on that machine, and reach it from a phone or desktop browser. The existing iOS and macOS Hosts are unchanged; this is an additional Host implementation.

Status: implemented as `apps/linux` (server, web client, device pairing) and `packages/agent/src/adapters/linux` (agent runtime adapter). iOS remote-Host mode, web access functions, services, schedules and OCR remain future work.

## Architecture

- One Bun process owns one Profile. Pi Durable state lives in `<data>/profiles/<id>/state/state.sqlite`; Profile content (MEMORY.md, skills, conversation folders and shared folders) lives as ordinary files in `<data>/profiles/<id>/files/` using the physical public-file store, so files added over SSH are reconciled.
- The model uses the production Ox prompt and the single `execute` tool. Scripts run in the pi-codemode QuickJS sandbox with `ox.fs.*` (except `attach`) and `ox.user.choose|progress|follow`. Other `ox.*` functions return `not_supported`. Removed files move to the Host trash, not permanent deletion.
- PDF text is extracted with `pdftotext` when installed; other binary formats report unsupported reads.
- Providers come from the pi-ai catalog with keys stored in `<data>/credentials.json` (0600). Ambient environment keys are ignored. A custom OpenAI-compatible endpoint covers local models.
- The server binds 127.0.0.1 by default. It serves the Host RPC v4 subset on `/rpc` (WebSocket), a JSON API plus server-sent events on `/api/*`, and the web client on `/`.
- Every request except health, session and pairing needs a paired device token: an HttpOnly SameSite=Strict cookie for browsers or `OX_HOST_TOKEN` (Bearer) for the `ox` CLI. Pairing codes are single use, expire after ten minutes and are invalidated after five wrong attempts. Devices can be revoked.
- Remote access is provided by a private network in front of the loopback listener, for example `tailscale serve`. Do not bind a public interface.

## RPC subset

`host.describe`, `profiles.list|inspect|update`, `files.list` (no folder grants), `conversations.list|get|open|new|send|stop|respond`, `providers.list`, `logs.list`. Conversation IDs are decimal Pi conversation IDs. The Host also sends `conversations.changed` notifications, which existing clients ignore.

## Web client pages

- Pairing: code and device-name fields; errors stay on the page.
- Conversations: sidebar list with unread and working states; transcript with user bubbles, Markdown replies, an activity trace, progress lines, choice cards and failures; composer with attachments, send and stop; per-conversation model picker; rename and delete with confirmation.
- Files: breadcrumb navigation, upload, new folder, open, download, move and delete with confirmation.
- Settings: default model, provider keys, custom endpoint, memory, Profile name, devices with revoke and pairing codes, Host details.
- Light and dark appearance, phone and desktop layouts, English and Simplified Chinese.

## Test plan

- Protocol: `bun test .agents/skills/test/protocol/client-host/linux-host.test.ts` starts a real Host with a scripted OpenAI-compatible model server and drives it with the `ox` CLI: authentication is required, describe/list/new/send/inspect/respond/stop conform to the v4 contract, an `execute` script writes a file to disk, a choice prompt reports `needsAttention`, and conversations survive a Host restart.
- Pairing and API: an unpaired request receives 401, a wrong code is rejected, a correct code pairs once, cross-origin writes are refused, and a revoked device loses access.
- Rendered review: desktop (1440×900) and phone (390×844) screenshots in light and dark for pairing, empty conversation, running and completed turns with activity, a pending choice, Files and Settings. Keep screenshots outside the repository.
- Deployment: systemd user service on the Spark bound to 127.0.0.1; verify with the CLI through an SSH tunnel before enabling any private-network access.
