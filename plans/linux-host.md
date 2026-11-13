# Linux Host

Goal: run OpenOx as an always-on Host on a Linux machine such as a DGX Spark, keep the Profile's conversations, memory and files on that machine, and reach it from a phone or desktop browser. The existing iOS and macOS Hosts are unchanged; this is an additional Host implementation.

Status: implemented as `apps/linux` (server, web client, device pairing, Ox VM modules) and `packages/agent/src/adapters/linux` (agent runtime adapter). The Ox VM work adds the native function surface: web fetch and search, the browser, services, repositories, secrets, skills, schedules, conversation and provider functions, attachments and OCR. Native iOS services (Calendar, Contacts, Location, Messages, Notifications, Reminders) stay unavailable on Linux. Native external-Host mode opens the selected Host's actual web workspace; embedded native mode stays available.

## Controlled upstream integration

Owner approved local integration of upstream `5bd54b97` into fork `97f8b705` on November 12, 2026. Preserve the fork's governing rules, encrypted local/outside connection model, native remote workspace isolation and Mac console lifecycle. Resolve overlapping Native Host-picker/settings/access/configuration changes semantically, not by replacing fork files. Keep the Linux package export and adapt shared Pi1.5.2 view/SQLite/service contracts without duplicating core projection logic or silently removing verified Linux capabilities.

Before native/UI handoff, UP-01/07 in `plans/feature-acceptance.md` cover the CLI safe validator, live/committed conversation rendering, a pinned1.3.0 predecessor fixture, service/secret/session/approval compatibility, native Host selection and changed conversation/credential/handoff screens, and the existing packaged Mac lifecycle. Use synthetic data, both native builds and a claimed existing normal-identity Simulator; do not boot clones, erase existing app state, call real models or migrate owner working data. Current owner manager PID89404 and Spark/MyGPT remain untouched. Local integration is not commit/push/deployment approval.

The local integration advances shared/native upstream behavior as well as Pi1.5.2. Linux reuses the shared conversation-view projector and implements counted SQLite writes, bounded UTF-8 read continuations, typed secret ownership metadata, guarded API headers and incremental redacted capture/body shapes. Existing generic secrets, icon-less Linux service packages and `context.session` remain compatible. Removed upstream `ox.conversation.start` and `ox.web.browser.waitForUserInteraction` remain Linux-only contracts; Native follows upstream's manual conversation creation and new live-page handoffs. Linux does not claim saved-account `$secret` login, child-frame/service-page Browser targeting or native automatic Done/Cancel follow-up turns. A shown page never proves human completion or authentication.

Verification on November 12–13: all 124 repository cases passed with 3370 assertions, six TypeScript projects and portable/package checks passed, and both native targets compiled. Actual Linux1.3.0 bytes survived a1.5.2 upgrade, ordinary writes and restart, including history, memory, attachments, paused/future schedules and valid/revoked authorization. The actual native1.0.23/Pi1.3 predecessor upgraded to1.0.28/Pi1.5 without erasure: the active Profile kept its identity/data, the repository move retained exact bytes, inactive Profile bytes stayed unchanged, and an actual Mock UI turn and second launch passed. All83 Native contracts and saved/temporary VM checks passed after aligning two missing metadata descriptions, not weakening the guard. All227 pinned upstream HTML fixtures plus one bounded nested case matched bare-JavaScriptCore output exactly; excessive depth was rejected and the installed iOS app's real fetch path passed. These are fixture results, not production performance or model-quality evidence.

The engineering archive passed14 groups with actual Mac Safari, Chrome and WebKit phone-touch, including QR replacement, local entry, uncertain sends, lifecycle/recovery and every reachable workspace page; all76 desktop/compact state captures were visually reviewed. The final archive also paired and sent once through normal `ox-1` iOS26.2 Safari using a pixel-decoded QR and actual native touch/keyboard, displayed the scripted reply, and distinguished cancelled from confirmed Host revocation. Safari WebDriver's iOS input injection was not counted as a pass; the normal browser flow supplied the evidence. No physical radio/cellular, configured WAN, real-provider login or customer-working-data result is claimed. This change set remains an uncommitted local merge until reviewed author approval; the Downloads package, live Mac manager and Spark are not updated by these checks.

## Workspace clarity packet

Owner requested multi-Host clarity and screenshot-led review on November 11, 2026. Preserve the existing Operate design, API routes, pairing, one Linux Profile and native saved-Host behavior. In reader copy, a workspace means that Profile's data and configuration, not a personal account or a new tenancy feature.

| Page | Change | User outcome |
| --- | --- | --- |
| Conversation, Files, Schedules | Persistent workspace/Host control separate from the model picker | Know which Host owns this screen, even when two Hosts use the same model name |
| Host and connections | Separate current browser address, shared workspace/data, and recorded Host access entries | A working HTTPS connection is not mistaken for a failed connection when LAN or the optional outside entry is absent |
| Workspace settings | Replace the misleading reader label Profile / 个人资料, retaining schema and routes | Understand memory, files and skills are workspace data shared by paired devices |
| Models | Identify inference services as services used by this Host, not other Agent Hosts | Understand that model selection does not switch workspace or prove local processing |
| First use and Host navigation | Name the current workspace; explain Host storage, client cache and external processing; guard unsent work | Connect deliberately without believing data migrates or running Host tasks stop |

Packet WC-1: actual local Host workspace, EN desktop light/dark and ZH mobile light/dark; first use, long names, Workspace settings, Models context, 200% zoom, accessible names and 44px context target. Review rendered screenshots from a first-time user's perspective, not only DOM assertions.

Packet WC-2: two isolated scripted Hosts with the same model name but distinct workspace data; explicit navigation and independent pairing, unsent draft/attachment selection and upload/send-in-flight protection, no implicit data/token transfer, Host work remains at origin, current HTTPS test while LAN and outside record are unset, shared outside record save/remove without network provisioning. No real Spark inference or MyGPT work.

Run lint, Linux/portable type/build checks and focused real protocol regressions; inspect the full diff including LOC, file tree, call paths, complexity and performance. Batch desktop/mobile screenshot review, fix material findings together, then confirm once. This packet changes the web workspace used by Spark and native remote mode; it does not change native source or claim physical-device acceptance, a unified browser Host registry, Linux multi-Profile or managed remote enrollment.

Verification: WC-1/WC-2 passed nine real browser workflow checks with two isolated Hosts, the same scripted model and distinct memory/history. Reviewed actual EN desktop and ZH phone-layout light/dark screenshots, including first use, shared workspace settings, Files, settled Models, connection entries and 200% Chrome page-scale zoom. Fixed the narrow mobile Host-navigation row and included attachment preparation, upload, submission and post-confirmation races in the leave guard. An error toast must be dismissed during recovery; it was not bypassed with forced clicks. No real model, Spark or native-device inference was used. Run `bun apps/linux/scripts/workspace-check.ts --out <outside-checkout>` to repeat.

## Mac Safari LAN test package

Owner requested a Mac-hosted physical-phone test on November 11, 2026 and chose Safari rather than the native client. This is a private ARM64 engineering test bundle, not a signed/notarized consumer release or a managed enrollment service. Reuse the real Host/web stack with isolated data and a clearly disclosed scripted model; do not use Spark, MyGPT, production keys or customer files.

| Surface | Change | Acceptance |
| --- | --- | --- |
| Mac archive | Bundle pinned runtime, workspace dependencies, required resources and explicit start/stop launchers | Runs after extraction without the source checkout or a global Bun install; no global installation or autostart |
| Start and phone invitation | Validate the assigned private interface, trusted HTTPS name, certificate/key and dedicated data; generate a fresh expiring QR on launch | Phone camera opens Safari with normal system trust; no certificate-warning bypass, global CA installation or HTTP LAN fallback |
| Host connection metadata | Distinguish a system-trusted LAN invitation from the existing private-CA/native invitation | Correct current/LAN address and browser pairing instructions; existing native private-CA behavior unchanged |
| Data and lifecycle | Keep data/identity outside the archive, reject an already-running instance, stop only the owned process | Restart retains workspace and pairing; stop does not delete data or touch another app |
| Trusted test entry | Engineering-managed dedicated hostname and independent certificate bound to the Mac's private IP | No customer-owned domain requirement, public Host listener, relay or change to website/mail/production TLS |

Packet ML-1: unpacked archive, minimal environment, dependency/resource completeness, symlink containment, no packaged keys/tokens/data, isolated profile, normal startup/duplicate startup, failed preparation and exact-owned-process stop. No dependency or security-setting changes at launch.

Packet ML-2: real Host and scripted model, normal trusted HTTPS, single-use/replay/origin/refused-client cases, QR fragment secrets, missing/expired/mismatched identity and wrong-interface refusal, restart/storage/pairing survival, current versus published connection metadata. Fixture certificate checks are not a physical Safari trust pass.

Packet ML-3: desktop and phone-layout rendered review with actual screenshots; owner-assisted physical iPhone on the same reachable LAN scans, pairs, sends a disclosed scripted request, opens a Host file and reconnects. Cellular without an outside route must not be reported as local success. Record untested device/network states explicitly.

Before provisioning, confirm DNS authorization in a task-private provider session. Change only a separately authorized dedicated test record and temporary ACME TXT; never overwrite existing records or reuse production keys. Keep DNS credentials, ACME identity, Host TLS private keys, live codes and browser state outside Git and the archive. A public HTTPS tunnel is not a substitute for this LAN packet.

ML-1/ML-2 use six grouped unpacked-archive process/browser checks over an actual public-CA certificate and private-interface HTTPS, including independent desktop/phone-layout pairing, a macOS WebKit send, labelled scripted replies, file retention, restart/cookie survival, duplicate startup, owned-process stop and certificate/interface refusal. Screenshot review caught the initial unconfigured test provider; it now reuses the established machine-ID convention and validates the choice before inviting. Archive audits verify canonical symlink containment and prebuild its complete shared/Pele resource graph. Physical iPhone Safari remains an owner-assisted ML-3 gate, not a simulated pass.

## Local Host pairing console

Console lifecycle packet (owner, November 12, 2026): the double-click engineering entry opens the local console only, without starting Host work. Reopening preserves the current running/stopped state. Keep the console alive independently of the HTTPS Host so its authorized owner can start/stop again without accounts, a native `.app`, autostart or global service installation. Preserve the existing direct CLI `start`/`pair`/`stop` lane for engineering automation; the primary packaged entry is clearly named Open Console.

