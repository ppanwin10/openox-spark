# Linux Host

Goal: run OpenOx as an always-on Host on a Linux machine such as a DGX Spark, keep the Profile's conversations, memory and files on that machine, and reach it from a phone or desktop browser. The existing iOS and macOS Hosts are unchanged; this is an additional Host implementation.

Status: implemented as `apps/linux` (server, web client, device pairing, Ox VM modules) and `packages/agent/src/adapters/linux` (agent runtime adapter). The Ox VM work adds the native function surface: web fetch and search, the browser, services, repositories, secrets, skills, schedules, conversation and provider functions, attachments and OCR. Native iOS services (Calendar, Contacts, Location, Messages, Notifications, Reminders) stay unavailable on Linux. iOS remote-Host mode remains future work.

## Architecture

- One Bun process owns one Profile. Pi Durable state lives in `<data>/profiles/<id>/state/state.sqlite`; Profile content (MEMORY.md, skills, conversation folders and shared folders) lives as ordinary files in `<data>/profiles/<id>/files/` using the physical public-file store, so files added over SSH are reconciled.
- The model uses the production Ox prompt and the single `execute` tool. As in the native app, every user message reaches the model after a line with when it was sent and the Host's time zone, such as `[Sun 2026-11-08 08:19 America/Los_Angeles]`; the transcript keeps the user's own text. A tool call whose arguments cannot be read (invalid JSON or missing required fields) goes back to the model as an error that quotes what it sent; five replies in a row whose tool calls are all unreadable stop the run with an explanation, so a model stuck on them cannot loop. Scripts run in the pi-codemode QuickJS sandbox. `ox.fs.*` and `ox.user.*` are built into the adapter; every other namespace is a Host module in `apps/linux/src/vm/` registered through `HostFunctions` (handlers, prompt limitations, mounts, attached services, skills and HTTP routes). The catalog shown to the model lists only registered functions; anything else returns `not_supported`. Removed files move to the Host trash, not permanent deletion.
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
- Settings: a ChatGPT-style dialog with General, Models, Profile, Devices and security, and About tabs (see below).
- Light and dark appearance, phone and desktop layouts, English and Simplified Chinese.

### Ox VM page changes

- Conversation, approval card, as in the phone app and ChatGPT's confirmations: a small line naming the source and the action (Ox · Create a schedule), then what the agent says it is for and any disclosure. A schedule also shows a summary: its name, when it runs in words (such as Daily at 9:00, with the Host's time zone when it differs from the viewer's, and a date for runs a week or more away) and what it will do. The raw arguments stay behind an ⓘ Show details button. Buttons Deny, Always approve and Approve (primary). Once answered it collapses to a one-line result.
- Conversation, form card (secrets and API keys): title, body and one labelled field per input; secret fields are password inputs, multiline fields are text areas, optional fields carry an "Optional" tag. Save and Cancel. Values are never echoed; the resolved card says Submitted or Cancelled.
- Conversation, live page handoff card: title, body, a thumbnail of the page that opens the viewer, the Done action (its label comes from the request) and Cancel.
- Conversation, live page card in the reply (non-blocking showPage): page title and host with an Open action; a closed page reads "Page closed".
- Live page viewer (overlay above the conversation; full screen on phones, large sheet on desktop): close, title and host, back, forward, reload; the page image fills the body and taps, clicks, wheel and touch scrolling are sent to the page; on desktop key presses go to the page, on phones a keyboard bar sends typed text plus Enter and Backspace. Popups appear as tabs. When a handoff waits on this page, a bottom bar shows its text with Done. States: connecting, closed page.
- Navigation: as in the phone app, the sidebar holds New chat, Search, the conversations and Settings. Files, Skills and Memory are in Settings → Profile, and Services and Schedules open from Settings; each page keeps its own address.
- Services page: search; available services (letter avatar, name, domain, source repository, Sign in for services with login, Reset approvals when any action is always approved); a separate list of services unavailable on Linux with the reason. Repositories section: Built-in, Local and connected Git repositories with sync, enable or disable, remove, and a Connect form for a public HTTPS Git URL. Secrets section: saved secret names and fields with Delete; values are never shown.
- Skills: system, Profile and repository skills with source and description in Settings → Profile; Delete for Profile skills with confirmation.
- Schedules page: name, recurrence, next run, last result and state; Run now, Pause or Resume, Delete with confirmation, and a link to the last run's conversation. Empty state explains that schedules are created by asking Ox.
- Settings, custom endpoint: an "Accepts images" switch so image attachments reach local vision models.

### Ox design system

The web client takes its visual language from [DESIGN.md](../DESIGN.md), the phone app's design system: colours, type, shapes, components and layout metrics, with native points used as CSS pixels. ChatGPT stays the reference for streaming, scrolling and the settings dialog's tabs (next section). Where DESIGN.md and `apps/ios/Client/UI/Theme.swift` differ, Theme.swift wins: dark code blocks use `surface` (`#1C1C1E`).

- Colour, using DESIGN.md's Light and Dark tokens:
  - The conversation canvas and the sidebar are `#FFFFFF` / `#0A0A0A`.
  - Grouped pages (Files, Services, Schedules and the settings body) use `background` (`#F2F2F7` / `#0A0A0A`) with `surface` groups (`#FFFFFF` / `#1C1C1E`) and no borders.
  - Text is `#000000` / `#ECECEC`; supporting text is `#666666` / `#9A9A9A`; muted text is `#8E8E93` / `#9A9A9A`.
  - The orange `primary` (`#FFA500` / `#F5A030`) marks primary actions, active states and confirmation only. Send and stop use `composer-send` (`#FF9500`), and errors `#B8422E` / `#E25A45`.
