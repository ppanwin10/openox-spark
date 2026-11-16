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
| Muse-parity Main chat foundation | default-off Linux conversation role and authenticated API; later workspace shell | MU below; stable Main/Side ownership, concurrent explicit creation, branch/regenerate/delete/restart and off-gate preservation; not a visual-parity claim |
| Muse Data controls | original Linux Host/Profile/files/review/VM owners, paired web Settings | DC below; content-use explanation, passive no-model import/review, complete declared-scope export and protected confirmed/recoverable Reset |
| Muse Connectors | original Services/Catalog/Preferences/Attachments/Secrets/MCP/Browser owners, paired Settings | Muse CN-01–03 and connector CP-05 below; PP/direct network excluded |
| Muse Permissions | original format2 Approvals, trusted submission lifecycle, Browser/API/MCP/page bridge/ScheduleStore | PP/CP-05 plus current DP-01–05 finite direct transports below; full application clients and finer grants remain separate |
| Muse global Search | original visible Pi title/message and public file IDs/text, paired overlay and original controller | GS-01–05 below; no model, index, preparation write or native Search surface |
| Muse message actions | original Linux conversation metadata, canonical visible parts, original Pi input/submission and web composer | MR-01–05 below; emoji React, trusted quoted Reply and actual existing More actions only |
| Muse Spaces completion | original Linux Library semantic records, Profile files, checked PageCalls, Services and ScheduleStore | SP-01–06 below; explicit source grants, atomic notes/checklist CAS, navigation visibility and original scheduled updates |
| Muse current-product state consistency | actual maintained entry/state inventory; gated web dialog/form/menu/feedback primitives | UX-A below; bounded shared foundations and critical callers, not a whole-product or native visual acceptance |

These are change-routing entries, not claims that every feature/device/network combination is accepted. Add detailed cases when work first touches a feature; do not invent pass results for this inventory.

## Muse shared state foundations packet UX-A

The source inventory and per-state evidence live privately in
`muse-ui-state-inventory.json` and `muse-ui-state-foundations-handoff.json`.
Inventory is not execution or screenshot review. Preserve Muse's observed
IA/tokens/system fonts; no replacement dashboard, font or chart library.

| Case | Boundary | Required outcome |
| --- | --- | --- |
| UX-A-01 | Original Schedule publication rejection → shared feedback | Readable localized error, original technical details retained; no covered header or controls |
| UX-A-02 | Root, nested form, refreshed sheet, compact Settings and file viewer | Retained layout space; late errors safely dismiss obscured menus without changing the current source |
| UX-A-03 | Selected conversation → menu → destructive confirmation | Named, readable object/range; safe cancel/Escape/backdrop and touch target; only explicit confirm deletes |
| UX-A-04 | Skill form → real validation refusal → corrective save | Named/labelled fields, localized readable error/focus, retained multiline input and original-owner save |
| UX-A-05 | Automation menu → Watch form → close | Actual initiating control regains keyboard focus, not a removed menuitem or body |
| UX-A-06 | Original conversation's long file menu | Viewport-bounded real scroll; Home/End/Tab/Escape, actual44px touch targets and original-source return |
| UX-A-07 | Dynamic Schedule form, invalid values and held submit | Busy feedback/actions remain visible; one request, pending close refusal and original paused result |
| UX-A-08 | Dirty Watch close, pointer drag/backdrop, actual transport failure | Preserve/discard explicitly; retain failed draft, never automatically replay an uncertain write |
| UX-A-09 | Nested Schedule edit and real peer/SSE refresh | Restore the replacement opener DOM node and genuine nonzero source scroll |
| UX-A-10 | Distinct original Space removal caller | Show selected names and exact registration-only scope; safe initial focus; retain original files/unrelated Spaces |
| UX-A-11 | No automations vs actual read failure/retry | Distinct no-items/error states and real next actions, no success-shaped empty fallback |
| UX-A-12 | Ordinary/off and affected original-owner boundaries | Existing navigation/data/request semantics retained; native inputs proven unchanged or both native builds required |

Bounded acceptance: clean `94be05f0` passes105 paired checks/54 captures,
the focus probe, two off modes and actual SP/permission/epoch dependents.
Clean `d3dcd56a` adds3 actual touch checks:40px RED→44px GREEN, original
last-file selection and source return. Its exact one-selector correction affects
only coarse open generic menus; base captures retain their real source labels.
12 original protocol cases/393 assertions, lint/six TS projects/build and all
five unchanged native input/output graphs pass; no native waiver or promotion.

The private inventory has2,149 concrete source/state/critical-variant rows:
74 actually viewer-reviewed states/72 unique visuals,1,451 planned,623 blocked
and1 explained N/A.12 workflow contracts remain separate from per-state rows.
EN/ZH × dark/light × desktop/compact, actual unknown/proof/focus/scroll/touch
evidence is source/hash-labelled; encoded viewer payload is1,561,880 bytes.
UX-B–I retain finite case IDs/fixtures/prerequisites, including Main-specific
deletion, bound-update removal and broader custom-field contrast. All33 actual
bundled chart/diagram types are inventoried; chart-state viewer acceptance is0.
Shared changes do not pass all123 callers or all states. Formal foreground V95=0.

## Muse chat state packet UX-B1

The private `muse-ui-chat-caseplan.json` maps the bounded paired Main/Side,
composer/message and original request/handoff workflows to exact inventory IDs.
Start with `UX-B-CHAT-MAIN-DESTRUCTIVE-RANGE`: original Main role, selected
object/files, independent Side/drafts, safe cancel, held/failed explicit delete
and no automatic replacement or model work. Capture actual failures before UI
edits; require matching owner-backed recovery and individually viewed variants.
The213 source/state declarations are plans, not213 accepted states.
Search/Agent (`muse.ts`/`search.ts`,89 rows) remain UX-B2; chart/diagram rendering
remains UX-D. Results belong in the separate `muse-ui-state-ux-b1-results.json`;
the original inventory and74 UX-A reviewed source labels stay unchanged.

Bounded source acceptance on `64a22c67`:73 individually viewer-reviewed
concrete states/75 evidence records (67 direct,6 original integration boundaries),
72 unique viewer derivatives and74 unique original rasters.
Only22 exact inventory source/state rows are complete;191 B1 declarations
and89 Search/Agent B2 rows remain planned. These measures are not additive.
Actual RED/GREEN fixes cover Main scope/focus/pending and immediate/late
deleted-row resurrection, retained original form values, duplicate live Done,
single model-error disclosure, live/nested-Viewer feedback space and scoped
contrast/CJK copy. Original owners, refs, leases, limits and off behavior remain.
19 distinct maintained protocol cases pass, with recorded impact reruns;
lint/six TS projects/build and five actual unchanged native graphs pass.
No native-app, storage-upgrade, chart or foreground V95 acceptance is implied.
The separate results/manifest retain every real source/hash, exact crops,
native glyph evidence, diagnostics and unexecuted variants. Actual encoded
viewer traffic is1,611,832 bytes (~1.54MiB), including39,352 invalid projection/
crop diagnostic bytes; useful reviewed evidence is1,572,480 bytes. Clipboard
result execution and unselected/composite variants remain explicit gaps.
Exact owned Host/browser/cache and unselected-raster cleanup is indexed in
`muse-ui-chat-states-handoff.json`; protected Preview is unchanged.

The separate UX-B1R pre-edit plan initially traces the exact191 remainder declarations:
128 applicable conversation/composer/request obligations and63 explicitly routed,
still-planned original Library/files, Search/Agent, connection, automation and
ordinary/off obligations. Private `muse-ui-b1r-caseplan.json` retains every ID,
actual caller route and prerequisite; it does not change the immutable inventory.
MS-03/06 and original request-choice recovery now include actual held attachment
delivery after Main→Side navigation, failed initial sidebar loading/retry, and
failed custom-choice transport. Their real RED/GREEN checks preserve original
file/chat identities, independent drafts and existing owners; no automatic replay.
The same bounded pass reproduces menu Escape losing its replacement header
opener after actual peer/SSE refresh, and sub-threshold original quote-loading,
unknown-send and stale-source text. Existing identity-aware focus return and
Muse-only contrast rules correct these exact conditions, not native/off styling.
Actual compatible `.chat` import also exercises passive compacted-context and
referenced-service notes, long-summary scrolling and unchanged service authority;
its original note text receives the same narrowly gated contrast correction.
The new sidebar retry also receives the existing44px coarse-pointer minimum
after a real compact touch-target RED; desktop geometry is unchanged.
The actual CJK sidebar no-match label uses the existing readable secondary
token after its normal-text3.2605:1 RED; ordinary/off labels are unchanged.
An actual held/failed existing Main cold read exposed a blank transcript.
Muse now shows original read progress or a local failed-read/retry state with
technical details collapsed; retry only rereads the same original conversation.
Cached valid content and ordinary/off presentation retain their existing paths.
Committed-lost branch/rerun/Edit replies now explicitly identify an unverified
result and the original Main/Side inspection route; raw transport details stay
collapsed. The original mutation is never automatically repeated.
The original missing-chat404 also uses Muse-localized unavailable copy; ordinary/
off text and original no-recreation behavior remain unchanged.
The exact original32MiB upload refusal is localized only in Muse; the real
Host413 limit and English/off bytes are unchanged.
Actual late-upload control visibility exposed compact textarea clipping; Muse
resizes only when its controls change available width. Confirmed reruns retain
the independent draft through the existing backup maps without overwriting newer
destination work. Unknown/404 originals keep local text/files at the exact
unavailable source with Send/Attach disabled, never guessed into another Main.
Keyboard submission while the original quote is still loading reports checking,
not a changed/deleted source; actual stale-source refusal remains separate.
Muse also refuses an11-file message before the unchanged original10-file owner
limit can truncate it; correcting the selection sends the exact remaining files.
The same real compact correction exposes the last file through bounded touch
scrolling and an actual44px removal target; visible glyph size stays unchanged.
Original form-dialog network failures use the same Muse-localized honest result
copy as the existing feedback helper; English/off bytes and retained inputs stay.
The actual conversation-owned Browser loading/gone labels use the same readable
Muse text token after4.3136:1 REDs. A service-owned login page surviving chat
deletion is recorded as retained, never falsely labelled closed.
Gone-source Viewer close restores a connected current control. Actual device
revocation tears down only its local Viewer presentation before pairing; it
does not close independent original service/account pages or replay actions.
Confirmed original-chat404 retires only that request's handoff footer. Retained
service pages remain live; gone Browser pages hide decoded/broken frames and
disable page-input controls, without guessing another request or outcome.
The exact expanded inline execution step (not Agent Activity or an offscreen
primitive) receives readable secondary text for its technical name after a
3.2605:1 compact-light RED; original trace/error ownership is unchanged.
Exact original model-readiness and message-owner-conflict errors use gated native
Chinese copy; their English and ordinary/off strings remain byte-for-byte unchanged.
Active composer Send/Stop uses the existing pressed-accent token after an
actual2.99978868018584:1 nontext RED; neither the glyph nor its surrounding
button contrast is rounded up. The original owner-backed Stop action is unchanged.
Bounded B1R runtime acceptance is `17e21b9f`:118 exact original obligations pass,
72 remain planned in their actual owning packets and one generated import-summary
field-validation variant is source-proved inapplicable because that summary has
no input/textarea/select or fields array. Invalid ZIP/stage and missing-model
refusals were executed separately, not substituted for field validation.
Private `muse-ui-state-ux-b1r-results.json` retains all191 original IDs/routes,
conditions and direct evidence; `muse-ui-chat-remainder-handoff.json` indexes it.

The actual reviewed selection is161 concrete execution records:153 edge-state
records plus8 freshly reviewed EN/ZH normal-send/waiting/streaming/stopped
dependents,160 unique original rasters,152 indexed layout derivatives,
59 selected readable review pages and8 directly viewed original composer images.
Those are separate overlapping measures, not additional source obligations.
Earlier quota-withheld image opens do not count as review. Older composer
glyph paint is not final color proof: the eight current images and their exact
final component hashes supersede only that token; old sources remain labelled.
All644 measured role records pass their unrounded original thresholds; the
minimum4.5-threshold text ratio is4.5024948619197485. Current active glyph ratio
is4.04229832517911; button/surround is3.2650019361656972 dark and
3.5788676742749264 light. Indexed pages do not certify color or native glyphs.

The full selected edge executions are47 mode/locale runs with531 explicit
checks; final token-only shared-caller and both-off checks are separately
recorded, not replacements for that broader packet. The final27-case/1,351
and12-case/1,007 maintained protocol selections overlap:28 distinct cases,
not39. Build/lint/six TypeScript projects and five actual unchanged native
input/output graphs pass. No native compile, storage625/full125 rerun or
native/physical, actual OS Clipboard/Share/account/provider acceptance is claimed.

The72 routed obligations form14 finite workflow groups:37 Library/context,
4 Search/Agent,8 connection/startup,3 Connectors/catalog,7 original automation,
4 OS Clipboard/Share and9 ordinary/off/capability compatibility. Their exact
IDs/prerequisites remain planned; the original89 B2 IDs are unchanged.
Normal Viewer-ready, actual Browser-owner closure and session revocation are
executed; independent retained service pages are never called closed.
The first-run onboarding disclaimer contrast remains an unaccepted UX-E
boundary. B2/C/D/E/F/G/H/I continue before new independent Muse features.
Original22 Mac-preflight planned,4 unavailable-UI planned and597 native-blocked
corrections remain unchanged. Formal foreground V95 and chart acceptance are0.

## Muse Spaces packet SP (V2 owner contract)

Both Linux/web gates are required. The original `ox.library` version1 gains
optional semantic placement/order/visibility and explicit source grants; old
records retain their pin interpretation. File bytes and mutation receipts stay
in ordinary original-owner JSON files, never a second private content store.
The detailed pre-production dispatch/bounds contract is the authoritative
business `plans/personal-agent/muse-spaces-completion-slice.md`.

| Case | Setup / action | Observable invariant |
| --- | --- | --- |
| SP-01 | Original Spaces/old pins → sidebar/main/hidden/order, zoned weekday/date/cross-midnight/DST windows, reload | Pure navigation projection, Library always available, no focus change/model/job; hidden is not revocation |
| SP-02 | Explicit original HTML and notes JSON grants → two frames/clients read/write/check/uncheck/cancel/revisit | Original atomic source CAS and embedded bounded receipt; no false success/replay, no private/path/foreign/cross-Space authority |
| SP-03 | Original selected API/web/MCP connection grants → real invocation, account/definition/disconnect/Deny changes | Current connector proof and original downstream policy before dispatch; real source/time/error, not cached-as-fresh |
| SP-04 | Original paused ScheduleStore task bound to Space/code/data grant → owner enable/run/stop, model fixture commit/no-commit | Original submission/start/tool/site gates; actual file receipt proves success, no model means unavailable, no second queue |
| SP-05 | Held approvals/writes, peer CAS, I/O errors, old code/frame/deletion/Reset | Zero stale mutation, fixed epoch and original busy admission; no append/toggle replay or resurrected bindings |
| SP-06 | Paired dark/light/ZH/compact/off UI and real X-written package → Y writes/off/relaunch | Stable controller/workbench/frame/drafts and complete original-owner/authority retention; reference-blocked deep views, no unsupported95 claim |

SP-01–06 bounded Linux/web source acceptance is GREEN at8e247397. Both flags
remain required; this is not full Muse/native/resource/foreground95 acceptance.
The SP dialog/state viewer pass also requires borderless shared Muse tabs,
truthful source-grant availability and no stale Saved toast over an uncertain
notes result. Native gray inactive tabs were observed in the actual2632229e
paired Space capture; their computed style is an explicit UI reproducer.
Own management-close must refresh the original action revision without
recreating its frame. Space removal must show real bound original tasks and an
explicit default-off stop choice; original files and tasks are not deleted.
An original data file without a tracked Space receipt is not necessarily empty;
source provenance must not label preexisting notes as an empty file.
Own revision refresh must return keyboard focus to the current original opener
without moving focus out of another active dialog, frame or draft.
Connection presentation must distinguish a retained grant record from current
original definition/account proof; source changes and disconnect are not a
current Space grant merely because its domain still matches.

| Gate | Actual evidence |
| --- | --- |
| Current owner/prerequisites | Frozen125 cases/4445 assertions; final focused20 cases/498 assertions include late ordinary-tool binding, original app files and ordinary schedules |
| Real persistence/faults | Two frames/clients, original file CAS+receipt, reload/revisit, stale peer/input/code/alias, actual EACCES/journal recovery, original read/action Deny, old epoch and no replay |
| Real connected updates | Original API/selected Browser account/OAuth MCP fixtures, source/account/definition/disconnect/Deny; original scheduled submission/file commit, no-commit, no-model and actual running stop |
| Current paired UI | 28 checks/52 captures/4 controlled model requests/zero page errors; original Library and context/Main-draft/attachment packet passes, PP10 workflows/198 checks |
| Time/epoch | Actual foreground clock crosses next-minute window with the same frame/focus/draft and zero task/model; actual confirmed Reset rejects late old data/editor resurrection |
| Viewer | 80 per-state reviews/76 unique CSS-scale artifacts, including corrected EN/ZH I/O/data-action errors. Old53b1 images retain their source; current8e recapture is separate. Total encoded image budget1,572,076 bytes including initial RED views |
| Storage/package | Actual clean X1fcc93c2 (production inputs equal a852) writes before →Y8e ordinary Space/data/connection/schedule writes →off original writer →Y relaunch:6 rows/625 checks,10 controlled model requests and2 actual HTTPS source reads, no automatic replay |
| Preservation | Nine stopped logical tables, complete original views/files/auth/Secrets; only declared original policy/connection metadata and the chosen data file change |
| Source/native | Lint/six TypeScript projects/build pass; five actual native input-graph hashes and output hashes unchanged. No native build or Local.xcconfig waiver |

