# Feature acceptance

Owner requested a reusable feature-to-case map on November 11, 2026. A changed feature must name the affected case IDs, run the matching bounded packet and record actual results before handoff. Passing source checks does not prove a rendered user outcome. Use the existing protocol, storage-compatibility and eval suites; do not create a fourth general test suite.

## Change gate

Identify affected features from behavior and shared dependencies, not just filenames. Before editing, add missing cases with setup, user actions, expected visible states and authorization/data invariants. After editing, run the smallest affected packet plus required source gates. Record build, client, network/fault method, case outcomes, screenshots and cleanup outside Git. Mark unexecuted or simulated conditions explicitly; a mobile viewport is not a Simulator, a Simulator is not a physical phone, and an unavailable endpoint is not proof of disabled radios or a real cellular route.

Changes to shared authentication, transport, storage or UI helpers also run their dependent feature cases. Failures introduced by the change block delivery; an unavailable required environment must be reported, not silently counted as a pass. Never modify a shared machine's networking, real credentials or other people's work to inject failures. No automated retry of an uncertain mutation.

## Feature map

| Feature | Current source boundary | Required packet / existing evidence lane |
| --- | --- | --- |
| Pairing and local Host console | `apps/linux/src/auth.ts`, console scripts, `web/host-console.*`, pairing UI in `web/app.ts` | PA below; existing Host protocol and Mac archive checks; actual Safari/Simulator UI packet |
| Local Host lifecycle | Mac engineering launcher/runtime, authorized local console and owned HTTPS listener | HL below; PA-07/11/13, CN-07 and existing archive/private-CA behavior |
| Connectivity and session recovery | `src/server.ts`, `src/api.ts`, `src/connections.ts`, web events/client and connection settings | CN below; Host protocol, local-connections and workspace packets |
| Host/workspace selection | native Host settings, `web/settings.ts`, workspace context/navigation | Two-Host workspace packet; pairing/session isolation; unsent work guard |
| Conversations and model selection | profile/runtime, web composer/transcript and providers | Existing Client-Host conversation/provider protocol; send/failure/recovery; targeted native/browser review |
| Files and attachments | filesystem, upload/content routes, file viewers/composer | Existing filesystem/media protocol; upload/read/delete-confirmation; interrupted-write and access boundaries |
| Services, login and approvals | VM services/repositories, web prompts/viewer | Existing services/repository/browser protocol; approval deny/cancel/allow; credentials excluded from output |
| Schedules, skills and memory | profile/VM workspace, web capabilities/settings | Existing workspace protocol; create/pause/resume/delete, persistence and missed schedule; targeted UI |
| Personal-agent Todos preview | opt-in Linux Profile Todo state, VM/API tools, web Tasks | PT below; existing workspace/notification boundaries, real rendered creation/edit/complete/conflict/recovery |
| Remote browser and media | page/browser routes, viewer/input and media service | Existing browser/media protocol; real touch/desktop packet; network/closed-page and permissions; no shared Spark workloads |
| Notifications | notifications/push and web presence | Existing notification protocol; foreground/background, revoke and lost subscription; physical-device gate |
| Shared notification inbox preview | opt-in Profile inbox, Host publishers, authenticated read API and web notification view | PN below; existing Push delivery unchanged when preview is off, explicit read/SSE/restart/revocation and actual two-client render |
| Reviewed memory and Skill suggestions | opt-in Profile review records, existing MEMORY/Skill file owners, reviewed publishing and web review page | RV below; maintained workspace packet, exact source revision, no premature activation, visible owner decision/recovery and legacy manual paths |
| Native installation and storage upgrades | native project/runtime, persisted data | Affected native builds and actual predecessor-to-current storage packet; never erase personal state |

These are change-routing entries, not claims that every feature/device/network combination is accepted. Add detailed cases when work first touches a feature; do not invent pass results for this inventory.

## Pairing packet PA

All cases use isolated Host data and an explicit client identity. Check the Host list and client screen together. Existing paired clients and Host history/files must remain unchanged unless the case explicitly revokes that fixture client.

