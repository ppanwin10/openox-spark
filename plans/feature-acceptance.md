# Feature acceptance

Owner requested a reusable feature-to-case map on November 11, 2026. A changed feature must name the affected case IDs, run the matching bounded packet and record actual results before handoff. Passing source checks does not prove a rendered user outcome. Use the existing protocol, storage-compatibility and eval suites; do not create a fourth general test suite.

## Change gate

Identify affected features from behavior and shared dependencies, not just filenames. Before editing, add missing cases with setup, user actions, expected visible states and authorization/data invariants. After editing, run the smallest affected packet plus required source gates. Record build, client, network/fault method, case outcomes, screenshots and cleanup outside Git. Mark unexecuted or simulated conditions explicitly; a mobile viewport is not a Simulator, a Simulator is not a physical phone, and an unavailable endpoint is not proof of disabled radios or a real cellular route.

Changes to shared authentication, transport, storage or UI helpers also run their dependent feature cases. Failures introduced by the change block delivery; an unavailable required environment must be reported, not silently counted as a pass. Never modify a shared machine's networking, real credentials or other people's work to inject failures. No automated retry of an uncertain mutation.

## Feature map

Browser-core workflows V2 use the accepted browser-only scope: Main/Side,
Search, Library/Spaces, Goals/tasks, Feed/Ideas, Agent, supported connectors
and essential Settings. This is a bounded current-source E2E packet, not
the historical all-state denominator or a visual/readiness pass.

Pre-edit setup: clean `main@26cc69fa`; empty task-owned loopback Host,
normal invitation/code pairing and ordinary browser cookies. Remove
inherited provider credentials before importing Host code. Start with no
model, then explicitly select only an owned CPU-scripted streaming endpoint.
Seed through original APIs/tools/stores, never response/DOM substitutes.
An actual tool receipt, file read or owner status must support every result.
Keep fixture-model evidence distinct from pending approved real inference.

| Case | Setup and user actions | Required visible result and owner/data invariants |
| --- | --- | --- |
| BV1-01 / MS-01/02 | Unpaired browser → invalid then valid owned invitation → no-model Main → original Models setup → select owned scripted model → reload | Admission remains required; selected Host/Workspace and selected model are truthful; no saved address is labelled reachable and no personal provider is contacted |
| BV1-02 / MS-03/04/05, MR-01/05 | Main text plus text-file attachment → streamed partial reply → stop → retry/recovery; Side send; switch drafts/context; refresh and stopped Host restart | Original Main identity and Side isolation persist; real stream/stop states and original attachment bytes are visible; no duplicate uncertain send or lost original result; drafts survive only where the existing contract promises |
| BV1-03 / GS-01/02, LS-01/02/03, SP-02 | Search exact original message/file → navigate; upload/open real Library text; Create a space from retained Feed → inspect prepared unsent draft → create supported persistent notes/checklist Space → edit/revisit/reload | Correct source anchors and original file identity/content; preparing a draft never dispatches; Space creation needs actual registration/data receipts, not an HTML heading; explicit updates persist through the original Space owner |
| BV1-04 / GL-01/02/03 | Create/edit Goal; create linked task and schedule through original controls; save, pause, resume, cancel, reload; inspect Agent Activity | Actual owner records/status and scheduling permission agree; elapsed time/model prose never completes a Goal; cancellation does not fabricate successful work; destructive confirmation applies only to owned fixture data |
| BV1-05 / FI-01/02/05/06 | Edit Feed prompt; explicit Generate with real tool approval/publication; source-labelled result → Discuss; Ideas Generate → prepared action; fail one owned read and retry | Original generation/publication IDs and receipts agree; sources are metadata, not independent verification; discussing/preparing sends nothing until explicit Send; owner recovery preserves drafts/items without claiming autonomous personalization |
| BV1-06 / IA-01/02/03 | Actual approval-requiring tool → approve and deny → history/Activity; edit Identity/SOUL/MEMORY through their original editors → reload | Real permission effect and original audit, not fabricated history JSON; denial never executes the protected action; identity/memory remain on the selected Host and do not replace higher-priority rules |
| BV1-07 / CN-01/02/03/04 | Supported controlled Browser/API/MCP setup, selected account/verification/disconnect; reuse unchanged source-stamped F2 owner conditions where valid | Configured is not verified/Connected; actual permission, cancellation, stale-source and disconnect facts stay distinct; no real account, registration or external credential |
| BV1-08 / MT-03/04/05, SS-01/02/03, DC-04/05 | Essential Models/Host/devices/store/permissions/data inspection; owned second-device pair/revoke; bounded export/read-only recovery; destructive variant only in its separate empty fixture | Original authentication/authorization and secure-store conflict/unknown protections remain; no credential export or mutation replay; inspection never resets owner data or silently switches Hosts; retain valid B1/F2 evidence without reopening completed cleanup |
| BV1-SHELL / MS-01, MT-01 | Inspect actual main rail/menu/composer in paired browser; activate only owned safe controls; keyboard/touch; repeat neither/single gates | No unsupported native download or live-call primary promise under the Muse gate; remove or clearly defer only reproduced non-core dead ends; preserve configured dictation/read-aloud and ordinary/off routes |
| BV1-RENDER / MT-06 | Current EN-dark desktop and ZH-light compact, keyboard/touch, affected off/single gates; actual success/error/recovery frames | View changed rendered implementations, preserve unmodified originals/source hashes and honest viewer receipts; no clipping or state repair through DOM/styles; captures alone are not review or V90 acceptance |

Shared dependencies: pairing/cookies and selected Host/Profile scope apply
to every group; composer/drafts/stream transport to Main/Side, Space and
discovery discussions; original approval/tool dispatch to generation,
identity, schedules and connectors; file/data/revision owners to Search,
Library, Space, export and restart. Changes to these paths require their
dependent cases, not only a same-file selector. Reuse unchanged maintained
workspace protocol evidence only with matching relevant source hashes.

Before any runtime repair, retain the meaningful paired RED and view its
actual frame, add only a focused maintained regression and a reachable
local RED checkpoint. Run the same/dependent GREEN, normal lint/six type
projects/build, and inspect LOC/call path/performance/native boundaries.
Private driver/logs/current reference captures and final per-group outcomes
live in `files/browser-v1-core/`; frozen comparison contracts/business docs
belong to the separate review owner. No native, model-quality, publication,
installation, shared-Spark or readiness claim follows from this packet.

Shared browser visual V2 is a contained follow-up for three surfaces only:
the main app menu, shared Feed rail entry and Agent hero/header/cards.
Use decision 0016's browser-core scope, not the historical full-equivalence
or 95% target. Settings assessment and remaining workflows are separate.

Pre-edit setup: preserve the inherited native Download-apps removal and
its actual shell evidence; pair normally to an empty task-owned loopback
Host. Freeze current source/driver hashes and view fixed CSS-scale crops
from the named 01/02/26/27 captures against the unchanged originals.
Keep CPU-scripted approval evidence distinct from real inference. Do not
change the comparison method, reference contracts, substitution ellipses,
privacy masks or scores to accommodate a different rendering.

| Case | Setup and user actions | Required visible result and invariants |
| --- | --- | --- |
| BV1-SV2-01 / BV1-SHELL | Open main menu by mouse/touch and keyboard; inspect core rows and shortcut hints; Arrow/Home/End/Escape; activate Shortcuts, Report and Settings | Room for icon, label and truthful shortcut hint; Settings visually grouped without restoring native Download; effective desktop/coarse targets retained; dismiss returns focus; Report remains explicitly unavailable rather than sending or claiming an issue |
| BV1-SV2-02 / MS-01, FI-01 | Inspect shared rail in Main with Activity open, then navigate Feed, Ideas, Goals and Library; open/dismiss Search and return Main | Original core destinations, current-page state and 44px rail targets; generic original Feed artwork with readable stacked-page semantics; preserve existing shared row coordinates, not per-label positioning; no generation, provider dispatch or data mutation from navigation |
| BV1-SV2-03 / IA-01 | Open Activity, Identity and Approvals; inspect hero, name, actual connection, avatar Edit and header/body hierarchy | Selected Host identity/connection remain truthful; original image/name substitution boundaries unchanged; preserve portrait ownership, edit control and tab/body positions; compare the visible hero envelope, not its larger structural header box |
| BV1-SV2-04 / IA-02/03 | Keyboard Arrow/Home/End through Agent tabs; inspect real approved/denied history and open an existing receipt; close/reopen | Correct selected tab, focus and original audit details; no fabricated empty or pending history, permission change, replay or navigation away from the selected Host |
| BV1-SV2-05 / IA-01, MR-01 | Identity Edit and avatar Edit; SOUL/MEMORY cards → original editors → cancel/save/reload on owned fixture; fail one Identity read and explicitly retry | Cards preserve readable title/warning/content hierarchy and contained original data; original independent identity/SOUL/MEMORY revisions persist; failure is visible, retry read-only, no hidden overwrite, changed authority or replaced data owner |
| BV1-SV2-06 / MT-06 | EN-dark desktop and ZH-light compact/coarse; keyboard/touch; inspect menu, Agent and cards with actual saved text/error/recovery | No clipping/overlap, reachable close/edit/tabs and retained coarse hit targets; desktop-only presentation must not regress compact rhythm, long names, real missing-avatar/error states or off behavior |
| BV1-SV2-07 / BV1-B1-07 | Repeat ordinary entry with neither gate and each single gate; inspect original Models and no-model state | Consumer-only menu/icon/layout never leaks into ordinary clients; no selected model, backend/schema/native/OS change or product-local quota/budget |

The inherited rendered RED shows a narrow menu without shortcut hints or
the Settings divider, a smaller/differently stacked Feed glyph and heavier
Agent card titles. Rail positions, Agent tabs, summary and card outer
geometry are already close. The 302px structural hero header is not the
174×198 visible reference envelope; its size alone is not a layout defect.
Retain an actual source-stamped paired RED and reachable local checkpoint
before any new presentation repair. Reuse bounded original browser helpers,
the maintained shell E2E and affected owner cases; run normal lint/six type
projects/build and review current-source GREEN. Private raw frames, exact
source/browser/DPR/viewport evidence and handoff remain in
`files/browser-v1-shared-visual/`. No V90/readiness or deployment claim follows.

Paired V2 RED completes 35 checks with two failed presentation expectations:
missing shortcut hints and card-title hierarchy. Two maintained E2E cases
also fail on the actual missing hints and content-dependent SOUL heading
movement after an original editor save. The fixed CSS-scale reference/current
menu, rail, Agent and history-header crops were viewed before new runtime
edits; tabs, summary and outer card positions are retained rather than moved
to fit a score. No provider calls occur in the paired visual RED.

V2 GREEN passes 134 bounded paired UI checks: Chromium desktop 40,
Chinese compact/touch 35, WebKit desktop 35 and three ordinary/single-gate
packets of 8. Eight maintained shell/Settings/Identity/history cases pass
281 assertions; normal lint, all six type projects and build pass. Only the
desktop owner packet makes six CPU-scripted calls for actual approval/denial,
identity/SOUL/MEMORY editing and original audit inspection, not model quality.