Private exact contracts, commands, hashes, per-state fixture/artifact/review/fix
status and cleanup are in `muse-spaces-handoff.json` and its viewer/storage
manifests. Source uses the original run binding at ordinary tool dispatch and
inside original filesystem/Library serialization; no separate Space queue,
private API surface or standalone fine-task allowlist was added.

Manage UI exposes the default notes/checklist slot; the typed owner contract is
bounded to4 slots and this fixed schema, not arbitrary private databases.
Original task request/config toasts can transiently overlap headers; explicit
task/file-proof rows remain authoritative. New generated-space deep foreground
Muse references remain reference-blocked; charts are not present/not applicable.
Physical touch/VoiceOver/native/WAN/24h, real provider quality, pressure,
fsync/power-loss and installed-entry promotion are unrun. Formal V95 remains0.

## Muse direct protocols packet DP (V2 owner contract)

DP replaces the earlier PP-04 unavailable projection only in double-gated
Linux/web. Original format2 action policy keys `ox.network.protocol.<id>` own
eight explicit default-Off gates. A confirmed revisioned `operation:protocol`
uses the original permission receipt/CAS path; Reset all restores Off. Existing
ordinary writers retain keys and metadata, not a second network policy.

The original VM exposes Linux-only checked `ox.network.exchange` and
`ox.network.resolve` contracts. Exchange is deliberately finite: one TCP/TLS
connection or UDP request, optional base64 input, bounded receive, then close.
It is not a persistent socket API, shell or complete SSH/SMTP/database client.
TCP port classification is22 SSH;25/465/587 SMTP;110/143/993/995 mailbox;
1433/3306/5432/6379/6380/27017 database;20/21/989/990 FTP; otherwise TCP.
UDP uses its separate category. Raw53/853 are refused: structured DNS only.
These are transport/port rules, not application deep-packet inspection.

On permits a fresh per-exchange Approve/Deny, never a task/Always bypass even
when the technical global policy is Allow. Explicit original Deny still wins.
DNS On permits structured A/AAAA/CNAME/MX/NS/SRV/TXT queries without an extra
connection prompt; stronger explicit original action/global policy still
applies. Internal HTTP resolution is unchanged.

Each request requires a UUID, original active task, current protocol and policy
lease. Before any socket/query dispatch the original policy owner atomically
spends the UUID in its existing private request receipts. It stores only task/
action identity, never query/payload/value hashes. A spent UUID is never
replayed, including after normal restart; it is an attempt proof, not remote
application success. No new durable queue or model loop is introduced.

Limits:4 active I/O requests,20 I/O admissions/minute,5000 original shared request
receipts; exchange input16KiB/output64KiB,timeout100–10000ms; structured DNS
name253 ASCII hostname bytes,7 record types,64KiB decoded result,one retry-free
resolver attempt. Actual endpoint IPs are checked and pinned through the
original public-address boundary; private/loopback are allowed only by exact
existing test-origin configuration. TLS keeps real certificate verification.
Abort, expiry, policy publication, VM close and Host epoch close exact owned
resources; timeouts/partial output never imply remote application completion.

| Case | Setup / action | Observable invariant |
| --- | --- | --- |
| DP-01 | Normal paired Host, eight Off gates → confirmed enable, stale/replayed change, Reset | Original policy truth, CAS/proof and actual Off; no raw Node/network globals |
| DP-02 | Owned real TCP/TLS/UDP endpoints → Off, Deny, Approve, global Allow, repeated UUID | Zero denied dispatch, actual bounded bytes, per-connection confirmation and durable no replay |
| DP-03 | Owned structured DNS server → Off/On/TXT and malformed/raw DNS | Real query only when permitted, no extra default prompt, no arbitrary DNS packet bypass or query/payload audit |
| DP-04 | Held I/O, revoke/cancel/peer/epoch, invalid/full/I/O policy and budgets | Actual close/refusal, no late bytes or retry; unchanged original HTTP/Browser/task gates |
| DP-05 | Settings eight real toggles/confirmation/unknown/recovery, actual predecessor→ordinary writes→second launch | Actual viewer review, off-mode/native/input preservation and exact auth/content/secret retention |

DP bounded source acceptance is GREEN: owner/runtime9effe1d2, with only the
subsequent Chinese literal correction atb4414a5a. Use the maintained services
protocol runner and existing private paired gym harness; all network fixtures
were owned Mac loopback, not external accounts or shared Spark/MyGPT.

| Gate | Actual evidence |
| --- | --- |
| RED/GREEN | Reachable82e741ee →1f8cd678 →e1ddf752 →c93e9110 →81ffe8e6 →eff731af →9effe1d2; narrow CJK7e3cfc0f →b4414a5a |
| Protocol/dependencies | 81 cases/3342 assertions; after the null-origin correction, affected direct/identity/audit11 cases/290 assertions GREEN |
| Real I/O/faults | TCP bytes, bounded connected UDP, actual TLS rejection then child-only trusted CA, pending socket revoke, real EACCES claim refusal and spent UUID after relaunch |
| Frozen UI | 39 checks/13 primary captures, zero models; original PP10 workflows/199 checks and ordinary off UI pass; source9effe1d2 |
| Scroll/density | RED85px/scroll207→0/focus lost; GREEN71px/actual short-desktop258→258/UDP focus. Zero-to-zero observation was not accepted as scroll proof |
| Viewer | All13 primary images plus explicit regression/short-desktop selection actually reviewed with <=1.5MiB encoded budget. Native CJK46/2-glyph orphan RED →one45-glyph line GREEN, one small after crop viewed; old13 captures remain labelled9eff, notb441 |
| Packaged storage | Actual normal X3702c083 writes before →Y9effe1d2 ordinary/off writes and relaunch,6 rows/592 checks;14 explicit fixture model requests, one real TCP request, no automatic replay |
| Preservation | Nine stopped logical tables and all original content/authority retained; only exact declared protocol keys/claims alter original policy. Other authority is byte-exact |
| Source/native | Lint/six TS projects/build pass; five actual native input graphs/output hashes unchanged. No native compile or Library iOS exception used |
| Cleanup/preview | Exact six owned cache folders removed, all archives/rollback retained; installed310eb664 Preview remains healthy/untouched |

Non-HTTP audit uses null web origin, not fabricated HTTP provenance; destination
is disclosed in the original connection prompt. There is no misleading
permanent-Allow control. Three compatibility-harness sequencing/legacy-body
errors were corrected without production edits, not counted as product RED.

Private proof is `muse-direct-protocols-handoff.json`, viewer/copy/recovery
manifests, source-stamped logs and immutable before/after ZIPs. The archived
9eff package does not include the later one-string b441 Chinese correction;
entry activation/installed promotion is a separate gate.

Unrun: application-level external protocol accounts, caller-abort and4/20
pressure stress, extreme DNS/kernel/heap, ENOSPC/fsync/power loss,
native/physical/WAN/24h/downgrade and whole-product foreground95. This packet
does not complete all Muse features, arbitrary private Space data, fine task
grants, credential injection or real-provider quality.

## Muse message actions packet MR (V2 owner contract)

This packet is only double-gated Linux/web (`OPENOX_PERSONAL_AGENT=1` and
`OPENOX_MUSE_PARITY=1`). React means an emoji reaction, not a UI framework.
Original metadata, immutable Pi entries, submission receipts, files, Main/Side
lineage and composer own all state. No second message table, transcript, Agent,
model queue, permission, analytics or training consent is introduced.
The installed personal Preview and shared/native contracts are excluded.

The canonical ref is `{profileId,conversationId,source,revision,epoch}`.
`source` is the existing GS `entry:message:part` key, never a turn index.
The revision is SHA256 of the entire original displayed text. Exact fork-aware
entry membership, current visible presentation, non-temporary/non-deleted owner
and Profile/epoch are rechecked. GS and MR share the original visible-part
projection: user text or Skill argument and assistant text only; not injected
schedule/Skill prompts, thinking, tools, forms, scripts or private headers.
Grouped assistant turns get distinct per-part actions, explicitly scoped to
that visible text part; legacy copy/branch/rerun retain their original scope.
Uncommitted streaming text has no actionable canonical ref.

Optional `fields.messageActions:{version:1,revision,reactions,requests}` lives
in original version1 `ox.conversation.metadata`. Reactions are one owner choice
per exact source, including clear tombstones; no message content is copied.
The fixed allowed choices are 👍 ❤️ 😂 🎉 😮 🙏 or null to clear.
`POST /api/conversations/<id>/reactions` takes only
`{ref,emoji,expectedRevision,requestId}`. The original Profile serial/transaction
checks the source and owner-wide revision, writes value and bounded hashed
paired-owner request proof atomically, then emits original metadata-only SSE.
Repeated matching requests are historical proof (`replayed:true,inputApplied:false`),
never fresh saves; changed input/same UUID and stale peer revisions409.
`GET .../reactions/<requestId>` verifies original receipt/current target without
replaying. Source/proof reads do not mark any notice read or change recency,
fulltext, model input, permissions or attachments.

`GET /api/conversations/<id>/message-source?source&revision&profileId&epoch`
returns the revalidated limited original excerpt/role/ref and current reaction
revision; optional `window=1` reuses the bounded original GS history window.
Reply drafts retain only that ref in the existing per-chat in-memory
draft lifecycle. Selection/cancel creates no chat, file or model work. Composer
shows a bounded literal quote, cancel and source-jump; jump waits for the real
original render/window, preserves the current draft/attachments/background,
and offers a return to the composer. Per-chat switches retain only their own
ref; editing explicitly cancels conflicting unsent Reply, never attachments.
Reset/unpair/owner change clears all old refs and retires late results.

Actual Reply send uses original `POST .../messages` plus UUID `requestId` and
`reply:<ref>`; no client-supplied quote/text/path/purpose fields are accepted.
Inside original Pi admission transaction, the Host validates the source CAS
and constructs a separate literal user-content text part, labelled quoted data,
not a system/developer instruction. The first user text part remains the actual
new request and original attachment markers. Optional original input-entry data
stores only version/paired-owner/request proof and minimal reply ref; the quote
exists only in the explicitly sent original user input, not metadata/another DB.
The original visible input/GS projection omits quote framing/internal noise.
Original submission receipt is the authority for accepted/placed/done/unanswered,
not latest assistant output. Admission and proof share its transaction; original
Approvals task lease surrounds dispatch and lasts to settlement.
`GET .../submissions/<requestId>` is read-only owner proof. Matching replay is
historical, changed input409, and unknown transport never auto-resubmits.
Unconfirmed Reply leaves draft/attachments/ref intact until explicit proof or
owner confirmation; failures/late route changes cannot clear a different draft.
At most32 unresolved `{id,requestId,epoch}` records in origin/Host/Profile/
paired-device-scoped sessionStorage restore read-only proof after reload, not
drafts, attachment paths, source refs, quote text or automatic submission.
Historical quoted inputs inherited by branch keep their original source identity;
rerun preserves their already-sent literal context without adopting a new source.
Fork/regeneration remove copied reaction metadata/request proofs and Main remains
owned by its existing transfer rule, not by a message ref.

Bounds: at most1000 reaction target/tombstone records and5000 requests per
conversation, 2MiB encoded action metadata, at most1000 canonical action refs/
512KiB per original rendered window with explicit `limited` coverage,
4KiB reaction input, 512KiB message
input, 1MiB encoded source entry, source key80 bytes, 4000-scalar/16KiB quote,
160-scalar composer excerpt, 10 original attachment paths and100000-character
new request. No silent pruning/empty replacement; corrupt/future/unavailable
metadata503, capacity507, oversized input/source413, malformed400, owner401/403,
missing/foreign404 and stale409. Original Pi deserializes a record before the
encoded bound; this is not an extreme-record heap/power/ENOSPC certification.
All new routes are private same-origin/no-store and original content-admission/
epoch fenced; neither gate permits the new routes/behavior alone.

| ID | Setup → action | Required result |
| --- | --- | --- |
| MR-01 | Original canonical user/multipart assistant, paired clients → choose/toggle/clear/reload/SSE | Exact per-part persistent owner value, unchanged text/recency/Search/notices/model dispatch |
| MR-02 | Temporary/hidden/deleted/private/foreign refs, peer CAS, same UUID, fork/rerun/Reset, bad/full/I/O/unknown transport | Explicit rejection/current or historical proof, no copied/adopted reaction, no replay/false save |
| MR-03 | Existing Main/Side/Space/discuss draft and attachment → select/cancel/jump/back/send | Correct quoted composer, no pre-send creation/model; actual original single admission/model fixture gets real quote/new request/files |
| MR-04 | Source edit/delete/Reset, stale source/ref, forged quote, failed/unknown send, late close/tab/SSE/Settings | Fresh source confirmation, retained unconfirmed draft/files/ref, exact receipt check, no automatic duplicate or foreign content |
| MR-05 | Keyboard/hover/touch/More, actual predecessor normal package → Y ordinary writes/relaunch, EN dark/light/ZH/compact/off | Actual copy/read/share/edit/branch/rerun retained, truthful cancel/failure, all old owners/authority preserved and screenshots individually viewed |

Use the maintained workspace/services protocol targets and existing private
paired headed `muse-workspace-ui.ts` gym harness; no fourth suite or unit lane.
Actual X-written immutable normal package is required for storage evidence.
UI01/UI23 show React/Reply/More controls only; private text and uncaptured picker/
quote/deep-menu states are reference-blocked. No formal V95 or whole-product
acceptance follows from source/protocol/Chromium success.

MR protocol RED on main68194303 executes all nine maintained cases with36
assertions: original source has zero canonical action targets where three are
required, so React/Reply are missing. Fixtures/Host/runner execute normally;
production has not changed. The actual clean928b6dc5 normal predecessor ZIP was
frozen before edits, SHA256
`6eed8acc797b9fbc8dfcd4e9c1633d374d7fba7abbad4dc639ff3085085bd9f4`.
Real paired headed UI RED on clean7d391231 shows original Copy/Share/Branch/
Regenerate but zero React controls, with the original unsent draft intact.
One explicit isolated fixture turn supplied the source; no page errors.
The actual reviewed image/result is private
`muse-message-actions-ui/red-1794694450337-f59ed27c`; no UI production changed.
Initial original-owner protocol implementation passes the same nine MR cases/
176 assertions and the bounded33-case/1338-assertion GS/Main/lineage/files/
Space/discovery/notice/DC/SS/CN/PP dependency packet. Repository lint/six TS
projects and portable build pass. Five actual native input-graph hashes and
output bytes remain exact. This is a protocol checkpoint, not rendered Reply/
More, packaged compatibility or final MR acceptance.
The first real headed controller packet passes nine workflows/61 checks with25
settled captures: exact React/peer/CAS/lost and stale receipts, quoted composer/
original model input/files, original More edit/branch/rerun,625-entry GS source
window, Space/discuss and real Reset epoch. It is labelled working-tree evidence.
Three representative quote/More/compact captures were individually viewed;
the post-proof transport toast needs a focused renderer follow-up before final
acceptance. Required medium36/1378, lint/six TS projects/build and all five
native graphs pass. Normal package and full frozen viewer acceptance are pending.
Focused real headed RED on clean457e3292 confirms an actual UX contradiction:
after a lost response and verified original send receipt, the preserved inline
unknown state clears correctly and no send repeats, but a sticky “Failed to
fetch” toast remains beside “original send is recorded.” Three explicit fixture
turns, no page errors; private
`muse-message-actions-ui/red-1794696244990-9d72a93a/feedback-result.json`.
On clean2bedc503, a real Host409 for a browser request with an explicitly stale
source revision rejects before any model, but the composer still enables Send
and original `live.error` incorrectly paints an assistant run failure despite
no admitted input. The headed `--source-red` case and maintained MR-04
`view.error === null` assertion both execute RED before their correction.
Frozen9fbb4d45 real screenshots reveal an unstyled result-check control: actual
text `rgb(150,152,155)` on native `rgb(107,107,107)` is only1.84:1 contrast.
The headed `--contrast-red` check executes and fails4.5:1 before CSS changes;
one explicit source fixture turn and no page errors. Private evidence:
`muse-message-actions-ui/red-1794697066269-2ba25d45/contrast-result.json`.
Focused same-tab reload RED on clean2cf0ff18 proves identity-only recovery does
not restore quote/text/files, yet its current wording falsely says they “are
kept.” The original send/receipt exists, two explicit fixture turns and no
automatic replay/page errors; existing headed `--reply-followup --restore-red`
fails the intended truthful-restoration assertion before its wording correction.
Late bounded MR-05 review finds a real legacy-retention gap: on cleanbec4c489,
an actual original temporary assistant has no new persistent ref (correct), but
also loses its pre-existing Copy/Read/Share actions (incorrect). The existing
headed `--legacy-followup --legacy-red` executes and fails missing More before
its correction; two explicit fixture turns, no page errors or new permissions.

