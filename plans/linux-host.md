# Linux Host

Goal: run OpenOx as an always-on Host on a Linux machine such as a DGX Spark, keep the Profile's conversations, memory and files on that machine, and reach it from a phone or desktop browser. The existing iOS and macOS Hosts are unchanged; this is an additional Host implementation.

Status: implemented as `apps/linux` (server, web client, device pairing, Ox VM modules) and `packages/agent/src/adapters/linux` (agent runtime adapter). The Ox VM work adds the native function surface: web fetch and search, the browser, services, repositories, secrets, skills, schedules, conversation and provider functions, attachments and OCR. Native iOS services (Calendar, Contacts, Location, Messages, Notifications, Reminders) stay unavailable on Linux. iOS remote-Host mode remains future work.

## Architecture

- One Bun process owns one Profile. Pi Durable state lives in `<data>/profiles/<id>/state/state.sqlite`; Profile content (MEMORY.md, skills, conversation folders and shared folders) lives as ordinary files in `<data>/profiles/<id>/files/` using the physical public-file store, so files added over SSH are reconciled.
- The model uses the production Ox prompt and the single `execute` tool. Scripts run in the pi-codemode QuickJS sandbox. `ox.fs.*` and `ox.user.*` are built into the adapter; every other namespace is a Host module in `apps/linux/src/vm/` registered through `HostFunctions` (handlers, prompt limitations, mounts, attached services, skills and HTTP routes). The catalog shown to the model lists only registered functions; anything else returns `not_supported`. Removed files move to the Host trash, not permanent deletion.
- Handlers receive a call context: user prompts (choice, approval, form, live page), `untimed` waits that do not count toward the 60-second active limit (service actions and handoffs, as on native), a per-execution budget (8 fetches, 4 attachments) and `evaluate` for skill scripts. Attachments return to the model as image or text content in the tool result.
- Headless Chromium (playwright-core) runs one persistent context per Profile in `<data>/profiles/<id>/vm/browser`. Every request and WebSocket from the browser, like every Host fetch, must resolve only to public addresses; loopback, private, link-local, Tailscale and multicast ranges are refused. Chromium sends all traffic, loopback included, through the Host's loopback egress proxy, which checks every connection (each redirect hop, workers and WebSocket tunnels) and connects to the address it checked; WebRTC may not use UDP outside the proxy. Chromium's own sandbox cannot start under Ubuntu's AppArmor user-namespace restriction, so the browser runs without it as the Host user.
- `repositories/` in the agent's file system is one mount: `bundled/` (read-only, `apps/shared/Resources/OxServices.bundle`), `local/` (read-write, `<data>/profiles/<id>/vm/repositories/local`) and connected Git snapshots (read-only). This is the layout the evolve skill uses to author services.
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

### Ox VM page changes

- Conversation, approval card: title, body and an optional monospace detail (service action and arguments). Buttons Approve (primary), Always approve and Deny. Once answered it collapses to a one-line result.
- Conversation, form card (secrets and API keys): title, body and one labelled field per input; secret fields are password inputs, multiline fields are text areas, optional fields carry an "Optional" tag. Save and Cancel. Values are never echoed; the resolved card says Submitted or Cancelled.
- Conversation, live page handoff card: title, body, a thumbnail of the page that opens the viewer, the Done action (its label comes from the request) and Cancel.
- Conversation, live page card in the reply (non-blocking showPage): page title and host with an Open action; a closed page reads "Page closed".
- Live page viewer (overlay above the conversation; full screen on phones, large sheet on desktop): close, title and host, back, forward, reload; the page image fills the body and taps, clicks, wheel and touch scrolling are sent to the page; on desktop key presses go to the page, on phones a keyboard bar sends typed text plus Enter and Backspace. Popups appear as tabs. When a handoff waits on this page, a bottom bar shows its text with Done. States: connecting, closed page.
- Sidebar: Services, Skills and Schedules join Files and Settings.
- Services page: search; available services (letter avatar, name, domain, source repository, Sign in for services with login, Reset approvals when any action is always approved); a separate list of services unavailable on Linux with the reason. Repositories section: Built-in, Local and connected Git repositories with sync, enable or disable, remove, and a Connect form for a public HTTPS Git URL. Secrets section: saved secret names and fields with Delete; values are never shown.
- Skills page: system, Profile and repository skills with source and description; Delete for Profile skills with confirmation.
- Schedules page: name, recurrence, next run, last result and state; Run now, Pause or Resume, Delete with confirmation, and a link to the last run's conversation. Empty state explains that schedules are created by asking Ox.
- Settings, custom endpoint: an "Accepts images" switch so image attachments reach local vision models.

## Test plan

- Protocol: `bun test .agents/skills/test/protocol/client-host/linux-host.test.ts` starts a real Host with a scripted OpenAI-compatible model server and drives it with the `ox` CLI: authentication is required, describe/list/new/send/inspect/respond/stop conform to the v4 contract, an `execute` script writes a file to disk, a choice prompt reports `needsAttention`, and conversations survive a Host restart.
- Pairing and API: an unpaired request receives 401, a wrong code is rejected, a correct code pairs once, cross-origin writes are refused, and a revoked device loses access.
- Rendered review: desktop (1440×900) and phone (390×844) screenshots in light and dark for pairing, empty conversation, running and completed turns with activity, a pending choice, Files and Settings. Keep screenshots outside the repository.
- Deployment: systemd user service on the Spark bound to 127.0.0.1; verify with the CLI through an SSH tunnel before enabling any private-network access.

### Ox VM test packets

- Packet VM-1, protocol suites (scripted model, loopback fixture sites allowed through `OX_HOST_TEST_ORIGINS`): `linux-host-web` (fetch, redirects, limits, feeds, PDF, attach, OCR, private-address refusal), `linux-host-browser` (all browser functions, capture, scripts, PDF export, user interaction handoff, scheme and address refusal), `linux-host-services` (catalog, inspect, attach, invoke with schema checks, approvals and Always approve, iOS refusal, validation, search merge, secrets, conflicts, repository connect and sync) and `linux-host-workspace` (skills, schedules, conversation and provider functions).
- Packet VM-2, prompt cards: approval, form and live page handoff cards in light and dark on desktop and phone, answered through the UI; secret values never appear in the DOM after submission.
- Packet VM-3, live page viewer: open from a card, frames render at phone and desktop sizes, tap, scroll, type, back, popup tab, Done resolves the handoff, closed page state.
- Packet VM-4, management pages: Services (sign in through the viewer, reset approvals, connect, sync, disable and remove a repository, delete a secret), Skills (list, delete) and Schedules (run now, pause, resume, delete, open last run).
- Packet VM-5, real model on the Spark with the local model: web search with a cited summary, fetching and summarizing an article, browsing and exporting a PDF, a bundled service action (Wikipedia, Hacker News), creating and running a skill, a scheduled check, image OCR and description, and starting a second conversation. Review the transcripts and the rendered UI.