The supported menu now has a 225px frame, truthful shortcut hints and a
Settings divider while retaining 40px desktop/44px coarse rows and the
approved native omission. Generic original Feed artwork and the existing
shield/check glyph replace only their Muse callers. Column-flex Identity
cards keep headings fixed across real excerpt wrapping; the original hero,
rail coordinates, tab/summary/card envelopes and data owners stay unchanged.
No generic font replacement or per-label origin adjustment is made.

Current-source reference/current crops and desktop/compact/WebKit
success/error/read-only-recovery frames were viewed within a 1MiB encoded
budget. Keyboard focus rings remain real; no portrait/name mask, image,
scoring method or frozen reference is altered. Remaining glyph, gradient
and text-metric differences are not declared a V90 pass. Private fixture
corrections cover lazy Main creation, compact Settings entry, animation
settling and release of the exact owned read-only Search session, not
relaxed product state/data assertions. All task Hosts/browsers/data/scratch
are closed or removed. No native, owner Preview, Spark or deployment change.

Browser rail geometry V2 corrects the shared content-box cause, not any
individual glyph. The72px rail includes a1px border, so44px controls
currently center at35.5 rather than the observed36. Preserve the divider
paint, grid columns, all vertical positions, avatars and44px targets.

| Case | Setup and user actions | Required visible result and invariants |
| --- | --- | --- |
| BV1-RL2-01 / BV1-SHELL | Original paired desktop rail; inspect all core controls and open menu/Search/Agent | Controls center on the actual rail column without consuming a pixel for the divider; no per-icon transform or copied artwork; original destinations/actions/focus retained |
| BV1-RL2-02 / MT-06 | Compact touch and WebKit keyboard; inspect rail/selected states and navigate core pages | Same divider/color, vertical rhythm and hit targets; no clipping or change to selected Host/data |
| BV1-RL2-03 / BV1-B1-07 | Existing shell/Settings neither/single-gate dependent cases | Ordinary navigation/setup unchanged; no extra owner work, API, model or native dependency |

Extend the existing real-browser shell case before the one-rule source
repair; retain f937df2a native geometry/frames as RED. Run focused browser
dependents, bounded original core variants and normal source gates. Review
current raw output and unchanged comparison; no threshold/mask fitting.

RL2 GREEN passes four maintained browser cases/177 assertions and all70
original core checks in desktop Chromium, compact touch and WebKit keyboard.
Normal lint/six types/build pass. One CSS rule uses the same inset divider
paint without reducing the rail content box; all44px controls center on the
72px/compact column, vertical positions and avatars stay unchanged. Actual
settled Main/Feed renders were reviewed. Runtime+1/-1 CSS line, no branch,
owner call-path, request, timer, dependency or native change.

Reference capture now restores the actual initial Feed prompt through its
original editor after functional tests, then waits for natural transient
confirmation dismissal. Model setup waits for the original empty inventory
before keyboard activation. A compact preference probe re-enters General
after the existing breakpoint re-render. Failed attempts are retained;
none is a product fallback, silent mutation replay or metric change.
V90 remains unaccepted; matched Feed imagery improves without relabelling
historical results or copying private content.

Browser Search rows V2 follows the matched24 condition, not mixed file/chat
fixture data: five original conversation recents and the first highlighted
row. Current one-line rows are44px with bare leading glyphs; the observed
row rhythm is about48px with a public rounded leading cue. Hidden names/
content are not reconstructed. Preserve variable-height file/snippet rows,
actual keyboard selection, source fencing, targets and draft/close owners.

| Case | Setup and user actions | Required visible result and invariants |
| --- | --- | --- |
| BV1-SR2-01 / GS-01/05 | Original owned chat/file sources -> Search recents/query -> keyboard select/open -> Escape | Readable padded leading cue and row rhythm; original text/path and correct source target; decorative glyph never takes focus or swallows activation |
| BV1-SR2-02 / GS-01/03 | Actual Main/file hit, lost/read-failed query and explicit retry, then reopen | Same original request/generation/owner fences; no fake or stale results, query replay mutation, model call from inspection or lost draft |
| BV1-SR2-03 / MT-06 | Desktop Chromium/WebKit, compact touch and retained ordinary gates | Contained actual success/error/recovery; file details remain variable-height and reachable, at least existing touch targets; no ordinary-shell leak |

Add a focused browser case to the existing services lane before runtime
edits; use a real public UTF-8 file and original target lookup. Retain the
matched raw RED and failed source-fence fixture attempt. Run affected core
Search workflows plus normal source gates and review actual native output.
No reference/mask/method/threshold change or V90 pass follows.

SR2 GREEN passes four focused/dependent maintained browser cases with176
assertions and all70 original core checks in each of desktop Chromium,
Chinese/light compact touch and desktop WebKit keyboard. The desktop run
makes23 CPU-scripted calls including five genuinely submitted matching
recents; compact/WebKit make18 each. Actual desktop reference/current,
compact message-hit and WebKit message-hit renders were viewed.
Normal lint/six types/build pass. Search runtime delta is two web files,
+4/-3 lines: one decorative span per existing bounded result, no new branch,
listener, request, timer, dependency or owner call path.

Matched fixture setup now uses the reference's conversation-result condition
instead of later file-read recents, retains the actual source-changed error
and explicit read-only retry, and does not tap an already-disabled approval.
The B1 breakpoint check re-enters Devices after the original tab re-render
before measuring settled compact Back. None changes product state handling.
The changed Search diagnostic improves from0.345058 to0.488454 under the
same reference/metric but remains below0.90. All18 current numerical
core/Settings candidates still fail the image gate; actual review and
functional passes are not relabelled90% or complete-browser readiness.

Browser Devices presentation V2 follows the actual current14/31 renders:
device rows omit the reference's generic device cue and detail Back lacks
the common circular surface. Keep original IDs, actual current-device
labelling, unknown OS, read-only inspection and revoke confirmation.
Use a generic device illustration, never infer an OS from a name.

| Case | Setup and user actions | Required visible result and invariants |
| --- | --- | --- |
| BV1-DV2-01 / BV1-08 | Paired owned browser -> Devices -> original named device -> Back | Readable generic device row cue and common circular Back; original name/current identity retained, no invented device or OS |
| BV1-DV2-02 / MT-06 | Desktop and compact/touch device details, long names and read-only key/value rows | Compact desktop row rhythm; 44px compact Back and effective desktop target; no value clipping or hidden OS fallback |
| BV1-DV2-03 / BV1-B1-05/07 | Existing B1/off variants and original second-device pair/cancel/revoke flow | Presentation remains Muse-only; original authorization, exact target ID, confirmation, revocation and settings stay unchanged |

Extend the existing B1 browser case with the visible cue/Back regression
before runtime edits; retain its RED and14/31 raw references. Run its
focused/dependent packet, normal source gates and actual current desktop/
compact renders. No backend/schema/native/OS change or V90 pass follows.

DV2 GREEN passes the three focused/dependent browser cases with164
assertions and the original compact/WebKit device/data packets with14
checks each and no model calls. Normal lint/six types/build pass.
Current native list/detail renders were viewed: generic device cue,
common circular Back and denser desktop key/value rhythm, with actual
names/current identity and explicitly unreported OS. The initial paint
probe was corrected to await the existing background transition, not
relaxed. A separate maximum-length-name boundary was not rerun.
Runtime delta is two web files,+18/-5 lines, no new branch, request,
timer, dependency, native input or authority. Original pair/revoke/
cancel/export owners and ordinary/single-gate behavior remain unchanged.

Browser Settings appearance V2 follows the current rendered General RED:
the desktop Mode control is 112x40 and its row is 72px, while the reference
has a roughly 94x36 control in a 56px row. The 18px accent circles and 27px
stride are visibly smaller/tighter than the reference's 24px/32px rhythm;
Auto lacks its separate selected-check cue. Approved cloud/account omissions
remain omissions, not blank cards to restore. Keep the existing system font,
all preference IDs/values and compact/coarse overrides. Do not repair scores,
reference masks or individual glyph positions.

| Case | Setup and user actions | Required visible result and invariants |
| --- | --- | --- |
| BV1-SG2-01 / BV1-B1-02 | Paired owned EN-dark desktop General; inspect Mode and accent rows against the fixed reference | Compact desktop Mode pill, 56px row rhythm, readable 24px swatches on 32px centers; selected Auto has a separate non-color check cue; no quota/account placeholders restored |
| BV1-SG2-02 / BV1-B1-02 | Select Light/Dark/System and named/Auto accents; keyboard, refresh and reopen | Original local preference IDs persist; exactly one selected mode/accent; original configured colors and live focus preserved; no Host/model/content write |
| BV1-SG2-03 / MT-06 | Actual compact Chinese/light touch and WebKit desktop keyboard; scroll and return | Existing 44px Mode targets and accent vertical targets retained; wrapping remains contained; current source success/selection frames reviewed |
| BV1-SG2-04 / BV1-B1-05 | Revisit essential Settings and original secure-store Add form after the shared stylesheet change | Common nav/header/fields and original owners stay unchanged; no secure-store, permission, device or data operation from inspection |
| BV1-SG2-05 / BV1-B1-07 | Repeat ordinary/neither and each single-gate Settings packet | Presentation remains consumer-only; ordinary preferences, no-model setup and deferred bookmarks keep their existing behavior |

Use the existing maintained services browser lane for the focused regression,
the original B1/dependent core packets for behavior and native raw Settings
captures for actual review. Preserve the RED report, run lint/six types/build,
record LOC/call-path/performance review and keep V90 and real-inference gates
separate. No account, external model, installation or deployment is authorized.

SG2 GREEN passes the three focused/dependent maintained browser cases with
158 assertions, the original Chinese/light compact Settings packet with92
checks, and normal lint/six types/build. Current desktop Mode is94x36,
Appearance rows retain56px rhythm, and24px swatches use32px centers. Auto
now has a non-color selected-check badge; local preference values and
compact targets remain unchanged. Eight actual native Chromium Settings
pairs, WebKit General/Add form and actual compact General were viewed.
This changes only two web runtime files by+11/-1 lines, adds one rendering
conditional and no asynchronous work, backend/native contract or owner
call path. No new dependency or resource request is introduced.

The recovered core packet also passes70 checks each on current desktop
Chromium, Chinese/light compact touch and desktop WebKit keyboard, with18
owned CPU-scripted calls each. Fixture corrections respect the original
compact generation-chat overlay, enable touch on the secondary paired
browser and scope preference setup to the top frame rather than the
sandboxed Space. These are not product fixes or real-inference evidence.
Current native core/Settings rasters remain below the frozen numerical
V90 diagnostic; neither these checks nor rendered review establishes a
90% or complete-browser readiness pass. No deployment was performed.

