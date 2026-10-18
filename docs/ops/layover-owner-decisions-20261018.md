# Layover: what moves it, and what only you can decide (2026-10-18)

Layover is 86 C / 158 W / 52 N of 296 requirements (29.1% built and correct), the lowest of the major areas. On
2026-10-18 two triage passes read every W and N row at its current census line, together with the code and the
production ledger. Their reports are in the session scratchpad (`layover-triage-W.txt`, `layover-triage-N.txt`).

**Where it stands after the lanes and the verifier (2026-10-18): 86 → 81 C (29.1% → 27.4%).** Code moved 8 rows up. Applying the census's reachability rule uniformly took 13 down. None of the 13 is broken code: each is unreachable in production until a migration you hold is applied.
- **Up (8):** L148, L149, L231 and L126 (disruption reporting and the offline map); L232 (crew departures); L13 and L59 (the time-window engine in its own package); L274 (no Rent-a-Buddy visa help: the test found a real path, and it is closed).
- **Down (13 false greens):**
  - L181, L197, L84–L89, L251 and L252 sit behind the crowd-reports channel. That channel is closed until 3513 is applied.
  - L254 sits behind Rent-a-Buddy, which is off.
  - L92 and L257: event de-duplication is built but has no caller, and the external-event path waits on 2981.
- **Built but held at W:** L296, recommendation snapshot pairing. It becomes C when you turn on `layover_stable_recommendation_ids_enabled`, with no migration.
- **Press-ready code halves:** seven rows (L207, L44, L196, L175, L189, L191, L180) now carry their code half. L207 and L196 become C on the press alone. L44 also needs your ruling that clearing a card's snapshot citation (audited) counts as invalidating it. The other four also need a route line.
- **Routes:** layover routing calls now open a Routes budget scope, so enabling Routes no longer refuses them all.
- **Apply 3513 before the next deploy.** The crowd-report gate has been on `main` since 2026-10-03 (154c18e0c). If production has been deployed since then, the channel is already closed; if not, it closes when this branch deploys. 3513 alone returns ten of the thirteen rows above.

**Most of the remainder is yours: the production press and the rulings below.**

## 1. The production press: the largest single move

Every unapplied layover migration is already in `prod-apply-packet-20261017` (its 3996 is in the addendum). Applying
them and flipping the matching flags would move about **39 W rows and 23 N rows to C**, and 3513 alone also returns ten of the thirteen rows above: 81 → about 153, roughly 52%. Of the other three, L254 returns with Rent-a-Buddy, and L92/L257 need 2981 and their de-duplication wired in.
- **Order matters.** 3792 must be applied **before** `layover_decision_persistence_enabled` is turned on. Otherwise
  every roomy layover fails to persist.
- The families: the snapshot family (2700 → 2992 → 3623 → 3792), then the following flags:
  - persistence and recommendation snapshots;
  - constraints (3640);
  - the lifecycle machine (3632);
  - stable recommendation ids (2410 is already applied);
  - presence (2740, 3900);
  - crew location (3996);
  - external events (2981 + 2986 + a producer secret);
  - crowd reports (3513);
  - live intersection (2851);
  - discovery mode;
  - safe-return status;
  - the client write boundary (3620);
  - erasure (3621 → 3622);
  - ranking shadow mode (3784);
  - the crew abort notice (3786).
- One platform action, not a database step: Apple's Time Sensitive Notifications entitlement for the App ID (L41).

## 2. Rulings, ranked by rows they unblock

| # | Decision | Rows it unblocks |
|---|---|---|
| 1 | **Routing provider** (#757): enable Google Routes for layover legs, with a credential and a spend ceiling. Also decide how a layover with no trip is charged, since the caps allow 3 calls per trip and each landside candidate costs 2. | 21 W rows + 6 partly, + 4 N (routed return) |
| 2 | **Layover Compass door** (lead ruling L-CL02d removed the model and its 12 tools): is that permanent? If so, these rows are recorded as declined by you, not left "wrong". | 14 (L100, L102–L113, L268) |
| 3 | **Rule A.2 versus census-layover's WAVE-1 rule** (pending since wave 4): code that exists but rests on an unapplied migration grades W everywhere else, but N in Layover. | 31 N → W (no C change) |
| 4 | **Live airport signals**: may screened traveller observations feed the live conditions (this changes a safety number), or is a feed bought? | 9 |
| 5 | **Airport data**: who curates terminal and gate topology, buffers, schedules and lounges? 0 of 3,206 production airports are curated. | 5 W + 3 N |
| 6 | **Metrics export** (OQ-8): where are §20's metrics exported? | 5 W + 9 N (L209–L217) |
| 7 | **Flight data**: does Trips own the flight-segment model, or is a feed bought? | 4 W + L153 |
| 8 | **Maturity gate**: should a generic airport withhold landside guidance? Every production airport is generic today. | 4 |
| 9 | **Entry forbid flag** (3640): forbid landside unless entry is confirmed allowed? `entry_requirements` is uncurated, so this would close landside for everyone. | 2 W + 2 N |
| 10 | **Data retention** (Q1–Q8): ratify the proposed retention periods. | 3 N |
| 11 | Smaller product questions: may the abort tell the crew (OQ-3)? A shared-ride product? A Rent-a-Buddy layover specialist? A landside Safe Return start? Should layover crews become a Locate My Friends scope? A recovery-help data source? The objective's unknown terms (OQ-6)? | 1–2 each |

## 3. Grading calls the lead will make, with the verifier checking

These are census-grading questions, not product decisions. They will be decided at integration with evidence, and
each one will be named in the census:
- whether a traveller-reported disruption satisfies §15.2's input (L148, L149, L231);
- whether D-41's acceptance test closes L274;
- whether a chain-replay database test counts as a real CI schema (L236, L295);
- whether the contracting planning edge satisfies L63;
- whether routing the published band through `calculateCommitmentEnvelope` counts as a use (L178).

## 4. Found while triaging

- **Routes are never budgeted for layovers (being fixed in lane 1).** No layover reader opened a
  `withRoutesRequestBudget` scope, so even after Routes is enabled every layover routing call would be refused as
  "unscoped". This kept L60, L68–L71 and L282 from ever reaching C.
- **Possible false greens (being checked in lane 3).** L181 and L197 are graded C, but both observation routes now
  refuse unless `layover_crowd_reports_enabled` is on, and 3513, which seeds that flag, is not applied in production.
  If the check confirms it, they come down to W.
- **Stale census reasons (being re-derived in lane 3):** L93, L36, L82, L14, L134/L135, L58 and L247.