Bounded MR-01–05 Linux/web source acceptance is GREEN on3702c083. All executed
RED/GREEN checkpoints are reachable on main with the required session trailers.
The maintained MR packet passes13 cases/231 assertions; the necessary medium
packet passes37/1393, including GS, Main/Side/branch/rerun, files/Skill, Space,
notice, DC epoch/Reset, SS, CN and PP. Those protocol-owner bytes are identical
at final source; later changes are web feedback/contrast/legacy More only.
There is no second message DB, Agent, model queue or native/Pi contract fork.

Final clean paired headed Chromium passes9 primary workflows/65 checks,
3 focused reload/context workflows/19 checks and1 temporary legacy More
workflow/5 checks; ordinary off mode passes3. These use17 explicitly sent
isolated fixture turns in total, never real providers. React/selection/cancel/
source/proof reads dispatch no model. Focused Space/discuss checks inspect the
actual new quoted provider input and fully rendered last reply, not an earlier
matching substring. Thirty-three MR/off captures and four GS dependency captures
were individually viewed. The existing GS headed packet also passes9/149 with
zero model calls and genuine >4k message/file/context anchors.

Actual owner/peer CAS, canonical JSON-order-independent request proof, stale/
foreign/private/temporary/deleted refs, lost committed responses, historical
receipts, same-tab identity-only reload/new-draft isolation,625-entry source
navigation, preserved draft/uploads and real Reset epoch are covered.
Actual SQLite writer-lock refusal, corrupt/future/full1000-target metadata,
1001-ref limited projection and4000/160-scalar source/excerpt bounds fail closed.
More keeps original Copy, conditional Read/Share, Edit/Branch/Regenerate and
correct temporary eligibility. Controlled clipboard/share refusal/cancellation
is explicit; the successful clipboard write is real, with no OS clipboard read.
The low-contrast native-gray result control was corrected from1.84:1 to15.86:1;
unadmitted source refusals no longer paint fake model failures or leave Send ready.

Actual immutable normal928b6dc5 X writes original populated chat/file/lineage
state → normal3702c083 Y reads/reacts/replies and performs ordinary branch/rerun/
file/off-mode writes → Y relaunch:504 checks/five rows. All nine stopped encoded
SQL tables are exact across readonly startup/source/Search, immutable entry rows
are unchanged by React, and all old physical content and encoded original
auth/Secrets/connector/policy/device/attachment owners are preserved. Only
operational logs change in the readonly tree. Six model calls are the explicitly
requested ordinary/quoted/rerun writes; reads/reaction/relaunch replay none.
Normal packaged source helpers and web compilation, repository lint/six TS
projects and portable build pass. Five actual native input-graph hashes and
bundle bytes remain exact; no native build or missing-iOS-config waiver is used.

UI01/UI23 private message foreground is redacted; picker/quoted-composer/deep
More/light/ZH/compact reference states are unavailable. Formal V95 remains0.
No Safari/native/physical, real provider/model quality, actual share/audio
delivery, full5000-receipt/2MiB stress, extreme-record heap/resource load,
ENOSPC/fsync/power-loss or downgrade acceptance is claimed. Exact source/proof/
artifact hashes and owned cleanup are in private `muse-message-actions-handoff.json`.
All immutable predecessors/reviewed proof/rollback are retained. The protected
310eb664 Preview/PID45320 is untouched. Stop here; remaining Muse scope belongs
to the parent, not this packet.

## Muse global Search packet GS (V2 owner contract)

Only double-gated Linux/web private paired-owner Search is in scope. React/Reply,
model tools, native contracts and the installed Preview are unchanged. Search
reads the original Pi conversation/presentation/metadata/entry and file owners;
it never prepares a transcript, reconciles files, creates Main, marks notices
read, writes an index or invokes a model. Operational device presence is separate.

`GET /api/search?q&scope&limit&requestId&cursor` uses a UUID request identity,
`scope=all|chats|files` (default all), limit1–50 (default20), and an opaque,
single-use continuation. Unknown/duplicate parameters are400. Queries trim and
NFC-normalize, at most200 Unicode scalars/800 UTF8 bytes, with deterministic
locale-independent upper/lower case folding, not regex or token/semantic search.
Grapheme mapping returns original UTF16 snippet/range offsets, including expansion
and combining characters. Empty query means actual original-owner recent activity,
not search history; favorites do not override recency.

Visible non-temporary conversations alone participate. Inherited visible messages
are keyed by original entry/message/part and deduplicated onto the first current
visible owner in activity/id order. The snapshot is original committed entries;
drafts/live uncommitted partials are not indexed. Only displayed user text (Skill argument,
not injected instructions; scheduled hidden prompt excluded) and assistant text
parts qualify. Thinking, tool output/arguments, forms and private docs do not.
Files use original public IDs/aliases, excluding hidden/deleted/retired owner
files and app/state/VM/log/cookie/repository/mount/internal conversation records.
UTF8 fatal decoding and binary detection are mandatory; HTML is literal source,
not execution, extraction, PDF or OCR. Names remain searchable without content
permission. Unregistered physical files are reported, never adopted by Search.

Each page rechecks the complete bounded logical/physical metadata inventory
and content epoch before publication; any change invalidates continuation.
At most5,000 conversation records/10,000 public file objects/4MiB metadata;
4 simultaneous120-second queries and512 owner-scoped120-second cancellation
identities (including cancel-before-GET);1MiB source/8MiB or128 entry scans per request/
64MiB per query;2,000 retained result references per query/4,000 per Host;
64KiB result pages and2MiB target replies. Limits, unsupported encoding,
unprepared native sources and unreadable content are counted explicit coverage
issues. Budget continuation may contain zero matches; only an exhausted inventory
with no skipped scope is complete. Terminal limits never claim no results.
No full-store content copy is retained between keystrokes or pages.
Physical file sizes are admitted before reads. The original Pi API deserializes
one immutable record before its encoded1MiB rejection/accounting; this is not a
hard heap limit for an arbitrarily large historical record. Extreme-record
memory/scale and wall-clock expiry stress are not certified by the bounded packet.

`DELETE /api/search/<requestId>` cancels only that owner's transient request.
`GET /api/search/targets/<opaqueRef>` revalidates original identity, source
revision, visibility and epoch, returning a bounded genuine chat window or
original file text/range. Verified binary downloads use the same opaque owner
reference, never a client-forged path. Retained moved-file aliases resolve only
unchanged original bytes; deletion/recreation never binds an old reference.
Changed sources409, expired/foreign refs404, invalid input400, origin403,
unavailable503, inventory/retained-limit507. All replies are no-store; same-origin
admission includes GET, and Search is not an iframe/RPC/model capability.

The existing app controller owns navigation. Exact targets render before
scroll/focus/highlight; an anchored history window must not be overwritten by
the normal600-entry refresh or scroll-to-bottom callback. Original draft,
attachment and stable background workbench ownership remains. Debounce,
abort/request retirement/latest generation, route/close/Reset fences, accessible
keyboard/clear/continue/retry/loading/empty/partial states are required.

| ID | Setup → action | Required result |
| --- | --- | --- |
| GS-01 | Main/Side/lineage, >4k visible text, English/ZH/combining Unicode, public text/HTML/binary/private sentinels → query/recents | Actual original matches/snippets, correct visibility, no model/read/write or secret/internal output |
| GS-02 | >500 conversations and >600 history entries → continue; peer edit/hide/move/delete/recreate/Reset/open | No duplicate/omitted matches within declared budgets; inventory/cursor/epoch/ref fences and exact original anchors |
| GS-03 | Invalid queries/filter/cursor, denied reads, invalid UTF8, oversized source/inventory, cancellation/transport failure | Explicit recoverable error or counted partial/unsupported scope; never empty/complete fallback or source mutation |
| GS-04 | Normal paired no-model UI, drafts/attachments/create-Space/discuss background → keyboard/query/clear/retry/close/late/open | Actual title/target render and exact highlight, preserved controller/frame/drafts, no notice read from Search |
| GS-05 | Actual packaged41ed5f22 predecessor → normal Y/search/ordinary writes → second Y; UI24 dark and light/ZH/compact/off | Stopped encoded-record and authority preservation, immutable ZIPs, real viewer review; no unsupported V95 claim |

Use the maintained workspace/services protocol targets, existing private
`muse-workspace-ui.ts` gym harness and predecessor compatibility lane only.
Native/physical/real-model, PDF/OCR, shared-resource load, power-loss and downgrade
remain separate unrun gates. Record actual outcomes after verification.

GS rendered RED ran on clean main0dcf6c15 through normal pairing with no provider:
an ordinary original public file contained `GSfilebody`, but Search returned
zero results and “No matching chats”; the unsent draft survived and model calls
were zero. Private `muse-global-search-ui/red-1794690171558-8e066db2` retains
the actual capture/result. Existing harness SHA256
`7e6db0ac9d571420dab19abed0ba85ee99485c885edcaa64fd91bc482a541048`.
The normal clean41ed5f22 predecessor package is frozen separately, not installed.

GS-04 exact-range rendered RED ran on clean59ab50d2 with625 original history
entries and a >4k message: the right title/source/`GSUIancient` highlight rendered,
but its actual range was y2075–2093 outside the y98–656 scroller (scrollTop0).
Zero model calls/page errors. Private
`muse-global-search-ui/red-1794691037387-693b52da` retains the image/range proof;
harness SHA256`f80e20f02bcdfc2f4b8c704bbd50849ef7021665ac39a3aa4c3a21c1f7facf98`.

The normal Mac personal-package build on clean07fab79d reproduced a packaging
RED: the newly shared Linux Search contract was outside the packager's existing
`src/` and `web/` runtime roots, so the packaged browser build could not resolve
`../search-contract`. This is a real missing runtime input, not a dependency or
fixture failure; private `muse-global-search-package-red.log` retains it.

GS-04 file-summary RED on cleand2eff995 found the correct original file but
rendered only its name/path, hiding the actual matched body snippet. The real
paired no-model card/capture is retained at
`muse-global-search-ui/red-1794691759329-92c11fb5`; no page errors or dispatch.

Bounded GS-01–05 Linux/web source acceptance is GREEN on6074de1e. Ten maintained
workspace cases/681 assertions cover original fulltext/visible lineage,505
conversations,625-entry anchors, literal EN/ZH/NFC/casefold, private sentinels,
changed inventories, retained move aliases, deletion/recreation, read failures,
cancel-before-GET, oversized indivisible Unicode snippets, actual10MB file
admission/continuation and the2000-of2002 retained-reference partial limit.
The necessary original Main/Space/Library/notice/DC/SS/CN/PP packet passes27
cases/1346 assertions, including those ten GS cases, not a full-product retest.

Actual normal paired no-model headed UI passes nine workflows/149 explicit
checks;20 source-stamped settled captures and the ordinary off-mode capture
were individually viewed. It proves real beyond4k/earlier-page content and
rendered range visibility, original file text/snippets, Chinese/Unicode, load
more, keyboard/clear/Escape/backdrop focus, loading/actual I/O/retry/empty/
unsupported, real paired peer conflict, late query/close/Settings/Reset epoch,
and preserved Main draft/attachment and stable create-Space/discuss backgrounds.
Private final evidence is
`muse-global-search-ui/green-1794693361303-509893ae`; finite viewer transitions
are settled before capture. The earlier faded file-sheet capture was a capture
timing issue and is superseded, not a renderer production defect.

Actual normal clean41ed5f22 and6074de1e packages pass419 compatibility checks:
X-written original chat/lineage/Main/files/Space/Goal/Feed/identity plus retained
notices/credentials/policy/device authority → normal Y/Search/ordinary message
and file writes → second Y. All nine stopped encoded SQL tables and original
authority bytes are exact across readonly Search/relaunch, all old physical
content remains, and only operational logs change in the readonly tree.
Immutable packages and before/after ZIPs are retained privately at
`muse-global-search-compat/6074de1e-8dc772a7`.

Repository lint/all six TS projects and portable build pass. Five actual native
input graphs reproduce byte-identical native bundles; no native source/config
input changed, no native build or old iOS configuration waiver is claimed.
The UI24 public overlay geometry is500×350 CSS at the reference viewport/DPR;
redacted content and unavailable light/ZH/compact/query/error references cannot
score V95. Formal V95 remains0. Native/physical/real-model, PDF/OCR, downgrade,
shared-resource load, power/ENOSPC and extreme historical-record memory remain
unrun. Protected Preview is untouched; React/Reply and all other Muse scope are
not started here. Clean source/proof/cleanup identity is in the compact private
`muse-global-search-handoff.json`.

The explicit beyond4k original-file viewport case subsequently reproduces RED
on the unchanged8b981364 production bytes (only acceptance/storage docs dirty):
the right original text/range resolves, but y1552–1567 lies outside its actual
y0–736 `.file-document` scroller, whose scrollTop stays0. This supersedes broad
long-file-anchor acceptance until GREEN. Real paired no-model evidence is
`muse-global-search-ui/red-1794692891211-330d9680/file-anchor-result.json`.

The range correction96e0e377 passes the real long-file case, but actual settled
viewer review then reproduces a coupled header-overlap RED: its scroll viewport
starts y0 behind the filename/close/download header ending y52. Exact proof is
`muse-global-search-ui/red-1794693232670-9dfcd375/file-header-result.json`;
no missing-glyph/renderer claim or native input change is inferred.

Both real long-file defects are GREEN on6074de1e: the original range is visible
inside its actual document scroller, whose viewport starts below the readable
filename/close/download header. The complete final clean-source headed packet
passes9/149, with20 settled original images plus off-mode individually viewed.
Actual packaged upgrade/relaunch419 and final lint/build/native-hash proof also
use6074de1e. Only owned QA processes/caches and145 unselected captures were
removed; every reviewed image, RED proof and immutable package/snapshot/backup
was retained. The protected Preview PID45320 is still running and was not read,
searched, promoted or reconfigured. No React/Reply scope was started.

## Muse Permissions packet PP / permission CP-05

The exact pre-production policy/default/CAS/scope/dispatcher/bounds contract is
V2 in business `plans/personal-agent/muse-connectors-permissions-slice.md`.
Only double-gated Linux/web behavior is changed. Original format2 rules,
original approval history and actual task/file/schedule identities remain owners.

| ID | Setup → action | Required observable outcome |
| --- | --- | --- |
| PP-01 | Two paired owners, API read/write, original technical overrides → defaults/action/source edits, replay/proof and peer CAS | Some is not global Allow; inherited/custom truth matches original dispatch, changed input cannot replay success, original writers preserve optional metadata |
| PP-02 | Browser/navigation/script/PDF/HTTP/API/MCP/Space/schedule original paths → Allow/Ask/Deny/revoke/reset | Denied new work has zero dispatcher/file/network/model mutation; scripts cannot bypass upload/download; stale Space binding refuses; schedule Deny precedes model creation |
| PP-03 | Original submission once/task/Always/site, pending answer, audit/policy corrupt/future/full/I/O/external writes → finish/cancel/revoke/read recovery | No conversation-wide task grants, late answer cannot override revoke, no unaudited Allow or empty replacement; Reset retains history/secrets/content/connections |
| PP-04 | Historical original sandbox inventory → eight unavailable categories | Superseded by current DP-01–05 finite checked transport controls above; no inert enabling flag was used |
| Permission CP-05 | Actual paired Settings → two defaults/five objects/Browser read-write-background/dropdowns/reset-confirm/cancel/error/retry/unknown/proof/peer; dark/light/ZH/compact/dependent pages; actual packaged X→Y→Y | Stable real viewer captures, original policy/dispatch evidence and retained stopped authority/secret/content owners; no formal V95 without frozen per-state foreground comparisons |

Use the maintained Host services/workspace/browser/web protocol runner, extend
the existing private `muse-workspace-ui.ts --permissions`, and the actual
normal-packaged clean08165cc3 predecessor. No fourth UI/unit suite.
Protocol RED `2a8e98ea` is reachable on main; initial original-owner GREEN
`fb09efa2` passes9 cases/174 assertions. Public HTTP boundary reproducer
`95de626a` and same-target GREEN `979d6c63` add the real anonymous-fetch path.
Permission CP-05 actual paired no-model UI RED on `979d6c63` found all four
consumer root controls absent: technical All Actions/functions list remains.
Rendered UI, storage and broader dependencies are not yet accepted at this checkpoint.

Boundary recovery RED on `d12b9293` additionally covers a specific website Allow
under a restrictive global capability Deny (projection must show effective Deny),
and real private-directory write failure followed by unconfirmed owner proof.
The latter must offer explicit inspection/fresh intent, never a replay or an
unrecoverable browser-local pending flag. Actual paired candidate reaches the
missing inspection control after rollback; a prior source-clean precondition
failure is not counted as RED.