Browser-core Settings cleanup V2 covers only the consumer Settings entry,
General, deferred bookmarks and directly related Help/Legal content. It
replaces the historical eleven-section MT-01 expectation for this slice,
not the original data/runtime owners or other MT evidence. With no existing
verified aggregate token source, hide Usage rather than build a counter.
Remove account/invite/plan placeholders and primary Wallet, messaging and
live voice/avatar destinations; retain truthful deferred bookmarks and all
essential/advanced setup, including About. Keep optional configured media,
technical limits, authorization, storage and default-off gates unchanged.

Pre-edit setup: normal invitation/code pairing to an owned empty loopback
Host through `Host.open`/`startServer`, no selected model or real provider.
Freeze the driver, assertions, source hashes and actual RED screenshots
privately before runtime edits; setup failures are not product RED. Use
EN-dark desktop and ZH-light compact, then neither/single gate enabled.

| Case | Page/actions | Required visible result and invariants |
| --- | --- | --- |
| BV1-B1-01 / MT-01 | Normal pairing → core rail/menu → Settings list/General | Original core navigation; only supported consumer sections; no account, invite, quota, allowance, reset-cycle, Upgrade or unverified usage placeholder |
| BV1-B1-02 / MT-02 | General language/mode/accent; keyboard focus, scroll, reload | Existing preferences and EN/ZH copy; contained scrolling, reachable controls and live focus; no Host mutation from inspection |
| BV1-B1-03 / MT-03 | General → Models/Host/Workspace/Repositories/About → Back | Original setup owners, truthful no-model/Host state, top/heading/Back; no selection, Host navigation or config loss |
| BV1-B1-04 / MT-01/05 | Old Wallet/channels/voice bookmarks, reload, Back/General | Explicit deferred state, no disabled payment-brand mock or account setup; optional media setup reachable only as real Models; no silent Host switch or data deletion |
| BV1-B1-05 / MT-04/05 | Devices, secure store, permissions, data, Help and Legal | Essential existing controls reachable; real documentation/license links, not inert feedback/cloud-terms controls; inspection does not pair/revoke/reset/connect |
| BV1-B1-06 / MT-03 | Hold/fail Models read, Back before completion; explicit retry | Actual failure and recovery, usable Back, late reads cannot replace General; never select a model or invent success |
| BV1-B1-07 / MS-01 | Neither gate and each single gate, ordinary setup and old bookmarks | Original ordinary Settings/config and advanced owners; no opt-in shell leak; deferred bookmarks acknowledge unavailability safely |
| BV1-B1-08 / MT-06 | Actual current desktop/compact rendered capture and review; retained config/read hashes | No clipping/overlap or dead primary destination; review raw source-stamped images, preserve named proof and remove only owned data/caches |

Run the existing Settings/Secrets/CN/PP/DC dependent selectors, normal lint
(including six type projects) and build after the bounded repair. Keep
actual UI/protocol outcomes, faults, cleanup and reviewed-image receipts in
private `files/browser-v1-b1/`. This packet is not complete-browser readiness,
a new similarity measurement, native acceptance, installation or deployment.

Pre-edit paired RED completes setup and all 73 checks per variant: desktop
reproduces 15 failed expectations and compact 16. The unwanted Usage is
unmeasured explanatory copy, not an observed enforced/numeric quota. Real
frames show account/invite placeholders, three deferred primary sections,
disabled payment mocks, inert Help submissions and hidden original About.
Compact advanced Back also leaves focus outside the dialog by targeting a
hidden nav control. Eight selected raw frames were viewed before runtime
edits; the new maintained B1 browser case fails on the actual General copy.
Original presence heartbeats and locally blocked catalog favicon requests
are fixture expectations, not product defects; raw attempts stay retained.

Rendered self-review also finds WebKit's raw English “Load failed” in the
Chinese compact Models read-error state. A separate actual paired 82-check
RED reproduces that one copy failure before its repair. Normalize only the
consumer Settings network-read feedback to the existing localized message;
retain explicit Retry, late-read fences and ordinary-mode error behavior.

B1 GREEN passes 530 actual paired UI checks: Chromium and WebKit each run
92 desktop EN-dark and 92 compact ZH-light checks; ordinary and both
single-gate packets pass 54 each. The 16 maintained B1/Settings/Secrets/
CN/PP/DC dependent cases pass 725 assertions. Normal lint, all six type
projects and resource/portable builds pass. Protocol model fixtures remain
explicitly scripted; the B1 UI Hosts have no selected model.

Thirty-nine current rendered frames are reviewed: 27 directly and 12 by
exact-byte matches to viewed payloads, plus nine retained RED frames.
Viewer batches stay below 1 MiB encoded. Two runtime files change
+26/-55 lines; CSS, backend/schema/storage/authorization and native inputs
are unchanged. Existing configuration hashes, paired identities, browser
preferences and unsent drafts survive; inspection never mutates content
or settings, apart from original presence heartbeats. No new usage owner,
dependency, endpoint, timer, primary IA, installation or deployment.
This closes B1 only, not all browser workflows or a similarity/native gate.

Visual V1 prioritizes the actual95% goal, independently of functional-ID
counts: shared desktop Settings shell and real blank Add-password state,
against verified UI09 public regions/UI29 at800×600/DPR2/EN-dark. Before
production edits, the reference-only regions and foreground SSIM/edge-F1
method were frozen in private `files/muse-visual-v1/contract.json`.

The real paired baseline reproduces hidden desktop Close, cumulative nav
rhythm/selection/heading drift, differing generic icon semantics and palette.
Frozen component gates pass0/18 public UI09 components and0/25 UI29 components;
whole valid-area foreground SSIM is0.1531/0.3569 respectively. These are strict
defined pixel diagnostics, not a claim that the entire product is15%/36%
similar. Actual current/reference/overlay frames were viewed before edits.
DOM-only geometry, large blank areas and redacted content cannot certify95%.

Repair only observed Muse desktop presentation, preserve compact/off behavior,
non-default accent choices, original owners and visible truthful store/privacy
information. A redundant Add-only notice may move back to the already visible
Store context; edit/error/recovery notices remain. No billing/account mocks,
new destination or proprietary artwork. Native Safari/physical/model/resource,
unmeasured states and whole-App95 remain unaccepted; functional counters do not
advance. Tool dependency/interpreter and locator-rounding corrections are
fixture setup, not product RED or a change to the frozen scoring method.

V1 controlled presentation repair restores36px navigation rhythm/32px
selected rows, reference heading insets,28px desktop Close (including Add),
same-semantics original generic glyphs, measured dark palette/dividers,
default Auto accent and form field/action placement. Explicit accent choices
and compact layout remain. The repeated Add-only notice now stays in the
already visible Store context; edit/error/recovery notices and actual
plaintext/private-file facts are retained. Actual filled/pending Close,
retired-result behavior and read-only recovery pass in Chromium and WebKit.

The frozen visual gate is **not passed**: final Chromium UI09 public0/18,
UI29 2/25 components. Its Add foreground SSIM changes0.356870→0.782113 and
edge-F1 0.473297→0.971569; only URL/Username inputs pass both95 gates.
Current WebKit Add scores0.536574/0.965238 with0/25 components. No engine
averaging, mask expansion, post-registration or native-Safari claim. These
are strict defined diagnostics, not a whole-product similarity percentage.
UI09 private contents and non-desktop references remain unavailable; whole
V95 stays0. Remaining text/glyph/Close/eye/action differences stay explicit.

Final affected UI packets pass258 checks:Permissions desktop92,
connector/store desktop64/compact64/off12, and matched-flow
Chromium11/WebKit11/compact4. Ten maintained CN/SS cases pass560 assertions;
normal lint/six types/build pass. One compact driver raced a successful
original catalog refresh after fault removal; its actual ready state is now
recorded rather than clicking an obsolete Retry, with no product fallback.
Runtime changes are3 web files,+37/-3 lines, no backend/schema/native change,
dependency, request or timer. Original2149-ID functional counts do not move;
earlier Settings renders retain their historical source stamps.
Private evidence/remaining work: `files/muse-visual-v1/handoff.json`.

UX-F2 freezes the remaining 15 original connector/store F IDs at `9ed35f77`:
five connector rendered callers, five Settings services conditions and five
Muse Passwords conditions. The private pre-edit V2 plan exercises real paired
API/web/MCP owners, controlled OAuth consent, configured-versus-verified,
stale sources, loading/failure/retry, exact read-only recovery, Passwords
conflict/deletion, nested original services/secrets and three off modes.
No new top-level destination, real account, selected model or Spark permission.

Actual paired RED in desktop dark and Chinese compact light reproduces lost
tab focus, detail loading/error retaining the directory title (and no desktop
Back), generic Advanced services title, and failed Advanced services/secrets
reads retaining the consumer heading with no desktop Back. A focused nine-check
desktop run reproduces eight assertions; the Host/no-model precondition passes.
Actual source-stamped RED frames were viewed before editing production code.
Reuse existing focus and heading/Back owners; leave API, storage/schema,
ordinary clients and native inputs intact. Scope, raw reports and viewed frames:
current-session `files/muse-f2/`. No F2 acceptance counters advance at RED.

F2 navigation GREEN passes 58 desktop + 58 compact + 12 off checks, ten
original CN/SS owner cases with 560 assertions, and normal lint/six types/build.
Twenty-seven selected current rendered frames were reviewed. That review
found internal policy-source enums displayed as consumer copy, including in
Chinese. A separate actual-owner RED sets fallback/global/service/action
resolution in turn: all four native-label checks fail while the original
owner scopes agree. Its compact frame was viewed before the copy repair.
The next change localizes only those distinct sources, explicitly names an
unavailable source rather than inventing a default, and preserves each policy.
No F2 row is accepted yet; earlier rendered evidence keeps its own source stamp.

F2 final GREEN closes the frozen 15 original IDs as specific-condition passes.
Final desktop64/compact64 plus three off-mode packets of4 checks pass (140
total); this includes actual Back from failed and still-held selected reads,
not merely arrow visibility. Ten original CN/SS owner cases pass560 assertions;
their backend/protocol inputs remain unchanged. Final normal lint/six types
and build pass. Twenty-eight final frames are reviewed:8 directly and20 by
exact-byte matches to reviewed payloads, with original source stamps/flags
retained. Four real policy origins have native labels without changing rules.

The original API/web/MCP owners, owned DCR/PKCE exchange, explicit account
selection, configured-versus-verified and remote-revocation503 remain distinct.
Real stale-source and paired-browser credential conflicts/deletion, committed
dropped response, identity-only same-tab recovery and read-only proof do not
replay writes. The Passwords empty/filter composite is accepted only for its
actual empty caller; no absent filter or hypothetical search is invented.
Advanced original services/secrets keep title/top/Back during failed reads.