| ID | Setup and user actions | Required visible result and invariant |
| --- | --- | --- |
| PA-01 | Unpaired browser opens the Host; close/back before Connect | No new authorized client, no workspace access, invitation not consumed by viewing |
| PA-02 | Mac Safari opens console, Add, Generate while invitation is active | Complete scannable QR inside visible scroll region; readable current code/expiry; one real replacement, previous code refused |
| PA-03 | Decode actual Host QR; open it in real iPhone Simulator Safari, Connect, first-use confirmation, send | Correct Host/workspace and disclosed fixture reply; Host shows that client and observed live web session; normal TLS |
| PA-04 | Slow Generate, overlap an old poll, close/reopen during generation | Pending feedback; old QR hidden; action cannot duplicate; late poll never restores old code; reopening is not blank |
| PA-05 | Generate commits but reply is lost, then explicit retry | No success-shaped old QR; clear uncertainty/recovery; retry creates one replacement; existing clients retained |
| PA-06 | Expired/replaced/used code, incorrect code, five wrong attempts | Actionable refusal, no client added or unauthorized content; new invitation can recover; single use and attempt limit retained |
| PA-07 | Host revoke dialog: cancel, then confirm one selected client | Cancel changes nothing; confirm removes only selected authorization and closes its sessions; old browser cannot fetch/send/reconnect; files/history retained |
| PA-08 | Client signs out, returns/back/refresh | No authenticated content/actions; other clients retained; fresh authorization required: remote browsers pair again, an authorized local console may reopen directly |
| PA-09 | Two clients attempt the same one-use invitation | At most one authorization succeeds, other receives refusal; no duplicate identity or cross-client credential transfer |
| PA-10 | User leaves while Connect is pending, including lost success reply | Cancellation before submission creates nothing; after submission outcome may be committed, never assert rollback; Host list remains authoritative, no automatic duplicate/replay |
| PA-11 | Unauthenticated/foreign-origin/missing-CSRF console actions, reused launch grant, private-LAN console access | Explicit refusal; no pairing/revoke side effect or credential disclosure; management remains loopback/OS-authorized |
| PA-12 | Console empty/list/detail/Host info/search/QR/revoke/stale flows in EN/ZH light/dark at compact, intermediate and desktop widths; inspect short recordings | Ox shared control/type/spacing/color roles, visible focus, accurate selected destination, full native Safari QR, every header action at least44px, long content without clipping; CLI activity is not a browser-session or physical-online claim |
| PA-13 | Already-authorized local console opens workspace with a fresh or returning browser while a phone invitation is pending; lose a committed admission response and explicitly recover | Direct workspace entry with a normal scoped cookie, no repeated Connect/pair-code screen, existing browser authorization reused, pending phone invitation unchanged; unauthorized/foreign/replayed/expired/wrong-Host/malformed grants fail explicitly; uncertain admission never silently retries or claims rollback |
| PA-14 | Walk the console and every reachable workspace page through normal navigation, including open/return/Back and local versus remote client entry; inspect shared sheets in actual Mac Safari | One meaningful navigation hierarchy per surface; visible page/workspace identity, truthful storage/access/model state and recoverable loading/empty/error states; inventory each route, review native sheet-body visibility and scrollability rather than accepting DOM presence or a passing subset |

Closing the Host QR sheet dismisses its view; it does not cancel or revoke an invitation. Regeneration invalidates an unused invitation; revocation removes a paired client's authorization. Tests must not present these different operations as the same action.

## Host lifecycle packet HL

| ID | Setup and user actions | Required visible result and invariant |
| --- | --- | --- |
| HL-01 | Double-click/open the console on fresh prepared data, then reopen while stopped/running | Console opens without Host listener, scheduled work or model calls; actual state retained, one owned manager, no duplicate Host or implicit enable |
| HL-02 | Start once, repeat rapidly/from another authorized tab, open workspace and pair a remote fixture client | Visible starting/running state, one listener/runtime, normal TLS/auth/cookie behavior; local entry reuses access and preserves the phone invitation |
| HL-03 | Stop dialog cancel, then confirm; reconnect an existing client after re-enable | Cancel changes nothing; confirm closes only owned Host sessions/work, console stays authorized and usable, data/identity/access survive; no interrupted-work resume promise |
| HL-04 | Start with occupied port or invalid/unreachable identity/interface, then repair and explicitly retry | Failed state with recovery; no success-shaped running status, leaked partial listener or hidden retry; console remains reachable |
| HL-05 | Unauthenticated/foreign/missing-CSRF lifecycle requests, conflicting/delayed/lost action responses | Explicit refusal or uncertainty; no unauthorized transition, duplicate action or stale poll overwriting newer state |
| HL-06 | Inspect default/devices/details/More information and each lifecycle state in desktop/compact EN/ZH light/dark | Status/control/access are primary; technical details secondary, no redundant navigation or clipping; actual screenshots/recording reviewed |
| HL-07 | Full engineering Stop, stale record, wrong bundle/PID and subsequent reopen | Only verified owned resources close; unrelated processes, owner data/identity and external workers remain; normal launch can recover without bypassing ownership guards |