Bounded PP runtime acceptance is clean main `8c0064b6`. Original-owner RED
checkpoints through `c423b76d`/`2be54504` are reachable on this task's main:
the same six final targets pass6/78; all23 PP cases plus original policy
compatibility pass24/416. The affected original-owner dependency packet passes
81 cases/2,911 assertions; the original advanced service case independently
passes1/71. The earlier combined cookie-counter fixture failure is not
relabelled as a merged pass. Lint, six TypeScript projects and ordinary build
pass; five actual native input graphs/output hashes remain unchanged, not a
native compile waiver or native acceptance.

The actual paired UI passes10 workflows/197 checks/52 captures, plus12
late-close/tab/owner-proof checks/5 captures and the ordinary off-mode case.
Forty-five current-source selected images (39 main,5 late,1 off), two actual
earlier RED images and eight reference hashes are retained privately.
The initial full-frame review incorrectly reported disappearing late-close
icons. A bounded CP-05 renderer follow-up at clean `ac20ceee` decoded the
unchanged original PNG and compared four actual headed Chromium states:
fresh document, late reply, real close/reopen in the same document, fresh peer.
All13 original icons have actual stroke pixels in all5 rasters; native-pixel
crops were directly viewed. No production/style/DOM defect or headless capture
loss reproduced, so no fabricated rendered RED, production fix, repaint hack,
sleep or mask was applied. Original images/source remain intact; exact SVG
boxes/raster counts and the headed reproduction command are in the handoff.
This corrects the earlier review interpretation, not a visual95 certification.
Formal foreground V95 remains0.
Light/ZH/compact/unknown/error reference states and external/native capabilities
are reference/resource blocked, not imagined matches.

Actual frozen clean08165cc3 normal package → original X writes → ordinary
Y PP-only writes/real denied and approved one-shot calls/off writer → Y second
normal launch passes402 checks: all9 stopped logical tables,4 full device
authority records, all old content/audit, and exact original Secret/connection/
attachment bytes are retained. Immutable before/after ZIPs and exact commands
are in session `files/muse-permissions-handoff.json`.
The historical PP-04 unavailable projection is superseded by current DP above.
Arbitrary private Space owner reads, safe credential injection, persistent
Browser scripts/popups/background sockets/unrestricted sync and fine per-task
trigger/tool allowlists remain unavailable. This is not all-Muse completion.

## Muse Connectors packet CN / connector CP-05

These scoped Muse IDs are distinct from the existing Host connectivity CN packet.
The production-before-RED contract is frozen in business
`plans/personal-agent/muse-connectors-permissions-slice.md`. Both gates are required;
ordinary/native/default-off semantics and the installed preview are retained.

| ID | Setup → action | Required original-owner result |
| --- | --- | --- |
| Muse CN-01 | Real bounded selected/conflicting/invalid/native Catalog, saved/attached/configured → directory/search/Available/Connected/category/Featured/See all/details | Complete or explicitly incomplete inventory; verifiable semantic categories; no auto login/model; configured is not authenticated |
| Muse CN-02 | Original API read channel, Browser sessions, no-auth MCP and OpenOx DCR server → configure/connect/verify/choose/cancel/disconnect | Original typed credentials/bindings and exact service identity; actual access proof; owner-scoped flow; dependencies/confirmation; zero new disconnected dispatch |
| Muse CN-03 | Bad issuer/resource/state/redirect, refusal/token/store/refresh/revoke faults, peer/cancel/reload/Reset/relaunch | No replay or cross-owner/cross-consumer write; explicit failed/unknown/unsupported; original audit before dispatch; live-file proof, bounds and epoch fences |
| Connector CP-05 | Actual paired no-model UI, dark/light/EN/ZH/compact/off, dependent Settings/DC/SS/Agent/chat, actual clean X → Y ordinary writes → Y relaunch | Stable selected viewer captures, honest reference/V95 limits, preserved stopped authority/secret/attachment/policy/content owners and immutable snapshots |

Use existing `linux-host-services.test.ts` and the relevant workspace dependency
packet, existing isolated `muse-workspace-ui.ts --connectors`, and actual packaged
predecessor storage matrix. No fourth UI/unit suite. Missing external OpenOx
registrations/accounts, unimplemented brand connectors, native/physical/provider
quality and unobserved foreground reference states are blocked, not inferred passes.

Connector CP-05 rendered RED was executed on clean main `ab1679eb`: the normal
paired no-model Settings showed the old technical list, with all eight frozen
directory/Search/tabs/Featured/four-category controls absent. Existing session
harness SHA256 `2bb3f1664d0f1ca0349ce447f5d94dd0387d5d6dea7ed883e2e7379d947bd190`;
private `muse-connectors-ui/red-1794672193004-d7a71870` includes the actual
foreground capture/read result. No model/provider or installed preview was used.
Real cross-site OAuth RED was then observed on clean `d49afe2d` using only
owned `localhost`→`127.0.0.1` origins: the original paired cookie remained
SameSite=Strict and was correctly omitted from the initial callback, leaving
zero token exchanges. Same-site loopback success is not cross-site evidence;
the callback must stage only transient code and require the original paired
owner's same-origin completion without weakening ordinary cookie policy.

Bounded original-owner CN source acceptance is now verified at clean runtime
`077f1acb`:15 protocol cases/435 assertions; required shared-owner packet48/
2282 GREEN; original advanced service share/import/delete case71 assertions
GREEN in its isolated fixture. A49-case combined attempt hit the pre-existing
absolute cookie-counter expectation (2/3 instead of1/2); it is recorded, not
claimed passing or treated as a product change.

Actual normal paired no-model browser runs pass12 workflows/142 checks/46
captures, plus the real cross-site Strict-cookie return (one exchange, no
cookie weakening). All47 primary/cross-site and16 selected dependent
Settings/DC/SS/off/Main/Agent captures were individually viewed. Public
Search/segment geometry is within1 CSS px; foreground V95 remains0 because
deep/light/ZH/compact reference and live brand/provider gates are unavailable.

Actual clean normal-packaged f8c9b5e writes the predecessor Catalog/API/MCP/
Secrets/bindings/attachments/Goals/discovery/identity/history/MEMORY fixture.
Changed normal startup, ordinary connect/disconnect/settings/off writes,
real private I/O refusal and second launch pass423 checks, preserve9 complete
stopped logical tables and4 stopped authorization records, and lose no old
file (27→31). Immutable before/after/package and private viewer/source/
cleanup proofs are in session files. Four controlled model calls are only
legacy original source authoring; connector configuration uses no model.

Existing lint/six type projects/portable build and all five unchanged native
input-graph/output-hash proofs pass. No installed preview promotion, native
configuration waiver, external account authorization, new credential/runtime
owner, PP/direct-network implementation or whole-Muse acceptance is claimed.

## Muse Data controls packet DC

The frozen DCV2 contract is in business `plans/personal-agent/muse-data-controls-slice.md`.
Only Linux/web is in scope. Collector/training is unavailable and no consent
mutation exists. Preserve original Secrets v1, Host/Profile identity, settings,
connections/permissions, authorization, Browser state and all immutable backups.
All content operations use paired authority, both gates and no-store responses.

| ID | Setup → action | Required owner/rendered result |
| --- | --- | --- |
| DC-01 | No model/collector, unpaired/foreign/single/off gates → read explanation | Truthful not-sending state, provider policy independent, no mutation/dispatch |
| DC-02 | UTF8 text/MD, OpenOx ZIP, supported ChatGPT text mapping → upload/preview/cancel/select/edit/review/approve | Passive user text, atomic original manual candidates, original MEMORY CAS/reconcile, no SOUL/permission/suggestions changes |
| DC-03 | Empty/unsafe/CRC/encrypted/bomb/unknown/oversized input; peer edit, held/lost response and actual owner I/O refusal | Before-mutation rejection, source-linked explicit decision, original receipt read verification, no overwrite/replay/false whole-batch success |
| DC-04 | Actual populated original/older owners including hidden lineage/files/media/all private content → export/download/parse | Complete SQLite/physical/VM content plus versions/scope/hashes; no automatic secret/token/cookie/authority export; changed/busy/unsafe/badstate/oversized refuses |
| DC-05 | Small authorized all-owner fixture, two clients → actual summary/cancel/stale/busy/confirmed Reset; I/O failure/restart | Durable confirmed phase before deletion, exact inventory erasure, old tasks/context cannot resurrect, original kept bytes/identity preserved, incomplete never success |
| DC-06 | Original paired browser UI15 dark EN; light/ZH/compact/off/dependencies; actual X writer→Y ordinary writes→Reset→second launch | Stable foreground captures and viewer review, real late/SSE/tab/abort/proof handling, true stored-owner compatibility; formal foreground V95 remains0 unless actually measured |

Maintained protocol owner is `linux-host-workspace.test.ts`; rendered exploration
reuses session `muse-workspace-ui.ts --data-controls`, not a fourth suite.
Bounds: import ZIP8MiB/expanded16MiB/entry8MiB/128 entries; text512KiB;
preview2,000 sources/512KiB total/32KiB source;1–20 facts/1,000 characters each;
two10-minute stages. Export128MiB/32MiB/256 entries. Reset10,000 authorized
objects/128MiB/32MiB, two2-minute confirmations,4MiB journal/500 receipts.
Reference sublayers without originals are reference-blocked, not V95.
The intended protocol RED is reachable `0da78e42`: six compiled/executed
cases fail on absent Data controls HTTP404,12 assertions (actual RED LOC304/-1).
The same six-case protocol target now passes243 assertions, including genuine
unconfirmed journal-write EACCES and confirmed deletion EACCES followed by normal
startup recovery. Lint/six TypeScript projects/portable build pass. The original
five native bundle audits retain their input counts and byte sizes; native
compilation is not claimed. Rendered/storage acceptance is not yet recorded.
The additional reachable stage-lifecycle RED `a4678882` executes the actual Host
ignoring a supplied upload identity. Its matching GREEN passes1 case/13 assertions:
known stage cleanup, cancel-before-arrival and cancel-while-reading, without
active content mutation or model calls.
First original paired rendered GREEN covers9 workflows/134 explicit checks and
24 stable captures: no-model content explanation, text/OpenOx/ChatGPT preview,
select/edit/cancel, original manual review/publication, real peer MEMORY CAS,
lost publication/read proof, late upload/close, unconfirmed import/Reset,
actual private ZIP download/hash parsing, stale Reset and genuine confirmed
deletion EACCES followed by ordinary startup recovery; light/ZH/compact and
original Passwords preservation. Viewer-discovered separator/color, file-name
and verification visibility defects were corrected. UI15 public card rectangles
are within1 CSS px with no masks; formal foreground V95 remains0.
The reachable incomplete-result RED `24dbf027` now passes the same owner case
with42 assertions: pending counts are confirmed scope plus recorded-object
progress, not completed deletion. Full clean-source/dependency/storage packet
acceptance follows; these initial source checks do not certify native, physical,
real-provider, power-loss or installed-artifact promotion.
The reachable complete-inventory/preparation RED `e96b330e` demonstrates an
accepted stale private title and a genuine staging EACCES interrupted preparation
with an unexpected original Goal written while that QA Host was stopped.
The matching owner packet now passes4 cases/137 assertions: full closed logical
SQLite fingerprint rejects changed private metadata/hidden visibility; each
original content owner proves empty before startup publishes recovery. This is
not a second runtime, manual SQL delete or native/power-loss certification.
The later-phase VM RED `8fb95133` executes actual confirmed deletion EACCES and
an independently written original paused schedule while that Host is stopped.
All10 DC protocol cases now pass324 assertions. Recovery revalidates original
VM content in every phase, syncs reset-specific owner/baseline writes before
advancement and guards database sizes before projection. Lint/six TypeScript
projects/portable build pass; native input counts/sizes remain unchanged.
DC-06 current-file dependent RED is executed in the original paired harness:
after actual confirmed Reset and recovery, an ordinary current-epoch HTML file
opens through `/#/file/...`, but its original frame service call receives409
because the existing streamed canvas writer omits the content epoch. This is
an actual admitted file/rendered request, not a mocked busy/HTTP response or
onboarding/route setup failure. Fix must bind the frame's original epoch,
not remove stale-authority protection or silently authorize old frames.
The matching paired packet now passes11 workflows/158 checks/28 captures,
including the actual post-Reset original HTML service call, a32MiB+1-byte owned
oversize refusal, one explicitly held original loopback model/busy refusal and
a successful second Reset whose held response is read-verified after real SSE
reload without resubmission. Only that bounded busy fixture makes one model
call; memory import/review/export/reset/collector make none. The original frame
captures its content epoch for call/answer/close, distinct from its local
document generation; stale frames are not granted a new epoch.
DC-01–06 bounded source acceptance is now recorded at tested clean runtime
`ab471858`:10 owning protocol cases/324 assertions;36-case original prerequisite
selection/1,949 assertions; final paired11 workflows/163 checks/29 captured states
(20 selected stable foreground captures individually viewed), plus4 original
Settings/off/Agent/Main-Side dependency modes (8 selected captures viewed; Agent
has its own132 explicit checks, no reused SS counts). Actual clean packaged
0da78e42 X writes→Y normal complete SQLite-table/owner preservation→ordinary
import/publish/file/full ZIP parsing→explicit Reset→real confirmed EACCES/exact
owned SIGKILL→Y second-launch recovery/new writes→stable subsequent launch
passes292 checks. Immutable before/after snapshots stay private.
All five native bundle contributing inputs/output hashes equal stable8c;
native compilation and the old Library/Space iOS exception were not used.
UI15 public geometry is0 except actions/Reset y=-1 CSS px, masks=[]; formal
foreground V95=0. No OpenOx collector/training mutation/model extraction exists.
ENOSPC/fsync fault/power-loss/native/physical/real-provider/downgrade/resource
work remains explicitly unrun. Only task-owned QA caches/hosts/browsers and
unselected captures are cleaned; the separate installed310eb664 Preview and
all old backups/rollback artifacts stay untouched. The parent Muse program
continues; this checkpoint does not promote an installed artifact or close
Connectors/Permissions/full Search/Space/voice/integrations.

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

## Conversational public-page watch packet WT

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| WT-01 | Scripted Agent creates two paused watches in one execution, lists/updates/deletes through approved tools and races a normal owner edit | Same Profile records/revisions as Activity, separate stable Host request identities, strict output contracts and no duplicate owner or blind stale-write replay |
| WT-02 | Decline/block tool calls, submit private/credential URLs or invalid intervals, and attempt persistent writes from a temporary conversation | Normal action policies enforced before mutation/reads of the target website, no unwanted job or browser dispatch, explicit errors and no temporary background delegation |
| WT-03 | Explicitly approve enabled creation, wait for a real anonymous fixture baseline, pause through the Agent, change text and check through existing owner controls | First baseline quiet, one durable change notice, shared current metadata, no cookies/site-script writes/body-to-model transfer or model calls during checks |
| WT-04 | Inspect tool discovery/permission defaults, restart the same data with the preview off, then re-enable | Four watch tools and Ask defaults only when enabled; no disabled CodeMode stubs/help/policy entries; existing watches/manual APIs/storage/Schedules preserved |
| WT-05 | Render actual watch approval/disclosure and existing Web permission rows in EN/ZH desktop/compact light/dark, including deny/stale recovery | Trusted target/scope and explicit enabled state visible, native labels, usable approval controls and visible failures; no new page or implication of real-model semantic understanding |
| WT-06 | Use valid near-limit URL/selector values in create and current/proposed update approval, then decline | Complete parseable bounded target arguments, visible full target/state and reachable controls; no mutation on Deny, no invalid JSON truncation, other action limits unchanged |

## Isolated crash and backpressure packet CR

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| CR-01 | Save a real anonymous baseline, hold an enabled read, kill only the disposable Host without shutdown, restart, then explicitly check changed text and restart again | Interrupted claim is not a valid new observation; last-valid fingerprint/time remain, no catch-up burst or duplicate notice, later accepted change and notice survive together |
| CR-02 | Subscribe an API-only synthetic device to a held local encrypted-Push endpoint, commit a real change, kill after durable sending and restart | Same unread notice becomes unknown, not accepted/read/failed; uncertain external submission is not automatically replayed; this is transport/state proof, not a physical popup or hidden-browser test |
| CR-03 | Fill the bounded Inbox through normal due-Todo APIs in capacity-safe batches, then submit another reminder and a changed page check; restart | Existing 1,000 records retained, no silent pruning/reset; reminder handoff remains pending if enqueue fails, watch preserves last-valid state and reports explicit failure, restart stays healthy without losing queued work |
| CR-04 | Kill the disposable Host during a held browser read, leave its browser untouched, restart and check a different responsive fixture URL | New checks recover without manual process cleanup or profile-lock failure; any future automatic cleanup must prove process/profile ownership and never touch foreign browser sessions |
| CR-05 | Supply missing/foreign/active ownership proof, reuse a PID identity, and repeat ordinary close/relaunch with the preview off | Fail closed before signalling unproven processes; current/foreign resources stay alive, default-off browser behavior stays unchanged and only matching ephemeral ownership metadata is removed |