Runtime delta from `9ed35f77`:3 web files,+21/-4 lines, no new runtime file or
dependency. Existing focus/heading/Back and original owner requests are reused;
the four-entry display map has an explicit unavailable-source label. No CSS,
backend/schema/storage or native inputs change, and no new native-build or
upgrade certification is claimed. Driver assumptions about invalid-definition
detail and create-versus-edit HTTP were corrected only in the fixture.

The additive ledger is1168 pass/365 planned/598 blocked/18 source N/A; other
original IDs are unchanged. Whole-product E2E, V95, real accounts/models,
physical/native/24-hour, source push, installation and Spark rollout remain
unaccepted. Task-owned run data/caches and unselected temporary rasters are
retired; selected raw proof remains private in `files/muse-f2/handoff.json`.

UX-F1 continues exactly25 still-planned original Permissions caller IDs:
the `permissions.ts` load/error/save, policy menu, reset and protocol
confirmations; five Settings Permissions states; and the original Reset-all/
selected-scope contracts. Earlier accepted F dependencies are not reopened,
and connector/password F rows remain separate. The frozen private scope
and pre-edit V2 plan cover normally paired Muse-mode loading/failure/retry,
real policy writes and caller focus, named reset/protocol ranges, safe
Cancel/Escape/backdrop, exact lost-result read recovery, peer/late callbacks,
and EN-dark desktop/ZH-light compact/off behavior. Reproduce before changing
code; reuse the original owner/ask/menu and keep native/default-off behavior.
No actual direct connection, model, external account, OS or Spark action.

UX-F1 current-source RED executes nine checks, with three reproduced
failures: a confirmed policy save leaves focus on BODY; selected-reset
confirmation omits the selected object; protocol confirmation omits the
actual protocol. Real paired screenshots were viewed before product edits.
The first driver needed the existing same-route reload convention; that
checker correction is separate from the three app defects. No backend
permission/schema change or new pass is claimed by this RED checkpoint.

UX-F1 GREEN dispositions the frozen25 IDs:24 specific-condition passes
and1 source N/A. The policy caller has exactly three fixed choices, so its
generic long-menu-scroll variant is not fabricated; real compact menu
placement and keyboard/touch use are verified under the ordinary menu IDs.
Final paired desktop92/compact94 checks plus9 default/single-gate checks
pass. Four original PP/DP owner cases pass77 assertions; normal lint,
six type projects and resource/portable builds pass.

Web-only fixes reuse the existing focus helper and ask/menu primitives:
preserve the current action/scroll after saves; name selected reset and
protocol targets; retain reset claim strength; localize the Chinese fetch
error and remove the measured orphan line; expose the existing nested
Advanced heading/Back handler and start that page at its top. Original
authority, API payloads, storage formats, CSS and native inputs are unchanged.
No new storage-upgrade/native compilation or real-model claim is made.

Current rendered frames were reviewed directly or by exact-byte matches
to already viewed frames, with stored image-payload receipts. A transient
immediate-touch highlight cleared in an unmodified settled capture; both
are retained without a speculative CSS repair. Earlier failed driver
attempts are not counted as passes. The additive overlay yields1153 pass/
380 planned/598 blocked/18 source N/A; other F dependencies and the remaining
15 connector/password F IDs are unchanged. No V95, complete-product E2E,
installation, push or Spark rollout claim. Private evidence:
current-session `files/muse-f1/handoff.json`.

Focused generic Secret recovery owns only
`UX-E-settings-secretDialog-1095-formDialog-072066a` under SS-03/SS-04/SS-05.
Before implementation: add optional stable entry identity/revision and bounded
generic request receipts to the original Secrets version-1 owner, sharing its
serial atomic writer with typed, website and API/MCP mutations. The paired,
double-gated route accepts expected identity/revision and returns exact request
proof without values or value fingerprints. Reused request IDs never apply
new inputs; unrelated legacy callers keep their original response contract.
The advanced form freezes uncertain input and offers explicit read-only
verification, with separate missing/superseded/deleted/unavailable outcomes.
Only bounded request metadata may survive same-tab reload. A normal immutable
predecessor/current Supervisor matrix at the owner-approved short fixture
location is required alongside affected protocols, rendered UI and source
gates. The normal-entry preflight passed27 checks without changing the socket
guard; this is not receipt implementation or full acceptance. The detailed
pre-edit page and V2 plan is in the private business UI-state plan.

Runtime `24ff1097` closes this one generic Secret recovery remainder for the
stated conditions. The maintained affected/dependent packet passes12 cases/
579 assertions; normal no-env lint, six TypeScript projects and resource/
portable builds pass. The frozen normal package matches all five changed
runtime files. Actual paired packaged Chromium executes53 checks across
nine rendered states, including EN-dark desktop and ZH-light compact;
seven frames are byte-identical to already viewed current-source frames,
and two additional packaged frames were viewed directly. Enabled recovery
text has an unrounded minimum contrast of4.5024948619197485. This is not
foreground V95, Safari/native/physical or whole-product acceptance.

The actual immutable8e247397 writer creates ordinary credentials and an
original generated API binding. Current normal-launcher reads/writes and
second launch, plus separately explicit-gated packaged request proof,
pass57 checks across the three before/after matrix rows. Original values,
bindings, device authority and ordinary files survive; an ordinary-mode
edit supersedes only its affected receipt. Normal Supervisor retains its
original default-off Muse behavior and unchanged private-socket guard;
canonical gated entry is not relabelled as Supervisor acceptance. Two
invalid synthetic-manifest attempts were corrected only in the fixture.

The additive one-ID overlay leaves the original E3 evidence unchanged:
effective ledger1129 specific-condition passes/405 planned/598 blocked/
17 source N/A. Website-clear acceptance remains separate and planned.
Task-owned processes, data/caches and unpacked staging are retired; selected
proof and immutable archives remain private. No preview installation,
push, native compilation or new external resource is claimed. Evidence:
session `files/secret-recovery-handoff.json`.

The focused HTTPclear continuation owns only
`UX-E-settings-serviceDetail-780-toast-f4c7805`; it does not reopen E3's54
or the separate generic Secrets proof owner. Its frozen original-owner/V2
contract and actual viewed HTTP200/cookie-absent/localStorage-present RED
are in `files/muse-site-data-clear-evidence/`. The Linux clear now uses the
selected manifest's actual origin (scheme and port), retains the existing
port-independent service-domain cookie scope, retires only target-origin
pages and not-yet-navigated target service pages, and reports incomplete/
possibly partial execution explicitly. Unrelated origins, port storage,
Profiles, credentials, approvals and device authority remain separate.
The original BOTH-gated confirmation declares the actual scheme/port origin
and cookie-domain scope. Its original route rejects a changed origin before
effects; missing owner scope is unavailable, and a lost/unconfirmed response
is explicitly unknown rather than full success. Legacy no-body callers and
ordinary/off confirmation copy retain their original request behavior.
Maintained original Services protocol cases exercise four gate combinations,
real Browser target failure, fresh/reopened read-only effect verification,
and real partial origin-clear/browser-close before cookie removal. The
normal-package predecessor/write/upgrade/relaunch and current paired UI
gates remain required; source or an HTTP200 alone does not accept this ID.

HTTPclear runtime `30e28ab7` fixes the original HTTP-origin effect and retains
the original CDP `all` effect: the actual normal predecessor matrix caught
cookie resurrection when that effect's cookie component was omitted. The
corrected immutable8e247397→normal-package write/clear/two-relaunch matrix
passes74 checks across6 rows;27 affected protocol cases/928 assertions and
normal no-env lint/build/six types pass. Five actual native graphs and
758 native/207 resource-project hashes are unchanged; no native compile.
Thirty-nine actual PNG deliveries total768,180 encoded bytes, with no
withholding or quota-reset assumption; historical/rejected labels remain.
This one ID is still planned: the actual normal Supervisor rejects the owned
SESSIONFILES path at its104-byte socket guard. Canonical packaged main is not
normal-entry acceptance. Genuine owned HTTPS storage effects, unchanged
ordinary/off contrast and the original Viewer technical identity label are
not accepted. No original54/global counters are advanced, no generic Secrets
proof repair or protected Preview change is included. Exact proof and
cleanup: `files/muse-site-data-clear-handoff.json`.

The later normal-entry HTTP behavior continuation at unchanged runtime
`24ff1097` passes 144 checks across eight rows. Actual immutable predecessor
Browser writes are persisted before upgrade; the ordinary paired Settings
served by the actual normal Supervisor executes one confirmed clear.
Independent canonical-fixture readback verifies old/new target removal,
peer/port/inactive-Profile preservation and two stopped normal restart
cycles. Normal environment/URL admission and the socket guard are unchanged;
canonical loopback staging/readback is never claimed as normal navigation.
The actual report-phase sequence confirms no reseeding during readback.

Two full-viewport frames resolve a cropped-toast ambiguity: the real
feedback is visible, and no product fix was needed. The first fixture used
a wrong pairing200 checker; the real contract is201, and only the checker
changed. This clears the old normal-entry HTTP behavior blocker, not the
entire composite source ID. Properly trusted HTTPS and broader ordinary/off
visual/contrast coverage remain unaccepted; its status remains planned
and ledger counts do not move. No new runtime/native inputs, Spark activity,
push, deployment or V95 result. Current-session evidence:
`files/http-normal-entry-handoff.json`.

UX-E3 is bounded to the immutable original54 Settings rows:
security15/confirm5/serviceDetail2/message1/recovery1/verify1/submit1/remove5/
form7/secrets5/secretDialog11. Its pre-edit caller/owner/V2 plan and exact
IDs are in `files/muse-ui-e3-evidence/plan.json` and `scope.json`.
Original ordinary Security confirmations are not replaced by Muse Devices.
Website data, saved preference, credential metadata and authenticated
connection proof remain separate. The focused SS-04 checks cover original
generic-form dynamic-field busy/late callbacks, website validation/CAS/
unknown read-only proof, exact delete range, cancel/focus/scroll and
ordinary/off behavior; no new vault/encryption/injection or policy audit.

UX-E3 runtime `04986036` now dispositions exactly54 original IDs:
**52 specific-condition pass,2 original-owner planned,0 source N/A**.
The remaining IDs are `UX-E-settings-serviceDetail-780-toast-f4c7805`
and `UX-E-settings-secretDialog-1095-formDialog-072066a`.
Actual HTTP-origin site clearing removes the owned cookie but retains
localStorage, so its200/success toast is not accepted. An original generic
Secret write with a lost committed reply has no exact request/revision
read-proof; metadata presence/hash is not newly saved-input proof. These
two owner changes require their proper boundary/compatibility work, not
a new vault, value-read endpoint, automatic replay or waived gate.