## Connection packet CN

| ID | Setup and user actions | Required visible result and invariant |
| --- | --- | --- |
| CN-01 | Client loses its route to the test Host after pairing, then returns | Disconnected/reconnecting feedback, no fabricated success or logout; draft retained; same valid pairing recovers; session counts are observed connections, not physical online status |
| CN-02 | Client opens a cold Host URL while that route is unavailable | Explicit browser/connection failure, no stale workspace presented as live, no insecure/public fallback |
| CN-03 | Delay requests/responses and interrupt an authenticated read | Bounded pending/retry feedback; no duplicate user actions, no missing/duplicated committed content; recover after route improves |
| CN-04 | Send fails before reaching Host | Error is visible, unsent input retained, no hidden automatic replay; explicit retry sends once |
| CN-05 | Host accepts a send but response is lost | Do not label it definitely unsent or automatically resend; retain the text, show uncertainty and require a separate confirmation before repeating the same submission so the user can inspect committed history |
| CN-06 | Host revokes client while its route is unavailable; reconnect | No restored access with old cookie/token; fresh pairing needed; cached past content is not proof of authorization |
| CN-07 | Host stops/restarts with same data/identity | Honest temporary disconnect; existing valid clients/history/files survive; revoked identities stay revoked |
| CN-08 | Client outside reachable LAN, no outside route configured | Local URL cannot reach Host; settings clearly distinguish LAN from optional self-managed outside route; no automatic third-party relay or account enrollment |
| CN-09 | Client outside LAN with an explicitly configured approved outside route | Normal TLS and pairing/session behavior through that route; no workspace migration, credential leakage or silent route switching |
| CN-10 | Internet unavailable but reachable LAN remains | Local Host/scripted workflow does not need vendor login/relay; external model/tool calls must fail honestly, not claim local success |
| CN-11 | Physical phone disables all network, uses poor Wi-Fi, changes Wi-Fi/cellular, backgrounds/returns | Device/browser-level evidence for disconnect/recovery and persisted identity; test proxy failure is supporting evidence, not this physical-radio pass |

## Personal-agent Todo packet PT

The initial slice is opt-in with `OPENOX_PERSONAL_AGENT=1`; existing Hosts keep their current behavior. It delivers shared Agent/page Todo objects and one-time reminder handoff, not recurring follow-up, browser monitors, device delivery or 24-hour acceptance.

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| PT-01 | Agent/page create, inspect, edit, complete/reopen and confirmed delete | One durable Host object and stable ID; tool writes honor real approval, page data matches receipts; no success text without save |
| PT-02 | Repeat create key, change its body, concurrent stale edits, restart | Same key does not duplicate, changed intent/stale revision conflict before mutation, actual data survives and deleted requests do not resurrect |
| PT-03 | One-time reminder, completion/change before dispatch, Host restart | Deterministic notification handoff uses no model; cancelled/unsent reminder suppressed, queued identity retained; handoff is not physical-device delivery |
| PT-04 | Preview off, existing data/schedules, bookmarked Tasks/Inbox route, then enable again | No exposed Todo tool, active Todo work or create/settings actions on a disabled page; stored data and old schedules unchanged; unknown/malformed input fails explicitly |
| PT-05 | Actual Tasks navigation, create/edit, stale or uncertain save, cancel/confirm deletion; EN/ZH desktop/compact light/dark | Inputs and focus survive recoverable failure, reminder time/zone are explicit, no duplicate submit or silent mutation replay; screenshots prove the visible result |