Use fresh local no-model Profiles and exact owned process IDs only. Public-page/Push fixtures use the existing exact loopback test-origin exceptions. Do not modify the live preview, model configuration, clocks, visibility state or shared Spark. Passing exploratory probes need no new maintained suite; reproduced bugs require focused RED/GREEN in the existing protocol owner.

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
| LP-04 | Normal owned stop/restart and repeated open; explicit restart after a proven owned crash; conflicting/foreign record or nonempty foreign data | Data/browser authority/origin retained, proven stale runtime ownership recovered without touching other processes, unknown ownership still fails closed; no blind overwrite or service takeover |
| LP-05 | Run exact bundled/installed artifact and normal browser launcher; inspect no-model Home and setup/task/observer paths | Real usable local preview, truthful no-model/Host wake limits, no fake replies or OS/global/service changes; actual model/device/24-hour proof stays separate |

## Unified personal workspace UX packet UA / UM

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| UA-01 | Owner creates paused scheduled task and page watch, lists/filters/opens/edits them together | One Automations management surface, correct trigger type and actual owner state, no model on create or copy into a new store |
| UA-02 | Replay/change creation key, restart, mutate old schedules, delete/replay, disable preview | Stable receipt without duplicates/resurrection, old storage/tools preserved, only new owner-create API gated, validation before mutation |
| UA-03 | Read Home counts, mutate both job types via normal UI/other client, open old Schedules links and Settings | Enabled jobs from both owners counted with no private prompt/title response, real SSE, personal entry unified and default-off legacy route unchanged |
| UA-04 | New/edit custom recurrence forms, list/API failure and uncertain/stale saves in EN/ZH desktop/compact light/dark | Actual 44px controls/equal padding, protected custom fields and pending close, visible recovery, no empty/zero fallback or implicit run |
| UM-01 | Open Memory & Skills with no suggestions, switch Memory/Installed Skills/Suggested changes and use Home/Settings | Useful active management first, clear pending counts, no ambiguous top-level Review or navigation dead end |
| UM-02 | Create/edit/toggle/delete active Skill or current memory through management, then publish a suggested change | Same physical owners/catalog and approval boundaries, manual ownership distinct from unreviewed Agent proposals |
| UM-03 | Open old Review list/detail links, pause proposals, cause stale publication and cross-page changes | Correct suggested-change destination, inactivity/provenance/conflicts and visible recovery retained, no automatic grants or draft loss |
| UM-04 | EN/ZH desktop/compact light/dark, no-model and master-off bookmarks with actual screenshots | Native copy, explicit model limits, 44px controls, visible errors, no active personal controls or extra data fetch when unavailable |

## Chat-first Activity packet CA

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| CA-01 | Open Activity from sidebar/Home/Settings, inspect scheduled tasks and page watches, then open old Automations/detail/Schedules links | One existing management view under Activity, same job identities and owner state, canonical new links and working old links; no second scheduler or invented history |
| CA-02 | Ask OpenOx from Activity with an empty/existing new-chat draft and no configured model | Editable task request only, existing draft preserved with visible explanation, no send/conversation/job/model request; ordinary model setup and disabled send remain truthful |
| CA-03 | Use secondary manual setup, filter/open/edit/pause/delete both job types, and trigger validation/pending/uncertain saves | Existing owner APIs, default-paused manual creation, approvals and protected forms preserved; page watches remain bounded static-text checks, not semantic monitors |
| CA-04 | Receive genuine peer SSE, fail/recover schedule/watch reads, and review EN/ZH light/dark at compact/tablet/desktop sizes | Correct current data, persistent decision feedback and dialogs, 44px controls, separated header title/actions, equal padding/no overflow, visible errors rather than empty/zero; actual screenshots inspected |
| CA-05 | Restart the same isolated data with personal preview disabled, open old/new bookmarks and Settings | Existing Schedules/tools/data remain, no personal Activity links or active personal controls, unavailable capabilities never appear usable |
| CA-06 | Use an explicitly approved real provider/endpoint and bounded resource window for conversational task creation, execution and result | Real tool approvals, stored job, useful run and notification; scripted fixtures/UI drafts do not establish model quality, Spark safety or 24-hour acceptance |

## Muse Main chat foundation packet MU

The November 13 product reset follows Muse's observed pages/features/interactions, not the earlier bespoke Home/Inbox/Automations/Memory-Skills navigation. Full design and the 35-reference inventory are maintained in the business parity plan. This foundation establishes real Main/Side identity before changing the shell; it must not be reported as a matching UI or 95% acceptance.

| ID | Setup and user actions | Required result and invariant |
| --- | --- | --- |
| MU-01 | Personal/parity gates off or enabled individually; query/write Main, read ordinary conversations | New API unavailable, no mutation/inference; old conversations and routes unaffected |
| MU-02 | Query fresh Profile repeatedly, then two clients explicitly create Main concurrently | Reads create nothing; exactly one ordinary Main, 201 + 200, same ID and no model request |
| MU-03 | Send distinct Main/Side turns, branch Main, regenerate a later and first turn | Context and roles stay distinct; a branch never inherits Main; replacement atomically receives Main without duplicate markers |
| MU-04 | Rename/restart, disable/re-enable, delete Main, query again | Role/content/Side identity survive ordinary writes and restart; deletion does not silently recreate Main |
| MU-05 | Invalid body/model, competing explicit model, no model on first create, unauthenticated access | Explicit refusal before mutation/inference; no silent model change or temporary Main |
| MU-06 | Actual predecessor data, current startup/ordinary writes and second launch | Existing history/files/memory/jobs/authorization retained; native/downgrade role preservation separately qualified |
| MU-07 | After shell integration: Main/Side/Search navigation, two drafts, old bookmarks, no-model and uncertain reply | Real rendered success/failure/recovery; no auto-send, draft loss or hidden model fallback |
| MU-08 | After matching shell implementation: UI01/UI24 aligned viewport/DPR/state/crop/focus | Frozen privacy/brand masks, foreground comparison, actual screenshots/diffs and manual review; missing functions/reference states cannot pass V95 |

Use the existing workspace protocol runner for MU-01–05, storage compatibility for MU-06 and gym for rendered MU-07–08. Do not add a fourth suite. The optional `mainChat: true` role belongs to existing private conversation metadata, not another transcript/registry. Prompt answers remain transient; a future Approvals history needs its own trusted minimal receipts, not an Allow-list relabel.

## Muse workspace rendered packet MS

The first three related surfaces are Chat/Main-Side, global Search and Agent Activity. Follow the frozen UI01/UI24/UI26 geometry in the business workspace plan; use existing message/schedule/watch owners, not a second runtime. Unimplemented primary destinations or Agent depths must be explicitly unavailable, not fake functional pages or accepted parity.

| ID | User actions | Required result |
| --- | --- | --- |
| MS-01 | Pair normally with both gates, then master/parity off and old bookmarks | Correct opt-in shell only, old behavior/data retained, no automatic model work |
| MS-02 | Send Main and Side, refresh and return Main | Real persistent Main owner, distinct contexts, correct model |
| MS-03 | Keep Main/Side unsent drafts/attachments while opening panels/Search/Settings | No loss/cross-contamination/auto-send or implicit job creation |
| MS-04 | Local filter and global recent/match/empty search, open result and Escape | Actual results/navigation and focus restoration |
| MS-05 | Open Agent schedules/watches, edit/pause, peer SSE, fail/retry reads | Same owners/counts, actual state and persistent visible errors, no run on open |
| MS-06 | Main lookup error, peer delete/regenerate, no model/offline | Truthful recoverable error, no empty/zero fallback, model swap or blind resend |
| MS-07 | 1285×736 DPR2 dark plus EN/ZH compact/light functional variants | Actual screenshot inspection, correct geometry, accessible hit targets, no overflow |
| MS-08 | Compare frozen reference/masks and actual images | Missing controls/features fail; no whole-product V95 score from partial/DOM evidence |

Rendered evidence belongs to isolated gym/session artifacts, not a fourth test suite. New UI/source changes still run affected MU/legacy protocols and the existing lint/build gates.

## Muse Settings rendered packet MT

First related surfaces are the Settings frame/General, Devices and Help/Legal. Match UI03/04/14/17/18/31 organization while keeping unsupported account/payment/channel features explicitly unavailable; a menu label is not functional parity.

| ID | Actions | Required result |
| --- | --- | --- |
| MT-01 | Menu/deep-link open, 11 ordered sections, Back/Close | 800x600 and224px nav on reference desktop; return to prior chat/draft |
| MT-02 | Light/Dark/System, nine accent choices, reload and gate off | Actual browser preference restored, no Muse accent leaked into legacy |
| MT-03 | General advanced Models/Host/Workspace and old bookmarks | Existing genuine setup remains reachable without extra consumer tabs |
| MT-04 | Real device list/detail, self/peer metadata, read error/retry | Correct current records, no guessed OS or unauthorized revocation |
| MT-05 | Help/legal links and unavailable external pages | Real destinations; no fake subscriptions/payment/connections/training/reset |
| MT-06 | EN/ZH light/dark desktop/compact screenshots | Real visual inspection, no clipping/overlap; missing references do not score V95 |

## Muse Goals packet GO

Goals own outcomes/criteria and progress, not copies of Todo/scheduler state. Use private version1 `ox.goals` in the same Profile database, stable create receipts, current revisions and both Muse/personal gates. Linked tasks remain under their original owner; all linked tasks complete does not complete the Goal. Agent update cannot set completed; owner UI completion is explicit. No model/job starts on create.

| ID | Actions | Required result |
| --- | --- | --- |
| GO-01 | Owner CRUD, same/changed/deleted receipt, invalid/blank/stale input and restart | Unique persistent identity, revision/conflict boundaries, no silent replacement or resurrection |
| GO-02 | Link own Todos, complete/delete Todo and complete/reopen/delete Goal | Actual projections and explicit Goal completion; no duplicated/deleted task or hidden cascade |
| GO-03 | Four approved tools, deny/block, temporary/off-gate and tool completion attempt | Same typed owner, Ask defaults, no mutation/inference on refusal or unsupported completed |
| GO-04 | Actual predecessor snapshot -> current Goal/ordinary edits -> second launch | Prior data/authorization retained and new Goal stable; native/downgrade excluded |
| GO-05 | Normal Goals entry, create/edit/detail/complete/delete and delegate draft | Real data, correct Tracking/create/list hierarchy, no auto-send or canned model result |
| GO-06 | Real peer SSE, stale editor, read failure/retry and uncertain creation | Visible feedback/draft retained, same creation key and no blind replay |
| GO-07 | Actual EN/ZH light/dark desktop/compact screenshots | Match observed UI21 shell/list geometry, no fake redaction blocks; unknown subviews not V95 |
| GO-08 | Off/older Host, actual provider and reference gaps | Gate/legacy retained, fixture not real-model or whole-product/95% proof |

Use the existing workspace protocol runner, scoped storage compatibility and isolated rendered gym evidence. Goal deletion retains receipts and other owners; no silent pruning. Source/type/build checks and related Main/Todo/approval cases remain required.

## Library and persistent Spaces packet LS

Match UI22/UI23 organization while retaining the original ProfileFileStore/ox.workspace authority. Private ox.library owns semantic Space/podcast metadata only, never duplicate file content/index/runtime. Stable IDs survive moves; missing entries do not adopt replacement files. Use the existing frame/CSP/approval boundaries.

| ID | Actions | Required result |
| --- | --- | --- |
| LS-01 | Actual file categories/search/sort/cursor/system entries | Original IDs/content, explicit pagination/change boundaries; ordinary audio is not auto-podcast |
| LS-02 | Space create/edit/pin/remove/receipts/stale edits | Persistent identity/revision, no resurrection/content deletion or fake execution |
| LS-03 | Owner/Agent move, off-gate move, update/delete/recreate entry and reject internal/escaping paths | Muse resolves retained owner aliases; default moves still expire references; missing without silent rebinding, file safety retained |
| LS-04 | Typed Agent approval/deny/block/temporary/off | Same owner and real contracts, no permission widening |
| LS-05 | Normal Library navigation and real/empty/missing/failure/open/manage states | Matching structure with actual artifacts, not gray redaction placeholders |
| LS-06 | Contextual create-space Side chat, unsent/sent/reload/return and drafts/attachments | Captured background target survives its own async refresh, normal Side ID retained, no auto-send/overwriting/second Agent |
| LS-07 | Real safe-frame service interaction/deny/close/refresh/faults | Existing sandbox/approvals, no blind replay or arbitrary network/files |
| LS-08 | Actual predecessor/current/relaunch and appearance/reference review | Original data/auth retained; no full V95/model/physical extrapolation |

Only the existing protocol, storage compatibility and isolated gym/eval lanes. New capabilities are double-gated; unsupported/reference-blocked behavior is not a pass.

UX-C2a is bounded to the immutable126 original `library.ts` UX-C obligations;
the ten historical Library rows in other packets are not new coverage.
The eight historical C2 passes belong to `space-settings.ts`, whose50 rows
remain a separate packet. Pre-edit page-change/V2 contracts are in the private
`muse-ui-c2a-page-change-plan.json`: actual six-category collection reads,
selection/range, Space registration/editor/removal and original detail routes;
LS-01–08, applicable SP-04 and UX-ST-02–05/07–08.
The paired no-model RED reproduces missing selected-file scope, blank initial
Space reads, unavailable stated unknown-edit inspection, pending action
reentry and replaced-caller focus loss. Preserve original file, Library,
ScheduleStore, frame/grant/CAS and contextual-chat owners. Matching GREEN,
actual original-scale viewer review, affected maintained protocol selectors,
lint/build/six types and five genuine unchanged native graphs are required
before accepting any exact row; unexecuted variants remain planned.
Selected-file UI checks now re-read original Library identity/path/hash before
the unchanged path-based file DELETE. This rejects an already changed/moved
selection, including a same-path replacement, but is not atomic file-delete
CAS certification: replacement between that read and the original DELETE
remains an explicit owner-boundary follow-up, not a passed identity guarantee.
The bounded C2a checkpoint is `1ad3589c`: all126 original IDs have an exact
disposition, with68 reviewed passes,6 source-proved N/A and52 finite remaining
IDs. Real UI workflows and corrections are validated; unviewed retained regions
are not passes. Final29 maintained cases/1238 assertions, normal lint/build,
six TypeScript projects and five unchanged actual native graphs pass. Native
compilation, old Library waiver, storage replay, charts and V95 are not claimed.
The private `muse-ui-library-handoff.json` retains exact continuation IDs and
original-scale evidence; C2b50 and C3 74 remain separate.