Viewed RED/checkpoints precede minimal web-only fixes for dynamic generic
fields pending, old generic/service completion replacing a new caller or
toasting late, replacement Cancel focus, three ordinary Security danger
labels, Saved/Local-delete text, wrapped pending feedback and native ZH
credential errors. Runtime changes are73 added/14 removed lines in three
web files; original owners/API/schema/consumers/native inputs are unchanged.
49 actual readable CSS deliveries are34 accepted/15 rejected/0 historical,
1,501,828 encoded bytes, no withholding/reset assumption; capture/viewer
stopped. Ten final clean-runtime workflows execute633 checks:632 pass and
the exact retained site-owner effect fails; generic unknown proof absence
is separately demonstrated, not accepted. Three off combinations preserve
ordinary behavior; unchanged ordinary generic colors/focus are not blanket
visual acceptance. Normal no-env lint/build/six types and9 original
protocols/412 assertions pass. Five actual native graphs and758 native/
207 resource-project hashes are unchanged; no native compile/storage matrix
or promotion claim. Actual accepted text/focus minima are
4.5024948619197485/3.9169496326546187, unrounded.

All54 owned QA runs and invitations are retired;49 reviewed originals/
source/rollback remain,56 exact unselected rasters are removed. Complete
2149-ID history retains atomic5 and C2b through parent E2bR overlays:
1128 pass/406 planned/598 blocked/17 N/A, including the unchanged genuine
notification resource and native/physical blocks. Authorities:
`files/muse-ui-state-ux-e3-results.json` and
`files/muse-ui-security-store-handoff.json`. Protected installed310/PID45320/
health200 and parent pointers/counters are untouched. Only the exact two
owner remainders or separate F–I/features/promotion follow, not all Settings,
all Muse, all states or V95.

Additive E2b viewer closure only: parent directly viewed the two original
validation-message PNGs at unchanged runtime `2bbfac28`, original400/retained
drafts/saved address unchanged. `files/muse-ui-state-ux-e2br-results.json`
SHA256 `e4de1d1ac148f2cecda709a1e5d0f7747474a209f7df0c5061876e6be52d3a98`
records2 actual deliveries/96,076 encoded bytes, error text6.907533565742727
and actual dark primary glyph4.520252793641685. This additive overlay closes
effective E2b47/47; the historical45/2 report below is immutable, not new E3.

UX-E2b (runtime `2bbfac28`) dispositions exactly47 immutable original rows:
pairDialog11, machineDialog10, keyDialog11, machineRows5 and models10.
**45 pass,2 planned**. Exact remaining validation-message frames are
`UX-E-settings-pairDialog-504-formDialog-state-2ce98f9` and
`UX-E-settings-machineDialog-514-formDialog-state-436d14e`. Their original
owner400 refusals execute correctly, but their exact pixels were not viewed;
503/404/transport frames are not substituted. Only one normal-caller dialog
frame per ID remains at the unchanged runtime, not a source/integration task.

Viewed REDs/checkpoints precede fixes for ordinary Connect contrast/rejection
focus, original Models caller/focus retirement and replacement controls,
single-flight visible busy, native picker focus, Default/Ready text and
native key-range copy. Original machine/model IDs, aliases, weights,
capabilities, Host/Profile/epoch/auth and persistent owners remain unchanged.
Configured/listed/controlled-health metadata is not provider/model quality.
Only six web files change:102 added/43 removed lines, no native/shared input.

49 actual original CSS-scale deliveries are32 accepted,15 rejected and
2 historical,1,529,240 encoded bytes; zero withholding/reset assumption.
Two unopened exact Main-component raster aliases are separately proved and
not extra views. EN/System/dark desktop, critical ZH/light390, native masking,
real scroll, keyboard/touch/reduced motion and original failure/unknown/
late/peer404/removal conditions have owner-specific evidence.
194 representative checks, three off combinations, direct More15/fields23,
normal no-env lint/build/six types and10 protocols/176 assertions pass.
Five actual native graphs and758 native/207 resource-project hashes are
unchanged; no native compilation, storage-upgrade, supervisor or promotion
claim. All78 owned runs are retired;49 reviewed originals/two aliases and
source/rollback remain,18 unselected rasters are exactly removed.

Whole2149-ID history retains atomic5 and every C2b–E2aR overlay:
1074 pass/460 planned/598 blocked/17 source N/A. Closed E2a59, native16,
four external-integration statuses and the E1 notification-error blocker
are unchanged. Authorities: `files/muse-ui-state-ux-e2b-results.json` and
`files/muse-ui-models-hosts-handoff.json`. Next only the two exact frames,
then separate E3security54/F–I/features/promotion; not all Settings/Muse/V95.

UX-E2aR (runtime `a7d68376`) closes only original
`UX-B-app-start-2831-rendered-state-8bcedc8`. The original sheet owner now
distinguishes retirement from user close: route supersession does not invoke
acknowledgement/markSeen or restore retired focus. Original firstRun leases
and Settings retire before Muse local-entry status/error publication; existing
draft/attachment maps keep original Main/Side ownership and a held upload
completes once without cancellation/replay. Explicit Get started/Got it and
both off modes retain their original semantics. Only23 added/8 removed lines
in three web files; no auth, persistent owner, CSS or legacy Connect change.

Current-byte RED was viewed before checkpoint `661517b7`; matching GREEN was
actually viewed. Two new tiny CSS-scale deliveries use13,496 encoded bytes;
cumulative45 deliveries/1,566,684 bytes, no withholding/reset assumption.
Focused35+4+4 checks, normal no-env lint/build/six types,9 protocols/149
assertions and five actual native graphs pass;758 native/207 resource-project
hashes are unchanged, not native compilation or storage-matrix acceptance.
The closed E2a55 pass/3 N/A/1 planned evidence remains immutable; this one-ID
overlay yields effective56 pass/3 N/A, not a59-state rerun. Whole2149-ID history
is1029 pass/505 planned/598 blocked/17 N/A, with prior external/native/
notification boundaries unchanged. Authorities:
`files/muse-ui-state-ux-e2ar-results.json` and
`files/muse-ui-local-startup-handoff.json`; no broader Settings/E1 campaign.

UX-E2a (runtime `5e7d5d6b`) is exactly59 original IDs: Settings Devices10,
pairing5, outside11, Connections25, plus B1R Connections7/startup1.
Disposition is **55 pass,3 source N/A,1 owner-only planned**, not all Settings.
Original Devices revoke now prevents reentry and reconciles failed/unknown
outcomes read-only. Outside submit/feedback and confirmed navigation retain
their original Settings/Profile/epoch caller; confirmations name the saved
URL. Original authorization loss closes stale Muse Settings. All33 added/
10 removed lines are in three web files; original auth/Host/Profile/grant,
Main/Side/draft/attachment/quote and persistent owners remain unchanged.

Actual original outside and Host-switch links reach a separately paired owned
TLS Host. Both pending guards were reached, including a real intercepted
browser file chooser completed after the original Leave ask opened; no OS
picker/permission or app-state override. Native EN/ZH, dark/System desktop,
light390/touch/reduced motion, keyboard/focus and nonzero scroll were exercised.
The three source N/As are only the synchronous Host-switch submit's nonexistent
awaited pending/remote-rejection/late-reply states, not waived real I/O.

Exact remainder `UX-B-app-start-2831-rendered-state-8bcedc8`: original trusted
LP-03 grants actually admit/reuse/refuse with201/200/403/404 and preserve the
independent phone invitation, but same-document failed reentry can remain
covered by the preceding first-use onboarding sheet. Its captured pixels are
rejected. Correct the original presentation owner's retirement without
silently acknowledging the disclaimer or discarding/replaying pending work;
do not infer completion from API/pending proof or reopen a full E1 audit.

43 actual image deliveries are31 accepted/12 rejected/0 historical,1,553,188
encoded bytes, zero withholding; one separately captured exact-raster alias
is retained without counting another view. Text minimum4.5024948619197485 and
semantic nontext3.3609857091517106 are actual stable unrounded paint values.
The unchanged ordinary unpaired Connect button's2.1098110773113743 contrast is
an explicit rejected outside-59 legacy observation, not an accepted new Muse
page. No-env lint/build/six types and9 maintained protocols/149 assertions pass;
five actual native graphs and758 native/207 resource-project hashes are
unchanged. No native compile, storage matrix, supervisor/promotion or V95 claim.
The full2149-ID historical overlay is1028 pass/506 planned/598 blocked/17 N/A;
four unavailable external features,22 Mac preflights,597 native blockers and the
separate E1R notification-error blocker retain their honest dispositions.
All53 owned runs are stopped/retired, selected originals and source/rollback
remain,50 unviewed rasters are exactly removed, and protected310/PID45320 stays
healthy and untouched. Authorities: `files/muse-ui-state-ux-e2a-results.json`
and `files/muse-ui-connections-handoff.json`. Next: the exact startup owner1,
then separate E2b47/E3security54 and F–I/features/promotion.

UX-E1R (runtime `f8da04f3`) continues **only the exact nine** E1 remainders:
eight self-UI passes and one genuine notification-error blocker. Actual saved
machine `Settings.more`, machine Pair/Edit fields, Profile Skills New/Upload/
open/cancel, and real nonempty conversation Export download → Profile file
input → import confirmation/adoption were exercised through their original
owners. Three scoped Muse CSS lines correct actually viewed/checkpointed
placeholder and light switch REDs; no runtime, storage or native owner changes.
The pre-denied owned Chromium uses `--deny-permission-prompts`; its unmodified
native request probe returns non-granted without throwing, while the actual UI
returns before Allow/subscription. The exact `notifications-error` catch is
unaccepted, not inferred from denied UI or fabricated by granting permissions.

The28 actual CSS-scale image deliveries are21 current accepted/5 rejected/
2 historical,762,192 encoded bytes, zero withholding. Actual text minimum is
4.5024948619197485 and semantic nontext3.3609857091517106, unrounded. Normal
no-env lint/build/six types and11 maintained protocol cases/393 assertions pass;
five actual native graphs and758 native/207 resource-project hashes are
unchanged. Full2149-ID history is973 pass/564 planned/598 blocked/14 source N/A:
597 native blockers plus the one web notification-error blocker. Original
four unavailable external features remain planned despite E1's honest self-UI
passes;22 Mac preflights and native16 remain unaccepted. No all-Settings,
native compile, physical notification, storage-upgrade, supervisor, promotion
or V95 claim. Private authorities are `files/muse-ui-state-ux-e1r-results.json`
and `files/muse-ui-settings-finish-handoff.json`; all prior evidence stays
historical/specific, not blanket current acceptance.

UX-E1 core Settings/onboarding (runtime `77fbfe50`) is a bounded72-ID review:
Settings52, notifications7, onboarding12, shared field/help1. Disposition is
62 self-UI pass,9 exact owner-only planned,1 source N/A; not all Settings/Muse.
Fresh owned first-use disclaimer, Settings card/action/error contrast, stale
Saved entering a failed new form and native Chinese Profile validation have
actual viewed RED/checkpoint/GREEN. Original Profile/MEMORY owners, unknown
responses, safe browser-only signout and tiny owned Git ranges were exercised.
The9 remaining IDs are Settings.more5 (Models/Secrets owners), composite
Models/Host field-help1, unauthorized notification-request error1, Skills
dependent control1 and original package import/export UI1. Protocol package
coverage does not replace the last UI gate; the reused exportable-turn fixture
failed before its loopback model was reached.