Use the existing workspace protocol with fresh data and a loopback scripted model. Render the Tasks list and create/edit/confirmation states through normal navigation in desktop/compact EN/ZH light/dark; test loading, error/conflict and recovery. No shared GPU workload is part of this packet.

## Personal notification inbox packet PN

The same opt-in preview owns one persistent inbox per selected Profile, not a separate user account system. A delivery receipt, fetch or popup is not a read receipt.

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| PN-01 | Finish a fixture conversation/create a due Todo; receive/fetch from two authorized clients | One durable notice identity with its real target; delivery and read stay separate, no fetch-triggered read |
| PN-02 | Explicitly view/read, repeat, refresh/restart, revoke the second client | Shared idempotent read timestamp/count, stream refresh for other online pages, restart retention; revoked credentials cannot mutate |
| PN-03 | Preview off, denied/unsupported Push, already-shown or offline OS notification | Legacy transport unchanged; inbox works without OS Push permission when enabled; local popup cleanup is best effort, no claim of immediate remote withdrawal |
| PN-04 | Counts-only badge refresh and two real browser contexts; compact/collapsed foreground, open list/detail, hide/show, read and recover | Header count stays visible when the sidebar is hidden; badge response omits private notice bodies; fetch/background do not mark read; visible detail shares read state; exact notice-ID cleanup never closes a newer same-tag popup |

## Reviewed suggestion packet RV

The personal-agent preview exposes a review queue; assistant submissions start paused. Every model-produced memory/Skill proposal stays inactive until an explicit owner decision, including self-labelled explicit facts. This is a conservative reviewed workflow, not an autonomous sensitive-profile classifier. Existing explicit manual MEMORY/Skill tools remain their original capability; background delegation/automatic history mining is not authorized by this queue.

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| RV-01 | Enable submissions; scripted Agent proposes a preference; fetch, review, accept, replay and restart | Proposal does not alter MEMORY/prompt; owner acceptance uses the real file owner, preserves manual text, has a durable receipt and appears in subsequent context; no second active memory truth |
| RV-02 | Change MEMORY after opening review, reject/delete another proposal, edit/clear current memory explicitly | Stale source conflicts before mutation; drafts and manual data survive; rejecting/deleting a review record is not a claim of erasing memory/history; source-conditional owner edit works |
| RV-03 | Propose a create/update Skill, inspect validation/source/services, accept or race a manual edit | No active Skill before acceptance; existing parser/owner/sandbox and policies retained, no automatic grants; stale update cannot overwrite a manual change |
| RV-04 | Pause submissions, use manual memory editing, disable/re-enable the preview | Paused assistant proposal denied without mutation; manual owner controls remain available; off means no new review API/tools/work, existing data retained |
| RV-05 | Normal Review navigation, memory editor, candidate detail/decision, pause and failure/recovery in EN/ZH desktop/compact light/dark | Stable actual control IDs, 44px targets, clear current versus proposed content and unverified model attribution; no hidden activation, double submit, draft loss or success-shaped fallback |

Render the inbox list/detail, unread badge and read propagation with two real isolated browser contexts. Mark user-visible read only on an explicit view in an active page, not message delivery or background refresh. Use approved local fixtures; physical-device Push/read cleanup remains a separate gate.

## Public-page observation packet WM

The personal-agent preview observes owner-selected public page text without a model, account connectors or signed-in cookies. This is a bounded change detector, not semantic news/event tracking or a promise to run while the Host sleeps.

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| WM-01 | Create paused, replay/change a key, edit with fresh/stale revisions, restart and delete | One private Profile-owned watch, durable receipt, explicit validation/conflict and no silent resurrection or accidental enable |
| WM-02 | Seed an ordinary Host browser cookie/page; check the same public fixture twice, change text, repeat, then fail and recover | Fresh anonymous read; baseline/unchanged cause no notice, change creates one atomic Inbox notice, failure preserves last valid hash/time and is never no-change; no model, subresource or site-script write |
| WM-03 | Enable a held first check, pause/edit/delete while in flight, release; restart interrupted/overdue work | Stale result cannot publish or notify, next check reflects owner state, one serial observation and no catch-up burst |
| WM-04 | Private/credential URL, cross-host/private redirect, invalid scope, preview disabled/re-enabled | Existing network/TLS/pinned-proxy boundary retained, explicit failures before unsafe dispatch, no cookie/service grants or resident-page eviction, stored data and legacy Schedules preserved |
| WM-05 | Normal Automations list/detail/editor/Check now/pause/delete and failures in EN/ZH desktop/compact light/dark | 44px actual controls, equal padding, visible errors/recovery, protected draft/pending requests, precise last-valid versus latest-attempt status and truthful Host/model limits |