UX-C2aR only continues those52 IDs. Its frozen private mapping and page-change
addendum separate original caller evidence from the original file-delete boundary.
An actual paired run on clean `a631cc37` (runtime `1ad3589c`) held DELETE after
the UI's ID/path/hash read, then used the original owner to delete/recreate that
path. The new, unselected UUID/hash was deleted by the released path-only request;
the independently recorded reply was HTTP200. This is a retained runtime RED,
not atomic admission or an accepted selection guarantee.
The five route/category deletion obligations ending `160ba27`, `021b58d`,
`e1ce189`, `65270a1`, `1214473` remain unaccepted. Original per-file journaling,
sequential partial progress and confirmation UI do not prove an all-or-nothing
batch or original UUID/content admission. Host content epoch admission is not
selected-file CAS. A safe root fix must reach the original shared
ProfileFiles/ProfileFileStore/backend mutation boundary, preserving file IDs,
proof, native/default behavior and recovery; a second browser read or a
Linux-only outer lock is insufficient. Shared/native and persistent execution
changes require both genuine native builds and actual predecessor/write/relaunch
verification. Normal ignored iOS Local.xcconfig is absent; the old Library waiver
does not apply. No owner/schema/execution fix or native build is claimed here.
The bounded viewer continuation accepts45 of52 exact original IDs and leaves
seven planned: those five deletion IDs, the separate C2b Manage leaf, and a
legitimate initial System no-items prerequisite. Prior68 passes/six source N/A
are immutable; original126 ID reduction is113 pass/seven planned/six N/A.
Actual review delivered46 readable image results/1,556,840 encoded bytes;
two inadequate focus crops retain rejection while adequate originals are read.
Four missing exact caller conditions add23 actual green checks, not new source
inventory. Runtime inputs are unchanged, so prior29/1238 lint/build/six-type/five
native-graph proof is retained, not rerun or relabelled. Independent results and
compact continuation are `muse-ui-state-ux-c2ar-results.json` and
`muse-ui-library-finish-handoff.json`; C2b50/C3 74/D–I, charts and V95 remain open.
Urgent containment case `UX-C2AR-DELETE-CONTAINMENT`: current paired UI RED on
`1e3cdc34` exposes enabled Library removal and reachable Muse legacy Files
Delete; actual confirmations dispatch two path-only file DELETEs. Until the
original owner is repaired, disable path-backed Library deletion and omit the
unsafe Muse legacy Files entry, with visible EN/ZH explanation and defensive
UI handler refusal. Preserve original Space registration deletion, podcast
metadata and ordinary/personal-only legacy behavior. Required GREEN proves zero
unsafe UI calls and retained original IDs/hashes, plus affected maintained
protocols, lint/build/six types and five actual unchanged native input/output
graphs. The five atomic IDs stay unaccepted; this is UI containment, not owner CAS.
Containment GREEN disables all four path-backed categories and omits the
reachable Muse Files Delete, with zero unsafe UI calls and exact retained file
IDs/hashes. Original Space removal and both off modes remain actual GREEN.
Normal29/1238, lint/build/six types and five actual native graphs pass. Tiny
EN/ZH control/copy images are actually viewed; prior closed evidence stays frozen.
The user now authorizes this real atomic-owner repair with normal Mac validation
and data-safety matrix while deferring only iOS compilation for this fix; this
is not a future/native blanket waiver or iOS acceptance.
The owner-only V2 follow-on is frozen in private
`muse-library-atomic-delete-plan.json`: extend the original serialized
ox.workspace journal with a checked whole-selection batch and durable scoped
receipt/proof. Current Linux/native trash loops and conflict reconciliation are
not batch atomicity. The real01d092be RED stays authoritative; the verified normal
8e247397 package contains byte-identical current file-store/Linux backend/Profile
owners for actual predecessor writes. No backend implementation or owner GREEN
is claimed at this checkpoint; normal Mac build and new storage matrix remain
required, while only this fix's iOS compilation is expressly deferred.
Owner repair RED extends LS-03 in the existing linux-host-workspace protocol
runner: valid exact-selection deletion/durable proof and the reproduced
replacement-plus-peer conflict. Both currently fail on absent original-owner
row proof (two cases/six assertions); this does not replace the real historical
HTTP200 data-loss RED. Private `muse-library-atomic-owner-contract.json` freezes
bounded admission, original pending rollback/publication, exact scope and
receipt retention before backend edits. The genuine normal macOS `host` target
already compiles with its existing `ai.openox.host.local` identity; affected
post-change build, storage and UI gates remain pending. Containment stays on.
The focused implementation now extends the original file owner with explicit
backend opt-in, whole-selection physical revision/SHA256 admission, one durable
checked-trash intent, no-overwrite rollback and exact scoped receipts. Native and
template backends explicitly refuse this Linux/web-only capability; their
sequential ordinary trash is not relabelled atomic. Six maintained LS-03 cases
exercise real valid deletion, the exact new-UUID/hash replacement race, batch
conflict, scopes/limits/off modes, caller/cancel fences and actual I/O interruption,
restart and rollback. Receipt/protocol GREEN is not yet a UI or storage acceptance;
the existing containment remains until the normal Mac and genuine normal-package
upgrade gates complete.
Post-implementation invariant review adds two RED variants to those same LS-03
cases: present malformed/future receipt metadata must not become empty history,
and recovery must bind its candidate receipt/index to the exact original checked
intent before backend effects. The paired real-owner RED returns200 with a null
receipt map and accepts a mismatched pending receipt UUID. These require narrow
owner hardening and fresh shared/Mac/package-compatibility gates; prior successful
valid-state race, UI and storage evidence retains its original source scope.
The narrow hardening now refuses malformed/future new receipt metadata and checks
the exact candidate/ordered-target/null-index recovery invariant before effects.
Refused-input receipts remain readable without granting file authority. Current
web deletion requires strict capability/version plus per-row proof, validates the
whole committed receipt, and offers only readonly proof after an unknown result;
unsupported old Hosts stay disabled without path fallback. Local success feedback
belongs to the current Library caller, not a global Saved/unchecked-success toast.
Fresh final owner/native/package and tiny current-image gates remain required.
Final owner repair runtime `c1760b19` passes27 focused maintained cases/963
assertions, normal lint/six types/build, the native bundle check and five actual
native graphs. The genuine normal macOS `host` target compiles with
`ai.openox.host.local` and fresh owner resources; only this repair's iOS build
remains expressly deferred/unverified. Native/template checked removal is
explicitly unsupported, not sequential-trash atomicity.
Actual immutable normal8e247397 writes → clean normalc1760b19 upgrade/ordinary
and checked writes → interruption/rollback/relaunch/after-snapshot reads pass331
checks/four rows/four exact receipts, preserving original authority and browser
data without model calls. Current EN/ZH and actual old-Host UI pass203 checks;
all23 selected tiny images are actually viewed with unrounded contrast. The
five original atomic Library IDs now have matching owner/race/proof/viewer GREEN,
not containment-only acceptance. Old Hosts fail closed with no path fallback.
Evidence is `muse-library-atomic-owner-handoff.json`; original C2a/C2aR reports
stay frozen, and the separate C2b leaf/System-initial-no-items obligations,
broader Library/Muse, native UI/glyph/physical/provider/charts and V95 remain open.

UX-C2b freezes exactly50 original UX-C `space-settings.ts` IDs plus the two
remaining Library leaf/System-initial-no-items IDs in private
`muse-ui-c2b-plan.json`; eight historical A-dependent passes are not new coverage.
Its targeted SP-01–06 / UX-ST-02–05/07–08 workflows retain original placement,
public notes/checklist grants/CAS, selected connector proof and ScheduleStore
owners. No private source expansion, new queue or native/storage change is planned.
Actual paired RED at clean `f4abf46e` reproduces two placement-caller defects:
after a successful save, a second save sends the stale revision and receives409;
editing after that save then closes without the required discard confirmation.
Both tiny original-CSS screenshots were actually viewed. Evidence is
`muse-ui-c2b/red-core-1794788288922-c28cfed6/result.json`.
This checkpoint precedes the surgical UI fix; matching GREEN and all focused
source/protocol/native-input/viewer gates remain pending. The accepted native
comparison baseline is atomic runtime `c1760b19`, not its older predecessor.
The same unchanged placement caller also reproduces dependent-control RED:
save unlock incorrectly enables the IANA field while Always visible remains on.
The six-check confirmation is `muse-ui-c2b/red-core-1794788341962-d918986b`;
no production edit preceded this additional tightly coupled observation.
The narrow placement fix keeps the current owner revision and a live post-save
dirty baseline, while retaining Always-visible field availability on unlock.
Matching paired placement17 and notes19 checks pass; normal lint/six types/build
pass. The focused owner packet currently has17 pass/one existing SP unavailable
read failure (400 instead of503); no backend/native source has changed in C2b.
Separate actual revoke RED names no selected file in its confirmation:
`muse-ui-c2b/red-revoke-red-1794788577358-f19d9c6c` records10 checks/one failure,
and its unchanged-CSS dialog was actually viewed. Source-scoped confirmation
repair and the unavailable-read investigation remain pending at this checkpoint.
Revoke consent now names its actual original public JSON path (or retained file
identity); the paired16-check grant/revoke workflow and selected-connector15,
bound-update7, empty/readonly6 and real I/O4 checks pass. Normal source gates and
five accepted native graphs pass again, with no native input or storage change.
Actual chmod000 notes-read RED is now rendered and viewed:
`muse-ui-c2b/red-unavailable-red-1794788823573-13d05825` returns400 and exposes a
raw Host filesystem path instead of a recoverable logical-source503. The existing
SP-05 protocol reproduces the same pre-C2b backend defect. Its read-only Linux
route error classification remains unfixed at this checkpoint.
The read-only Linux Library/Space boundary now maps only actual EACCES/EPERM
GET failures to the existing localized logical-source503 and logs only the error
code; mutation/unknown semantics and all original file owners remain unchanged.
The extended existing SP-05 case covers data/resources/list reads; the focused
18-case owner packet passes415 assertions. The same actual chmod000 UI GREEN
is viewed, normal lint/six types/build pass, and five actual native graphs remain
identical to accepted `c1760b19`. No native compile or storage rewrite is claimed.
Separate caller-scope RED is now frozen before its repair:
`muse-ui-c2b/red-discard-scope-red-1794789227097-ff8178d2` has two actual failures:
placement and notes discard both show generic text without naming their original
Space/public source. Both exact caller dialogs were actually viewed. The coarse
checkbox hypothesis was rejected: the real touch tap outside its20px native glyph
successfully toggles within the44px target; no speculative pixel fix was made.
Discard now identifies the original Space or public notes path in all five
close/tab/reload callers. Actual EN/dark, ZH/light/compact and EN/light paired
GREEN dialogs were viewed; placement35, notes/context30 and connector28 focused
checks pass. Normal lint/build/six types and all30 selected maintained
workspace/services/browser/web cases (726 assertions) pass; native graphs are
unchanged. Two tightly coupled read-feedback corrections remain RED before edits:
the new shared Library GET error mislabels an ordinary public document as Space
data (`muse-ui-c2b/red-read-scope-red-1794789618641-6cf33ba8`), and actual ZH
transport failure still displays untranslated browser text
(`muse-ui-c2b/red-read-copy-red-1794789672454-9ae11754`). Neither is empty/success.
The shared read error now names the original source without inventing a Space
binding, with native EN/ZH copy; caller-local transport errors reuse the existing
Muse read-failure/retry helper. Actual shared-document, manager and inaccessible
notes GREEN states were viewed in EN/dark and ZH/light/compact, with exact
unrounded contrast. The fresh original unavailable-read protocol passes20
assertions; it overlaps, and is not added as a new semantic case to, the earlier
30-case/726-assertion protocol packet. Normal lint/six types/build and five actual
accepted native graphs pass again. Final exact-ID/viewer/cleanup reduction remains
the C2b handoff gate, not a claim that the broader product is finished.
Actual viewer review rejects the initially functional-only ZH update captures:
original schedule row/detail errors bypass localization, and real per-span status
text is below4.5 (paused3.260528410471992; running/active2.717892242550473).
The improved same paired selector reproduces these exact rendered RED conditions
at clean `7102f2b6`: `muse-ui-c2b/red-updates-1794790085628-63ab6f7f`.
Earlier execution labels remain immutable and are not visual passes. The next
repair is confined to Muse schedule row/detail presentation and native copy;
original ScheduleStore/error/permission/commit owners and off behavior stay fixed.
Muse schedule rows/details now render original errors through native copy and
use existing text tokens for actual status text. Matching ZH update17/shared9
and personal-on/Muse-off5 checks pass; current permission/source-proof images
were viewed. Normal source/native-input gates pass. The EN/dark dependency gate
then finds one additional real text defect in the same original detail:
Delete schedule is4.06677370182974 on its actual card, not4.5. Its current tiny
image was viewed and rejected (`green-updates-1794790256468-ced5f71e`); its
execution label is not a visual pass. This RED precedes the narrow detail fix.
The exact dark detail now measures5.09377131524453 and its current tiny image
is viewed; final EN update14, both-off/Personal-off genuine owned relaunch6 each,
current ZH connector28 and original code/grant/reload/keyboard22 checks pass.
The final compact-date boundary probe catches a separate exact form defect:
native174px date inputs overflow their150px labeled cells. Actual
`muse-ui-c2b/red-baseline-1794790865715-e2d48f2a` geometry and diagnostic pixels
are retained before correction; its overheight whole-form locator capture is
diagnostic, not accepted layout evidence. No owner/schema/execution fix is needed.
The native date overflow is now corrected with Muse-only `min-width:0` on the
existing paired fields, retaining the original two-column layout and desktop
geometry. Matching real compact boundary5 and affected placement35 checks pass;
the complete original-CSS date window is actually viewed with both calendar
controls inside their cells. Normal lint/build/six types and five actual accepted
native graphs pass. All production changes in C2b remain Linux/web presentation
or GET-only error classification; final exact-ID/viewer/cleanup manifests follow.
Viewer-accounting correction:25 early image-open responses explicitly withheld
their images. Earlier checkpoint wording that called those attempts reviewed is
withdrawn, not silently relabelled; `muse-ui-c2b-viewer-corrections.json` identifies
their exact paths/hashes. Only later actual image deliveries can accept cases.
Current actual ZH manager peer-conflict pixels also expose one missing native
Host-message translation; the exact paired seven-check RED is
`muse-ui-c2b/red-peer-copy-red-1794791307748-7b3d47a9`, before its dictionary fix.
The exact peer message now uses native ZH revision/recovery copy. Matching
seven-check GREEN and its actually delivered current image pass; normal
lint/build/six types and accepted native input/output graphs pass again.
Final accounting uses the corrected actual-delivery ledger, never the withheld
attempts or rejected functional-only captures, and retains exact original IDs.
UX-C2b closes exactly52 original IDs:51 pass/one source-proven System-initial-empty
N/A. Eight historical A passes are revalidation, not new coverage; new coverage
is43 passes/one N/A. The five earlier atomic passes enter the global ID overlay
only. Corrected actual viewer evidence is67 deliveries (59 accepted/seven
rejected/one diagnostic),1,250,220 encoded bytes;25 withheld attempts stay
explicitly unreviewed at those attempts. Global2149 IDs reduce to569 pass,
971 planned,597 blocked and12 N/A, not a visual score or all-Muse completion.
Complete evidence is `muse-ui-state-ux-c2b-results.json`; compact owner handoff is
`muse-ui-space-settings-handoff.json`. Original owners/atomic guard/epochs and
protected old310 Preview remain unchanged; no new native inputs, native compile,
storage-matrix, charts or V95 claim. C3 fileViewer/legacyFiles74 and D–I remain open.

## Muse Feed / Ideas packet FI

Double-gated Linux semantic objects and explicit generation reuse the original conversation/model/file/approval owners. Page reads never generate; sources are model-provided unless independently checked. Publication, saved content, model completion and owner Love/dismissal remain separate. No extra runtime, background inference, external image tracking, cloned news or fixture data in the user preview.

| ID | Actions | Required result |
| --- | --- | --- |
| FI-01 | Feed prompt read/edit/stale revision/restart | Real saved prompt, no inference or silent overwrite |
| FI-02 | Explicit generation, same-key replay/concurrency/missing model/lost response | One original Side/dispatch, Main unchanged, current intent and uncertainty inspectable |
| FI-03 | Typed approved publication/deny/block/temp/off, empty batch/dedup/URL/image binding | Real receipts, local owner choices retained, sources not self-certified, no scope widening |
| FI-04 | Failed/cancelled/incomplete/interrupted generation and restart | Existing conversation truth, no-update differs from no-publication/error, no automatic resubmit |
| FI-05 | Feed CRUD/Love/discussion/recovery through normal navigation | Persistent objects and protected contextual draft/background |
| FI-06 | Ideas generation/dismiss/restore/delegation/return | Real lifecycle, no generation on read or automatic task/goal creation |
| FI-07 | Related Main/Library/Goal/schedule/approval/pager packet | Preserve prior behavior and native/legacy gates |
| FI-08 | Both pages and contexts in locale/theme/size variants | Actual rendered viewer review and reference-derived public comparison, not whole-page V95 |
| FI-09 | Actual predecessor/current ordinary writes/second launch | Original data/auth preserved; new records/receipts survive without model replay |

Use the maintained workspace protocol, actual predecessor templates and isolated viewer evidence. Real-provider quality and unmatched/physical/native variants remain explicit gates.

## Muse Agent Identity / approval history packet IA

Double-gated Linux Agent metadata and actual SOUL/file context remain separate
from Workspace/MEMORY. Trusted approval receipts describe decisions, not model
claims, Allow-rule history or completed executions. Keep policy format2.

| ID | Actions | Required result |
| --- | --- | --- |
| IA-01 | Agent name/avatar owner reference/edit/move/conflict/restart | Workspace and MEMORY unchanged; original artifact ownership retained |
| IA-02 | SOUL missing/create/CAS/uncertain write/Main/Side/off context | No implicit file creation, real original-owner text and actual prompt effect |
| IA-03 | Typed Ask/deny/block/temporary/off | Same data and actual gate, no implicit private access |
| IA-04 | Approve/Always/policy allow/deny/cancel/block and old rules | Trusted minimal decision receipts, no secret args or retroactive history |
| IA-05 | Failed/corrupt/full audit storage and restart | No success-shaped execution grant or empty replacement, existing policy retained |
| IA-06 | Agent tabs/edit/SOUL/avatar/history details/recovery/peer updates | Rendered protected forms and accurate decision meaning |
| IA-07 | Locale/theme/size/reference and dependent workspace packets | Actual viewer review and bounded public comparison, not whole V95 |
| IA-08 | Actual predecessor/current normal writes/second launch | Original data/auth/policies and new receipts preserved |

Reuse the maintained workspace protocol, prior storage templates and original
file/prompt/approval paths. Do not substitute external accounts, copied avatars
or fixture/user data for actual acceptance.

Bounded IA implementation is GREEN on b055a3cd: five IA owner cases/143
assertions; the 14-case Muse owner packet/470 plus prerequisite-aware
workspace11/509, service10/169 and Browser8/177 pass (43 selected cases/1,325
assertions, not the full product suite). The committed actual UI packet passes
12 workflows/132 explicit checks, 32 settled EN/ZH×theme×size captures and all
seven dependent UI modes. It checks real Main/Side prompt facts, original
avatar/SOUL/MEMORY, stale/unknown recovery, actual approval and sandboxed-page
receipts, readonly peer refresh and visible continuation failures.

IA-08 passes with the immutable actual145fd109 snapshot, ordinary current
writes/decisions and a second launch; original stopped encoded device records,
data and format2 policy fields are preserved. Private source-stamped evidence:
`agent-result.json`, four Agent contact sheets, `agent-reference-geometry.json`
and `muse-agent-compat/result.json`. Seven measured public regions are within
2 CSS px; this is not image-level95% or formal whole-product V95 (still0).