47 original CSS-scale deliveries are33 current accepted/10 rejected/4 historical,
1,561,028 encoded bytes, zero withholding. Normal no-env lint/build/six types
and11 maintained protocol cases/374 assertions pass. Five actual native graphs,
758 native and207 resource/project inputs are unchanged; no native compilation,
physical notification, storage-upgrade, supervisor/promotion or V95 claim.
Full2149-ID history is965 pass/573 planned/597 blocked/14 source N/A, not a
blanket current visual score. Native16 and22 Mac preflight dispositions remain
unchanged. Private authority: `files/muse-ui-state-ux-e1-results.json` and
`files/muse-ui-settings-core-handoff.json`. The75-minute timing target was
exceeded; remaining work was stopped at this finite boundary, not waived.

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
| Muse chart-state packet UX-D1 | original web Markdown/diagram/file/HTML owners and six registered bundled numerical families | Exact92 original inventory IDs in private `muse-ui-d1-plan.json`; actual source-labelled synthetic render/interaction review, not all33 families or native acceptance |

These are change-routing entries, not claims that every feature/device/network combination is accepted. Add detailed cases when work first touches a feature; do not invent pass results for this inventory.

## Muse bounded chart-state packet UX-D1

UX-D3b freezes exactly40 original UX-D IDs, four each for packet, info,
railroad, agentflow, treeView, cynefin, wardley, eventmodeling, usecase and
ishikawa, at clean902fd521. The private `muse-ui-d3b-plan.json` fixes the
inventory hash, exact IDs, original Host/Pi/import/file/Markdown callers,
canonical grammar owners and pre-edit V2 conditions. Actual supported
topology/labels/source, truthful refusal, readable CJK/compact output and
EN/ZH keyboard/touch/zoom/copy/current-caller return require behavior and
delivered-pixel evidence. Info's supported visible title is distinct from
its fixed package-version body; no invented label syntax or visible-comment
claim is permitted. View RED, checkpoint main, then minimally fix the
existing public model/font/native-scale/palette/refusal boundary if needed.
Stop all image opens/retries/recapture at first explicit withholding and
record unviewed gaps. No progress/QR/voice, native16, iOS, physical, V95,
promotion, full33/all92 or whole-Muse acceptance follows from this packet.
Before any production edit, two original RED image payloads were actually
delivered and reviewed: packet's noncontiguous-bit semantic refusal remains
silent ordinary code; info's supported CJK title renders with a fixed version
body whose actual light contrast is3.260528410471992, below4.5. Info also
receives the default guessed font rather than the current System/CJK
measurer. The exact source hashes and honest review chronology are retained
in private `muse-ui-d3b-viewer.json`; a generated source-panel frame remains
unviewed. This main checkpoint precedes the narrow existing-path fix.
The first20-source primary pass also exposes a genuine Cynefin RED:
its fixed central Disorder subtitle is4.421085898598831 against the actual
composited tinted region, despite the ordinary muted token passing against
the container. The original source-correspondent raw image was actually
delivered and reviewed before the next color correction. This checkpoint
preserves the first narrow path change and that exact remaining failure;
it does not claim20 sources or40 rows accepted. Reuse the existing public
foreground theme token for Cynefin subtitles, preserving its geometry,
five fixed domains, source-declared two domains and transition.
The ten critical ZH/light390 sources then reveal a second exact tinted
text boundary: eventmodeling frame01 has3.694519304323394 contrast against
its actual command fill. Its original two-lane/two-frame/01-to02 relation
and CJK data were actually delivered and reviewed before the next change.
This checkpoint keeps the tested Cynefin foreground correction and records
the remaining event frame-ID failure. Use the same existing public
foreground token for eventmodeling's muted labels; do not alter frame data,
entity identity, lane order, relation, SVG shapes or canonical typed owner.
The final minimal renderer source is16 additions/4 removals from902fd521.
Actual30 declared source conditions pass266 primary and191 compact
behavior checks; all20 positive SVGs pass actual composited text4.5 and
semantic nontext3, including line geometry. Info has text-only output,
so semantic nontext and custom version-body labels have precise
canonical-source N/A proofs, not invented shapes or whole-row N/A.
Original confirmed import, missing/transport/empty source distinctions,
renderer transport recovery, both off-mode preservation checks and only13
earlier numeric/temporal/work positive/source-invalidation smokes pass.
Normal no-env lint/build/six types and28 maintained protocols/1407
assertions pass. Canonical typed owners and712ab877 resource are unchanged.
Final source-correspondent pixel review, genuine normal Mac compilation,
actual native/resource/project/agent graph hashes, clean NORMAL package
and actually served renderer/current-client bytes remain delivery gates.
iOS remains explicitly deferred, not passed; storage owners are unchanged.
Those final gates now pass at runtimeb320d73d:758 native files,207
resource/project files and five actual agent graphs are unchanged; genuine
normal Mac compilation and the clean NORMAL Preview package independently
pass. The package retains and actually serves712ab877 plus byte-matched
current client assets. Two in-checkout package preflights were truthfully
rejected before an archive/runtime existed; the final normal invocation
honors the canonical outside-checkout output guard, without changing it.
Exact40 dispositions are40 pass. Viewer use voluntarily stops at39 actual
payloads/656,884 encoded bytes:34 current-UI, one normal-package technical
and four rejected RED images, zero withheld/historical/diagnostic deliveries.
Cynefin's compact left extent plus native-width original viewer extent and
Wardley's real scroll use at most two accepted frames per source; generated
unviewed captures are never relabelled viewed. All18 owned paired runs, two
build caches and59 unselected/unviewed rasters are cleaned; selected raw
RED/GREEN, normal packages/native archive/source/rollback remain.
Private `muse-ui-state-ux-d3b-results.json` and
`muse-ui-other-diagrams-handoff.json` retain the exact40 cases and complete
2149-ID overlay:874 pass/665 planned/597 blocked/13 source N/A, not a
blanket current old33/all92 acceptance. Remaining UX-D scope is precisely
progress/QR/voice29 and native visual16; E–I/features/promotion remain open.
Protected installed310/PID45320/data, parent pointers/counters and old
labels are unchanged. iOS, native16, physical, promotion and V95 remain
unaccepted; missing frozen Muse references block V95 only, not self-UI.

UX-D3a freezes exactly40 original UX-D IDs, four each for flowchart, er,
mindmap, class, state, architecture, requirement, sequence, c4 and block.
The private `muse-ui-d3a-plan.json` records the immutable IDs, original
Host/Pi/import/file/Markdown/diagram callers and pre-edit V2 conditions.
Actual source topology, truthful refusal, readable CJK/compact output and
EN/ZH keyboard/touch/zoom/copy/current-caller return require separate
behavior and delivered-pixel proof. An explicit image-withholding response
stops all further image opens and capture retries; any affected rows remain
unviewed, never retrospectively accepted. No remaining ten diagram families,
native16, iOS, physical, promotion or V95 acceptance follows from this packet.
Before the upcoming root fix, actual payload-delivered original RED shows
flowchart invalid syntax silently left as ordinary code and C4 light-mode
stereotypes at2.9644760775970473 contrast, with396px output reduced to350px.
The source trace confirms these relationships bypass existing Muse public
model/font/native-scale/refusal/palette handling. A separate readable
sequence image is diagnostic, not falsely reported as visible clipping.
Private `muse-ui-d3a-red-viewed.json` preserves the honest pre-fix chronology.
The minimal web-only fix now routes exactly these ten adapters through the
existing gated public-model/System-CJK/native-scale/refusal/palette path.
Canonical typed owners and712ab877 resource bytes are unchanged. Actual30
source conditions and critical10 compact variants preserve exact identities,
cardinalities, classes, actors and edges; original confirmed import, both
off modes, renderer transport recovery and13 earlier positive/source smokes
are bounded dependencies, not expanded state acceptance. Normal lint/build,
six types and28 maintained protocols/1406 assertions pass. Genuine normal
Mac compilation and758 native/207 resource-project/five actual agent graphs
confirm no native/resource change. The normal packaged/served-byte gate,
final original-ID overlay and exact cleanup remain final delivery gates.
Those final gates now pass at runtime58edd1e4: the clean NORMAL Preview
package retains and actually serves the current712ab877 renderer and
byte-matched current client assets. Exact40 dispositions are40 pass;49
actual image payloads total892,524 encoded bytes:41 current-UI evidence,
one normal-package technical image, six rejected images and one diagnostic.
No withholding occurred; the four insufficient inline frames remain
rejected, not backdated. All24 owned paired runs, two build caches and29
unselected/unviewed rasters are cleaned; selected raw proof and normal
archives remain. Private `muse-ui-state-ux-d3a-results.json` and
`muse-ui-relationship-diagrams-handoff.json` retain the complete original-ID
overlay, historical33 applicability and exact remaining scope. iOS,
native16, physical, promotion and formal V95 remain unaccepted.

UX-D2bR continues only the two GitGraph branch-order IDs retained below.
Before any typed edit, `muse-ui-d2br-red-owner-proof.json` verifies the
actually delivered/viewed nonfinite-order RED against current37778713
renderer bytes, original pinned Git parser/db archive members and the
complete canonical build-input digest. This upcoming repair therefore has
real viewed RED beforehand; it does not backdate the previous D2b viewer
deviation. The private D2bR plan freezes finite/representable validation in
the original Git order owner, preserving supported defaults, ties, finite
fractional configuration and topology. Normal pinned regeneration, focused
source/rendered GREEN, original served protocol, normal source/Mac/package
and resource-graph gates remain required; no broad audit or iOS pass follows.
The targeted owner fix now compares each original INT token with its
finite numeric value before spelling is discarded. Exactly representable
orders beyond2^53 remain valid; rounded neighbors refuse with the existing
semantic PeleError. Numeric main configuration retains its supported
finite/fractional/signed Number semantics, defaults/ties and topology.
Normal pinned regeneration is682977 bytes; focused18 actual source cases,
the single critical ZH refusal, normal lint/build/six types and28 affected
protocol cases/1407 assertions pass. Genuine normal Mac compilation and
758 native/207 resource-project/five actual agent graphs identify only the
intended Pele native-resource change. Clean normal packaged/served-byte
proof and new GREEN pixel delivery remain final gates; withholding means
viewerGAP, never success. Earlier D2b30/correction records remain immutable.
UX-D2bR closes exactly those two IDs at runtime03976f87. The clean NORMAL
Preview package retains and actually serves712ab877 renderer bytes,
executes both original invalid-order refusals and preserves safe lane order.
Three tiny original GREEN components were actually delivered through the
same viewer,56,472 encoded bytes, with no withholding or slot-reset
assumption. The viewed pre-fix RED, focused18-case/92-check data GREEN,
critical ZH9 checks,13 unchanged valid/duplicate raw outputs and small
six-family38-check smoke are source-labelled independently. Six owned
runs/build caches and two unselected rasters are cleaned; normal packages,
archives, source and old proof remain. New results/handoff are
`muse-ui-state-ux-d2br-results.json` and `muse-ui-gitgraph-order-handoff.json`.
Prior D2b30 and its chronology correction remain byte-identical; this is
not a full32/92/140 re-audit, native16/iOS/physical/promotion or V95 acceptance.