- Type:
  - System UI at 17px for body text and replies. On desktop, dense lists (sidebar, menus and settings rows) use 15px.
  - `ui-rounded` at 22px semibold for headings and 15px semibold for labels (buttons, chips, toasts and tags).
  - Monospace only for code, URLs and arguments.
- Shapes:
  - Capsules for buttons, chips, standalone fields and information toasts.
  - 24px radius for the composer, user bubbles, code blocks, settings groups and error toasts.
  - 18px radius for request and live-page cards.
  - Circles for navigation controls.
- Buttons:
  - Primary is an orange capsule with white label text; secondary is a `surface-sunken` capsule.
  - Actions inside settings rows are capsules of orange at 14% with orange text.
  - Pressed buttons drop to 70% opacity, and touch targets are at least 44px.
- Conversation:
  - One 700px reading column with 20px between blocks.
  - User bubbles are neutral grey (`bubble`), 24px round with 14px by 12px padding; replies have no bubble.
  - Links keep the text colour with a dotted underline. Inline code is grey monospace without a fill; code blocks sit on the code surface with a 1px border.
  - The empty state reads "Start a conversation".
- Composer:
  - Glass (a translucent surface with a blur) with a 24px radius.
  - While empty and unfocused it is 84% wide and centred; it widens when focused or holding text or attachments.
  - Starter and follow-up suggestions sit inside the glass above the text field.
  - The send and stop button is a `composer-send` circle with a white icon.
- Request cards:
  - No fill, a 1px outline of the muted colour at 18%, and 16px padding.
  - The head is an 18px icon with "Ox · action" (or "Service · action") in 12px semibold supporting text. ⓘ opens an Arguments dialog.
  - Purpose and disclosure follow in 15px. The buttons are Approve (primary), then Always approve and Deny (secondary), as 36px capsules.
- Toasts: glass with label type.
  - Information is a capsule with an orange check and leaves after 1.8 seconds.
  - An error has a 24px radius and a warning icon in the error colour, and stays until dismissed.
- Navigation, as in the phone app:
  - The sidebar holds New chat, Search, the conversations and Settings.
  - Files, Skills and Memory are in Settings → Profile; Services and Schedules open from Settings. The pages keep their addresses.
- Activity: before the first text and while a step runs, the cellular-automaton loader (rule 75 on a 4 × 4 grid, 0.15 seconds per generation, static under reduced motion) shows beside a shimmering label, "Plowing…" (耕耘中…) or the running step.
- Copy shared with the phone app uses its words, such as 批准, 始终批准 and 拒绝, and 开始对话.
- Motion: 0.2-second smooth transitions without bounce. Reduced motion removes movement; reduced transparency replaces glass with solid surfaces.
- Contrast: white text on the orange primary is below WCAG AA (about 2:1), as in the phone app. Primary buttons therefore use semibold labels and stay rare.

### ChatGPT-style interface and streaming

Reference for behaviour: the ChatGPT web app, measured in a browser on desktop (1440×900, light) and phone (iPhone 15, dark).
- Streamed text fades in, and the composer turns into Stop immediately.
- When sent, the user's message moves to the top of the view, and the reply grows below it without the page following it.
- A round button returns to the latest text.
- Settings is a dialog with tabs.

Colours, type and shapes follow the Ox design system above.

- Design system: one set of tokens and one component for each of: button (primary, secondary, ghost and danger capsules), icon button (circle), field, card, row (title, description, trailing control or ⋯ menu), section title, tag, switch, menu (anchored popover), dialog and toast. Every page uses these; no page-specific variants.
- Conversation:
  - No title bar. The model picker sits at the top left (desktop) or centre (phone), with a ⋯ menu for rename and delete.
  - Empty state: a centred heading with the composer below it; sending moves the composer to the bottom.
  - Replies render without a bubble, with a copy action under each finished reply.
  - Tool activity is a one-line summary (the loader and the running step while working) that expands to the steps.
  - A round button above the composer scrolls to the latest text when the view is away from it.
- Streaming: the Host commits partial replies every 50 ms and sends each text and reasoning delta over the event stream with the item it extends, so the client appends text without reloading the conversation. When a reply is committed, the Host sends the rest of each part with a final mark. Block IDs come from the assistant message timestamp, so a reply keeps its block when it is committed. The client reveals buffered text at a steady per-frame pace, hides unfinished bold, code and link syntax until the part is final, updates only the changed parts of the rendered reply, and keeps unchanged blocks in place.
- Sending: the user bubble, the Stop button and the pulsing dot appear before the request returns; a failed send restores the draft. A new conversation appears at the top of the sidebar at once. Conversations open from a cache and refresh in the background. On desktop the composer keeps focus after sending.
- Sidebar: brand row with a collapse button (desktop), New chat, a Search field that filters the conversations by title, conversations grouped by Today, Yesterday, Previous 7 days, Previous 30 days and Older, and a Profile row that opens Settings. On phones it is a dimmed slide-over drawer with a New chat capsule and a Settings button; choosing a row closes it.
- Files, Services, Schedules and Settings: centred 700px column on the grouped background, page title in the header, section titles 8px above 24px-round groups of rows and 32px between sections; secondary actions move into ⋯ menus (files, skills, schedules) and primary actions are capsules.
- Pairing: logo, a rounded heading, code and device-name fields and a full-width 44px orange capsule, as in the phone app's onboarding.