| Surface | Change | Targeted evidence |
| --- | --- | --- |
| Default console | Lead with Host state, the start/stop action and authorized devices; technical address/path/version/certificate details move behind More information | Desktop/compact EN/ZH actual screenshots and short recording; no default engineering-details landing page |
| Host control | Explicit stopped/starting/running/stopping/failed state; stop requires confirmation, preserves data/identity/pairings and does not kill unrelated services | HL-01/02/03/04/05, PA-07/11/13 and CN-07 |
| Unavailable Host | Console remains usable; workspace/QR are unavailable until running, old QR is hidden, failure explains recovery without automatic replay | Failed identity/interface/DNS/port and delayed/lost control-response cases; actual failure/recovery renders |
| Relaunch/exit | Same owned manager reopens the console without duplicates or implicit Host start; full Stop exits only the verified manager and its own resources | Minimal-environment archive launch/reopen/exit and unrelated-PID guards |

Use the existing shared Ox controls and local OS/Origin/CSRF boundary. Starting/stopping manages only the engineering Host, its owned browser resources and its scripted connection-test model, never external inference workers or Spark/MyGPT. Closing the browser does not stop Host; full controller exit remains an explicit engineering action. Do not promise that interrupted in-flight work automatically resumes. The current owner PID81699/`13042f34` is unchanged during development; any live replacement needs new reviewed approval.

The first packaged run completed all functional groups but exposed a checker-only held-route/unroute race, so its nonzero exit is not accepted as a passing packet. The rendered batch also showed duplicated default guidance, a large mostly-empty default detail column, inherited settings-button margins moving Stop out of header alignment, and a stale previous failure banner during a later action. Correct these together: default to the full device list, reveal detail/technical metadata only after an explicit selection, retain a visible Back action, keep shared-workspace/test boundaries once in the footer, scope the power-button color without settings margins, and clear superseded errors. Confirm once with the same desktop/compact and failure/recovery packet; do not start a cosmetic loop.

Verification: the corrected packet passed all 13 Chrome/WebKit groups, then all 14 groups with actual Mac Safari 26.6.2. Native visible clicks confirmed cancelled/confirmed Stop, usable console while Host is off, disabled workspace/QR actions, re-enable, unchanged phone invitation, full QR, direct local entry/reuse and readable shared sheets. Chrome desktop and actual WebKit phone-touch exercised 23 lifecycle captures including occupied-port failure/retry, uncertain committed Stop, offline selected-client revocation, old-cookie refusal, retained valid client cookie/history/draft/file and secondary More information; the page-inventory packet retained all 76 available state captures. Reviewed the rendered initial/correction/confirmation batches without further cosmetic changes. Lint/six type-check projects, portable builds and all 121 repository cases passed (3325 assertions). No native app/configuration changed, no physical radio/off-LAN or real-provider pass is claimed, and the owner Host remains unchanged until reviewed upgrade approval.

Host user-journey packet (owner, November 11, 21:57 PST): inspect every reachable console/workspace page from a user's perspective, not only component styling. Owner approved removing the extra two-item left sidebar in favor of one device-list/detail layout, and continuing local management authorization into the workspace without a repeated pairing step. A Host does not pair with itself; the browser still requires server-authorized access.

| Area | Planned change / review | Required evidence |
| --- | --- | --- |
| Console navigation | Remove redundant sidebar; retain one device list, clear Host-information entry and compact Back navigation | List/Host/device/search/empty/QR/revoke, desktop and compact screenshots/short recording |
| Local workspace entry | Authenticated local console issues bounded one-use workspace authorization; existing valid browser reused, first local browser authorized without the remote QR flow | Normal HTTPS cookie, no new record on reuse, no pending phone-code mutation, clear failure/recovery |
| Authorization boundary | Enable handoff only with the local console; retain session/Origin/CSRF checks and remote pairing | Unauthenticated/foreign/missing-CSRF, replay/expired/restart/wrong-Host/lost-response/revoke cases, real Host API plus browser completion |
| Workspace pages | Walk empty/populated chat, Files, Schedules, every settings tab, Memory/Skills and reachable detail/overlay states using synthetic data | Page inventory with pass/fail/blocked evidence, actual desktop/compact renders, entry/return/wayfinding and state checks |

Preserve Ox's incumbent design, ordinary remote QR pairing, the one shared workspace, device revocation, native private-CA behavior and current owner data/runtime. No global authentication bypass, implicit network trust, new account/role system, real-provider login or Spark/MyGPT work. A live upgrade requires separate approval of the reviewed result.

The baseline walk reproduced both repeated local Connect and pending-phone invitation replacement. All ten settings tabs, chat/Files/Schedules, first use and Memory were rendered in desktop/compact EN/ZH. Additional user-perspective findings: General does not identify browser-only preferences; Services does not distinguish the assistant's Host-side sign-ins; unavailable services name Linux even in the Mac engineering package; browser disconnection is buried under About rather than Devices and security. Fix these narrow scope/wayfinding issues without redesigning unrelated features. A modal's internal settings categories remain legitimate secondary navigation; the redundant persistent console sidebar is removed.

The first full after-walk also verified file/skill/service/permission overlays, returning browser reuse, cancelled/confirmed browser disconnect and local re-entry. One copy correction is required: disconnection/revocation must say fresh access is needed, not promise that every local browser must scan again. Standard service action metadata uses the existing Host-text localization mechanism; external repository-authored descriptions keep their supplied language rather than being silently retranslated or treated as reviewed application copy.

An actual Mac Safari follow-up reproduced the same auto-height flex collapse in the shared skill sheet: the title remained visible but its instructions were clipped into a padding-height body. Correct the shared sheet flex basis, remove the now-redundant QR-specific override and verify native skill/notification/release sheets alongside QR, desktop/compact overlays and existing workspace/service regressions. DOM presence or Chrome-only screenshots are not sufficient acceptance for Safari-readable sheet content.

Verification: PA-13/14 passed twelve unpacked-archive groups with actual Mac Safari, Chrome and explicit phone-touch WebKit. The page inventory has 76 captures in desktop EN/light and compact ZH/dark, covering 39 distinct available states, all ten settings tabs, file/skill/permission/service overlays, notification/release sheets, local reuse, disconnect cancel/confirm/re-entry and invalid/lost-admission recovery. Reviewed screenshots plus sequential desktop/mobile recording frames; review copies are slowed 5x and are not performance evidence. Native Safari now reads the shared skill and release bodies without collapse; its full QR, direct local entry, returning-browser reuse and unchanged phone invitation passed. Lint/six type-check projects, portable builds and all 121 repository cases passed (3325 assertions); after the shared-sheet correction, the 31 affected workspace/service/admission cases passed (1717 assertions). A lost fresh-admission reply can leave an authorization whose cookie never reached the browser; explicit re-entry may add another record, so cross-tab/refresh idempotency is not claimed. Physical phone/radio/off-LAN and real-provider actions remain outside this packet. The owner's running Host is unchanged pending reviewed upgrade approval.

Ox design consistency packet (owner, November 11, 20:09 PST): refine the local Host console, not the conversation app or networking. Preserve the existing list/detail composition, Ox design authority, shared workspace semantics, stable controls and pairing/authorization behavior. Before editing, capture the current rendered operator path and a short recording with isolated data. One refinement batch, one desktop/mobile rendered review, and at most one material correction/confirmation round.

| Surface | Planned refinement | Targeted cases |
| --- | --- | --- |
| Header and navigation | Ox shared button/icon/type/spacing patterns, clear current destination and one primary pairing action | PA-02/03/07, keyboard, 44px targets, 390/768/1365 widths |
| Paired list and detail | Consistent selection, row rhythm, information alignment, equal edge padding and readable long names/paths | Search/no match, selected/back/overview, live versus authorization state |
| Overview and copy | Native EN/ZH terminology consistent with Host/workspace settings, concise nonduplicated explanations without changing claims | Shared-workspace, local-only control and scripted-reply boundaries retained |
| QR and revoke overlays | Shared sheet/dialog actions, inset and type; stable full QR in actual Safari; explicit progress/error and destructive confirmation | PA-02/04/05/06/07/11 plus existing CN-04/05 regression |
| Responsive/state review | Light/dark desktop/mobile, intermediate width, keyboard/reduced motion, empty/long/stale/failure states | Actual screenshots and short desktop/mobile recording; native Safari and Simulator where applicable |

Use `DESIGN.md`, `Theme.swift` and the existing shared web components as authority; do not import Matrix website styling, new fonts, a new UI framework or decorative effects. Record exact package/source, affected cases, visual findings and recordings outside Git. Keep the currently running owner Host/data untouched; a new live upgrade is separate from this refinement request.

Baseline recordings/screenshots showed a wrapped tablet header, mismatched type/insets, a permanently highlighted navigation entry, no narrow-width route to Host information, verbose repeated notes and a misleading web-session line on CLI records. The refinement keeps the three-pane world but makes Host/devices navigation explicit at compact widths, reuses shared settings/button/field/icon patterns and treats CLI activity separately from browser tabs. The existing dark text on the gold Host action is retained for legibility; only its shared control styling changes, not global primary-action foregrounds.

PA-12 rendered review used five real browser variants (1365px EN light/dark,390px ZH dark,375px EN light,768px EN light) with short desktop/mobile recordings. One correction batch fixed inherited square compact settings tabs and a shrinking375px refresh target; confirmation retained all44px header targets, equal gutters and readable long client/path values. Native Mac Safari and the affected eleven-group archive packet passed, including QR replacement/error/stale/revoke/workspace flows and CN-04/05. Lint/six type-check projects, portable builds and all119 repository cases passed (3296 assertions). This is local-console responsive review, not a new physical-phone/radio or LAN-management permission claim.

Owner chose a local-only console and clarified on November 11, 2026: one Host, no account registration; other machines connect to it; the Host lists and manages every pairing, can add/revoke at any time and shows each pairing's actual state. Use the supplied Tailscale screenshot for the precise list/detail composition, not its branding, VPN inventory, blue palette or cloud account model. Keep the existing Ox Operate design.

| Surface | Change | User outcome |
| --- | --- | --- |
| Start/Pair | Open an authenticated live local management page rather than a static QR file; repeated Start of the same running bundle opens its console without restart | One persistent Host entry without duplicate processes or lost work |
| Pairing list/detail | Existing authorized clients, kind, creation/last-seen, observed web-session count; selected record detail and confirmed revocation | Distinguish paired authorization from observed activity; no invented device-level online status, IP or account |
| New pairing | Explicit fresh QR, expiry, replacement/consumption state and regeneration | Add clients without rerunning terminal commands; new codes invalidate unused old ones |
| Workspace action | Open the existing trusted Host workspace through bounded local-console authorization | No cloud login, repeated pairing confirmation or private per-user workspace claim; first-use welcome is separate |
| Authorization/lifecycle | Loopback-only control origin, owner-only short Unix socket, one-use bootstrap and HttpOnly local session | Local OS authorization, not unauthenticated localhost administration or a LAN control API |

Packet HC-1: isolated fixture data/identity config and free ports; the owner's existing Host remains untouched. Reject unauthenticated, foreign-Origin, Host-rebinding, reused/expired claim and missing-CSRF control requests; verify owner-only IPC and no control credential in URL queries/logs or the archive.