Not-run limits: selectively unwritable audit I/O cannot be safely isolated from
conversation SQLite in this lane; full/corrupt/no-reset failures are exercised.
Native/physical/downgrade, real-provider/persona quality and24-hour operation
are not certified. No native/shared-core source changed; the 751-input native
bundle bytes remain identical. The protected145fd109 preview was not upgraded.

## Muse chat / Agent attention packet NT

Keep the version1 `ox.notifications` owner, original Main/Side conversations,
conversation-read owner and Push delivery semantics. No standalone Muse Inbox,
new bell, notice store or inferred conversation ownership.

| ID | Actions | Required result |
| --- | --- | --- |
| NT-01 | Counts/target metadata, malformed and mismatched reads, either gate off | Canonical same-Host safe-integer targets only; counts omit titles/bodies; atomic owner validation |
| NT-02 | Foreground chat refresh, hidden/offline/unfocused, held render and newer notice | Snapshot IDs before fresh view; read only after the same eligible chat actually renders; unseen notices remain |
| NT-03 | Two clients/SSE, repeat/restart/revoke and lost read response | Shared idempotent readAt; no hidden mutation replay; exact notice-ID popup cleanup |
| NT-04 | Agent Activity, old unlinked Todo/watch, detail/source deletion and failures | Real record detail and delivery/unknown/cancelled states; explicit recovery; no recreated sources |
| NT-05 | Old Inbox deep links, Main/Side drafts/attachments, Settings and workbench return | Muse compatibility through Agent/detail, legacy off unchanged; original controller and unsent context retained |
| NT-06 | EN/ZH × light/dark × desktop/compact and dependent UI packets | Settled rendered viewer review, usable focus/controls; not physical Push or whole-product V95 |
| NT-07 | Immutable actual predecessor, ordinary notice/read operations, second launch | Original data, stopped encoded authorization and delivery semantics preserved without replay |

Bounded NT source is GREEN at `1c9faec9`, after actual protocol/rendered RED
and local checkpoint `4ad37752`. Three maintained NT cases plus the original
PN read case pass the focused4-case/100-assertion packet. The final
dependency-aware selection passes35 cases/1,001 assertions across Muse,
personal notifications, Push and original Host boundaries; this is not the
full product suite.

The committed real-browser attention packet passes14 workflows/87 explicit
checks and43 captures, including actual hidden-mid-render and genuinely
visible-unfocused windows, offline/reconnect, late snapshots, read uncertainty,
two paired clients/SSE/restart/revocation, old unlinked/deleted sources and
preserved drafts/attachments/workbench DOM. All eight existing browser modes
also pass. Eight EN/ZH×theme×size variants include Activity/detail/chat; all
43 full-frame captures were reviewed through unmasked contact sheets.

NT-07 passes the immutable actual145fd109 snapshot, ordinary old/new notice
reads and reminder writes, and a second normal launch. Original stopped
encoded device records, policy bytes, old data and delivery/read values remain
intact. Lint/six TypeScript projects and the normal build pass; all five native
bundle input graphs/hashes are unchanged, so no native build exception is used.
Private evidence: `muse-attention-ui/result.json`, its viewer manifest,
`muse-attention-compat/result.json` and source-review/native-boundary reports.

Browser service-worker popup checks are not physical Push certification.
Native/device, external provider/source, downgrade,24-hour and formal whole
V95 remain unclaimed (V95=0). The protected145fd109 preview was not upgraded;
its read-only health check remains OK. No next independent feature was started.

## Muse Secure store packet SS (V2 contract)

SS is the double-gated Linux/web website Passwords slice, not a rename of the
generic Secrets editor. Its only credential owner is the original `Secrets`
in `vm/state/secrets.json`, version1. No native format, provider, Browser
authorization, model secret-read tool or second credential database is added.
Values remain plaintext JSON protected by the existing private directory,
0600 atomic-file writer and model-output isolation; this is not encryption
or Keychain certification.

| HTTP boundary | Concrete contract |
| --- | --- |
| `GET /api/passwords` | Paired owner, both gates; `{available:true,passwords:[{id,revision,site,connectedServices}]}`. `site` is only the normalized HTTP(S) origin, never a private path, username or password. Reads do not create objects. |
| `POST /api/passwords` | `{id,requestId,url,username,password}`; safe lowercase UUID object/request identities;201 only after original-owner commit. Key is `password.<id>`, type is `account`, with no implicit service binding. |
| `PATCH /api/passwords/<id>` | `{requestId,expectedRevision,confirm:true,url?,username?,password?}`. Empty/omitted fields retain original values. Explicit replacement confirmation and CAS are checked inside the original serial/atomic writer. |
| `DELETE /api/passwords/<id>` | `{requestId,expectedRevision,confirm:true}`; confirmed CAS deletion removes original bindings and retains request receipts. Cancel sends no mutation. |
| `GET /api/passwords/requests/<requestId>` | Read-only original-owner proof queued behind pending writes. `{outcome,receipt,password}`; outcome is `committed`, `superseded`, `deleted` or `unconfirmed`. Absence is not rollback proof. |
| Receipt replay | Matching object/action/base revision returns the original receipt and current proof without another write, including after edit/deletion. Every mutation reply explicitly declares `replayed` and `inputApplied`; a replay has `inputApplied:false` and is not proof that newly supplied fields were saved. Fresh writes alone have `inputApplied:true`. Reuse for another identity/action/base revision conflicts. Deleted object IDs cannot be recreated. No input hash, secret or raw form intent is in receipts, logs, SSE or responses. |
| Refusal |400 fixed validation/confirmation errors;401 unpaired;403 foreign/opaque origin;404 either gate off/absent object;409 stale/reused identity;413 request size;507 full owner;503 invalid/unavailable/externally changed storage or failed atomic write. Unknown transport outcome never automatically replays a mutation. |

Optional persisted metadata is `entry.website:{id,revision}` and
`websiteRequests:[{requestId,id,operation,expectedRevision,revision}]` in the
same version1 file. Full URL, username and password exist only in `entry.value`;
website display names are safe origins. Original generic/typed/API writers
preserve the URL and advance affected website revisions, including binding
changes, inside the same serialized update. Old entries/bindings and off-mode
legacy load semantics remain unchanged; disabling retains optional metadata.

New request limit is8KiB; URL2048 UTF-8 bytes, origin256, username512,
password4096; URL credentials, non-HTTP(S), whitespace/control characters,
all query strings and fragments are refused without echo. Owner limits are
500 website objects,2,000 total entries,5,000 retained request receipts and
40MiB encoded file; no pruning or empty fallback. Existing flat secret values
retain the original16KiB bound. Gated invalid/future/oversized files are retained
and isolate Secrets rather than preventing the normal workspace from opening.
Explicit read retry may recover a repaired unavailable file; a live external
state change requires normal Host restart rather than overwriting another writer.

| ID | Setup → actions | Required owner / rendered result and dependencies |
| --- | --- | --- |
| SS-01 | Real original generic/API credentials → website add, metadata/model reads, edit, restart and confirmed delete | One original owner; typed/API bindings preserved; no values in browser list/model/logs/audit/SSE; saving starts no model or site execution. Original typed/API/permissions cases are prerequisites for their shared packet. |
| SS-02 | Invalid/oversized/credential-bearing URL, empty input, confirmation refusal, unpaired/foreign/opaque origin and single/off gates; corrupt/future/full file and actual private-directory I/O denial | Fixed actionable refusal before write; old bytes survive, no success-shaped empty list, no hidden dispatch. Actual I/O injection is distinguished from mocked HTTP unavailable states. |
| SS-03 | Two clients, stale generic/typed/API edits, repeated IDs, committed lost response, deletion then late replay | Serial CAS and durable receipt proof prevent overwrite/duplication/resurrection; unknown is separate from saved and absence is not rollback. |
| SS-04 | Paired normal Settings entry → Passwords/Add, URL/Username/Password, show only entered text, cancel/save/edit/replace/delete confirmation, validation/retry, unavailable/retry, peer conflict, lost commit proof, tab/close/late response | Actual rendered state/focus and original records agree. Active forms/action errors survive SSE; leaving clears inputs and late responses cannot replace another page or emit an obsolete Saved toast. Advanced generic/API entry remains available. |
| SS-05 | UI09/29 dark EN800×600/224px navigation; supported light/ZH/compact; actual310eb664 writer → current ordinary writes → second launch | Reference-observed geometry/state reviewed; private/redacted rows and unobserved edit/delete/error variants are reference-blocked. Original secrets/API bindings, files/conversations/goals/discovery/identity/notices/settings and stopped encoded authorization survive. |

Page states are loading, empty/populated Passwords, add/edit, pending,
validation/write failure, stale conflict, unknown submission/read verification,
owner unavailable/retry and advanced compatibility. No stored secret value is
read into an editor; blank edit controls explicitly keep saved fields.
The UI never labels a mutation replay as a fresh save: it requires the
explicit applied-input acknowledgment or performs separate read-only proof.
Replay intentionally ignores new fields rather than adding a password-guess
oracle, value digest or retained historical credential copy.
Unresolved UI recovery retains only the bounded object/request UUIDs,
operation and base revision in origin/Host/Profile-scoped sessionStorage.
Same-tab reload restores the read-verification action, not a credential draft
or mutation replay. Values never enter that record; known refusal or verified
proof clears it. Disabling Muse neither initializes nor replays this metadata.
Reference coverage is UI09 Passwords header/intro/Add and UI29 three-row form,
show-entered control and Cancel/Add. Freeze component bounds before comparison;
DOM presence/background pixels are not formal95%. Until legitimate per-state
foreground comparison runs, formal V95 is0.

SS Linux/web source is verified through `b2bca233`, with reachable main RED
checkpoints `54d3aa38` (owner), `062be426` (live read failure), `9f15ea7b`
(applied-input versus replay) and `bb70ca56` (rendered reload recovery).
The exact4-case owner packet passes274 assertions; the dependency-aware
typed/API/page/permission/Main/Identity/audit selection passes17 cases/1,371.
Lint/six TypeScript projects and normal build pass; all five native bundle
input/output hashes and native project/lock inputs are unchanged.

Clean-source paired rendered SS passes11 workflows/200 explicit checks and
42 source-stamped captures. All42 were directly reviewed through six unmasked
contact sheets and critical full frames. The actual UI29 password-column,
Cancel/Add-height and empty-Add defects were reproduced and corrected.
Frozen public card/three-input geometry differs by at most1 CSS pixel, not
formal95%. Original Settings/off/Main-Side rendered packets also pass.

SS-05 passes the actual normal-packaged clean310eb664 writer, its immutable
before snapshot, current website/generic/API/file and ordinary-off writes,
and a second current launch:303 checks,3 original Secret entries/1 binding
and3 complete stopped device records. Older populated Feed/Ideas/choices/image
data came from the retained immutable FI fixture;310eb664 itself wrote the
typed/API/Goal/identity/prompt data used for the credential upgrade baseline.
No current serializer or live lastSeen cache substitutes for that evidence.

Private evidence is in session `files/muse-secure-store-ui`,
`muse-secure-store-dependent`, `muse-secure-store-compat` and
`muse-secure-store-handoff.json`. Actual failures cover live/private-file read
denial, directory write denial, corrupt/future files and full500/5,000 bounds.
ENOSPC, failed rename/power loss, native/physical, encryption/Keychain, real
account/model, full-resource and formal V95 remain unrun/unclaimed (V95=0).
The installed310eb664 preview/data/auth/origin were not modified or promoted;
the parent Muse program continues with Data controls/Connectors/Permissions.

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

FI controlled owner/UI/storage subsets pass through the current source candidate:7 protocol cases242 assertions, actual5-call paired Feed/Ideas publication/discussion/lifecycle/uncertainty/recovery,16 appearance states and reference-derived public geometry≤2px. Source prompt revision/action-error races were reproduced and fixed. Actual145fd109/current ordinary owner writes/image moves/second launch preserves old data/auth and repeats no model work. Existing MS/GO/MT/LS/off browser packets, lint/types/build pass. These are not independent source/model/personalization, native/physical/24-hour or whole-productV95 certification.

LS-01–08 controlled source subsets now pass:2 owner/tool cases109 assertions, real Library CRUD/classification/pagination/search/recovery/viewer/selection and8 appearance states, plus approved contextual execute generation with preserved Main draft/attachment, retained Space DOM and correctly scoped Goal refresh. Existing MS/GO/MT/off browser packets pass; actual145fd109 snapshot/current writes/second launch retains original objects and stopped authorization. Public UI22 geometry is within2 CSS px, not formal V95. The owner explicitly waived the current change's iOS build gate because normal ignored configuration is missing; macOS/lint/types/portable builds pass, iOS/native/physical/real-provider acceptance is not claimed. Private-data Space permissions/scheduled display and full Muse scope remain open.

MS/MT first UI slices are implemented through `6227a322`, not full Muse parity. Final clean-source paired-browser packets pass actual Main/Side/drafts/attachments/search, Agent keyboard/memory/schedule/SSE/read failure/retry, startup Main lookup/no-model, and Settings ordered11 sections/800x600/224px/preferences/true reload/advanced Back/device detail/read recovery/legal boundaries. Real off-gate UI and an older-capability response are distinguished. Sixteen locale/theme/size appearance captures and the combined review sheet were viewed; actual keyboard/header bugs have RED/GREEN fixes. Private source-stamped JSON evidence lives in session `files/muse-workspace-ui`. Other primary destinations and deep capabilities, peer-delete/offline/uncertain-send rendered variants, full V95, native/physical/real-provider/24-hour and installed promotion are not closed.

MU-01–05 foundation at `d3ba05c0`: two public-Host cases pass 57 assertions after executed RED; related legacy packet passes 8 cases / 241 assertions with the restart fixture's prerequisite selected. MU-06 has an actual clean `145fd109` packaged writer, changed normal startup/edits and stable second launch, with private before/after snapshots; scoped Linux conversation-role compatibility only. That foundation did not execute MU-07–08; subsequent rendered subsets are recorded separately above and do not close full V95. No real provider, native/physical, 24-hour or installed-upgrade result follows from the foundation.

UP-01/07 local integration evidence includes124 passing repository cases, both native builds, the real Linux and native1.3-to1.5 before/after/restart matrices,83 exact Native contracts, pinned offline HTML extraction parity,14 actual-Safari archive groups, the full76-state web inventory and a normal iPhone Simulator Safari pairing/send/revoke run. Native capture/field tests use settled layouts and real-duration touches; known WebDriver input and OCR-observer failures are tooling failures, not accepted application outcomes. Linux live-page guidance explicitly excludes Native automatic Done/Cancel follow-up behavior. Real accounts/models, physical radios/cellular, configured WAN/private-CA native entry and dirty-repository migration variants remain unexecuted in this packet; preserved source, portable checks and loopback fixtures do not imply those passes.

For PA-14, the inventory includes console list/Host/device/QR/revoke/authorization states; workspace first use, empty and populated conversation, Files, Schedules; Settings General, Host and connections, Models, Workspace, Devices and security, About, Permissions, Services, Repositories and Secrets; Workspace Memory/Skills and available item detail/overlay states. Record unavailable tools/providers as unavailable, not accepted functionality. Native app screens and the separate marketing website are outside this web-Host inventory.

Keep per-run case IDs and pass/fail/blocked/not-run results with source/build/device identities in private evidence. The current native Safari clipping repair and real `ox-1` iOS 26.2 pairing are recorded in `plans/linux-host.md`. Network-fault and cancellation/revocation results must be added after execution; real off-LAN/cellular and physical-radio coverage stay open until actually tested.

Maintained pairing files live in `.agents/skills/test/protocol/client-host/pairing/`: `authorization.test.ts` and `workspace-entry.test.ts` run in the existing protocol suite, `archive.ts` is the explicit packaged-runtime/UI packet, `connection-browser.ts` covers CN-04/05 transport-fault/retry UI and `native-safari.ts` adds actual Mac Safari when `--safari-driver` is supplied. `--workspace-pages` runs `workspace-pages.ts` and expands native checks to direct entry/reuse and readable skill/notification/release sheets. The old `apps/linux/scripts/mac-host-package-check.ts` command forwards to the canonical runner. Native iPhone HID screenshots and bounded manual/OCR exploratory runs remain private evidence, not portable CI or a second maintained implementation.

`--host-lifecycle` exercises the actual packaged Open Console entry without Host work and runs `lifecycle-browser.ts` against Chrome desktop and actual WebKit phone-touch. It covers controlled start/stop/cancel, occupied-port recovery, uncertain replies, offline revocation and valid-client cookie/history/draft/file survival; an authorized `--safari-driver` adds actual Mac Safari lifecycle buttons. The November 12 local packet passed 14 groups plus 121 repository cases; owner runtime publication/upgrade is a separate reviewed action.

The November 11 native iPhone packet exercised PA-03, cancelled/confirmed PA-07, CN-01, delayed CN-03, CN-06 and cold CN-02 with a controlled trusted fixture gateway. A stopped fixture endpoint supplies only an unavailable-route equivalent for CN-08. PA-01/06/09 and revoke/session refusal also have portable protocol coverage. The browser packet covers before-send loss, lost committed replies, cancel/confirm of a repeat and navigation during that confirmation. Real Internet-only outages, configured WAN access and physical radio/carrier changes remain blocked environment cases, not passed by the proxy or browser packet.