## Personal workspace overview packet OH

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| OH-01 | Open the gated Home with no selected model; open existing model/credential/service/permission controls | Usable model-free task/observer paths and honest model setup; no canned replies, implicit model/credential probe or duplicated settings owner |
| OH-02 | Create/update a Todo/watch/proposal/notice and receive real SSE; fail a summary read | Counts-only data agrees with owners, no title/note leak or write-on-GET; failures are not zero and open editors/alerts survive refresh |
| OH-03 | Inspect Host/model labels, sleep/uptime explanation, existing Chat and disabled preview | Selection is not reachability/loaded/GPU acceptance; Host must remain awake, clients can close, old Chat entry and master-off behavior unchanged |
| OH-04 | Render empty/configured/error/recovery, normal navigation and all links in EN/ZH desktop/compact light/dark | Deliberate existing-product layout, 44px controls/equal padding, no overflow or hidden retry; exact packaged preview remains a later acceptance gate |

## Independent local preview packet LP

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| LP-01 | Build/unpack personal preview with existing Mac packager, inspect files/dependency links/build identity | Self-contained Bun/runtime, no private identity/data/credentials/env or scripted provider; normal engineering mode unchanged; final build revision/dirty state honest |
| LP-02 | Start own loopback Host, request one-use grant through private Unix control, open normally and retry/reuse | No unauthenticated public management; owner directory/socket permissions, Origin/CSRF/TTL/single-use intact, literal Home destination only |
| LP-03 | Keep a normal localhost Host cookie while opening/logging out of scoped preview; test wrong/combined cookies | Default cookie behavior unchanged, no cross-Host overwrite/fallback or accidental authority; all HTTP/RPC/SSE/pair/logout call sites honor scope |
| LP-04 | Normal owned stop/restart and repeated open; conflicting/stale record or nonempty foreign data | Data/browser authority retained, one owner/listener, no other PID/service stopped and no blind overwrite; incomplete ownership/recovery is explicit |
| LP-05 | Run exact bundled/installed artifact and normal browser launcher; inspect no-model Home and setup/task/observer paths | Real usable local preview, truthful no-model/Host wake limits, no fake replies or OS/global/service changes; actual model/device/24-hour proof stays separate |

## Upstream compatibility packet UP

November 12 integration freezes fork `97f8b705` and upstream `ziyzhu/openox` `5bd54b97`. Keep the fork's local-first Host trust, explicit remote workspace routing, console-only lifecycle and verified Linux capabilities. No owner working Profile, live Mac manager, Spark/MyGPT, real provider or external account is an integration fixture. A clean textual merge is not a compatibility pass.

| ID | Surface / actions | Required result and invariant |
| --- | --- | --- |
| UP-01 | CLI validates/imports repository metadata containing synthetic throwing JavaScript | Validation never executes repository JavaScript; malformed metadata and missing required files remain explicit failures |
| UP-02 | Linux Pi1.5.2 SQLite writes and streamed/committed conversation projection, tools, retry/cancel/restart | Counted writes return real affected-row counts; view projection preserves committed history/live deltas, no duplicate past thinking or silent submission replay; verified Linux functions remain available |
| UP-03 | Isolated pinned1.3.0 predecessor storage opens in merged1.5.2, then restarts | Synthetic history/memory/attachments/schedules and authorization survive; no owner-data migration or unsupported rollback claim |
| UP-04 | Services/Secrets manual login, references, session/page/frame routing and approval policy; Browser snapshots, incremental capture/filtering and bounded body shapes | Shared contracts match actual Linux/native implementation; no plaintext credential exposure, silently ignored targeting/filter arguments or unsupported sign-in reported as success; stale capture cursors fail, omitted frame coverage stays visible and human completion is never inferred |
| UP-05 | Native Host picker/settings, saved legacy selection, trusted LAN/outside entry and failure | Preserve CA identity, per-origin WebKit data, explicit workspace routing and embedded fallback rules; no silent trust downgrade or lost route settings |
| UP-06 | Native conversation/composer, service handoff/credential screens and changed native-only visualization | Both targets build; representative light/dark Simulator renders and actual interactions reviewed using normal app identity and a claimed existing pool device; non-native presentation limits stay explicit |
| UP-07 | Mac package default console, start/stop, HTTPS QR/local entry, revoke and client/data retention | Existing PA/HL/CN packets remain passing with merged resources; localhost alone never grants management; no unexpected Host/model work or external-worker control |

