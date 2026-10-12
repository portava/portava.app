# Owner decisions of 2026-10-12 — the verbatim record

**Documentation only.** Nothing was applied, flipped, deployed or merged in
producing this file. It records what the owner said, in the owner's words, and
reconciles each answer with the requirements and rulings already approved. It
grades nothing.

**An answer authorises work; it moves no verdict.** The owner said so in the
same message: "Do not mark a requirement complete merely because I approved its
policy; require implementation and verification evidence." No census row changes
on the strength of an entry here.

**Scope of the authorisation**, in the owner's words: "This authorizes
implementation—not production database writes, destructive cleanup, or bypassing
checks."

Identifiers (`OD-1012-APPEAL-1` and so on) are assigned here so other documents
can refer to one answer. Where a question already had an identifier in a census,
a lead ruling or a PR, that identifier is given in brackets.

## Part 1 — the answers, received 2026-10-12

### Trips appeals (PR #691)

**OD-1012-APPEAL-1 — Merge conditions.**

> Resolve merge conflicts and obtain independent verification and passing required checks before merging.

**OD-1012-APPEAL-2 — Merge before the prerequisites.** [#691 hold question 1]

> It may merge before migration 3979 is applied or `trip_kernel_enabled` is enabled. I accept that affected appeals remain pending until those prerequisites are ready.

**OD-1012-APPEAL-3 — The kernel flag.**

> Do not enable the entire kernel just to unblock this PR.

**OD-1012-APPEAL-4 — Crew cap.** [#691 hold question 2; census-trips §83 open item]

> An upheld appeal does not override the crew cap or displace another member. Keep restoration pending with a clear explanation and an operator retry path.

**OD-1012-APPEAL-5 — What is restored.**

> Restore the permissions removed by the appealed decision. Never restart location sharing automatically; ended trips restore retained-record access only.

**OD-1012-APPEAL-6 — After merging.**

> After merging, verify main’s checks before continuing the merge train.

### Privacy

**OD-1012-PRIV-1 — Legacy location shares.** [LSP-1]

> LSP-1: legacy location shares remain limited to their original crew-sharing purpose. No broader reuse or automatic backfill.

**OD-1012-PRIV-2 — Layover postcards.** [LP-1]

> LP-1: layover postcards default to “Only me”; the traveller explicitly chooses broader visibility.

**OD-1012-PRIV-3 — Memory settings in Compass and aggregates.** [W-HM-PRIV-1, W-HM-PRIV-2]

> W-HM-PRIV-1/2: honor restrictive memory settings in Compass and public aggregates while preserving permitted private search. Exclude disputed locations from aggregates until reconciliation reliably honors the latest user correction; do not permanently disregard a valid later correction.

**OD-1012-PRIV-4 — Home time zone.** [N1, census-trips §92]

> Keep `home_timezone` private by default. Public schedules may show their destination/event timezone.

**OD-1012-PRIV-5 — Plan visibility.** [census-trips §90 open items]

> Organizers may narrow a plan’s visibility, but organizer status alone grants no access to someone else’s private plan. Private access is limited to its author and explicitly selected people. Time slots inherit plan privacy. Never widen visibility automatically.

### Rides and requests

**OD-1012-RIDE-1 — Several rides.** [OD-T107-ONE-RIDE]

> Keep existing behavior on multiple rides until “active ride” and overlapping commitments are precisely defined.

**OD-1012-RIDE-2 — Declining a 1:1 request.** [census-telegraph §80.7 observation]

> Declining a 1:1 request does not automatically block the person permanently. Handle repeated unwanted requests separately without weakening explicit block protections.

### Stamps [BD-OD-1..4]

**OD-1012-STAMP-1 — What a planning stamp means.**

> Planning or contribution stamps must not imply verified physical presence or earn verified-travel trust credit.

**OD-1012-STAMP-2 — Every award path.**

> Enforce this consistently, including generic/admin award paths.

**OD-1012-STAMP-3 — Notification copy.**

> Use notification wording describing the actual achievement.

**OD-1012-STAMP-4 — Historical rows.**

> Prepare a separate, scoped historical-data repair proposal. Do not modify production records or retroactively recalculate trust without review and approval.

### Layover

**OD-1012-LAY-1 — Return warnings.** [L41, L99]

> L41/L99: prioritize actionable return warnings, notify when the required action changes, and suppress duplicates. Do not suppress an essential return warning merely because its scheduled time is unchanged.

**OD-1012-LAY-2 — Night.**

> Keep night-dependent recommendations gated until airport-local night rules, actions and missing-data fallbacks are specified.

**OD-1012-LAY-3 — Retention.** [L261]

> Propose an explicit L261 retention policy covering snapshot contents, deletion, saved records and minimized audit evidence. Do not borrow another feature’s retention period.

**OD-1012-LAY-4 — Time-sensitive notifications.**

> Implement and test appropriate Apple time-sensitive notification support, respecting user settings and normal-delivery fallback. Never treat push delivery as guaranteed.

### Deletion and device trust

**OD-1012-DEL-1 — Trip hard-delete error 23514.**

> Investigate trip hard-delete error 23514 and repair the intended trip/chat lifecycle. Do not bypass the constraint or blindly cascade-delete chat history. Bring back any unresolved retention or ownership decision.

**OD-1012-DEV-1 — Device trust.**

> Devices default to unverified. Only server-validated evidence may promote `trust_state`; never accept a client’s self-declaration as proof.

### Standing instructions in the same message

> Work in isolated worktrees, preserve unrelated changes, add focused regression tests, and keep changes reviewable. Do not mark a requirement complete merely because I approved its policy; require implementation and verification evidence. Continue independent work while genuinely unresolved decisions remain gated.

## Part 2 — reconciliation with requirements already approved

Each answer was checked against the earlier owner record
(`docs/ops/owner-decisions-20261004.md`), the 2026-10-11 owner rulings on PR #685,
and what the code on `main` does today. "Agrees" means the code already follows
the answer; "work" means code must change; "conflict" means two approved
statements pull in different directions and the owner must choose.

| Answer | Earlier approved requirement | State on `main` | Result |
| --- | --- | --- | --- |
| APPEAL-2/3/5 | OD-TRIP-1 (restore the removed access and permissions; no recreated live activity or location sharing; an ended trip restores the retained record only) | PR #691 implements OD-TRIP-1 through the kernel command; nothing restores while 3979 is unapplied or the flag is off | Agrees. APPEAL-5 restates OD-TRIP-1. |
| APPEAL-4 | none (the cap was an open question) | #691 holds a crew-full restore `under_review` and calls the cap undecided; the operator queue has no re-drive | **Work**: state the ruled behaviour and add an operator retry path. |
| PRIV-1 | 3753 / lane tg-locpurpose default | Legacy `NULL`-purpose rows admitted only for `live_session_sharing` (crew), no backfill, no deletion | Agrees. |
| PRIV-2 | lead ruling LP-2 (route hand-off to Passport) | A postcard started from a layover opens as "Only me"; the ordinary composer still defaults to public | Agrees for layover postcards. The ordinary composer is out of this answer's scope. |
| PRIV-3 | 3725 / lane hm-priv | A `DO_NOT_RESURFACE` Memory is kept out of Compass even when its owner asks for it by id, which is stricter than the owner's own retrieval note. The trend count drops a Memory whose stored place the owner *ever* rejected. | **Work** on both halves: let the owner's own permitted search find it, and replace "ever rejected" with "latest correction wins". Disputed locations stay excluded until reconciliation reliably honours the latest correction. |
| PRIV-4 | OD-TRIP-3 (owner-only by default) | 3768 (CI only) adds `trips.home_timezone`; the column is reachable wherever the trip row is | **Work**: private by default. |
| PRIV-5 | OD-TRIP-3; lane trips-privacy (3720) | `private`, `selected_participants` and unknown scopes admit the creator only; `selected_participants` is refused with 422 because no selection is stored | **Work**: store explicit selections; let organizers narrow, never widen; time slots inherit. Agrees with OD-TRIP-3 on "organizer status alone grants no access". |
| RIDE-1 | 2026-10-11 ruling on #685 ("Don't impose a one-active-ride limit") | No limit enforced | Agrees. |
| RIDE-2 | 2026-10-11 ruling on #685 ("Preserve fail-closed block checks and unconditional permission to leave") | A decline creates no block. **The shared 1:1 block guard refuses every write across a block, DECLINED included**, so a blocked person cannot leave a ride in a 1:1 thread (in a group they always can). | **Conflict** — see Part 3. Repeated unwanted requests need their own mechanism (work, once specified). |
| STAMP-1..3 | lane stamps (BD-OD-1..4 listed as open) | Every engine award, planning stamps included, fires trust `STAMP_VERIFIED`; the admin and internal award endpoints accept a place for any slug | **Work** on all three. |
| STAMP-4 | none | Historical rows left untouched | Proposal only; no production change. |
| LAY-1 | census-layover §11.1 step 8 (`shouldNotify`) | L99 is W: a reschedule is not a notification; RETURN_SOON stays on the default channel | **Work**. |
| LAY-2 | — | PR #683 shipped the night arm of the layover **buddy safety gate** (22:00–06:00 airport-local), which only refuses | Agrees if that arm restricts and recommends nothing; to be re-checked. No night-dependent recommendation is enabled. |
| LAY-3 | OD-TRIP-4 (trip snapshots: 30 days) | L261 is N | **Work**: a layover-specific proposal. OD-TRIP-4's 30 days must not be borrowed. |
| LAY-4 | — | Code requests the time-sensitive level only when the app's iOS entitlement is present; no entitlement is configured | **Work** on settings and fallback. The entitlement itself is an Apple Developer account action (enable the capability on the App ID, regenerate the provisioning profile) that only the owner can take. |
| DEL-1 | — | A `trip` thread blocks the trip's hard delete (`message_threads.trip_id ON DELETE SET NULL` against `chk_thread_context`), which is also reachable from account deletion | **Work**: investigate and repair; bring back any retention or ownership question. |
| DEV-1 | 3743 / lane tg-devices | `trust_state` defaults to `unverified`; `devices` is server-only; nothing promotes a device | Agrees on the default. **Work**: a server-only promotion path. No server-validated evidence source exists yet, and adding one (for example a platform attestation service) would be a provider integration that needs its own decision. |

## Part 3 — what these answers do NOT decide

- **A 1:1 decline across a block (RIDE-2 against the #685 ruling).** "Preserve
  fail-closed block checks and unconditional permission to leave" and "without
  weakening explicit block protections" disagree on one case: a person in a 1:1
  ride thread who has been blocked cannot answer DECLINED, so cannot leave the
  ride. Nothing changes until the owner says which wins.
- **What counts as a "repeated unwanted request"** and what happens next
  (rate limit, cool-off, silent drop). RIDE-2 asks for it; it is not specified.
- **"Active ride" and "overlapping commitments".** RIDE-1 keeps today's behaviour
  until they are defined.
- **Airport-local night rules, actions and missing-data fallbacks** (LAY-2).
- **The L261 retention periods themselves** (LAY-3 asks for a proposal).
- **The historical stamp repair** (STAMP-4 asks for a proposal; nothing is
  repaired without review).
- **Which server-validated evidence promotes a device** (DEV-1). Any attestation
  provider is a new integration and needs its own decision.
- **The Apple time-sensitive entitlement** is an account action for the owner.