### Settings, local media and skills

Reference: ChatGPT's settings dialog. On desktop it is a centred dialog over the current page with a tab list on the left and the tab's rows on the right; on phones it is a full-screen sheet that lists the tabs first and opens a tab with a back button. Each row has a title, an optional description and one control on the right (select, switch, button or ⋯ menu); rows are separated by hairlines and nothing is typed inline. The Host machine's models are our own deployments; the Host does not call another product's services.

- Opening: the Profile row and the phone drawer's settings button open the dialog over the page underneath; `#/settings/<tab>` opens a tab directly; Escape, the close button or a click outside closes it and returns to the page underneath. Tabs: General, Models, Profile, Devices and security, About. The old `#/skills`, `#/settings/skills` and `#/settings/personalization` links open Profile.
- General: Appearance (System, Light, Dark) and Language (Auto, English, 简体中文), saved in the browser and applied at once.
- Models: the default model, used for new chats, offering every model below. Local machines: each paired computer that runs a model server (vLLM, Ollama, LM Studio or any OpenAI-compatible server on the network or Tailscale) with its name, address, This machine for the Host itself, Connected or Can't connect with the reason, and a ⋯ menu to edit or remove it; under it one row per model it serves, with aliases of the same weights shown once and what each can do. Pair a local machine asks for an address (such as `spark-2:8000`), an optional name and key, and whether it reads images; the Host lists the machine's models and adds one ID per set of weights. Any number of machines can be paired; the first keeps the `custom` provider ID that `install.sh --model-url` sets. Then this machine's capabilities with their state (speech recognition, read aloud, image generation: ready, loads on use, loading, not installed, not enough memory), and AI providers as rows with Add key or Remove key. A new chat whose model disappears falls back to the default.
- Profile: the profile name and Memory, each edited in a dialog, then Skills, as in the phone app's Settings → Profile. Skills shows every skill with an on/off switch, its source, description and when it was last used; New skill (name, description, instructions) and Upload (a SKILL.md file) open dialogs; a ⋯ menu deletes your own skills. A skill that is off is left out of the agent's skill list and cannot be run.
- Devices and security: paired devices with Revoke, Pair a new device, and always-approved actions with Forget and Forget all. Pair a new device shows the code and, when the page was opened on an address other than localhost, a QR code for `<origin>/#/pair/<code>`; the code sits in the URL fragment, so it never reaches the server's request log. Opening that link fills in the code and a device name, focuses Connect and removes the code from the address bar. `openox-host pair` prints the same QR code in the terminal for the `--url`, `OPENOX_PUBLIC_URL` or Tailscale address, and `deploy/tailscale.sh` prints one when it finishes.
- About: Host name, version and storage, and Sign out.
- Local media service (`apps/linux/media`): a Python user service on loopback with OpenAI-compatible endpoints for speech recognition (Qwen3-ASR-0.6B), read aloud (Qwen3-TTS-12Hz-0.6B-CustomVoice), image generation (Z-Image-Turbo) and media extraction (video frames and the audio track's transcript). Models load on first use and unload when idle; a load is refused with an explicit error when the machine lacks memory for it.
- Using it: a microphone button in the composer records speech and puts the transcript in the composer; finished replies get Read aloud next to Copy; the agent can generate images, which are saved in the conversation folder and shown in the reply; audio attachments are transcribed, video attachments reach the model as sampled frames plus the transcript, Word, Excel and PowerPoint files are read through LibreOffice, and scanned PDF pages reach the model as page images.

### Parity with the phone app

Everything a person can do in the phone app should also work in the web client, except what needs the phone itself. The November 2026 audit compared `apps/ios/Client/Features` with `apps/linux/web` and the Host API. The gaps are built in the order below; each packet ships with its Host API, protocol tests and a rendered check.

- PAR-1, conversation actions:
  - Under a reply, in this order: Copy, Read aloud (when the media service is on), Share (when the browser can share), Branch and Regenerate. Branch and Regenerate are disabled while the conversation is working and absent in a temporary conversation.
  - Regenerate: after "Regenerate this reply?", it starts a new conversation from before the prompt that produced the reply, sends that prompt again with its attachments in the conversation's current model, and opens it. As on the phone, the original is kept but no longer listed.
  - Branch: after "Branch into a new conversation?", it opens a new conversation with everything up to that reply, under the same title. Both stay listed.
  - Under a user message, shown on hover or, on a phone, by tapping the message: Copy and Edit. Edit puts the text in the composer under an "Editing message" chip, which cancels when tapped, and hides "+". Sending starts a new conversation from before that message with the new text and the message's original attachments; the original is no longer listed.
  - A forked or regenerated conversation keeps the attached services.
  - The conversation ⋯ menu adds Copy: the conversation as readable text ("You:" and "Ox:" sections, with the names of attached files). The phone app copies its JSON export instead; the web copies text people can paste.
  - Export and Import (PAR-1b): the ⋯ menu's Export downloads a `.conversation` package in the phone app's format.
    - The package is a ZIP of stored entries: `conversation.json` (sorted keys, dates in seconds since 2001), `turns.jsonl` and `artifacts/<file>`. Each payload file is declared with its size and SHA-256.
    - User turns carry their text and attached files. Agent turns carry reasoning, text and code steps with their results, and consecutive agent turns are merged.
    - Import is under Settings → Profile, and choosing a `.conversation` file in the composer opens it too. It shows the title, the message count, the files and their size, a compacted-context note and the services used, which are not attached.
    - Import checks the limits (128 MiB archive, 32 MiB per file, 256 entries), the declared files and their checksums, and the versions. It then adds the conversation in the default model, so it can be continued, branched and exported again.
  - A new chat can be made temporary with the dashed-bubble button in its header; the empty state explains it and the conversation shows a Temporary badge. It is not listed, and it is deleted when you leave it or close the page. The Host also removes temporary conversations idle for six hours.
  - Host:
    - User messages in the transcript carry their entry ID.
    - `POST /api/conversations/<id>/branch {entry}` and `POST /api/conversations/<id>/rerun {entry, text?}` fork at the message's turn; `POST /api/conversations {temporary: true}` creates a temporary conversation.
    - They refuse while the conversation is working (409), in temporary conversations, and for unknown messages (404).
- PAR-2, composer:
  - "+" opens a card (270px wide, glass, 24px radius) like the phone app's. Each row has a 44px grey circular icon and a label:
    - Camera, on touch devices; it uses the camera capture input.
    - Photos: images and videos.
    - Files.
    - Services.
  - Services, and typing "@" in the text, open a service picker:
    - Choosing Services inserts "@" into the text. While the text ends in "@query", a glass panel above the composer lists matching services that are not attached yet, saved services first and at most 40. Each row shows a 24px avatar and the name.
    - The panel is headed "Services", which opens Settings → Services, and reads "No services found" when nothing matches.
    - Choosing a service removes "@query" and attaches the service to the conversation.
    - Attached services show as chips in a strip above the composer, each with its avatar, name and ✕ to detach it.
    - In a new chat, the chosen services are attached when the conversation is created, before the first message is sent.
  - Host:
    - `GET /api/services?conversation=<id>` marks the services attached to that conversation.
    - `POST /api/services/<domain>/attach` with `{conversation}` and `DELETE /api/services/<domain>/attach?conversation=<id>` attach and detach a service without asking, because the user chose it.
    - Attaching or detaching refreshes the conversation's turn state. Native iOS services and unknown conversations are refused.
  - Still to come: pasted images and files, skills from the composer, the conversation's files, and press-and-hold for the microphone on phones.
- PAR-3, settings and services. As in the phone app's Settings, Permissions, Services, Repositories and Secrets are entries of their own, each with a summary value (the default policy, the number of services, how many repositories are enabled):
  - The sections of the Services page move into those entries, and `#/services` opens Settings → Services.
  - Permissions:
    - All Actions (Ask, Always allow or Block).
    - Built into Ox: All built-in actions, then the actions grouped by feature.
    - One entry per service: All service actions, Attach to a conversation, then each of its actions.
    - Every row has a menu that can also inherit the wider setting.
    - A deeper page takes its name as the title, and one back button in the header goes up a level, as on the phone.
    - Backed by `GET /api/permissions` and `PUT /api/permissions` (`{scope: default|source|action, id, policy}`).
  - Repositories read as on the phone: the name, then the number of services and skills and where they come from (Included with Ox, Editable on this Host, or when it last synced). Built-in can be turned off and on; Local is always on.
  - Secrets: Add secret and Edit, with a key, a display name, and fields that each have a name and a value. When editing, an empty value keeps the saved one. Backed by `POST /api/secrets` and `PUT /api/secrets/<key>`.
  - Each available service opens a detail page inside Settings, as on the phone. Its name is the title, and the header's back button returns to the list. The page shows:
    - the service's icon, name and domain, with Save/Saved, Start conversation (opens a new chat with the service attached) and Sign in;
    - the description, or "No description.";
    - Actions: Default for This Service (Use Global Default, Ask, Allow, Block); Attach to a conversation with its explanation; and every action with its description, Standard and Authenticated tags, and a policy (Use Service Default, Ask, Allow, Block). Standard actions have no policy;
    - Domain (Endpoint for MCP) and Repository, with Included with Ox or the last sync;
    - Inspect service page (opens the website in the page viewer); Share Service (Local website and API services); Clear website data, after "Clear website data?", which removes cookies and stored data for the service's origins; Remove MCP server; and Delete Local service, after "Delete Local service?".
  - Import service, under the list, takes a `.service` package in the phone app's format: a ZIP with `package.json` (`version`, `kind`, `domain`) and the source under `services/<kind>/<domain>/`, at most 4.5 MB, 64 files and 4 MB of source. A `.service` file chosen in the composer opens it too when it is a ZIP; any other file with that name is attached like a normal file. The same applies to `.conversation` files.
    - The preview shows the name, domain, description and actions, and says permissions and login are set up on this Host.
    - When a Local service has the same ID, Replace Service changes its source; another kind on the same domain, or a folder that Local doesn't list, is refused.
    - The package is unpacked into a scratch folder and checked like any Local service (manifest, files and `actions.js`). Only then does it take the place of the old source, which comes back if anything fails. The service then opens.
  - Host:
    - `GET /api/services/<domain>` for the details; `PUT …/saved`; `POST …/page`; `DELETE …/website-data`; `GET …/package`; `DELETE /api/services/<domain>` for Local services;
    - `POST /api/service-imports` to preview, then `POST /api/service-imports/<token> {replace}` to install, or `DELETE` to discard. Imports have their own route, so a service named `import` is never mistaken for one.
  - The agent's bot-check and payment handoffs use the live page viewer.
- PAR-4, schedules and skills. As on the phone, schedules are created by asking Ox; the web adds no New schedule form.
  - PAR-4a, schedule details and editing:
    - When Ox creates a schedule, a row under that step shows a clock, the schedule's name and how it repeats. If the schedule is off, the row says Paused, Expired or Finished; if it was deleted, "Schedule unavailable". The row follows changes to the schedule.
    - Selecting the row, or a schedule on the Schedules page, opens its details: the prompt; Stop when, Deadline, Repeat and Next run (while on, in the schedule's time zone, which is named when it differs from the browser's); the last failure; and Delete schedule, after "Delete this schedule?" ("Future runs will stop. Your conversations will be kept."). The header has Edit, which is disabled while a run is in progress, and Pause or Resume while the schedule has a next run.
    - Edit opens an editor with:
      - Name and Prompt;
      - Repeat: Once with a date and time, Interval with every N seconds (at least 30), Daily with a time, or Weekly with a day and a time. Daily and weekly times are in the schedule's time zone, which is named when it differs from the browser's;
      - Stop when (optional), with "Each run checks this condition. A repeating schedule and deadline are required.";
      - Deadline, with Stop after.
    - Saving checks the same rules as creating a schedule. It re-arms a finished or expired schedule, keeps a paused one paused, and shows any error in the editor. The Schedules page's ⋯ menu also has Edit.
    - Host: `PATCH /api/schedules/<id>` with `name`, `prompt`, `condition`, `deadline` and `recurrence`. Schedule rows include `condition` and `deadline`. A successful `ox.schedule.create` step records the schedule's ID and name in its result, so the transcript can find it after a reload.
  - PAR-4b, scheduled messages and skill rows:
    - A message a schedule sends shows as a clock with the schedule's name instead of its prompt, as on the phone. This applies in new conversations and in the conversation a schedule is bound to, and the message has no Copy or Edit. The ⋯ menu's Copy writes "Schedule: <name>" for it.
      - The Host records the schedule's name against the run's request ID and resolves it to the message once the run ends. If the Host stopped mid-run, the first view after the restart resolves it. Branches resolve it when they are made. A run that never placed its message drops the name. A conversation keeps the last 2,000 names.
      - Exported packages carry `scheduleName` in the phone app's format, and importing one restores the clock.
    - When Ox creates or copies a skill, writes its `SKILL.md`, or reads it to use the skill, a row under that step shows `/name` and its description, as on the phone. Built-in skills get no row, and a deleted skill says "Skill unavailable".
    - Selecting the row, or a skill in Settings → Profile, opens the skill: its description and its instructions as Markdown. Edit changes the description and instructions of a skill in the profile or the Local repository; other skills have no Edit. Renaming stays on the phone. If Ox changed the skill after it was opened, Save explains this instead of overwriting the change.
    - Host:
      - `GET /api/skills/<name>` returns the instructions, whether the skill is editable, and a revision;
      - `PUT /api/skills/<name>` refuses with 409 when the revision it sends is out of date;
      - skill rows say whether a skill is built in;
      - skill steps record the skill's name in their result.
- PAR-5, reply rendering, as on the phone: syntax-highlighted code, diff blocks, Mermaid diagrams, the image and video widgets (`ox.widget.image`, `ox.widget.video`), inline canvas cards and the reasoning view.
- PAR-6, memory and app functions:
  - The agent can read and edit memory (`ox.memory.read`, `write` and `replaceText`), and can read or change the app's language, default model, action permissions and notification state (`ox.app.*`).
  - Settings → Profile adds Personal context, and the empty state offers Import memory to Ox.
  - The first run shows the phone's "A few things to know", and About lists What's New.
- PAR-7, notifications: web push to paired browsers when a schedule finishes or an action waits for approval, with a Stay notified setting. On an iPhone this needs the web app added to the Home Screen.
- PAR-8, files: HTML files open in a sandboxed view; Markdown files render and can be edited; files show thumbnails; images zoom; and a reply lists the files the agent changed.
- Stays on the phone: the iOS services Calendar, Contacts, Messages and Reminders, Apple Pay, and the phone's own location. Browser location may be offered later.
- Not yet decided:
  - The Host keeps one profile, so every paired device sees the same conversations, files and memory. Multiple profiles, one per person, need a design with per-device access before they are built.
  - Until then, saved secret values stay hidden on the web, because any paired device could read them.

## Model packs

A model pack is a tested local model the Host can use without the user choosing an engine, flags or weights. Each pack is `apps/linux/packs/<pack>/pack.json`, run by the shared `apps/linux/packs/pack.sh`; packs ship and are versioned with the Host. The Host never starts or stops a pack and talks to it like any other local machine, so a pack can also run on another computer that the Host pairs with.

- A manifest pins the engine image (an explicit tag, never `latest`), the model's Hugging Face repository and 40-character revision, its license, the engine flags, the served model ID and whether it reads images, and states the hardware it fits: architecture, GPU, total memory, free memory to start and disk. The runner sets the serving flags (address, port and served model name) itself.
- `spark-qwen3.6-35b` is the configuration measured on a DGX Spark: NVIDIA's vLLM 26.10 image (vLLM 0.31.0) serving Qwen3.6-35B-A3B in NVFP4 with a 131,072-token context, an FP8 KV cache, 30% of GPU memory, `qwen3_coder` tool calls and `qwen3` reasoning; one user gets about 78 tokens/s.
- `install` refuses a machine that does not fit. It pulls the image, downloads the pinned revision inside it as the user (or takes `--weights`), checks every file's size and every large file's SHA-256 against the Hugging Face listing for that revision, and creates a container bound to `127.0.0.1` with the weights read-only. The engine sees only that folder, so a file that is a link (as in a Hugging Face cache snapshot) is refused with the command that makes a usable copy. It then starts the pack.
- `start` waits for `/health`, then adds the model to the Host through the settings API with a temporary device token that it revokes: as the default model when no local machine is paired, otherwise as another local machine. When a local machine already has the pack's address but lists another model, that machine is switched to the pack's model, and so is the default when it pointed there; when it already lists the model, nothing changes. A pack whose first start failed is therefore added once it starts. A start that exits or does not answer within 20 minutes is stopped and reported with the engine's last log lines; a busy port is refused.
- Starting is refused while free memory is below the pack's requirement unless `--force` is given. `stop` keeps the pack stopped across reboots; `remove` asks for the pack name, and `--purge` also deletes the pack's download folder (even after an earlier plain `remove`) and its engine cache, never weights given with `--weights`.

## Test plan

- Protocol: `bun test .agents/skills/test/protocol/client-host/linux-host.test.ts` starts a real Host with a scripted OpenAI-compatible model server and drives it with the `ox` CLI: authentication is required, describe/list/new/send/inspect/respond/stop conform to the v4 contract, an `execute` script writes a file to disk, a choice prompt reports `needsAttention`, conversations survive a Host restart, each user message reaches the model after its send time and the Host's time zone, and unreadable tool calls go back to the model, several in one reply included, while five replies in a row of them stop the run.
- Pairing and API: an unpaired request receives 401, a wrong code is rejected, a correct code pairs once, cross-origin writes are refused, and a revoked device loses access.
- Rendered review: desktop (1440×900) and phone (390×844) screenshots in light and dark for pairing, empty conversation, running and completed turns with activity, a pending choice, Files and Settings. Keep screenshots outside the repository.
- Deployment: systemd user service on the Spark bound to 127.0.0.1; verify with the CLI through an SSH tunnel before enabling any private-network access.

### Ox VM test packets

- Packet VM-1, protocol suites (scripted model, loopback fixture sites allowed through `OX_HOST_TEST_ORIGINS`): `linux-host-web` (fetch, redirects, limits, feeds, PDF, attach, OCR, private-address refusal), `linux-host-browser` (all browser functions, capture, scripts, PDF export, user interaction handoff, scheme and address refusal), `linux-host-services` (catalog, inspect, attach, invoke with schema checks, approvals and Always approve, iOS refusal, validation, search merge, secrets, conflicts, repository connect and sync) and `linux-host-workspace` (skills, schedules, conversation and provider functions).
- Packet VM-2, prompt cards: approval, form and live page handoff cards in light and dark on desktop and phone, answered through the UI; secret values never appear in the DOM after submission.
- Packet VM-3, live page viewer: open from a card, frames render at phone and desktop sizes, tap, scroll, type, back, popup tab, Done resolves the handoff, closed page state.
- Packet VM-4, management pages: Services (sign in through the viewer, reset approvals, connect, sync, disable and remove a repository, delete a secret), Skills in Settings → Profile (list, delete) and Schedules (run now, pause, resume, delete, open last run).
- Packet VM-5, real model on the Spark with the local model: web search with a cited summary, fetching and summarizing an article, browsing and exporting a PDF, a bundled service action (Wikipedia, Hacker News), creating and running a skill, a scheduled check, image OCR and description, and starting a second conversation. Review the transcripts and the rendered UI.
- Packet UX-1, protocol: a streamed reply delivers stream events whose deltas rebuild the final text exactly, its block ID before and after the commit is the same, and text deltas do not trigger conversation reloads.
- Packet UX-2, side-by-side with ChatGPT (desktop light and phone dark, the same prompt; OpenOx uses a scripted model streaming at ChatGPT's rate): record videos and per-frame metrics. Pass when the user bubble and Stop button appear within 50 ms of sending, the reply element is created once, the page does not scroll by itself while streaming, the user's message stays at the top, the reply text updates at least as often as ChatGPT's and in smaller steps, the picture never holds still for more than 80 ms while text on screen is streaming (text growing below the composer is excluded, since neither app follows it), layout shift stays under 0.02 and no task blocks for more than 50 ms.
- Packet UX-3, rendered review of every page (pairing, new chat, reply, activity, approval, form, page handoff, viewer, sidebar or drawer, Files, Services, Schedules, Settings, menus) in desktop light Chinese, phone dark Chinese, desktop dark English and phone light English, compared with the ChatGPT reference screens. The same run checks the edge cases: a streaming reply with bold, code and a link never shows raw markers; Copy returns the whole reply; a follow-up or an attach-first chat leaves no draft in the next new chat; sending after attaching in a new chat moves to the chat layout with the composer on screen; a failed send restores the text, and when the user has moved to another chat it leaves that chat alone and keeps the text as the first chat's draft; leaving a new chat while it is being created keeps the chosen chat; the closed phone drawer is skipped by Tab and Escape returns focus to its button.
- Packet UX-5, approval cards: a schedule approval shows the source line, the purpose and a summary in words for a once (two weeks ahead, shown as a date), interval (90 seconds), daily and weekly schedule, with the Host's time zone when the browser is in another, and no raw arguments until Show details, which toggles them; an action without a summary (deleting a skill) shows its purpose; only a schedule approval gets a summary; rendered on phone dark Chinese and desktop light English; Approve, Always approve and Deny still answer, and the answered card collapses to one line.
- Packet PAR-1, conversation actions:
  - Protocol checks (`linux-host.test.ts`):
    - Branching at a reply copies the conversation through that reply, keeps its title and attached services, and leaves the original listed.
    - Regenerate sends the original prompt again with its attachments in a new conversation and unlists the original; Edit, including of the first message, sends the new text with the original attachments.
    - Bad, unknown and blank requests are refused, and branching while the conversation works answers 409.
    - A temporary conversation is never listed, cannot be branched and can be deleted.
  - Browser check in all four variants: the reply and message actions and their order, both confirmations, the regenerated reply, the branch, Edit with Cancel and the hidden "+", the copied text, and the temporary toggle, empty state, badge, deletion on leaving and reset.
- Packet PAR-1b, conversation packages:
  - Protocol checks (`linux-host.test.ts`): an exported conversation with an attachment, a code step and a service has the phone app's layout, sorted header, checksums, alternating turns and upper-case IDs; it imports with the same messages, the file, the activity and no attached service, and can be continued; a package written the way the phone app writes it imports; damaged files, undeclared entries, another version and non-ZIP data are refused; a staged import can be discarded.
  - Browser check in all four variants: Export from the ⋯ menu downloads `<title>.conversation`; Settings → Profile imports it with its summary and opens it; a `.conversation` file chosen in the composer opens the import instead of attaching; a broken package shows an error.
- Packet DS-1, design system:
  - Rendered review against DESIGN.md on phone dark Chinese, phone light English, desktop light Chinese and desktop dark English. Pages: pairing, the empty conversation, a reply with a link, inline code and a code block, running and finished activity, an approval card and its Arguments dialog, a form card, information and error toasts, the sidebar or drawer with search, Files, Services, Schedules, every Settings tab, and the menus and dialogs.
  - Computed styles: canvas, bubble, primary and secondary buttons, send button, the request card's outline and radius, and the composer's radius and its 84% resting width, which grows on focus.
  - Behaviour: the request button order; an information toast leaves after about 1.8 seconds while an error stays until dismissed; search filters the conversations; Files, Services and Schedules open from Settings.
- Packet PAR-2, composer attachments:
  - Protocol checks:
    - Attaching from the API marks the service as attached in the list and puts it in the conversation's turn state; detaching removes it.
    - An iOS service, an unknown service and an unknown conversation are refused.
  - Browser checks on phone dark Chinese and desktop light English:
    - The "+" card: Camera only on touch, and Photos accepting images and videos.
    - "@" and Services open the panel; search narrows it; "No services found" shows when nothing matches.
    - Choosing a service attaches it and shows a chip; ✕ detaches it.
    - A new chat attaches the chosen service before the first message.
- Packet PAR-3b, service details:
  - Protocol checks (`linux-host-services.test.ts`):
    - the details of a Local and a built-in service, with their actions, defaults and management rows;
    - Save;
    - opening the website;
    - clearing website data, after which the next call carries a new session cookie;
    - sharing a package in the phone app's layout;
    - previewing and replacing it, then importing a new service;
    - refusing a domain mismatch, missing `actions.js`, a manifest without its required fields, another version or kind, and non-ZIP data;
    - a replace that fails its checks, or has clashing paths, keeps the old service working;
    - a folder in Local that Local doesn't list is refused with 409 and keeps its files;
    - the details and Clear website data still work for a broken Local service;
    - `/api/services/import` is not an import route;
    - discarding an import;
    - deleting a Local service, and refusing to delete a built-in one.
  - Browser check in all four variants: open a service from the list; the title, description, actions, repository and management rows; the service default saved; Save toggles; Share downloads `<domain>.service`; Clear website data asks first; Import shows Replace Service, then opens the replaced service; a new package imports and is deleted after "Delete Local service?"; Inspect service page opens the viewer; Start conversation attaches the service to a new chat. Packet PAR-1b's browser check also confirms that a plain-text `.service` file in the composer attaches as a file.
- Packet PAR-4a, schedule details and editing:
  - Protocol checks (`linux-host-workspace.test.ts`):
    - a created schedule's step result carries its ID and name;
    - `PATCH` changes the name, prompt, repeat, condition and deadline and moves the next run;
    - it refuses an empty name, a condition without a repeat or deadline, a past time, a deadline before the next run and an invalid time zone;
    - it refuses with 409 while a run is in progress;
    - it keeps a paused schedule paused and re-arms an expired one;
    - an unknown ID is 404.
  - Browser check in all four variants:
    - the row under the agent's step, with its name and repeat;
    - details open from the row and from the Schedules page;
    - the editor shows the stored values;
    - switching Repeat shows the right fields;
    - a saved change updates the row, the details and the page;
    - a rule the Host refuses shows its message in the editor, in the error color, while fields hidden by Repeat or Deadline never block Save;
    - Pause, then Resume;
    - closing the details returns focus to the same row or card, and closing them after navigating away leaves the new page intact;
    - Delete asks, then the row says "Schedule unavailable".
- Packet PAR-4b, scheduled messages and skill rows:
  - Protocol checks (`linux-host-workspace.test.ts`):
    - a schedule's message carries its name, both in a new conversation and in the conversation it is bound to, where earlier messages carry none;
    - the names survive a Host restart, an export and import, and a branch, including a Host killed during a scheduled run and then branched;
    - creating a skill, writing its `SKILL.md` and reading it name the skill in their steps;
    - `GET /api/skills/<name>` returns the instructions and whether the skill is editable;
    - `PUT` edits a profile skill and a Local skill in place;
    - `PUT` refuses a built-in skill (403), an empty description (400) and an out-of-date revision after Ox edited the skill (409);
    - an unknown skill is 404.
  - Browser check in all four variants:
    - the clock message with the schedule's name and no actions;
    - the skill row with `/name` and its description, and no row for a built-in skill;
    - the skill opens from the row and from Settings → Profile;
    - Edit saves new instructions, which the open skill shows;
    - closing a skill edited from Settings returns focus to its own row;
    - a built-in skill has no Edit;
    - deleting the skill turns the row into "Skill unavailable".
- Packet PAR-3, settings entries:
  - Protocol checks: permissions read and write the default, source and action policies; inherit clears a setting; an approval follows the stored policy; secrets can be added, edited (an empty value keeps the old one) and deleted, without returning their values.
  - Browser checks, in all four variants:
    - Settings lists Permissions, Services, Repositories and Secrets with their values, and every row's chevron lines up.
    - Every page renders, and `#/services` opens Settings → Services.
    - A policy change survives a reload.
    - Each Permissions level shows its own title; the header's back button goes up one level, and on a desktop it is hidden at the top.
    - Repositories show translated names without a repeated label; Built-in turns off and on from its menu, and Local has no menu.
    - Adding and editing a secret works, its values never appear, and only editing explains that an empty value keeps the saved one.
    - The "@" panel never covers the top bar, and the chips stay above the composer while it moves down after the first message.
- Packet UX-4, the deployed Host on the Spark over the private network with the local model: record a phone and a desktop conversation and check the same streaming and scrolling behaviour.
- Packet ST-1, Settings rendered in desktop light and dark and phone light and dark, in Chinese and English, against ChatGPT's settings: tabs, rows and dialogs, Tab order, Escape and focus return, and that every change persists (appearance, language, default model, provider key, pairing, editing and removing a local machine, memory, profile name, pairing and revoking a device, forgetting approvals, sign out).
- Packet ST-2, skills protocol: a skill that is off is missing from the agent's skill list and `ox.skill.run` refuses it; New skill and Upload validate SKILL.md the same way as `ox.fs`; last used changes when the agent reads or runs a skill.
- Packet ST-3, local machines: protocol (`linux-host.test.ts`) pairs a second model server by `host:port`, picks the ID that matches its weights, refuses a duplicate and explains an unreachable address, keeps both machines across a Host restart, sends a chat to the chosen machine, renames and removes it and falls back to the remaining default; browser check of the Models tab (machines, This machine, Connected and Can't connect with a translated reason, pairing errors in the dialog, the default model offering both machines, edit, remove) and of a new chat falling back when its machine is removed.
- Packet PR-1, QR pairing: protocol (`pair --url` prints the link and a terminal QR code whose code pairs once; without an address it says how to get one); browser check that decodes the dialog's QR code from a screenshot in light and dark, opens it on a phone (code and name filled, Connect focused, code removed from the address, one tap pairs), ignores a used link on a paired phone, and hides the QR code on a localhost page; on the Spark, the same from a desktop to a phone over Tailscale.
- Packet MD-1, media service on the Spark: a recorded Chinese sentence is transcribed exactly, a reply is read aloud, a 1024 px image with Chinese text is legible, a phone video yields frames and its transcript; peak memory per model is recorded and a load is refused when memory is short.
- Packet MD-2, end to end with the local model on the Spark from a phone and a desktop: dictate a question, read a reply aloud, ask for an image, and analyze a video, an audio recording, a Word document, a spreadsheet and a scanned PDF.
- Packet MP-1, model packs protocol (`linux-host-packs.test.ts`): every manifest pins its image and revision, leaves the serving flags to the runner and has no argument containing spaces; the runner refuses an unknown pack, lists each pack with whether it fits, and on a machine without an NVIDIA GPU reports which requirement fails and points to Settings → Models. With a real Host, a stand-in model server and a stand-in for Docker: `start` makes the pack the default of a Host with no local machine, changes nothing when run again, switches a machine at its address that lists another model (keeping its name) and the default with it, and leaves no temporary device; `remove --purge` deletes the downloaded weights even after a plain `remove` and keeps weights given with `--weights`.
- Packet MP-2, a pack on the Spark: `check` reports every requirement; `install` downloads the pinned revision and verifies it; started while the machine's memory allows, it serves the model and a phone and a desktop chat with tools and images through it; streamed tool calls parse; `stop` frees the memory and `status` reports each state.