Record before/after call paths, dependency/resource changes, storage compatibility, actual native launches/Mock turns and build/test evidence outside Git. Source publication or any live-service upgrade requires reviewed author approval after these checks; upstream version numbers and release notes are not deployment authority.

## Execution record

UP-01/07 local integration evidence includes124 passing repository cases, both native builds, the real Linux and native1.3-to1.5 before/after/restart matrices,83 exact Native contracts, pinned offline HTML extraction parity,14 actual-Safari archive groups, the full76-state web inventory and a normal iPhone Simulator Safari pairing/send/revoke run. Native capture/field tests use settled layouts and real-duration touches; known WebDriver input and OCR-observer failures are tooling failures, not accepted application outcomes. Linux live-page guidance explicitly excludes Native automatic Done/Cancel follow-up behavior. Real accounts/models, physical radios/cellular, configured WAN/private-CA native entry and dirty-repository migration variants remain unexecuted in this packet; preserved source, portable checks and loopback fixtures do not imply those passes.

For PA-14, the inventory includes console list/Host/device/QR/revoke/authorization states; workspace first use, empty and populated conversation, Files, Schedules; Settings General, Host and connections, Models, Workspace, Devices and security, About, Permissions, Services, Repositories and Secrets; Workspace Memory/Skills and available item detail/overlay states. Record unavailable tools/providers as unavailable, not accepted functionality. Native app screens and the separate marketing website are outside this web-Host inventory.

Keep per-run case IDs and pass/fail/blocked/not-run results with source/build/device identities in private evidence. The current native Safari clipping repair and real `ox-1` iOS 26.2 pairing are recorded in `plans/linux-host.md`. Network-fault and cancellation/revocation results must be added after execution; real off-LAN/cellular and physical-radio coverage stay open until actually tested.

Maintained pairing files live in `.agents/skills/test/protocol/client-host/pairing/`: `authorization.test.ts` and `workspace-entry.test.ts` run in the existing protocol suite, `archive.ts` is the explicit packaged-runtime/UI packet, `connection-browser.ts` covers CN-04/05 transport-fault/retry UI and `native-safari.ts` adds actual Mac Safari when `--safari-driver` is supplied. `--workspace-pages` runs `workspace-pages.ts` and expands native checks to direct entry/reuse and readable skill/notification/release sheets. The old `apps/linux/scripts/mac-host-package-check.ts` command forwards to the canonical runner. Native iPhone HID screenshots and bounded manual/OCR exploratory runs remain private evidence, not portable CI or a second maintained implementation.

`--host-lifecycle` exercises the actual packaged Open Console entry without Host work and runs `lifecycle-browser.ts` against Chrome desktop and actual WebKit phone-touch. It covers controlled start/stop/cancel, occupied-port recovery, uncertain replies, offline revocation and valid-client cookie/history/draft/file survival; an authorized `--safari-driver` adds actual Mac Safari lifecycle buttons. The November 12 local packet passed 14 groups plus 121 repository cases; owner runtime publication/upgrade is a separate reviewed action.

The November 11 native iPhone packet exercised PA-03, cancelled/confirmed PA-07, CN-01, delayed CN-03, CN-06 and cold CN-02 with a controlled trusted fixture gateway. A stopped fixture endpoint supplies only an unavailable-route equivalent for CN-08. PA-01/06/09 and revoke/session refusal also have portable protocol coverage. The browser packet covers before-send loss, lost committed replies, cancel/confirm of a repeat and navigation during that confirmation. Real Internet-only outages, configured WAN access and physical radio/carrier changes remain blocked environment cases, not passed by the proxy or browser packet.