Packet HC-2: real web session opens/closes, paired clients persist independently of live sessions, add/use/expire/replace QR, revoke only selected client after confirmation, open workspace without a new account, repeated Start without PID change, old-bundle mismatch refusal and retained data after explicit Stop.

Packet HC-3: actual rendered desktop/mobile light/dark and WebKit screenshots reviewed from the local operator's perspective, keyboard focus/empty/loading/error/stale states and safe actionable copy. Run focused protocol/archive packets then existing source gates. No native binary, DNS, Spark, MyGPT or real-model changes; deliver a new ZIP and require explicit old-bundle Stop before upgrading the owner's active process.

Eight isolated archive groups cover the local console plus the existing Host workflows. Real screenshots exposed the native workspace form's referrer-policy/Origin conflict, a clipped modal action inset and the same-document authorization-link reopen path; these were corrected without accepting foreign/null action origins or bypassing local authorization. Test-local preference injection is limited to HTTP(S), rather than touching localStorage on the launch bridge or opaque documents. Fixture identities use free ports and separate data; the owner's current process is not stopped or read for acceptance.

QR repair packet (owner report, November 11, 16:03 PST): reproduce Generate new QR in the exact delivered `f612b0af` ZIP before fixing runtime source. Check repeated regeneration while the QR is still active, not only after expiry. Each action must complete its real request, change the visible/scannable QR and expiry state, re-enable its action and reject the replaced code. Repeat in desktop Chrome and WebKit, narrow touch layout, and with an overlapping state poll and a failed request. Review actual before/after/loading/error screenshots; no forced clicks, silent retries or certificate exceptions.

Review the whole operator path alongside the repair: empty list, add/close/reopen, real pairing and session updates, search/no matches, selection/back/overview, refresh/stale recovery, revoke cancel/confirm and workspace opening. Use only isolated fixture pairings/ports and leave the owner's current Host, clients and data untouched. The old expiry-only check is not sufficient evidence for active regeneration.

QR repair verification: the original ZIP reproducibly left an invalid old QR visible when an earlier automatic state response overlapped a successful generation. The confirmed POST now updates the invitation directly; request revisions reject superseded polls, and explicit generating/unconfirmed-failure states hide unsafe codes and allow a clear retry. Reopening an in-flight generation also renders its state rather than an empty sheet. Nine unpacked-archive groups passed using desktop Chrome and explicit phone-touch WebKit (`--webkit-touch`), including repeated active generation, delayed polls, slow committed responses, committed-but-lost responses, close/reopen, stale recovery, replaced-code refusal and actual pairing with the regenerated invitation. Four actual before/after QR image crops independently decoded to the verified invitation hashes. Reviewed rendered EN/ZH desktop/narrow light/dark, loading/error/used, search/detail/revoke and workspace states. Lint, six type-checks, portable builds and all 117 repository tests passed; physical phone-camera acceptance remains owner-assisted, and no owner Host, Spark or real inference was used.

The local macOS WebKit desktop mouse injector later produced wrong event coordinates even on an independent minimal page under both Bun and Node, including headed mode. Do not count those blocked pointer runs as a product or desktop Safari pass. The checker retains its default desktop-mouse mode and records explicit `--webkit-touch` acceptance separately; phone WebKit uses real touch for pairing, onboarding and sending. Strict CSP remains unchanged; its rejection of Playwright's empty screenshot-synchronization stylesheet is narrowly attributed and retained in diagnostics, not suppressed as an application warning.

Actual-Safari pairing recheck (owner repeat report, November 11, 17:13 PST): the owner's running bundle and console source match clean `b35188d6`, and the reported page is its live local console in Safari, not an old package or a test image. Reproduce the actual Mac Safari Generate action with an isolated matching Host; then use one reserved existing fixed-pool iPhone Simulator's Safari for the rendered invitation, Connect, workspace, Host pairing/session visibility and a disclosed scripted reply. Review actual Mac/iOS screenshots and record browser/runtime/build identities. Do not substitute mobile viewport emulation, forced clicks or API pairing for the interaction under test. Keep owner data/pairings/runtime, global browser/trust settings and Spark untouched; release the reservation and restore the simulator's initial boot state. No current Safari/Simulator pass is implied by the earlier browser packet.

Native Safari 26.6.2 reproduced the visible failure: trusted Add/Generate clicks changed the real Host pairing record and QR DOM, but the scroll body was only 20px high with `flex: 1 1 0%`, clipping the 280px QR below it. The whole sheet measured 148px despite 463px of body content. Scope the content-based flex basis to this pairing sheet only; keep the shared sheet behavior unchanged. Verification must assert that the complete QR lies inside its visible scroll region and viewport, independently decode the actual native screenshot and pair through real Simulator Safari. DOM presence or a successful POST is not a visible-QR pass.

The scoped `flex: 1 1 auto` repair gives the same native Safari body 463px and the sheet 591px; the whole QR is visible and independently decodes. Actual existing `ox-1` iOS 26.2 Safari opened that decoded invitation, paired through its visible Connect action, completed first use, sent a synthetic message and displayed the disclosed scripted reply. The actual Mac Host console showed the iPhone with one observed live web session. Native desktop/iOS screenshots were reviewed and the nine unpacked browser workflow groups passed with the complete-QR guard. Simulator camera capture is not claimed: the real rendered QR was decoded before handing its URL to Safari. No native app identity/install, certificate bypass, real inference or owner-data mutation was used.

The owner requested feature-linked failure cases and maintained test files. `plans/feature-acceptance.md` maps affected changes to pairing/connection cases; deterministic pairing tests and the existing archive packet now live together under the Client-Host protocol boundary. Native Simulator HID checks passed delayed pairing, route-loss/draft recovery, cancelled Host revocation, offline revocation/reconnect refusal and a cold unavailable Host URL using only a dedicated test gateway, not global networking. Actual radios/cellular/off-LAN routes remain separate gates.

CN-04/05 also reproduced a safety gap: after an unconfirmed send the restored draft could be submitted again without a separate warning. Keep ordinary successful sends unchanged; retain uncertain input, never replay automatically, and reuse the existing confirmation dialog before repeating that same conversation/text/attachment submission. Test cancellation leaves the draft and committed history unchanged; explicit confirmation may send once. A lost successful response must not be presented as proof that the Host did not receive it. This is a local retry guard, not a server idempotency guarantee across refreshes or other devices.

Final source verification: lint/six type-check projects and portable builds passed; all 119 repository cases passed across 20 files, including the two new pairing protocol cases. One earlier full run timed out on the unrelated service viewer's first frame; the unchanged targeted case and the subsequent sequential full run passed without changing its threshold or source. The expanded archive packet passed eleven groups, including actual native Mac Safari QR clipping and failed/committed-but-lost send responses, cancellation and navigation during retry confirmation. The old archive command still forwards to the maintained feature folder. Physical-radio, real separate-LAN/cellular and Internet-only-outage gates remain explicit; neither proxy failures nor mobile viewports close them.

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
  - Hover highlights apply only where the device can hover. On a phone, as in the phone app, a tapped row or button isn't left highlighted; selected and current states still show.
- Conversation:
  - One 700px reading column with 20px between blocks.
  - User bubbles are neutral grey (`bubble`), 24px round with 14px by 12px padding; replies have no bubble.
  - Links keep the text colour with a dotted underline. Inline code is grey monospace without a fill; code blocks sit on the code surface with a 1px border.
  - The empty state reads "Start a conversation".
