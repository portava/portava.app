# Compass architecture upgrade v2

Extend the existing conversational, context, tool, memory, recommendation, Home, Sense, Live, and Trip integration systems with shared World and Experience Intelligence. Read 00-START-HERE.md and the complete bundled COMPASS and C1 baselines. This is an additive specification, not a replacement implementation.

## Existing foundation

Preserve all fifteen roadmap phases and their acceptance requirements: conversation, owner-controlled prompt, context, tools, dynamic UI, memory, recommendations, live intelligence, social intelligence, Home, Sense, Live, Trip Autopilot, outcomes, and graph. Retain phase dependency and owner-trigger rules unless explicitly superseded by the owner. Do not reinstall the system prompt or rebuild conversation storage to add sensing.

An older inspected checkout contains CompassConversationService with getOrCreateConversation, loadHistory, appendMessage, and touchConversation. These are navigation hints, not evidence of the current head. Locate their current owners before editing. Reuse existing tools, ranking, streaming, context guards, session models, and real UI components.

## Processing and ownership

Authorized request/session → existing context assembly → shared world/experience/forecast/opportunity projections → existing decision/ranking owner → grounded explanation → existing UI/action contract.

Home consumes a server-built UserNowProjection or equivalent: what matters now. Compass consumes it and other authorized context to explain what to do. Sense sends eligible proactive attention; Live retains only its permitted active-session context. Neither becomes a second sensing ingest route.

The logical decision result carries subject references, recommendation/action class, supporting evidence references, truth metadata, validity, reasons, relevant constraints, and any confirmation requirement. SENSE's action vocabulary is GO NOW, GO SOON, WAIT, STAY, SWITCH, SKIP, RETURN. Map this to the existing action model with compatibility handling; do not blindly add enum values.

## Upgrade requirements and acceptance

| ID | Required behavior | Evidence required | Basis |
|---|---|---|---|
| CPV2-01 | Reuse existing conversation, intent, memory, tool and streaming owners. | Existing multi-turn, reference resolution, streaming and action journeys still pass after integration. | COMPASS 1, 4–6; C1 |
| CPV2-02 | Ground answers in shared structured evidence; never upgrade inference into fact. | Predicted, inferred, conflicting, stale and unknown fixtures retain their qualification in tool output, UI and generated explanation. | SENSE 5.1, 10 |
| CPV2-03 | Apply safety, feasible time, travel friction and user/crew constraints before opportunity advice. | An attractive but infeasible option is not recommended as actionable; an unmeasured route remains unknown, not zero. | SENSE 10–11; engineering acceptance |
| CPV2-04 | Consider current Experience value and switching cost. | Given an otherwise comparable candidate, unnecessary switching is not promoted; missing current-session evidence is not invented. | SENSE 10 |
| CPV2-05 | Home uses a server-built current-context projection rather than reconstructing domain truth in components. | Producer→route→real Home component test; partial source outage preserves unaffected content with accurate availability. | SENSE 10 |
| CPV2-06 | Sense routes meaningful changes through the existing attention policy and user-controlled presence modes. | Repeated unchanged events do not repeatedly notify; revoked permissions, expired events and exhausted policy budget prevent delivery. | COMPASS 11; SENSE 15 |
| CPV2-07 | Live session start, stop and revocation control ongoing context and queued attention. | Stop/revoke during an in-flight read prevents later disclosure or notification; unrelated chat remains functional. | COMPASS 12; SENSE 18.4; engineering acceptance |
| CPV2-08 | Propose Trip changes through the canonical Trip command path. | Recheck membership and aggregate state at execution; fixed items remain fixed; duplicate execution does not duplicate changes. No direct projection-to-plan write. | COMPASS 13; SENSE 11 |
| CPV2-09 | Preserve confirmation for money, bookings, messages and location sharing. | A model/tool proposal cannot execute those actions without valid user confirmation and server authorization. | COMPASS global rules |
| CPV2-10 | Keep private/group context and anonymous intelligence separate. | Blocked users, unauthorized group memory, coordinates and contributor identifiers do not reach model context or explanations. External text cannot issue tool instructions. | COMPASS 3, 6, 9; SENSE 3 |
| CPV2-11 | Learn from permitted actual outcomes, not assumed visits or passive movement. | Repeated delivery is idempotent; revocation follows lineage; a recommendation or sensor observation alone creates no visit, Memory or Trust event. | COMPASS 14; SENSE 13 |
| CPV2-12 | Use shared city/time confidence and graph context without duplicating truth. | Sparse coverage degrades honestly; changed time/context changes eligible evidence; no coverage cannot generate a confident quiet/busy claim. | COMPASS 15; SENSE 5 |

## Failure and compatibility behavior

Preserve useful basic Compass without premium. A world-intelligence failure must not disable ordinary grounded conversation. Distinguish authorized empty results from dependency failure internally and give an honest user-facing limitation. Do not fabricate a fallback candidate, open status, travel duration, safety verdict, or current crowd.

Attach evidence to the particular claim it supports. Do not attach a general valid citation to unsupported generated prose. Revalidate expiring evidence when an action is taken rather than treating conversational history as current authority.

Run the baseline nine-query evaluation set alongside deterministic contract tests. Record factual grounding, permission compliance, action correctness, continuity, and live-provider limitations separately. Real model/provider behavior requires an appropriately configured integration evaluation before declaring that part complete.

## Decisions that must not be invented

Preserve the owner's finalized-prompt boundary. Reuse approved attention budgets, switching policy, confidence/freshness rules, and permission scopes. If absent, ask for the missing values or proposed policy approval, implement configurable contracts and tests with explicitly synthetic fixtures, and leave activation/certification unresolved. World Sensing authentication posture is owned by Sensing; Compass cannot resolve it by adding its own ingest.