DP-05 narrow Chinese-copy RED on clean `06067020` (2026-11-14): private `bun muse-workspace-ui.ts --direct-protocols --zh-copy-red --headed` used the normal paired Host, zh-Hans/dark, 1285×736 CSS/DPR2 and actual database-description Range rectangles. The 399px description ended in two lines (46/2 non-space glyphs), the last `口。`; the rendered no-orphan assertion correctly exited 1 before any production edit. A temporary actual-element fit probe measured `PostgreSQL、MySQL、MongoDB、Redis、SQL Server 标准端口。` on one 370.055px line, then restored the original before capture/assertion. Exact proof: session `files/muse-direct-protocols-ui/zh-copy-red-1794704750448-b8531f50/zh-copy-result.json`. Zero model/provider calls; only the new owned Host/browser/cache were cleaned. This checkpoints the copy defect, not new runtime/package or V95 acceptance.

DP-05 narrow Chinese-copy GREEN: after RED checkpoint `7e3cfc0f`, only the Chinese `dpDatabaseBody` changed to the measured standard-port copy. Private `bun muse-workspace-ui.ts --direct-protocols --zh-copy --working-tree --headed` passed against that actual source: one 45-glyph line, 370.055/399px, no orphan or horizontal overflow. Proof: session `files/muse-direct-protocols-ui/zh-copy-green-1794704814834-ecf8f34e/zh-copy-result.json`; the complete native 750×36 after-crop was actually viewed, losslessly re-encoded to 6,748 encoded bytes (cumulative viewer payload 1,558,160 bytes, below 1.5MiB). Existing localization validation passed 3 catalogs/1,405 entries; `node node_modules/typescript/bin/tsc -p apps/linux/tsconfig.json --noEmit --incremental false` passed. Zero model/provider calls; exact new owned Host/browser/cache cleaned. Backend/native inputs remain unchanged. The earlier 39-check UI captures and 592-check packaged-upgrade proof retain their `9effe1d2` source/package identity; neither broad suite was rerun, no newer package was produced, and no promotion/full-V95 claim follows.

## UX-B2 Search / Agent state packet (V2 execution contract)

The immutable UI inventory supplies exactly89 declarations (82 `muse.ts`,
7 `search.ts`); B1R groups `B2-ATTENTION` and `B2-SEARCH` add exactly4.
Private `muse-ui-b2-caseplan.json` records every original ID, current caller,
owner, condition and fixture before production UI edits. Source declarations,
executed states and unique viewer-reviewed rasters are separate measures.

| Workflow | Actual boundary and required states |
| --- | --- |
| B2-RAIL | Original four-item More menu, shortcuts/support explanation, keyboard/close/current focus, compact/scroll and real pin-read retry; no external support submission |
| B2-ACTIVITY | Real schedules/watches/notices; loading, empty, warning, read failure/retry, tabs/late results and original detail callers; no standalone Inbox |
| B2-IDENTITY | Original name/avatar/public-image owner; validation/upload, pending, confirmed/verified/unknown save, peer CAS, protected discard/reload and real focus/scroll |
| B2-SOUL | Missing/empty/unreadable original SOUL, readonly/Edit, original hash/CAS, pending/conflict/unknown/read-only verification, nested close/reload; MEMORY stays independent |
| B2-HISTORY | Actual trusted approval/PageCalls decisions, original empty/loading/failure/continuation, safe detail fields/meaning, real chat/page/deleted context, close/nested shortcuts and peer focus |
| B2-SEARCH | Original recents/fulltext/files/exclusions/cursors/epoch; loading/empty/partial/failure/retry, exact anchors/Back/Latest, keyboard/focus/close/reopen/late/context preservation |
| B2-ATTENTION | Original notice UUIDs/readAt/counts and eligible painted chat; snapshot failure, uncertain read, explicit readonly check/retry and no automatic uncertain mutation replay |

Use the existing private paired gym harness and maintained workspace/services/
browser/web protocol runners, not another suite. Genuine defects require actual
rendered RED, immediate main checkpoint, minimal double-gated Linux/web fix and
matching GREEN. Review selected original screenshots at readable CSS scale in
EN System/dark1285x736 DPR2 and ZH/light390/coarse/reduced-motion, with relevant
long-copy/scroll/keyboard variants; text4.5 and nontext3 thresholds are unrounded.
Keep Muse geometry, prior source-specific evidence and all original owners.
Record exact N/A/routing/resource blockers rather than inventing variants.
Final gates are affected protocol/caller/off checks, normal lint/build/types,
LOC/tree/callpath/complexity/performance review and five actual unchanged native
input/output graphs for Linux-only changes. Changed native inputs require both
native target builds; the missing normal iOS configuration is not waived.
Storage/owner/encoding/execution changes require the ordinary predecessor/write/
relaunch matrix. Installed Preview310eb664/PID45320 and user data remain untouched.
Formal V95 and chart acceptance remain0; other finite packets remain open.

The source-traced B2 follow-up freezes private
`muse-ui-b2-page-change-addendum.json` before further UI edits: current Search
opener/continuation/ARIA focus, explicit identity/SOUL progress and empty-file
semantics, notice readonly-check progress/focus, original searched-chat title,
and Search-file source invalidation/explicit same-query recovery. Only these
Linux/web call paths and Muse-scoped tokens/critical touch targets may change.
Original callbacks, refs, CAS, notice eligibility/read receipts and owners stay
authoritative; ordinary/off and native inputs must remain unchanged.

UX-B2 now resolves the exact89+4 source declarations through reviewed original
owner workflows. Private `muse-ui-state-ux-b2-results.json` separates93 covered
source obligations from113 reviewed execution records/109 unique original
rasters; static variants overlap. Source runtime is`6d499b2e`; earlier captures
keep their real revisions and only changed editor-feedback/Host-copy states
were replaced. A genuinely visible below-fold warning supplements its first
capture; withheld opens are excluded. Both original off modes pass.
The maintained owner/dependent31 cases/1,899 assertions, normal lint/build/six
TS projects and five actual unchanged native input/output graphs pass.
No native compilation, old Library waiver, storage-upgrade or whole-product
acceptance is claimed. Original68 routed B1R obligations retain their C/E/F/G/H/I
owners; other packets, first-run UX-E disclaimer, charts and formal V95 remain open.

## Muse file viewers and compatibility Files packet UX-C3

UX-C3 freezes the immutable35 `file-viewer.ts` and five `app.ts#renderFiles`
UX-C rows plus the34 original B1R `C-FILES` routed IDs, a disjoint74-ID set.
The private frozen page-change/V2 plan maps original callers and owner conditions
before UI edits. Review original read/loading/missing/failure/retry, viewer
close/scroll/focus, named Markdown discard and CAS-save failure, Search public
source wrappers, compatibility menus/folders/uploads and conditional off deletion.
Every accepted row needs its exact executed condition and actually delivered
original-scale screenshot; unchanged primitive association is insufficient.
Muse compatibility Files remains failclosed for path deletion; canonical Library
checked deletion is unchanged. No charts, D–I, native compilation, storage-upgrade
or formal V95 acceptance is implied. Unexecuted rows retain exact finite IDs.

Paired RED at `6eb07b6b` reproduces blank viewer/list reads, retained stale
Markdown after an original-owner move, a raw failed-fetch list without retry,
unnamed dirty-file discard, and editable/closable in-flight Markdown saves.
The12-check original-flow packet records seven failures; three corresponding
original-scale images were actually delivered and reviewed. No UI source was
changed before this RED checkpoint; one earlier incomplete driver run used the
wrong expected folder-create status and is not acceptance evidence.

The next bounded20-check viewer RED also renders actual900px scroll painting
Markdown beneath the filename/actions bar. Original nested code, CAS409 and
read-failure states were delivered separately; this scroll failure is preserved
before the Muse-only viewport-inset correction. No chart renderer is involved.

Exact original menu/upload RED now records missing source/parent/overwrite
scope, lost upload-opener focus, enabled in-flight upload controls and continued
selected writes after a committed reply was lost. The original Files read-error
text measures4.06677370182974:1, not4.5:1. These caller-specific failures are
retained before their bounded Muse-only copy/busy/recovery/contrast correction.

Critical Chinese/light390 RED measures original Files header controls40px,
Library navigation39×16px, unnamed compact icon buttons and metadata text
2.9644760775970473:1. Measuring disabled text too exposes held-save status at
1.7144947732909235:1. The menu's earlier42.68px sample was its transient0.97
opening transform, not a persistent target-size defect; settled items are44px.
These are scoped Files/viewer corrections, not a shared palette/menu redesign.

The affected original C2b source/grant dependency caught an introduced
regression: broadcasting Library notifications as global `ox-files` replaced a
managed Space frame before its explicit reload. Actual new-code pixels and the
failed original frame/contentWindow check are retained. The correction must
subscribe only original file viewers to the existing readonly source signal,
not widen Library events to all embedded/managed Space callers.

The final exact-caller edge packet proves real replaced-row focus recovery,
then catches two save-failure dismissal paths losing their disabled Save opener
and a public preview filename at4.313625571897182:1. Fixes stay local to the
original viewer's settled failure focus and Muse file-card name token.

Validated bounded C3 closure accepts66 of the exact74 original IDs, proves one
Files-selection/search state inapplicable from its original/current source,
and retains seven exact IDs: five legacy-off destructive states with genuine
contrast/focus failures, original long save-error scroll, and the complete Files
missing/private/denied matrix. Actual original root/nested empty, normal
read/edit/CAS/download/overwrite/unknown, PageCalls and replaced-node callers
are reviewed; protected MEMORY is never erased to manufacture empty.
The maintained32-case/877-assertion protocol packet, normal lint/build/six TS
projects and five actual accepted782c/c176 native graphs pass. Native compilation,
storage upgrade reruns, charts and V95 are not claimed. Full source, actual
accepted/rejected/historical image accounting and finite IDs belong to private
`muse-ui-state-ux-c3-results.json` and `muse-ui-file-viewers-handoff.json`.

UX-C3R plans only the seven remaining original IDs in three workflows before
further source edits: the five `app.fileMenu` legacy-off Delete obligations,
the original `file-save-failed` long-body/scroll state, and the original Files
missing/private/denied matrix. Reuse the exact off-caller contrast/focus RED
only after unchanged-source comparison. Scope its correction to that caller's
dialog colors and real opener/surviving-control focus, preserving path deletion
and authorization. Muse never dispatches that legacy DELETE. Exercise the
original save route with a transparent owned filesystem fault, real long owner
error, nonzero modal scroll, keyboard return and retained draft. Exercise the
original list owner with new-owned-profile synthetic excluded markers, missing
paths, actual denied filesystem access and transport failure, never fake empty
responses or real private data. Any presentation correction remains double-gated.
Record exact runtime/source/hash/viewer evidence separately; retain C3's66 pass,
one source N/A and all prior atomic/native/storage provenance unchanged.

The C3R original list404 RED renders generic transport-failure copy for a genuinely
absent folder. Its actual original-scale image was delivered before correction.
An initial fixture wrongly treated public `files/state` and `files/vm` namespaces
as private; that diagnostic is not a product privacy failure. Corrected access
fixtures use reserved `payloads/staging/repositories` and a synthetic marker
outside the public tree in the new Profile's own state directory.
The original save-failure caller already handles a genuine849-character disk
EACCES body: at Chinese/light390×520 its actual modal scroll reaches147px and
retains draft/Save focus with one rejected write; no save UI fix is presumed.

C3R's actual ordinary/personal-only Delete now passes the exact original
confirmation, cancel/Escape/backdrop, owner/hash/peer, single-call and return-focus
conditions; its optional ask opener/ID leaves every other caller unchanged.
Normal lint/build/six types,32 maintained protocol cases/877 assertions and five
actual native graphs pass. The compact original Files error recovery controls
still measure62×36px; this rendered RED precedes their scoped44px coarse fix.
Unrelated old off Upload/metadata contrast probes are diagnostics, not accepted
screenshots or permission to change the off palette.

The scoped Muse Files recovery actions now measure at least44px, with the
complete original missing/private/denied/empty/failed and Library-navigation
matrix GREEN. Actual original legacy row focus returned correctly in the DOM
but remained visually unmarked after native modal dismissal; a new22-check RED
records that exact missing outline. Its correction is limited to this legacy
Delete opener, not a global off palette or menu-focus change.

Exact C3R closure accepts the seven remaining original IDs in those three
workflows. The original off Delete opener now has a real visible2px outline
after dismissal (actual dark8.06457762680618/light4.61171071798562 nontext ratios);
its cancel/confirm/path-delete ownership and the Muse checked-only boundary
remain unchanged. Real849-character save errors retain the exact draft and
original bytes, with actual147px compact modal scroll. Original list404,
reserved/private exclusion, real EACCES/symlink denial, transport failure,
owner200 empty recovery and readonly Files/Library navigation stay distinct.
The prior66 passes and one source N/A remain preserved, giving73 pass/one N/A
for C3's original74 IDs, not a new whole-product claim. Fresh image deliveries
are accounted separately from case passes; partial/invisible focus proofs and
pre-fix36px recovery controls are not accepted. Normal lint/build/six types,
maintained32-case/877-assertion protocols and five actual unchanged native
input/output graphs pass. No native compile, storage matrix rerun, charts or
V95 is claimed. New private authorities are `muse-ui-state-ux-c3r-results.json`
and `muse-ui-file-finish-handoff.json`; original C3/atomic evidence is immutable.

## Muse workbench state packet UX-C1

The immutable inventory contains **104**, not108, exact C1 obligations:
Discovery51 + Goals46 + `app.renderWorkbench`4 + routed C-CONTEXT3.
It contains five `renderFiles` records, not one. Those stay in C3; do not
relabel four Files records as workbench passes. The disjoint C partition is
**C1 104 / C2 176 / C3 74 =354**. C2 retains eight historical foundation passes.

Before production changes, private `muse-ui-c1-caseplan.json` records every
literal ID, original owner/caller/condition and targeted V2 workflow. The
refresh and visually discovered reload-title addenda precede their fixes.

| Workflow | Actual boundary and required outcome |
| --- | --- |
| C1-GOALS | Original Goal/Todo IDs, creation key and revision CAS; visible pending/validation/confirmed/unknown, protected drafts and explicit readonly reload; named noncascading deletion, missing versus zero links, manual completion, peer/scroll/menu/focus/route/epoch lifetime |
| C1-DISCOVERY | Original prompt CAS, generation UUID/Side/submission/publish receipt; no-model, noUpdate/incomplete/failed/stopped/unknown/unavailable remain distinct; explicit new-intent confirmation, no late navigation or uncertain replay; actual publication, source/image identity, Love/hide/restore and exact cursor freshness |
| C1-CONTEXT | Original Library/Space/Goal/Feed/Ideas workbench and local conversation; real approved file/Space creation and explicitly sent discussion, retained live frame, Main/Side/context drafts/files and return/reload; original upload/send guards and missing/invalid-source recovery |
| C1-VARIANTS | Real EN System/dark1285×736 DPR2, ZH/light390/coarse/reduced motion, critical light/dark native Chromium pixels, keyboard/current focus, long copy/nonzero scroll and44px touch; both original off modes |

Bounded result: **101 pass +3 source-proved N/A**. Only the auto-generated
long-scroll variants of the three bounded static-label menus are N/A; their
actual open/keyboard/compact/current-caller states were exercised and viewed.
This is not acceptance of C2 editors or C3 Files by shared primitive association.

Runtime `9048bbe7` finishes actual screenshot-discovered Goal/Feed prompt
reload titles naming a saved task. Two historical failed records remain failed;
four corrected EN/ZH originals were actually viewed. The comprehensive
source-labelled `6ab741e2` campaign passes78 workflows/1,032 checks/148 owned
loopback model calls; the exact title-only correction adds four workflows/
54 checks/zero calls. Other applicable captures keep their original source labels.
The viewer separates135 reviewed executions,133 accepted executions and127 unique
reviewed original rasters (125 accepted); none is a unique semantic-state count.
Two inadequate creation crops were explicitly rejected and supplemented by
actual full original context images. Source PNGs remain; lossless true-color
delivery was pixel-verified before review, never used to bypass withheld images.

The existing27 maintained workspace/services/browser/web cases/1,209 assertions,
normal lint/build, six TS projects and five actual unchanged native input/output
graphs pass at the runtime. No native compilation, old Library waiver or storage
matrix rerun is claimed: persisted owners/schema/encoding/authority are unchanged.
Private `muse-ui-state-ux-c1-results.json` and `muse-ui-workbenches-handoff.json`
contain exact IDs, per-condition evidence/source applicability, immutable packages
and301 owned-run cleanup records. C1 removed235 unselected rasters and exact owned
caches while retaining selected RED/GREEN/reviewed images and all previous evidence.
Raw server-internal preparing is not separately screenshot-accepted; actual local
unacknowledged dispatch is distinct. C2/C3/D/E/F/G/H/I, the unaccepted UX-E first-run
disclaimer and unfinished features remain. Formal V95/chart acceptance stay0.
Installed Preview310eb664/PID45320 and its data/configuration were not touched.