- Composer:
  - Glass (a translucent surface with a blur) with a 24px radius.
  - While empty and unfocused it is 84% wide and centred; it widens when focused or holding text or attachments.
  - Pressing + with a mouse or a finger doesn't take focus from the text field, so the composer keeps its width; when the field isn't focused, as from the keyboard or assistive technology, the menu takes focus and Escape returns it to +.
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
  - PAR-2b, paste, drop, files and hold to talk:
    - Pasting images or files into the composer attaches them, as on the phone. An image that only has the browser's generic name is called "Pasted Image.png", or "Pasted Image 1.png", "Pasted Image 2.png" and so on when several come at once.
      - Pasted text stays text. When the clipboard has text, an image with only a generic name is left out, because Office and iWork apps add a picture of the copied text.
      - When files are attached, the browser's own paste is blocked, so a file copied in Finder doesn't also type its name.
    - Dropping files on a conversation attaches them; the composer is outlined while files are dragged over it. The phone has no drop, so this is a desktop addition.
    - When a conversation has files, a "Files · N" chip leads the strip above the composer, as on the phone. It lists the files sent with messages and the files Ox wrote in the conversation, each with its icon and name, and opens the chosen one. Skill files and `MEMORY.md` are left out.
    - On phones the microphone is Hold to talk, as on the phone app:
      - a tap shows "Press and hold to talk.";
      - holding for 0.35 seconds starts recording, with the level bars and "Release to send";
      - sliding 32 px or more out of the composer, up or to the left, turns it red with "Release to cancel";
      - releasing sends the words (added to any draft) after "Transcribing and sending…", or cancels;
      - no speech gives "No speech detected. Nothing was sent.", and an interrupted hold gives "Recording interrupted. Nothing was sent.";
      - when the microphone permission prompt ends the first hold, it says "Ready. Hold to talk, then release to send.".
    - Keyboards and screen readers, and every desktop, keep tap-to-dictate (start, then insert or cancel).
  - PAR-2c, skills from the composer, as on the phone:
    - Typing "/" at the start of an empty composer opens a skill picker above it. It lists the enabled skills that aren't built in whose name contains the typed text, each as `/name` with its description on one line. Arrow keys, Enter, Tab and Escape work as in the "@" picker.
    - Choosing a skill sends it at once. "/name words" sends it with those words, and the name is matched without case. Any other "/text" is sent as plain text.
    - The message shows as a `/name` bubble that opens the skill, then the files and a bubble with the words, without Copy or Edit. The conversation's Copy writes "/name words", and a new conversation is titled "/name words".
    - Regenerate keeps the skill on the message, as on the phone. A branch keeps it too.
    - Host: `POST /api/conversations/<id>/messages` accepts `skill`. The Host:
      - refuses built-in, turned-off and unknown skills (404);
      - attaches the skill's services and records its use;
      - sends the instructions followed by the words;
      - records the skill and words on the message with the same marks as schedules, which now live in the conversation's `marks` (the earlier `scheduled` list is still read).
    - Exports keep the expanded text of a skill message; the phone's skill invocation format isn't written.
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
- PAR-5, reply rendering, as on the phone:
  - PAR-5a, code, changes and thinking time:
    - Code blocks colour comments, strings, keywords, numbers and JSON keys with the phone's colours in light and dark, for `json`, `python`/`py`, `bash`/`sh`/`shell`/`zsh`, `swift`, and `javascript`/`js`/`typescript`/`ts`/`tsx`/`jsx`, in any letter case. Other languages stay plain, as do blocks over 100,000 characters. The phone's patterns are kept; where two would overlap, the one that starts first wins, so `//` inside a string stays part of the string. A JSON string followed by a colon is a key, and a quote right after a backslash never opens a string, so colouring takes time in proportion to the block's length, even inside a string that hasn't closed yet, and stays cheap when the reply is drawn again on every streaming frame. The header names the language as written, or Text, in the text colour.
    - A `diff` or `patch` block is titled Changes and is not scrolled sideways as a whole; each part of it scrolls on its own. Copy copies the diff as written.
      - With file headers (`diff --git`, or `---` and `+++`), the header says "1 file" or "N files". Each file has a row with a chevron, its path (and the old path when renamed), Added, Deleted, Renamed or Binary when the change isn't a plain edit, and the added and removed line counts. Selecting the row collapses or expands the file. A collapsed file stays collapsed while the reply streams.
      - Without file headers, the header shows the added and removed counts, and the lines follow.
      - Lines show their old and new numbers from each `@@` hunk. Added lines are green and removed lines red, both on a light tint, and hunk headers are dropped in favour of a rule between hunks, as on the phone.
      - A binary file says "Binary file changed"; a file without lines says "No text changes", or "Receiving changes…" while the reply streams. Counts are hidden while the block streams.
    - A thinking row without steps reads "Thought for N seconds", or "Thought for N min N seconds", as on the phone: from the start of the first response in it to the end of the last. While the reply after it is still streaming, it shows the time so far; once the response ends, it shows the final time. A reply whose time wasn't recorded keeps "Thought it through". Rows with steps keep "Activity · N steps".
    - Host: a trace starts at the start of its first response (its `timestamp`), and a finished trace's `completedAt` is the end of its last response (`timestamp` plus `durationMs`, which the model library records). A saved response without that record ends where it started, never at a later message; a response that is still streaming ends now. Exported packages give each generation its end time, and importing a package records it again, so thinking times survive the round trip with the phone.
  - PAR-5b, Mermaid diagrams:
    - A `mermaid` fence, in any letter case, is drawn as a diagram by the phone's renderer, Pele (MIT, from Obsidian), using the same file the phone bundles. The browser loads it only when a reply first contains a diagram. Links and images inside diagrams stay off, as on the phone.
    - The diagram is shown as an image of its SVG in the theme's colours, the same ones the phone uses (background, text, muted text, lines, surfaces, borders and accent), so nothing in it can run. It is drawn again when the theme changes.
    - A fence that is still streaming shows as code and becomes a diagram as soon as it closes. A diagram that can't be drawn stays a code block. When a diagram replaces its code in a conversation that was showing its end, the end stays in view.
    - Screen readers hear "Open diagram", described by the diagram's title and description (Mermaid's `accTitle` and `accDescr`), or by its source when it has neither. The full-screen image uses the same text.
    - Selecting a diagram ("Open diagram") opens it full screen on the conversation background, as on the phone: fitted to the screen, with Close and Copy code.
      - A double-click or double-tap zooms to 3× at that point, or back.
      - Pinching (including Safari's trackpad gesture), or the wheel with ⌘ or Ctrl, zooms between 1× and 8×.
      - Dragging pans, and the keys +, − and 0 zoom in, out and back.
      - Escape closes it and returns to the diagram.
    - Host: the web build emits Pele as its own file with its license banner, served like the other assets and cached by name.
  - The phone's image and video widgets and canvas cards come from functions the Linux Host doesn't have. Images and videos the agent links in a reply already show inline, and HTML files come with PAR-8.
- PAR-6, first run, memory and app state. The phone keeps memory in `MEMORY.md`, which Ox reads and edits with `ox.fs` and Settings → Profile → Memory edits; the Host already does both. The phone has no separate memory functions and no Personal context page: its `ox.memory.*` and `ox.app.*` names are permissions for these files.
  - PAR-6a, first run, What's New and importing memory:
    - The first time a browser opens the web client after pairing, it shows the phone's "A few things to know":
      - Connect to anything ("By turning any website into tools and using your Host's capabilities." The Host has no folder grants);
      - Stay yours ("By running on your Host and keeping conversation data in a portable folder.");
      - Pick any model ("Without changing how you use Ox.");
      - the warning that Ox can make mistakes, and Get started.
      Closing it in any way counts as done for that browser.
    - Settings → About lists What's New: the web client's releases, newest first, each with its highlights. After an update, a browser that has finished the first-run sheet shows the releases it hasn't seen, once. A new browser counts all releases as seen when it finishes the first-run sheet.
    - In a new, empty conversation that isn't temporary, with nothing typed, attached, or attached as a service, and no follow-up suggestions, the composer offers "Import memory to Ox", as on the phone. A browser shows it in at most three new conversations. Selecting it sends the built-in `import-memory` skill, which the Host accepts from the composer although it is built in. The message reads "Import memory to Ox", and so does a new conversation's title.
  - PAR-6b, the app folder. As on the phone, `app/` in the Profile shows Ox the app's state, and each read follows its Action policy:
    - `status.json`: the Host's version, the profile, the default model with its sign-in state, the repositories and whether the Host accepts connections (App info, Profiles, Default model and Repositories);
    - `policy.json` (Actions): the stored default, source and action policies;
    - `actions/<encodeURIComponent(action)>.json` (Actions): one Action's effective policy and where it comes from, listed for every built-in Action and every stored one;
    - `providers.json` (List model providers): the local machines and saved provider definitions, without keys, and the chosen default model;
    - `services.json`: saved services and their names;
    - `logs.jsonl` (Logs, asking by default with the phone's warning): the Host log that Settings → Logs shows, read only by its name; folder searches skip it.
    The folder exists only for Ox; the Files page doesn't list it, and a Profile that already has its own `app` keeps it. A folder search never asks: it reads the app files whose Actions are allowed and skips the others, noting each one and why, so a blocked Action never breaks a search of the user's files. A change to an app file that waits for approval doesn't hold other conversations' file changes. Ox may change `services.json` and the default model in `providers.json`, after reading the file or with `ox.fs.edit`, with the phone's checks: the JSON stays valid, new services must exist, the model must be available, Default model asks as its policy says, and a file changed since it was read is refused. A temporary conversation can't change either. Provider definitions stay read-only here; Ox changes them with `ox.provider.save` and `ox.provider.delete`. Other app files are read-only, nothing in `app/` can be created, deleted, moved, copied or attached, and the Host has no app language, so there is no `settings.json`. Settings → Permissions lists the new Actions as the phone groups them: Default model under Models & secrets, and App info, Profiles, Actions and Logs, in the phone's order, under App settings. Changing the default model is labelled Change default model, so it is told apart from reading it. List model providers now also applies to `ox.provider.list`.
- PAR-7, notifications, as on the phone:
  - Settings → General → Notifications opens "Stay notified", with the phone's text and states:
    - the permission card with Allow;
    - already on;
    - off, with how to allow this site in the browser's settings;
    - and why it can't turn on: on an iPhone or iPad, add OpenOx to the Home Screen and open it from there; a browser without notifications; an address without https.
  - Turning it on asks the browser, subscribes this device with the Host's key and saves the device's language. Each device decides for itself, and revoking a device removes its subscription.
  - The Host notifies a device when none of its tabs is visible, as the phone does when the app isn't in use:
    - a reply finishes: the conversation's title and the start of the reply, or "Your conversation finished while you were away." when it has no text;
    - a conversation waits for the user: "Ox needs your approval", "Ox needs your input" or "Log in to continue";
    - a schedule fails: "<name> needs attention" and why.
    Notifications for one conversation replace each other, and tapping one opens the conversation.
  - Web Push uses VAPID and aes128gcm encryption (RFC 8291 and 8292), built on WebCrypto with no new dependency. Only the browsers' push services are accepted as endpoints, and a subscription a push service reports gone is removed.
- PAR-8, files, as on the phone:
  - PAR-8a, the file viewer. Opening a file anywhere shows it in the app instead of a new tab: a reply's link, image or embed, an activity step, the conversation's Files list or the Files page. The viewer has Close, the file's name and Download. A click with a modifier key still opens a new tab, as before.
    - Images fill the screen and zoom like diagrams. SVG shows as a static image without running its scripts.
    - HTML opens as a live page in a new tab, prepared by the Host under the phone's content policy:
      - sandboxed, with inline scripts and styles only, and nothing loaded from the network;
      - images, media and stylesheets next to the page are inlined from the Profile, up to 8 MB each and 16 MB in all, counting every reference;
      - links open in a new tab, and in-page anchors still work;
      - a page over 32 MB or not in UTF-8 opens as the file itself, under the file policy.
      It couldn't run inside the app in PAR-8a. A frame created by the app inherits the app's content policy, which forbids inline scripts, and `server.ts` sends `X-Frame-Options: DENY`. PAR-8b shows it inside the app without changing `server.ts`, which stays as it is because of the colleague's local patch on the Spark.
    - Markdown renders. Edit opens the source, and Save writes it, refusing if the file changed since it was opened, as on the phone. Closing with unsaved changes asks first.
    - Text and code show with colours, and audio and video play. A PDF or another file shows its name and size, with Open and Download.
    - A file that changes while it is shown, and isn't being edited, reloads.
  - PAR-8b, HTML inside the app, as on the phone:
    - Opening an HTML file shows the live page in the viewer, with Close, the file's name, Open in a new tab and Download. Open in a new tab opens the app at `#/file/<path>`, which shows the same viewer, so the page keeps the same limits in the new tab.
    - `![title](page.html)` in a reply or in a Markdown file shows the live page inline, as the phone's inline canvas:
      - it sizes to its content up to 720px and clips to an 18px radius, without an outline;
      - the file's name sits underneath with a dotted underline and opens the viewer;
      - loading and failure placeholders are 220px tall, with the native spinner;
      - re-rendering never reloads it: a reply's text keeps its live pages, and the conversation inserts rebuilt blocks, such as a bubble when a run starts or ends or an activity that opens, without moving the blocks that stay;
      - a page that changes reloads, and a deleted page shows its name struck through.
    - The Host serves the prepared page at `/api/files/frame` under the page policy plus `frame-ancestors 'self'`. Browsers ignore `X-Frame-Options` when a policy has `frame-ancestors`; Chromium, WebKit and Firefox were checked. So `server.ts` stays unchanged and no service worker is needed. A missing file, or a page that can't be prepared, answers with an empty page that tells the app it is unavailable.
    - The frame keeps the phone's sandbox: an opaque origin with no network, so the page can't reach the app or the Host. The app accepts only four messages from it: its height, that it is unavailable, the answer to the app's check, and Escape, which closes the viewer.
    - On the phone, a page can't leave its document, and links open only when tapped. In a browser, a sandboxed page's own script can't be stopped from navigating, because the Navigation API doesn't fire in documents with an opaque origin (checked in all three engines). Inside the app it can't get anywhere:
      - the app's own content policy (`default-src 'self'`) limits its frames to the Host's address, so an attempt to go elsewhere is blocked before any request leaves (checked in all three engines);
      - after each load the app checks that the page still answers. Chromium shows an error page after a blocked attempt, which fails the check, so the app replaces it with the failure placeholder, and the viewer then offers only Download. WebKit also fires a load event for an in-page jump, which passes the check.
      The web also removes `<meta http-equiv="refresh">`, disables `window.open` for the page's scripts, and opens links only on a real click, not a scripted one.
      A page opened outside the app isn't covered by the app's policy: a click with a modifier key opens the file itself in a new tab, as before PAR-8, and so does Open for a page that can't be prepared. Its script could still navigate away with the page's own content in the address.
  - PAR-8c, file cards and thumbnails, as on the phone:
    - `![title](file)` for a file that isn't an image, audio, video or HTML shows a 240px card, as the phone's file card: a 160px preview with the file's name underneath, on `surface-sunken` with a 12px radius. Clicking it opens the viewer.
      - Markdown shows its rendered start, text and code their first lines in monospace, and CSV and TSV their first five rows and three columns. All come from the file's first 8 KB. The preview is a picture only: nothing in it takes focus, and diagrams stay as their source, so the viewer still draws them at its own width.
      - A PDF or a spreadsheet shows its icon. An archive or another file shows only its name, as on the phone.
      - A changed file updates its card, and a deleted file shows its name struck through, as an HTML page does.
    - The Files page shows each row in a 40px tile on `surface-sunken`. Images up to 2 MB show the picture, loaded once the row scrolls into view. Folders and other files show their icon: a folder, an image, a page, audio, video or a file. Larger images keep the icon, so a folder of photos doesn't download every photo.
    - The phone's QuickLook pictures of PDF pages and office files, and its video frames, have no browser equivalent without new dependencies, so these show icons.
  - PAR-8d, the HTML service bridge, as on the phone. A page shown inside the app gets an `ox` object with the functions the phone's pages can call: `ox.service.list`, `inspect`, `validate`, `invoke`, `create`, `update`, `delete` and `showPage`.
    - `find` doesn't exist on Linux, and the phone's pages can't reach `attach`, `detach`, `listAttached` or the repository functions. New tabs get no `ox`.
    - Each call takes one options object with a `purpose`, as the agent's do. It goes from the frame to the app, and the app sends it to the Host with the page's path.
    - Each function has `.help()`, as on the phone. A failed call rejects with an error that carries a `code` and a `recovery` as well as its message, as the agent's errors do.
    - The Host checks the call against the same schemas the agent uses and runs it in a page context:
      - a page uses any installed service directly, without attaching it to a conversation, as on the phone;
      - every Action follows its policy, as for the agent.
    - Limits are those of the phone: arguments up to 1 MiB and answers up to 8 MiB; calls from one page run one at a time, with at most 16 waiting and 120 a minute; each call gets 60 seconds of its own time, not counting time spent waiting for the user.
    - Closing or reloading a page cancels its calls, including a call whose close reaches the Host before the call itself.
    - The Host streams each call's answer back after a newline sent at once and then every 20 seconds, which keeps the connection open. A call that waits for the user can therefore outlast the server's two-minute idle limit without changing `server.ts`.
    - The app sends one page's calls one at a time and refuses a 17th waiting call itself. Across all pages it runs at most two calls at once, so pages can't take up the browser's connections to the Host.
    - PAR-8d-1: the bridge, the page context and the functions that only read: `list`, `inspect` and `validate`.
    - PAR-8d-2: approvals beneath the page, in the viewer and under the inline page, and `invoke`, `create`, `update` and `delete`.
      - An approval uses the conversation's approval card: Approve, Always approve and Deny, with the Action's arguments behind its info button, as the phone reuses its permission card. It sits between an inline page and its file name, and at the bottom of the viewer.
      - When a call needs the user, the Host ends the call's response with the question, so a waiting call holds no connection and gives up its place among the two. The answer is sent as a new request, which streams the rest of the call. The 60 seconds don't run while the question waits; an unanswered question is cancelled after 15 minutes or when the page closes.
      - A choice is refused; no function a page can call asks one on this Host.
      - `invoke` needs the qualified name, `web:<domain>:<action>`, `api:<service>:<action>` or `mcp:<server>:<action>`, as on the phone, and uses the service without attaching it.
      - Each page session has its own owner in place of a conversation, as the phone's pages do. When the page closes, its website conversations close with it.
      - A page can't send Profile files to a service, as on the phone: website attachments are refused before approval, and MCP file inputs after it, where the phone reads them. Files a service returns aren't saved to the Profile; the page gets their names and sizes, as on the phone, which keeps them only until the page closes.
      - A call whose connection drops before its answer arrives is cancelled, with any question it was waiting on, so later calls aren't held behind it. When a call's connection fails, the app closes the page's session and uses a new one, in case the Host was still holding a question the app never received.
    - PAR-8d-3: `showPage` and service login beneath the page.
      - `showPage` opens the action's live page in the live-page viewer, as the phone presents its browser over the page. When the page is shown in the file viewer, the live page opens on top of it; Escape, Back, an Escape the page sends or any other attempt to close the file viewer closes only the live page first.
      - Because the page decides when it opens, a live page opened this way doesn't take the keyboard: focus goes to its close button, and the user clicks the website to type into it. A live page opened while another is open replaces it in the same history entry.
      - Website login hands its live page to the user with the conversation's hand-off card beneath the page. Done, in the card or in the live page, finishes the call, and Cancel ends it. The live page answers only the question it was opened for, and it closes when that question ends, for example when the page reloads.
      - Setting up an API service shows the conversation's credential form beneath the page, with the conversation's rules: every required field filled with more than spaces, at most 16,384 characters. The credential is saved on the Host and never reaches the page. If the Host still refuses an answer, the app cancels the question so the page isn't left waiting.
      - The live page's address isn't passed to the page; it only learns that the page was shown.
      - Known edge: an inline page acting in the background while the file viewer shows another file can still call `showPage`. Its live page then opens behind the file viewer, and the user's first Escape closes it. Nothing leaks; showing it on top would need every dialog to close the live pages it holds.
- PAR-9, live websites that feel native, and logins typed in the app (Percy, November 9, 2026: "a和c可以").
  - A live website is a headless Chromium on the Host, streamed to the app as JPEG frames. Before PAR-9, every gesture was a separate request sent after the last one finished, and a phone saw a desktop page without touch: scrolling lagged and stopped dead, and a second finger was ignored. The phone app doesn't have this problem, because its login pages run locally in WKWebView.
  - Meta's Muse also runs its browser remotely, streams it to the app, lets the user take control, and fills logins from a credential store, so the user rarely types into the remote page. PAR-9 takes the same two steps: make the stream feel native (a), and let logins be typed in the app (c). A video stream (b) waits until (a) has been tried on a phone; whether Muse streams video isn't public.
  - PAR-9a, native touch on the remote page:
    - A viewer whose main pointer is coarse, such as a phone or tablet, asks for phone mode: the Host emulates a mobile device at the viewer's size, with touch, so sites lay out for phones. A mouse viewer keeps the desktop page. When the last phone viewer leaves, the page returns to the desktop settings, and touch from a desktop touch screen ends with its stream.
    - Phone mode survives another viewer resizing the page, a first frame and page thumbnails. Playwright's resize puts back its desktop settings, so the Host applies phone mode again after it. Playwright's screenshots would too and would also reset the user's zoom, so in phone mode first frames and thumbnails are captured directly from the page; a screenshot already running when phone mode starts is followed by applying phone mode again. Chromium ignores settings sent again unchanged, so phone mode is always sent as a change. Changes to a page's emulation, touch and size run one at a time, so a rotation, which closes one stream while opening another, ends at the new size.
    - When the last phone viewer leaves, the Host clears its own settings before Playwright applies the desktop ones again, so later reloads and navigations keep the desktop layout.
    - The app forwards each finger with its time, and Chromium on the Host handles the touches as on a phone: scrolling with momentum, two-finger pan and pinch zoom, and taps. The Host compares each event with the fingers already down, so a new finger is pressed, a lifted finger is released and the others move. If Chromium has lost a gesture, the Host starts it again and logs a warning.
    - Chromium reads touch and click positions in page pixels and multiplies them by the page's zoom, so the Host divides each position by the current zoom; taps land where they are shown on zoomed-out pages and after a pinch.
    - The app keeps at most one input request in flight. Touch events and wheel deltas that arrive meanwhile are merged into the next request, so nothing piles up on a slow connection. Chromium accepts about one touch event per frame, so within a run of moves the Host sends only samples a frame apart from the last 100 ms, ending with the latest position: touch follows positions, so no distance is lost, and a pinch, a 120 Hz phone or a busy page doesn't fall behind. Each touch event keeps its original time, so momentum matches the finger even when events arrive together; a gesture that would start before the last one ended is moved later as a whole, keeping its spacing.
    - Frames carry the page's scroll offset and zoom.
    - Frames stay at 1x. Sharper 2x frames need the browser itself drawn at 2x; forcing that changed the geometry of desktop frames, so it waits.
  - PAR-9b, logins typed in the app:
    - A website login handed to the user, from a conversation or from a page, shows a sign-in form in its card: username or email, password, and Sign in. The user only needs the live page for a challenge or an unusual step.
    - The card names the site that will receive what is typed, taken from the live page's address and kept current as the page moves, and sends it with the values. The Host fills nothing if the page is on another site, both before the first field and after the username step of a two-step login, and the card says the page has moved, so a password never reaches a site the user didn't see.
    - Every card shares the Ox app's address, so a password manager would offer one site's saved password to another service. The username field turns autofill off for password-manager extensions, and the password field is marked as a new password, which keeps the browsers' own managers from filling saved passwords into it. The code field keeps its one-time-code hint, so a phone can fill a code it received.
    - The Host fills the live page's sign-in form and submits it with Enter, as a person would:
      - a one-step form: the username field before the password field in the same form, then the password;
      - a two-step login: with no password field on the page, the username alone, then the password once its field appears, within 8 seconds. This needs a clear sign of a login: a field marked as a username, or an email or user field in a form with a password field or a sign-in, next or continue button. A search box or a newsletter form is never filled;
      - a verification code: when the page asks for one, the card shows a code field and fills it the same way. A code field is one marked as a one-time code or named for one (otp, 2fa, mfa, totp, verification), not any field whose name contains "code", such as a ZIP code or a promo code. A page that still shows a password field is reported as the sign-in form, before any code; a password field marked or named as a code is a code field.
    - Only the page's own frame and frames of the same site are filled, so an embedded third-party frame never receives the values.
    - The card says what happened: the page took it (check the page if you like, then Done), the page still shows its sign-in form, the page asks for a code, or there is no sign-in form to fill (sign in on the page instead).
    - The values go only into the page: never to the agent, the transcript or the logs. The Host logs only which fields it filled and the outcome, and a page that can't be filled gets a plain error, so no browser message can carry a value. The app empties the password and code fields after each attempt and keeps the username.
    - The browser's own hand-offs (`waitForUserInteraction`) don't show the form, because they may not be logins.
    - Remembering a login for a site, so the Host can offer to fill it next time, is a later step, kept in the Secrets store.
- PAR-10, remote-browser compatibility (Percy, November 9–10, 2026).
  - Keep the existing viewer and design. Reproduce USTA through the Mac web client connected to Spark, retain a recording and inspect the rendered result after each action. Initial observation: opening its stream sometimes waits 30 seconds; wheel requests succeed and the scroll offset changes, but the visible page can become blank. USTA separately redirects to its blue authentication-error page; a working input request does not establish a working sign-in.
  - Check first-frame capture and stream cancellation before changing transport. A slow font must not keep an already-drawing page behind the connecting state. Frames must show the visible viewport, including after scrolling, resizing, reconnecting and overlapping viewers.
  - The rendered Mac check also caught a cropped Chromium screencast: the image was 87 pixels shorter than the emulated viewport, so pointer positions missed their visible targets. Set the captured surface's visible size explicitly after viewport/emulation changes, without platform-specific constants. Check JPEG dimensions as well as metadata: Chromium can attach a new viewport's metadata to an old-sized image during a resize.
  - Each live page owns one screencast shared by its viewers, with one validated latest frame. Resizes and mobile leases share the input queue; a departing viewer never stops another viewer's encoder. If Chromium's delayed window resize overwrites the visible size, change it before restoring the requested value, and wait for a correctly sized frame rather than displaying the intermediate image.
  - Complete ordinary desktop input in the same viewer: pointer movement, press/release, selection and dragging, double-click, right-click events, Shift+Tab and bounded editing shortcuts. Keep touch, keyboard text entry, zoom-correct coordinates, input ordering and existing handoffs working. Never intercept browser-reserved shortcuts that the remote page cannot perform.
  - Cancelling a press or losing the last viewer must release the pointer without clicking its captured target. Native browser menus, reading the remote clipboard and complete Mac shortcut/trackpad-zoom parity are not claimed by this packet.
  - Compare evidenced architectures, not guessed vendor internals. Muse's public browser-broker teardown supports CDP, actionability checks and interactive viewer sockets, but does not establish its display codec or protocol. OpenAI's computer-use integration guide demonstrates bidirectional noVNC/WebSocket as a reference, not as proof of Dots' implementation; Dots and Grok do not disclose enough to claim protocol parity. Fix measured failures before deciding that a full desktop or video stack is necessary.
  - Sources: [Muse browser teardown](https://mouse.dev/blog/muse-browser/), [OpenAI's computer-use integration guide](https://developers.openai.com/api/docs/guides/tools-computer-use-integration), [Dots announcement](https://openai.com/index/introducing-dots/).
  - Inspect upstream `0cbe51b8` independently of unrelated upstream work. Its native Host picker probes and saves a remote address but explicitly does not route native conversations. Verify that distinction in a real iPhone Simulator; test the actual Spark web client in that simulator's Safari, not only Playwright's phone viewport. Percy authorized the example bundle identity only for this simulator test; remove that task-owned installation afterwards.
  - Follow-up PAR-10c, found in actual Safari: Settings → Services must leave the settings interaction layer before showing a live website, even when Back reaches another Settings entry or the same hash. Keep the existing desktop/phone layout and ordinary Back/close behavior. Check those history cases with the rendered client, then repeat the actual iPhone handoff, scroll and keyboard.
  - USTA's `/en/login.html` entry fails before credentials in a fresh Spark browser, while its homepage's Sign in button opens the account form. The owner explicitly approved one directly authored, minimal USTA repair rather than Evolve for this incident, with no model calls. Verify the actual service login Action, not only a terminal browser click, and never enter real credentials or submit an account change.
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
  - Hover, in all four variants: `(hover: hover)` matches only on desktop. A settings row highlights under a desktop pointer but not on a phone, where a tapped row isn't left highlighted after going back. The selected row in the skill and service pickers and a tapped message's actions still show on a phone.
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
- Packet PAR-2c, skills from the composer:
  - Protocol checks (`linux-host-workspace.test.ts`):
    - a skill sent with words reaches the model as its instructions followed by the words;
    - it attaches the skill's services and records its use;
    - without words the conversation is titled "/name";
    - built-in, unknown and turned-off skills are refused, and a skill that isn't a string is 400;
    - the skill stays on the message after a restart, a branch and a regenerate, and an edit turns it into plain text.
  - Browser check in all four variants:
    - "/" lists only enabled skills that aren't built in, and typing filters them;
    - the keyboard and Escape work;
    - choosing a skill sends the skill bubble;
    - "/name words" adds the words bubble, and a file adds its chip;
    - after a long reply, the sent skill message stays in view;
    - "/" reopens the picker after Escape;
    - the bubble opens the skill;
    - an unknown "/text" stays plain text.
- Packet PAR-2b, composer paste, drop, files and hold to talk (browser check in all four variants, with the media service stubbed):
  - a pasted screenshot becomes "Pasted Image.png" and two become "Pasted Image 1.png" and "Pasted Image 2.png";
  - text with a generic image, as Office pastes it, attaches nothing and keeps the text;
  - a named file with text, as Finder copies it, attaches the file without typing its name;
  - a moved file is listed under its new name only;
  - a second hold during transcription records nothing;
  - dropped files attach on a desktop;
  - the "Files · N" chip counts the attachments and the files Ox wrote, skips skill files, and opens a file;
  - on phones:
    - a tap shows the hint;
    - a hold shows "Release to send", and releasing sends the transcribed words;
    - sliding out shows "Release to cancel" and sends nothing;
    - silence sends nothing.
  - on a desktop, and from the keyboard on a phone, the tap-to-dictate flow still inserts the words without sending.
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
- Packet PAR-5a, code, changes and thinking time:
  - Protocol checks (`linux-host.test.ts`):
    - after a streamed reply, its thinking row ends at the end of the response, at least the time the reply took to stream, and not at its start;
    - while the reply is still streaming, the row already starts where it will finish starting, and shows the time so far;
    - a phone package whose generation ran for 7.4 seconds imports with that thinking time, and exporting the copy keeps the generation's end;
    - a packaged response without a recorded time ends where it started, not at the next message.
  - Browser check in all four variants, with a model that replies with fixed Markdown:
    - JSON, Python, shell, Swift and TypeScript blocks colour their tokens with the theme's colours, a JSON value containing an escaped quote and a colon stays a string, `//` inside a string stays a string, an unknown language stays plain, and a block without a language is labelled Text;
    - a two-file diff says "2 files", lists both paths with Renamed and the old path for a rename, Added for a new file, the counts, and numbered, tinted lines;
    - collapsing a file hides its lines, the keyboard opens it again, and Copy copies the diff as written;
    - while a diff streams it shows no counts, and a file collapsed then stays collapsed when the reply finishes;
    - a diff without headers shows its counts in the header, and its long line scrolls inside its part only;
    - a binary file says "Binary file changed";
    - a reply that thought for about two seconds says "Thought for 2 seconds"; imported replies that took 7.4 seconds and 2 minutes 5 seconds say "Thought for 7 seconds" and "Thought for 2 min 5 seconds", and one without a recorded time says "Thought it through".
  - Timing check in Chromium: a 37,600-character JSON block whose value holds escaped JSON, a 75,800-character streaming cut that ends inside that string, and a 99,000-character script each render in under 50 ms, and a frame of text streaming after a finished block in under 5 ms.
- Packet PAR-5b, Mermaid diagrams:
  - Protocol check (`linux-host.test.ts`): the Host serves the Pele file that the web client's bundle names, as JavaScript cached by name and starting with Pele's MIT license banner.
  - Browser check in all four variants, with a model that replies with fixed Markdown:
    - Pele isn't loaded until a reply contains a diagram;
    - a flowchart and a sequence diagram are drawn as images in the theme's colours, and switching the theme draws them in the other colours;
    - a diagram with a syntax error and text that isn't a diagram stay code blocks labelled with their language;
    - a fence that is still streaming shows as code, and becomes a diagram once it closes while the reply keeps streaming;
    - after a reload, a conversation whose last reply ends with a tall diagram still shows its end once the diagram is drawn, without the jump button;
    - a diagram is described by its source, or by its `accTitle` and `accDescr` when it has them, and the full-screen image uses the same text;
    - selecting a diagram opens it full screen and fitted, with Close and Copy code, and Copy code copies the source;
    - a double-click, or a double-tap on phones, zooms to 3× and back; the wheel with Ctrl or ⌘, a Safari pinch gesture and a pinch on phones zoom; + and 0 zoom from the keyboard;
    - Escape closes the view and returns focus to the diagram.
- Packet PAR-6a, first run, What's New and importing memory:
  - Protocol check (`linux-host-workspace.test.ts`): the built-in `import-memory` skill can be sent from the composer and keeps a title set beforehand, its instructions reach the model, and it is refused while turned off; other built-in skills stay refused.
  - Browser check in all four variants:
    - a newly paired browser shows "A few things to know" with its three rows and Get started, and a reload doesn't show it again;
    - after an update, the browser shows only the release it hasn't seen, once, with Got it;
    - Settings → About → What's New lists every release with its date in the browser's language;
    - a new conversation offers "Import memory to Ox"; typing or attaching a file hides it, and a temporary conversation doesn't offer it;
    - selecting it sends the skill: the message and the conversation's title read "Import memory to Ox", and the model receives the skill's instructions;
    - after three new conversations have shown it, it no longer appears.
- Packet PAR-6b, the app folder:
  - Protocol check (`linux-host-workspace.test.ts`):
    - Listing the Profile shows `app`; `app` lists its five files and `actions`, which lists the built-in Actions.
    - `status.json`, `policy.json`, one Action's file and `providers.json` read with the phone's fields and never contain a key.
    - `services.json` takes a new name for an existing service, and refuses one for a service that doesn't exist and a full write without a read.
    - `providers.json` changes the default model the Host uses, and refuses a changed definition or a model that isn't available.
    - A read-only file, deletion and a temporary conversation are refused with the phone's codes.
    - `logs.jsonl` asks first, a denial keeps `permission_denied`, and a folder search skips it.
    - With Actions set to Ask and App info blocked, a search from `/` asks nothing, finds the user's file and `services.json`, and notes `status.json`, `policy.json` and `actions` once each; reading `policy.json` by name then asks once, and attaching an app file is refused.
    - While changing the default model waits for approval, another conversation can still write a file.
    - Blocking an Action blocks its file.
    - A Profile with its own `app` folder keeps it.
  - Browser check in all four variants:
    - Settings → Permissions → Built-in shows App settings last, with App info, Profiles, Actions and Logs in that order and Logs asking by default, and Default model and Change default model under Models & secrets, in English and Chinese.
    - A reply that read `app/status.json` shows the path without a link, and the conversation's files don't list it.
- Packet PAR-7, notifications:
  - Protocol check (`linux-host-notifications.test.ts`, with a stand-in push service):
    - the service worker is served without signing in, as JavaScript allowed to control `/`;
    - a subscription is stored per device, an endpoint outside the push services is refused, and `/api/push` never returns the endpoint;
    - with no visible tab, a finished reply sends a push that the test decrypts with its own keys: the title, the start of the reply, the tag and the link, signed for the push service's origin with the Host's key, with TTL and urgency;
    - a visible tab holds pushes back until it reports hidden or its stream closes;
    - a pending approval sends "Ox 需要你的批准" to a device that chose Chinese;
    - a failing schedule sends "<name> needs attention";
    - a push service answering 410 removes the subscription, and revoking the device removes it too.
  - Browser check in all four variants, with push stubbed to the stand-in service:
    - General shows Notifications; the sheet shows the permission card, Allow turns notifications on and the Host stores the subscription; reopening says they're on;
    - a denied browser shows how to allow it, and an iPhone browser outside the Home Screen says to add it there;
    - the service worker registers, and a hidden page gets a push while a visible page doesn't.
- Packet PAR-8a, the file viewer:
  - Protocol check (`linux-host.test.ts`):
    - `/api/files/page` returns an HTML page sandboxed under the phone's content policy, with the page's own body and the link handling, which tests each link's own `href`;
    - an image and a stylesheet next to it are inlined as data URLs, while external, missing, oversized and outside references are left as they were, and `srcset` is removed so a picture can't ask for a file that wasn't inlined;
    - a page with more than 200 references stops looking them up, references to one file stop being inlined once the 16 MB is spent, and a page that can't be prepared because it isn't UTF-8 opens as the file itself under the file policy;
    - files that aren't HTML are refused;
    - `/api/files/text` saves Markdown only over the text it replaces: it refuses a file that changed (409), lets one of two racing saves through and refuses the other (409), and refuses a file that isn't Markdown and text over 200 KB.
  - Browser check in all four variants:
    - the prepared page, opened in the viewer's frame since PAR-8b: its script ran, its inlined image loaded, an external link, a link inside an SVG and a link with spaces around its address open another tab, an in-page anchor doesn't, and a relative link does nothing;
    - an image opens and zooms with a double-click;
    - Markdown renders; Edit and Save write it; a change made elsewhere shows the error and keeps the draft; closing with changes asks, and pressing Escape repeatedly keeps the editor and its draft;
    - a file that changes reloads, a reload doesn't replace an editor opened while it loads, and leaving the editor unchanged shows the latest file;
    - Markdown with Windows line endings closes without asking when unchanged, and Save keeps its line endings;
    - code shows coloured tokens, and a PDF shows Open and Download;
    - a modified click opens a new tab, and a Files page row opens the viewer;
    - Escape closes the viewer and returns focus.
- Packet PAR-8b, HTML inside the app:
  - Protocol check (`linux-host.test.ts`):
    - `/api/files/frame` returns the prepared page under the page policy plus `frame-ancestors 'self'`, next to the Host's unchanged `X-Frame-Options: DENY`;
    - the injected script disables `window.open`, opens links only on trusted clicks, reports the page's height and answers the app's check;
    - `<meta http-equiv="refresh">` is removed from frames and from new-tab pages;
    - a missing file and a page that isn't UTF-8 answer with the unavailable page under the frame policy (404 and 415), and a file that isn't HTML is refused.
  - Browser check in all four variants in Chromium, phone light English in WebKit and desktop dark Chinese in Firefox:
    - a reply's link to a page opens the viewer with the live page: its script ran and its inlined image loaded; an external link opens another tab, an in-page anchor stays in the frame, and a scripted click opens nothing;
    - Open in a new tab opens the page in the app's viewer at `#/file/…`, and Escape inside the page closes the viewer;
    - `![title](page.html)` shows the page inline and sandboxed: a short page sizes to its content, a tall one stops at 720px, and the file's name opens the viewer;
    - the inline page isn't reloaded when a run starts and ends below it; a changed page reloads; a deleted page shows its name struck through, and a restored one shows again;
    - a page that tries to navigate away sends no request and leaves no frame on another address or an error page: it stays, or in Chromium it is replaced by the failure placeholder, and the viewer then offers only Download;
    - a page that isn't UTF-8 shows the failure placeholder inline within 2 seconds, and the viewer shows its card with Open and Download;
    - `![title](page.html)` in a Markdown file shows the page inline in the viewer.
- Packet PAR-8c, file cards and thumbnails:
  - Browser check in all four variants:
    - `![title](file)` shows a card for Markdown (its rendered heading), code (its first line), CSV (its header and rows), a PDF (its icon) and an archive (its name only), and each card opens the viewer;
    - nothing inside a card's preview takes focus, and a diagram previewed in a card still opens at full width in the viewer;
    - a changed file updates its card, a deleted one shows its name struck through, and a restored one shows its card again;
    - the Files page shows a small image as its picture and a large image, a folder, a page and a video as icons, and the picture loads only once its row is visible.
- Packet PAR-8d-1, the HTML service bridge for the functions that only read:
  - Protocol check (`linux-host-services.test.ts`):
    - a frame gets `ox` with `list`, `inspect` and `validate` only, and a new-tab page gets none;
    - a page lists every service as not attached, even one its conversation has attached, inspects a service that no conversation has attached, and validates a Local service, with answers that match the agent's output schemas;
    - `attach` is refused as not supported, a missing `purpose` as an invalid argument and arguments over 1 MiB as too large;
    - a default policy of ask is refused as `approval_unavailable`, and block as `permission_denied`;
    - another device or another page can't use a page's session; a bad session, a path with `..` and a file that isn't HTML are refused; a session closes once, and only from its own device;
    - a closed session can't be used again, even when its close arrived before its first call, and another device closing it changes nothing;
    - 64 sessions are kept, and the one idle longest makes way for a new one;
    - the 121st call in a minute and the 17th waiting call are refused as `rate_limited`; calls wait behind a slow one, and closing the page cancels the running call and those waiting.
    - The 60-second limit and the 8 MiB answer limit are checked by review, not by a test.
  - Browser check in all four variants in Chromium:
    - a page lists the Host's services inline and in the viewer;
    - its `ox` is frozen, has no prototype and can't be replaced; it offers `.help()`, refuses arguments that aren't one JSON object, and its errors carry a code and a recovery;
    - a burst of 20 calls runs 16 and refuses 4, sending one request at a time;
    - three pages calling at once share two requests, and a page removed with calls waiting sends none of them;
    - the viewer's page has its own session, which closes with the viewer; a changed inline page, and one taken out and put back, close their session and call with a new one;
    - the page opened on its own, at either of its addresses, has no `ox`.
- Packet PAR-8d-2, approvals beneath the page and the functions that change things:
  - Protocol checks (`linux-host-services.test.ts`):
    - an Action set to ask ends the call with the question; Deny refuses it, cancel cancels it, Approve finishes it, and Always approve stores the choice so the next call doesn't ask;
    - an answer to another question, from another device or outside the offered answers is refused, and a page closed while its question waits can't be answered;
    - a page invokes a web Action, and one needing approval after the question; a name that isn't qualified, the wrong kind and a missing service are refused, and `showPage` isn't available yet;
    - a page's website conversation opens under the page's own owner and closes with the page;
    - a page creates, renames and deletes an MCP service and invokes its tools; a file input is refused whether its path is relative or absolute, and a returned image isn't saved in the Profile;
    - website attachments from a page are refused before any website opens;
    - a call whose connection drops while it is still working doesn't hold up the page's next call.
  - Browser check in all four variants in Chromium:
    - a page's approval shows beneath the inline page with the conversation's approval card, and at the bottom of the viewer;
    - Deny refuses the call and Approve finishes it, and the card goes away;
    - two pages waiting for approval leave room for another page's call;
    - closing the viewer with its question waiting closes the page's session, and a page reloaded while its question waits drops the question;
    - a call whose connection is lost reports `unavailable`, closes its session, and the page's next call uses a new one.
- Packet PAR-8d-3, live pages and service login beneath the page:
  - Protocol check (`linux-host-services.test.ts`):
    - `showPage` after a page's own action returns the live page to the app, and with an input no action ran it reports that no page is available;
    - website login asks with the live page and Done; another answer or a form's values are refused, Cancel ends the call, and Done finishes the login so the account is listed;
    - API setup asks with the credential form; a missing, blank, non-text or too long token and a plain answer are refused, and the saved token never appears in a response.
  - Browser check in all four variants in Chromium, with fixture website and API services:
    - website login shows the hand-off card beneath the inline page; Open page shows the live website with its hand-off bar, and Done there finishes the page's login and closes the live page;
    - `showPage` while that live page is open replaces it and stays open, takes no typing, and leaves no history entry once closed;
    - in the file viewer, the live page opens on top; Escape, including one the page sends, closes only the live page; Cancel beneath the page ends the login; a page reloaded while its login is open closes the live page and the card; a forced close of the file viewer closes only the live page over it; nothing of the live page is left after the file viewer closes;
    - `showPage` opens the action's live page, inline and over the file viewer, and the page's own message listener never sees its address;
    - API setup shows the credential form beneath the page; a blank token is refused in the form, which stays open; Save stores the credential and finishes the page's call.
- Packet PAR-9a, native touch on live pages:
  - Protocol check (`linux-host-browser.test.ts`), with a fixture page that reports its layout, touch support, scroll, zoom, taps and touches:
    - touch input is refused without events or with more than 240, without `sentAt`, with an unknown kind or a missing time, with a finger id outside 0–9, a position that isn't a number, more than 10 fingers or the same finger twice;
    - a phone stream gives a page without a viewport tag the 980 px phone layout with touch, the first frame has the viewer's size, and the layout survives a thumbnail;
    - a drag scrolls the page, which keeps gliding after release, and frames carry the scroll; a tap presses a button;
    - a slow drag that ends in a pause, sent as one request as on a slow connection, scrolls by its own distance without gliding, because each event keeps its time;
    - a 2-second 120 Hz drag, sent in real time with one request in flight as the app sends it, finishes within 400 ms of the finger and scrolls by its distance;
    - two fingers spread from 0.3 to 0.7 of the width zoom to between 1.6x and 2.6x, the finger left after one lifts pans without changing the zoom, and frames carry the zoom; a thumbnail keeps the zoom; a finger still down when the stream closes is cancelled;
    - taps land where they are shown on a page zoomed out to 0.4x, by touch from a phone and by a click from a desktop viewer;
    - after the last phone viewer leaves, the desktop layout stays through a navigation and a reload;
    - closing the stream returns the desktop page, and no gesture had to start again;
    - a thumbnail requested together with a phone stream, four times, never leaves the phone on the desktop layout;
    - phone mode survives a desktop viewer resizing the page and taking its first frame, another phone viewer leaving, and a rotation (one phone stream closing while another opens at the new size), and ends with the last phone viewer; touch from a desktop viewer works and ends with its stream.
  - Browser check, a phone in dark Chinese and a desktop in light English, with 150 ms added to every input request:
    - phone: the phone layout; a tap follows a link; a drag scrolls and glides on, its events go in fewer requests than events, and frames carry the scroll; a tap presses a button; a pinch zooms past 1.5x; the keyboard button still opens text entry; closing the viewer returns the desktop page;
    - desktop: the desktop page; 30 wheel steps arrive in full in fewer requests and scroll the page; a mouse click still presses the button and sends no touch.
- Packet PAR-9b, logins typed in the app:
  - Protocol check (`linux-host-browser.test.ts`) on fixture sign-in pages:
    - a one-step form signs in, and a wrong password reports that the form is still showing; a form whose script submits after a short delay still reports that the page took it;
    - a two-step login fills the username, waits for the password page and signs in;
    - a page that then asks for a code reports it, and the code signs in;
    - a page without a sign-in form, a page with only a newsletter form and a page with only a search box report that there is none and send nothing, and a form in a third-party frame is never filled;
    - a sign-in that lands on a page with a ZIP code field reports that the page took it; a wrong password on a phone-number form with a country-code field, or on a form that also has a code field, reports that the form is still showing;
    - a field the page won't let the Host fill gives a plain error that carries no value;
    - a masked code field after the password is reported as a code request and takes the code;
    - a sign-in for a site the card didn't show fills nothing and reports that the page moved, and so does a two-step login whose username step moves to another site, before the password;
    - values that aren't text, that are longer than 1,024 characters, or that are all empty are refused;
    - no value appears in the Host's log, a response or the conversation.
  - Protocol check (`linux-host-services.test.ts`): a service's login hand-off is marked as a login, and the browser's own hand-off isn't.
  - Browser check, in all four variants:
    - the login card shows the form and the site that will receive the values, and asks password managers not to fill or save the username and password;
    - Sign in fills the fixture page, and the card says the page took it;
    - a wrong password says the form is still showing, keeps the username and empties the password;
    - a code request shows the code field, and the code signs in;
    - Done finishes the login;
    - the card's thumbnail follows the page;
    - the browser's own hand-off shows no form;
    - the Chinese card is fully translated.
- Packet PAR-10, remote-browser compatibility:
  - Protocol checks (`linux-host-browser.test.ts`): an unfinished font cannot delay the first frame; closing one viewer leaves the other live; frames retain the full viewport; desktop mouse and editing inputs affect the actual page; cancellation and disconnect release a captured press without a click; malformed coordinates, mouse events and shortcuts are refused. Keep the existing touch, login and private-network checks.
  - Mac web client connected to Spark: record initial draw, small and large vertical wheel deltas, reversal and momentum-like bursts, horizontal and nested scrolling, hover, clicks, double-click, dragging, selection, context-menu events, Tab/Shift+Tab, typing/editing/paste, navigation, resize and reconnect. Compare rendered frames with actual page state, not just HTTP success. Use a controlled page for deterministic interaction checks and USTA for the reported production failure; do not enter credentials or submit account changes.
  - Real reserved iPhone Simulator: install and launch native Ox under the authorized identity, inspect upstream remote-Host selection and its limits; pair Safari to Spark and record the real WebKit viewer's tap, scroll, keyboard, rotation and reconnect. Restore the device's boot state, revoke task devices and remove task-only app/configuration and disposable caches. Keep only the requested private screenshot/video evidence.
  - Native Host picker: Spark is reachable, selection survives reinstall/restart, and an accepting but silent WebSocket becomes unavailable after the probe timeout rather than checking forever. The probe must cancel its pending receive when the timeout wins.
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
- Packet UX-5, the composer and the + menu, desktop and phone: the composer keeps its width while the menu is open and after Escape, both at rest and focused; Files opens the file chooser and Services adds @ without changing the width; from the keyboard or an assistive-technology click the menu takes focus, the arrows move it and Escape returns it to +.
- Packet UX-4, the deployed Host on the Spark over the private network with the local model: record a phone and a desktop conversation and check the same streaming and scrolling behaviour.
- Packet ST-1, Settings rendered in desktop light and dark and phone light and dark, in Chinese and English, against ChatGPT's settings: tabs, rows and dialogs, Tab order, Escape and focus return, and that every change persists (appearance, language, default model, provider key, pairing, editing and removing a local machine, memory, profile name, pairing and revoking a device, forgetting approvals, sign out).
- Packet ST-2, skills protocol: a skill that is off is missing from the agent's skill list and `ox.skill.run` refuses it; New skill and Upload validate SKILL.md the same way as `ox.fs`; last used changes when the agent reads or runs a skill.
- Packet ST-3, local machines: protocol (`linux-host.test.ts`) pairs a second model server by `host:port`, picks the ID that matches its weights, refuses a duplicate and explains an unreachable address, keeps both machines across a Host restart, sends a chat to the chosen machine, renames and removes it and falls back to the remaining default; browser check of the Models tab (machines, This machine, Connected and Can't connect with a translated reason, pairing errors in the dialog, the default model offering both machines, edit, remove) and of a new chat falling back when its machine is removed.
- Packet PR-1, QR pairing: protocol (`pair --url` prints the link and a terminal QR code whose code pairs once; without an address it says how to get one); browser check that decodes the dialog's QR code from a screenshot in light and dark, opens it on a phone (code and name filled, Connect focused, code removed from the address, one tap pairs), ignores a used link on a paired phone, and hides the QR code on a localhost page; on the Spark, the same from a desktop to a phone over Tailscale.
- Packet MD-1, media service on the Spark: a recorded Chinese sentence is transcribed exactly, a reply is read aloud, a 1024 px image with Chinese text is legible, a phone video yields frames and its transcript; peak memory per model is recorded and a load is refused when memory is short.
- Packet MD-2, end to end with the local model on the Spark from a phone and a desktop: dictate a question, read a reply aloud, ask for an image, and analyze a video, an audio recording, a Word document, a spreadsheet and a scanned PDF.
- Packet CONN-1, provider-independent connection proof:
  - Preserve the existing loopback HTTP listener, private-network deployment and device/action authorization. Add only explicit Host-side TLS configuration; a reverse TCP carrier forwards application TLS without holding the Host's private key.
  - Use the actual pair page and client without Tailscale, a separate local Host and a scripted model. Check QR/code pairing, Secure cookies, authenticated HTTP/SSE/RPC, device revocation, strict TLS identity, carrier admission, remote interruption/reconnect and surviving local access.
  - Keep all prototype listeners on loopback; do not expose the shared Spark, change its private-network settings or generate model inference. Pin the optional carrier tool and keep its binaries, certificates, logs and screenshots outside the checkout.
  - Render the existing desktop and phone-layout pairing/chat states through the carrier. Do not report browser emulation as real iOS, loopback as cellular/CGNAT acceptance, or a ciphertext capture as proof of an operator-resistant browser design.
  - Commercial provisioning, stable Host identity, account/recovery policy, production certificate/domain ownership, fleet isolation, real WAN acceptance and native conversation routing remain separate gates.
- Packet V1-HOST, local-first Host settings and real workspace routing:
  - Pages: native Host picker/creation/connection details, the external-workspace shell, separate native inbound sharing; web Settings Host and connections; local Host CLI/pairing invitations. Reuse the current Theme/Settings rows and web design tokens; keep model-server settings separate.
  - Host: retain loopback HTTP by default. An explicit local-network startup option binds an assigned private IPv4 interface with a persistent private Host CA and HTTPS leaf. Advertise only the opted-in interface; do not change public networking, the shared Spark or model processes. Optional outside settings store a provider and trusted HTTPS entry, never credentials or automatic Tailscale enrollment.
  - Pairing: an invitation carries the one-time code and private-CA fingerprint in the fragment. Discovery is untrusted reachability metadata, not permission to accept a certificate. App trust is scoped to the selected origin and pinned private CA, with standard hostname/leaf-chain evaluation; standalone browsers still need trusted HTTPS or loopback.
  - Native: keep embedded-phone mode unchanged. Selecting an external Host opens its actual web workspace with isolated persistent website data and a permanent way back to Host settings. Route/origin changes are explicit; no automatic credential transfer, data migration or fallback to the phone. Split outbound selection from inbound Host sharing.
  - States: local-only/unconfigured outside route, discovering/no results/permission failure, unreachable/timeout, reachable but unpaired, paired, wrong CA/name/expired leaf, revoked credential, saved-config collision/failure and offline recovery. Show the data location and selected address; do not label an unmeasured route P2P.
  - Protocol packet: default compatibility; reject public/unassigned local binds and bad outside URLs; persistent CA/leaf identity and owner-only files; partial/corrupt TLS state fails rather than rotating identity; encrypted local pairing, replay/refusal, remote-setting validation, no secrets in URL queries/logs and complete discovery/listener cleanup.
  - Rendered web packet: desktop/phone, English/Chinese, local status and outside settings, current-session test, pairing invitation and safe origin navigation without copying tokens. A failed operation stays visible and preserves input.
  - Native packet on one reserved pool simulator: default local app; add/scan-or-paste private-CA invitation; actual scripted Host reply through the selected workspace; restart/cookies; wrong certificate/origin refusal; offline without phone fallback; separate explicit outside address; edit/remove confirmation and isolated data stores. In-app camera hardware is not established by Simulator paste testing.
  - Existing native configurations without the new routing-acknowledgement field retain the prior phone-native workspace. Show why old saved connections need a fresh selection; never activate an old reachability-only selection automatically. Include that upgrade state in the native packet.
  - Build both native targets for shared changes, run portable/targeted gates and review actual screenshots. Use only the expressly approved simulator identity for this change set, remove task-created installation/configuration, restore initial boot state and release the claim. No new public tunnel or real inference is authorized.
- Packet MP-1, model packs protocol (`linux-host-packs.test.ts`): every manifest pins its image and revision, leaves the serving flags to the runner and has no argument containing spaces; the runner refuses an unknown pack, lists each pack with whether it fits, and on a machine without an NVIDIA GPU reports which requirement fails and points to Settings → Models. With a real Host, a stand-in model server and a stand-in for Docker: `start` makes the pack the default of a Host with no local machine, changes nothing when run again, switches a machine at its address that lists another model (keeping its name) and the default with it, and leaves no temporary device; `remove --purge` deletes the downloaded weights even after a plain `remove` and keeps weights given with `--weights`.
- Packet MP-2, a pack on the Spark: `check` reports every requirement; `install` downloads the pinned revision and verifies it; started while the machine's memory allows, it serves the model and a phone and a desktop chat with tools and images through it; streamed tool calls parse; `stop` frees the memory and `status` reports each state.
