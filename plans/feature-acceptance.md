# Feature acceptance

Owner requested a reusable feature-to-case map on November 11, 2026. A changed feature must name the affected case IDs, run the matching bounded packet and record actual results before handoff. Passing source checks does not prove a rendered user outcome. Use the existing protocol, storage-compatibility and eval suites; do not create a fourth general test suite.

## Change gate

Identify affected features from behavior and shared dependencies, not just filenames. Before editing, add missing cases with setup, user actions, expected visible states and authorization/data invariants. After editing, run the smallest affected packet plus required source gates. Record build, client, network/fault method, case outcomes, screenshots and cleanup outside Git. Mark unexecuted or simulated conditions explicitly; a mobile viewport is not a Simulator, a Simulator is not a physical phone, and an unavailable endpoint is not proof of disabled radios or a real cellular route.

Changes to shared authentication, transport, storage or UI helpers also run their dependent feature cases. Failures introduced by the change block delivery; an unavailable required environment must be reported, not silently counted as a pass. Never modify a shared machine's networking, real credentials or other people's work to inject failures. No automated retry of an uncertain mutation.

## Feature map

| Feature | Current source boundary | Required packet / existing evidence lane |
| --- | --- | --- |
| Pairing and local Host console | `apps/linux/src/auth.ts`, console scripts, `web/host-console.*`, pairing UI in `web/app.ts` | PA below; existing Host protocol and Mac archive checks; actual Safari/Simulator UI packet |
| Connectivity and session recovery | `src/server.ts`, `src/api.ts`, `src/connections.ts`, web events/client and connection settings | CN below; Host protocol, local-connections and workspace packets |
| Host/workspace selection | native Host settings, `web/settings.ts`, workspace context/navigation | Two-Host workspace packet; pairing/session isolation; unsent work guard |
| Conversations and model selection | profile/runtime, web composer/transcript and providers | Existing Client-Host conversation/provider protocol; send/failure/recovery; targeted native/browser review |
| Files and attachments | filesystem, upload/content routes, file viewers/composer | Existing filesystem/media protocol; upload/read/delete-confirmation; interrupted-write and access boundaries |
| Services, login and approvals | VM services/repositories, web prompts/viewer | Existing services/repository/browser protocol; approval deny/cancel/allow; credentials excluded from output |
| Schedules, skills and memory | profile/VM workspace, web capabilities/settings | Existing workspace protocol; create/pause/resume/delete, persistence and missed schedule; targeted UI |
| Remote browser and media | page/browser routes, viewer/input and media service | Existing browser/media protocol; real touch/desktop packet; network/closed-page and permissions; no shared Spark workloads |
| Notifications | notifications/push and web presence | Existing notification protocol; foreground/background, revoke and lost subscription; physical-device gate |
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
| PA-08 | Client signs out, returns/back/refresh | No authenticated content/actions; other clients retained; fresh explicit pairing required |
| PA-09 | Two clients attempt the same one-use invitation | At most one authorization succeeds, other receives refusal; no duplicate identity or cross-client credential transfer |
| PA-10 | User leaves while Connect is pending, including lost success reply | Cancellation before submission creates nothing; after submission outcome may be committed, never assert rollback; Host list remains authoritative, no automatic duplicate/replay |
| PA-11 | Unauthenticated/foreign-origin/missing-CSRF console actions, reused launch grant, private-LAN console access | Explicit refusal; no pairing/revoke side effect or credential disclosure; management remains loopback/OS-authorized |

Closing the Host QR sheet dismisses its view; it does not cancel or revoke an invitation. Regeneration invalidates an unused invitation; revocation removes a paired client's authorization. Tests must not present these different operations as the same action.

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

## Execution record

Keep per-run case IDs and pass/fail/blocked/not-run results with source/build/device identities in private evidence. The current native Safari clipping repair and real `ox-1` iOS 26.2 pairing are recorded in `plans/linux-host.md`. Network-fault and cancellation/revocation results must be added after execution; real off-LAN/cellular and physical-radio coverage stay open until actually tested.

Maintained pairing files live in `.agents/skills/test/protocol/client-host/pairing/`: `authorization.test.ts` runs in the existing protocol suite, `archive.ts` is the explicit packaged-runtime/UI packet, `connection-browser.ts` covers CN-04/05 transport-fault/retry UI and `native-safari.ts` adds PA-02 on actual Mac Safari when `--safari-driver` is supplied. The old `apps/linux/scripts/mac-host-package-check.ts` command forwards to the canonical runner. Native iPhone HID screenshots and bounded manual/OCR exploratory runs remain private evidence, not portable CI or a second maintained implementation.

The November 11 native iPhone packet exercised PA-03, cancelled/confirmed PA-07, CN-01, delayed CN-03, CN-06 and cold CN-02 with a controlled trusted fixture gateway. A stopped fixture endpoint supplies only an unavailable-route equivalent for CN-08. PA-01/06/09 and revoke/session refusal also have portable protocol coverage. The browser packet covers before-send loss, lost committed replies, cancel/confirm of a repeat and navigation during that confirmation. Real Internet-only outages, configured WAN access and physical radio/carrier changes remain blocked environment cases, not passed by the proxy or browser packet.