UX-D2b is restricted to32 original UX-D Pele obligations: Kanban8,
Journey8, GitGraph8 and Swimlane8. The private pre-edit
`muse-ui-d2b-plan.json` freezes the immutable IDs, canonical public models
and original paired file/Markdown plus conversation/import workflows.
These are source-declared diagrams, not task management, live Git,
provider state or calendar integrations. Date/timezone subclauses require
specific canonical-model N/A proof, not invented dates or blanket row N/A.
Empty, invalid, nonfinite or topology-losing input must retain usable exact
source rather than normal blank/coerced output. Actual rendered RED and a
main checkpoint precede minimal fixes. The existing double gate, owners,
checked-delete safety and off/default behavior remain intact. Shared-code
changes require only the earlier six numerical-family smoke, not a repeat
of the accepted28 temporal rows or a full33-family audit. Normal source
gates and medium protocol selection remain mandatory; resource changes
also require pinned normal regeneration, genuine normal Mac compilation
and normal clean packaged/served renderer-byte proof. The explicit
chart-only iOS deferral is not native16, physical, promotion or V95 approval.
The actual source-correspondent RED is retained at
`muse-ui-d1/red-d2b-red-readable-1794830214747-9b31ca88`.
Journey renders a declared NaN score as a normal neutral3; duplicate Git IDs
silently replace an earlier commit and retain a self-parent; empty Journey,
GitGraph and Swimlane produce normal output without data. Empty Kanban
retains code without an explanatory reason. Four original readable images
were actually delivered and reviewed before production edits. The initial
tiny empty-chart crops are unaccepted diagnostics, not visual acceptance.
The first public-model guard now rejects empty diagrams, invalid Journey
scores and Git duplicate/self-parent topology without changing Pele bytes.
Real desktop and compact runs expose a distinct Swimlane lane-label RED:
secondary text on the actual lane band is4.313625571897182 dark and
4.116343557422093 light, below4.5 without rounding. The original dark
Swimlane and light compact long-CJK frames were delivered and rejected
before a scoped public-theme correction. Native glyph inspection confirms
the apparent Kanban/Journey/Swimlane long-label failures are a private
harness raw-XML comparison error: wrapped text is complete, not lost.
Actual adjacent-paint checks then expose light-theme card/tag outlines
at2.9644760775970473 and Swimlane band outlines at2.7102311890136304,
not3. The light Kanban/Git source pixels and earlier Journey/Swimlane
pixels remain rejected for those conditions. A real owned renderer-script
transport abort retains all four exact sources but gives no unavailable
reason; its actual code-only frame was delivered before repair. The
private reload probe initially forgot the original app's normal return
route and is diagnostic, not a product recovery failure. These precede
work-only public border tokens and an explicit Muse renderer-load notice.
Matching GREEN passes all37 explicitly synthetic grammar/data conditions
and critical EN/System1285×736DPR2 plus ZH/light390 coarse/reduced-motion
workflows, with exact source/copy, real keyboard/touch pan, source scroll,
current focus and source-retirement checks. Original confirmed conversation
import/Pi projection and actual renderer transport failure/reopen recovery
also pass. These four families use the existing public parse/model/font
path; original model identity preserves the Swimlane adapter. Work borders
use the existing line token, Swimlane lane labels use foreground, and
renderer-load failure exposes an honest unavailable notice plus exact code.
Current text is at least4.5024948619197485 and actual adjacent nontext
at least4.116343557422093, unrounded. Normal lint/build/six types and the
maintained28 protocol cases/1393 assertions pass. Genuine normal Mac
compilation and all758 native/207 resource-project bytes plus five actual
agent graphs are verified; all native inputs and the682705-byte37778713
Pele resource/typed provenance remain unchanged. No regeneration is needed
or claimed. Full selected-pixel review and a clean normal packaged/served
runtime remain final delivery gates; iOS/native16/physical/V95 stay pending.
The final bounded grammar trace finds two unaccepted GitGraph obligations:
`UX-D-pele-Ib-gitGraph-1-bundled-renderer-state-a72a562` and
`UX-D-pele-Ib-gitGraph-1-bundled-renderer-state-4076eec`.
Actual clean69366011 paired sources with320-digit and unsafe-integer branch
orders still render normal diagrams. Safe maximum9007199254740991 correctly
retains explicit main/early/late lane order; its original pixels and the
nonfinite RED were delivered. `git/parser.ts` converts the supported INT
with parseInt; `git/db.ts` loses the numeric orders when publishing lanes,
so frontend public-model validation cannot recover them. This is a genuine
canonical-owner follow-on, not calendar/date N/A. The unchanged37778713
resource proves it is not introduced by the validated web repair.
Freeze the precise owner-only remainder instead of adding a rushed typed
fork near the45–60-minute boundary: canonical finite/representable branch
order validation, normal pinned regeneration, focused public served-renderer
RED/GREEN, actual native/resource hashes, genuine normal Mac compilation
and a clean normal packaged/served renderer gate are all still required.
The other30 original rows can close at their exact reviewed conditions;
these two stay planned. No other families or prior28 audit were added.
Viewer correction: earlier UX-D2b statements that initial frames were
delivered/reviewed before repair are withdrawn. The first25 image opens
explicitly withheld pixels; later13 current originals and one historical
NaN RED were actually delivered through the same viewer, without resizing,
reencoding, alternate paths or backdating. Actual delivery is50 images:
47 current positive UI, one normal-package technical and two rejected
(one historical NaN, one current invalid Git order). Eleven initial
historical/crop originals remain unviewed. Actual encoded payload is
1,239,720 bytes; generation/open success is not review. Current positive
pixel coverage recovered, but the initial before-fix viewer chronology
gate was not met and remains an explicit process deviation, not a waiver.
Bounded disposition is30 current-condition passes and two planned owner
rows, not all32 completion. The full2149-ID replay is792 pass/747 planned/
597 blocked/13 source N/A; prior33 and prior28 keep their original labels.
Both independent off gates/default, current six-family38-check smoke,
normal Mac package/served bytes and exact owned cleanup are recorded in
`muse-ui-state-ux-d2b-results.json` and `muse-ui-work-charts-handoff.json`.
No persistent owner/schema, Pele resource or native project changed;
no storage-matrix rerun, iOS/native16/physical, promotion or V95 acceptance.

UX-D2a is restricted to28 original UX-D renderer obligations: Venn12,
Gantt8 and Timeline8. The private pre-edit `muse-ui-d2a-plan.json` freezes
their immutable inventory IDs, canonical grammar, source semantics and V2
workflow. It uses the original paired Markdown/file/chart/source pipeline,
not analytics/provider fixtures. Timeline labels are declared-order text,
not parsed dates; Venn sizes are relative areas with documented grammar
defaults; Gantt dates and dependencies must remain truthful. Empty/error
output needs usable exact source, not a successful blank SVG. Only these
three families receive state acceptance; shared changes require the earlier
six numerical-family regression checks. New Muse frontend remains double-gated.
Resource changes require pinned typed regeneration, normal Mac compilation
and normal packaged/served renderer-byte proof. The explicit chart-only iOS
deferral grants no native16, physical, promotion or formal V95 acceptance.
The first actual paired RED is retained at
`muse-ui-d1/red-d2a-1794825817919-06a94abd`: explicit Venn zero draws a
positive circle, invalid Gantt duration becomes zero-duration normal output,
and empty Timeline draws a successful blank SVG. These three original
CSS-scale images were delivered and viewed before any production fix.
Gantt unknown dependency, impossible date, reversed range and nonfinite
duration also produce misleading normal output. The private harness's
trailing fence newline comparisons are diagnostic test errors, not product
failures; canonical Markdown removes that delimiter newline. This checkpoint
precedes both the surgical chart repair and corrected matching GREEN.
Matching current behavior passes41 explicitly synthetic data/grammar conditions
plus the critical EN/System and ZH/light390 keyboard/touch/source/scroll
workflows. Canonical Gantt scheduling now rejects invalid, unresolved,
unanchored or reversed inputs; declared/default ISO dates and Unix seconds
remain truthful. Venn zero, missing, nonfinite and unrepresentable area input
is explicit source-preserving refusal, not a coerced circle. Timeline remains
literal declared-order text, never an invented calendar/provider scale.
Normal pinned regeneration produces682708 bytes,
`d72e451e04413c68b12512f0130c69769fe3012df0601cef9fd290e66fadf181`.
The original28 protocol selection passes1392 assertions; normal lint/build/six
types, genuine normal Mac compilation and758 native/207 resource-project
hash checks pass. Only Pele changes within native inputs; five actual agent
graphs remain identical. Clean normal package/served-byte proof and final
viewer acceptance remain delivery gates, not inferred from these checks.
Actual viewer review rejects the current Venn long-CJK image: region labels
overlap despite fitting the outer SVG. The unchanged clean3b03c214 image is
preserved, and `red-d2a-cjk-red-1794827499917-04c7cf0b` reproduces the real
22.879974365234375×5.6199951171875 glyph-bound collision before repair.
Use the canonical existing fixed-width label fitter, not SVG rewriting or
smaller text. Earlier behavior-only GREEN is not this row's visual acceptance.
The canonical existing `fitLabel` now wraps only region labels that exceed
their measured room. Set geometry, values and font sizes are unchanged;
Venn render complexity remains49 decisions. Matching actual glyph bounds,
all41 data conditions, critical compact/touch/source states, original off modes
and six-family smoke pass. The final normal regeneration is682705 bytes,
`37778713ca632e2aaaa2e3b21f85430f3fd44cb9968245743590f0acde0ea90b`.
Normal lint/build/six types, normal Mac compile, current native/resource hashes
and the maintained28-case/1394-assertion protocol packet pass again. The earlier
d72 package/proofs retain their original source labels; a new clean normal
package and actual final pixel review are still required for this fitter.
Final layered-paint review finds a separate Venn contour RED: the first
circle stroke under the later circle's20% fill is2.892085739968626 against
their actual overlap region, not3. The actually viewed blue/orange source
pixels and `red-d2a-boundary-red-1794828861337-f995c7e0` remain rejected for
that condition. This precedes a Venn-only existing-theme-token correction;
outer-SVG/container-only contrast is not accepted as composited proof.
The existing teal chart token now applies only to Venn's first series through
Pele's public theme variables. Actual dark/light layered-neighbor contrast,
all41 original-condition datasets and critical compact/interaction states pass;
Gantt/Timeline, off modes and the earlier six numerical families are unchanged.
Normal lint/build/six types and28 maintained protocol cases/1392 assertions
pass. Pele/resource/native inputs remain the already Mac-validated37778713
bytes; final current static-package bytes and six bounded colour frames follow.
UX-D2a closes exactly28 original IDs at runtime `cba9ae39`: Venn12,
Gantt8 and Timeline8. All41 synthetic data conditions, critical real
keyboard/touch/pan/scroll/source/return states and current composited roles
pass; unsupported date/unit/legend clauses have narrow canonical-source
proof, never blanket row N/A. Current normal packaged/served renderer and
static-asset bodies match the clean runtime. iOS/native16/physical/V95 remain
unaccepted; no storage/owner/authority change or promotion is implied.
Actual viewer accounting is67 deliveries:60 accepted evidence records
(56 current-condition UI, one normal-package technical and three
historical-only records), seven rejected,1,531,456 encoded bytes. One of the
56 is explicitly unchanged-focus-only, not old Venn-palette acceptance.
The60-minute aim was exceeded; the bounded75-minute workstage and1.5MiB
image target are not conflated. Exact owned cleanup and independent2149-ID
replay yield762 pass/777 planned/597 blocked/13 historical source N/A,
not selected-count addition or all92/current33 acceptance. New authorities
are `muse-ui-state-ux-d2a-results.json` and
`muse-ui-temporal-charts-handoff.json`; parent pointers/SQL and old labels stay
unchanged. This final delivery changes documentation/evidence only.

The UX-D1R continuation is restricted to the exact59 unaccepted IDs frozen in
private `muse-ui-d1r-plan.json`; the prior33 accepted IDs and original inventory
remain immutable. Assess canonical1.6.0 public parse/model-validation, render,
configuration and font-measurement APIs before requiring a resource edit.
Review retained source-correspondent pixels rather than recapturing unchanged
states. Chart resources remain unchanged without an explicit chart-only native
gate decision; the atomic-deletion exception does not apply.

UX-D1R closes those exact59 web obligations at runtime `bf49145e`, not another
92-row audit or all33-family/native acceptance. Public parsed-model validation
rejects unsupported/nonfinite/no-record/zero-area input with unchanged usable
source; loaded-font measurement and native-scale real scrolling preserve CJK
labels and XY legends. Necessary canonical typed fixes are limited to Sankey
Unicode/strict amounts/link-text-node contrast and multiseries radar
geometry separators/dashed legend. The original complete upstream1.6.0 build
first reproduced immutable `b82d1bcd`; the regenerated682534-byte resource is
`09b690376c075c1ca11d4051fe20f211a9d05590e4bfbfd1d2028a8501d00769`.

Current numerical258, actual compact overlap/right-scroll, source38/System38,
font recovery10, numeric edges40, real form14/import6, load recovery5 and
original HTML43/53 checks pass. The original maintained medium protocol packet
passes28 cases/1381 assertions; normal no-env lint/build/six types pass. Five
actual native agent graphs are unchanged, but the758-file/207-resource-project
inspection correctly identifies Pele as changed. Genuine normal
`ai.openox.host.local` Mac compilation and an actual clean normal Personal
Preview package/launcher verify packaged and served renderer bytes; relocatable
asset names do not change executable bodies. Only this chart repair has explicit
approval to defer iOS compilation; iOS/native16/physical/V95 remain unverified.

Exactly delivered readable original pixels, including small source-correspondent
pages with verified unchanged RGBA, are recorded in new private
`muse-ui-state-ux-d1r-results.json` and `muse-ui-chart-finish-handoff.json`.
First25 withheld opens are withdrawn, not counted as review. Complete delivery
used2634548 encoded bytes and exceeded the approximate1.5MiB and timing targets;
no within-budget or short-duration claim is made. Prior33 historical passes,
original source/image labels, atomic-owner evidence and parent counters remain
unchanged; no blanket current-pixel inheritance or all92/whole-Muse claim is
made. Original-ID overlays, including atomic5/C2b/C3/C3R/D1, reduce the2149-row
historical ledger to734 pass/805 planned/597 blocked/13 source N/A. No owner,
schema, encoding or execution-authority change requires a storage-upgrade rerun.

Baseline `b9316914` follows closed C3R. Before production edits, the private
`muse-ui-d1-plan.json` freezes all20 original Markdown/diagram/file/HTML rows
and12 original rows each for pie, quadrantChart, xychart, sankey, radar and
treemap. Original inventory SHA-256 remains
`142c73fcafeb909aaedc1fa783afe3172ba7eaea8594cfaf276ffa771d6e2047`.
Use the existing paired private gym and maintained protocol runners.

| Workflow | Setup and actions | Required visible result and invariants |
| --- | --- | --- |
| D1-NUMERIC | Original paired public Markdown file; exact current renderer DSL; valid/invalid/long-CJK/zero/empty/missing/single/negative/extreme/multiple inputs | Accurate units/range/source, no false normal or missing-to-zero conversion, usable focusable exact-source alternative and non-color values |
| D1-GLUE | Original file/conversation/link/image/frame and nested diagram viewer; keyboard, touch, source/copy, real zoom/pan/scroll, close/late-source replacement | Current source and original caller focus preserved; real loading/failure/recovery/cancel, no unavailable-source substitution or OS clipboard effect |
| D1-HTML-GUIDANCE | Original sandboxed public HTML/SVG with explicitly synthetic input, table and provenance | Exact source/units/invalid/missing states agree; original approval/form/page/epoch boundaries preserved, not arbitrary future output certification |
| D1-DEPENDENT | Both Muse gates and ordinary/personal-only off; affected file/sandbox/capability protocol checks | No new owner/store/renderer; native graph plus actual resource/project inclusion/hash proof; normal lint/build/six types |

Actual baseline six-family paired RED is retained privately at
`muse-ui-d1/red-red-1794802084393-950acaee`. All six render valid charts but
expose no usable keyboard-focusable source alternative; actual pie render and
viewer pixels were delivered and viewed. Pointer-pan observations require
matching fit/zoom geometry before they can be classified as product defects.
Separate canonical1.6.0 numerical probes are syntax/SVG diagnostics, not
rendered acceptance. Genuine bundled parser/render defects must retain exact
blocked IDs if native validation is unavailable; the atomic-deletion iOS
exception does not authorize chart-resource changes. Foreground V95 remains0.

First wrapper checkpoint adds double-gated inline/viewer exact-source controls,
keyboard-scrollable source, and exact-source replacement focus return. Original
renderer CSS variables are applied through the SVG root DOM API, not regex
output patching. Six-family interaction68 and actual load-failure/reopen5 checks
pass; source and failure pixels were actually viewed. Normal lint/six types and
build pass. Actual five native input/output graphs,758 tracked native files and
207 resource/project files match `b9316914`, including Pele's original hash.
No native compile or storage/atomic campaign is claimed.

Further actual RED is preserved in private `red-audit-1794802540942-f30e5bc0`,
`red-audit-1794802677878-5675e113`, `red-lifecycle-1794802677944-230984e8`
and `red-resize-1794802677784-2cefb5b9`: actual SVG text contrast3.8550701524817583
on dark blue and2.5452396422570263 on light orange, stale open-viewer System
theme, and desktop-width cache shrinking compact text. These are not accepted
chart states. Protocol selectors must include the original runners' conversation
setup prerequisites; omitted prerequisites are harness failures, not product
failures or passed checks. The preceding documentation checkpoint's commit-body
LOC estimate was35; its actual reviewed diff was27 added documentation lines.

Second wrapper checkpoint fixes container-width cache keys, native-scale
horizontal recovery at the renderer's real minimum width, and open-viewer
System theme refresh. Supported theme variables correct only the six selected
numerical families; other27 families are not a palette acceptance claim.
Actual six-family theme38, compact22, dark/light SVG38+38, original sandbox
handoff9 and maintained protocol28/1383 checks pass. Normal lint/build/six types
and actual five graphs plus758 native/207 resource-project byte comparisons pass.
Further six-family actual source-owner replacement RED is retained privately at
`red-source-1794803504032-dd385a15`: the old viewer survives a real source
overwrite and cannot return to its surviving original file control. Fix this
local viewer lifecycle before accepting source-unavailable conditions.

Third wrapper checkpoint retires the open diagram when its real source owner
removes/replaces that source, restores the exact surviving file control, and
disconnects its local observers. Six actual original-owner replacement38 and
System lifecycle38 checks pass; normal lint/build/six types and native graph/
resource comparisons pass again. Original source labels and prior native
numerical defects remain unchanged. Actual standalone HTML loading is now RED:
`red-html-1794804121903-8797086f` holds the genuine frame request and exposes a
blank white surface without loading feedback. Source-correspondent canonical
plot/table fixtures otherwise pass37 checks; nonfinite author validation is
explicitly not a canonical renderer fix or arbitrary future HTML certification.

Standalone HTML loading now uses the original source-height acknowledgement,
existing native loading copy/status and an opaque themed surface. Actual
HTML loading/access/late-close40, six-family trusted-touch94, final source-role92,
EN-light80/ZH-dark80, three off-mode9+9+9 and original off HTML6 checks pass;
normal lint/build/six types and28 maintained protocol cases/1382 assertions pass.
Further real OS/symlink-denied reader RED is explicit in
`red-html-1794805147437-2c87cc2b`: original HTTP400 EACCES/symlink refusals still
look like transport failures. Existing Files already has the correct trusted
denial predicate; align only this original viewer caller, without changing
permission/source/API authority.

The original viewer now uses that existing trusted denial predicate, preserving
private-source404 and ordinary/off behavior. Actual EN/ZH original OS/symlink
denial43+43 checks and native44px recovery pass, with matching readable source
error pixels viewed. No owner/API/permission/storage changes are involved;
normal lint/build/six types and native graph/resource proofs pass again.
Final per-ID rendered review and exact unviewed/native-blocked remainder are
recorded separately; no blanket92/all33/native/whole-Muse acceptance follows.

Delivery audit correction and finite handoff: the first25 D1 image opens
explicitly withheld their pixels. All earlier D1 checkpoint wording that
called those opens viewed/accepted is withdrawn by the independent
`muse-ui-d1-viewer-corrections.json`; capture/source labels remain unchanged.
Only41 actual image deliveries count:33 accepted,7 rejected,1 diagnostic.
Exact92 original IDs are33 pass/20 blocked/39 planned, not full closure.
Actual compact quadrant/XY CJK clipping and overlapping XY line/bar contrast
remain open; standalone DOM checks do not override the rejected pixels.
Normal clean-runtime lint/build/six types,28 original protocols/1382 assertions,
five native graphs and actual758 native/207 resource-project byte comparisons
pass at `5f2294fb`; native compile/physical UI and formalV95 remain0.
Exact cases, retained unviewed evidence, native prerequisites and cleanup are
in private `muse-ui-state-ux-d1-results.json` and
`muse-ui-data-charts-handoff.json`. Prior C2b/C3/C3R evidence and parent
pointers/counters are unchanged; later D families and E–I remain separate.

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
