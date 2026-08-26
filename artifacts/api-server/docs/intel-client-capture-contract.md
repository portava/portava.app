# IG capture — client contract for the independent-group signal

**Audience:** whoever implements the mobile capture client (`travel-buddy-standalone`).
**Status:** the server side is complete and deployed (migration 2171 on CI + prod;
PRs #145/#146 merged). **Until the client sends the two fields below, the whole
live-label pipeline stays dormant and fail-closed** — observations are still
stored, but no crowd aggregate can ever become privacy-eligible, so nothing
publishes. This doc is the exact, unambiguous contract to close that gap.

_Written 2026-08-26. Grounded in `src/routes/intel.ts`, `src/services/intel/IntelCaptureService.ts`, `src/lib/intelGroupKey.ts`, `src/lib/activeCrew.ts`._

---

## Why

The crowd privacy gate publishes a live label only when an aggregate has
**≥15 distinct people AND ≥5 independent groups AND no single group >20%**. The
server can count people (actors) on its own, but it cannot know **how many
independent parties** those people represent unless capture tells it. That is the
one missing input. The client supplies it with a single low-friction question and
(when known) the user's active trip id.

## The endpoint (unchanged) + the two new fields

`POST /v1/intel/observations` — the existing quick-signal capture call. Header
`Idempotency-Key` is still required. Add **two optional body fields**:

| field | type | values | meaning |
|---|---|---|---|
| `partySize` | string enum, optional | `just_me` \| `one_other` \| `two_to_four` \| `five_plus` | the answer to "Who are you here with?" |
| `partyId` | uuid string, optional | the user's **active trip id** | the observer's Trip Crew, if they are on a trip |

Both are optional and additive — an older client that omits them keeps working
(the observation is stored with no group credit). No other field changes.

### Full request example

```json
POST /v1/intel/observations
Idempotency-Key: <uuid-or-stable-key>
{
  "subjectId": "<place uuid>",
  "observedAt": "2026-08-26T11:00:00.000Z",
  "context": "inside",
  "option": "packed",
  "partySize": "two_to_four",
  "partyId": "<active trip uuid, or omit if not on a trip>"
}
```

(The `context`/`option` quick-signal form is unchanged; the `{claimType, value}`
direct form works too. `partySize`/`partyId` attach to either.)

## When to show the question

Show **"Who are you here with?"** on quick-signal captures that feed a public live
label — the **crowd / queue / access** signals (`context` = `arrival`, `inside`,
or `entrance`). Do **not** show it on trail/movement captures (`exit`, `movement`)
— those are a separate, aggregate-only path.

- Present it as a single tap: **`Just me` · `1 other person` · `2–4 others` · `5+ others`** → send `just_me` / `one_other` / `two_to_four` / `five_plus`.
- If the user skips it, omit `partySize` (do not send an empty string). The
  server treats a missing answer as "unknown" → the observation counts as a
  person but not as a group (fail-closed).

## `partyId` — send the active trip id when you have it

If the user is currently **on a trip** (the app already knows the active trip),
send that trip's uuid as `partyId` on the capture. This is the **strongest**
group signal: every crew member who sends the same `partyId` collapses to one
independent group, which is what stops one organized crew from reading as many
parties.

- You do **not** need to validate membership or resolve "which trip is active" —
  the server does both: it validates the user is an accepted member of `partyId`,
  and independently resolves the user's active crew from trip dates. A `partyId`
  the user is not a member of is ignored (falls back to the size answer).
- If the user is not on a trip, omit `partyId`.

## What the server does with it (for your understanding — no client logic needed)

Server-side group identity is derived in this order (`IntelCaptureService`):
1. a validated `partyId` → that crew is one shared group;
2. else a server-resolved **active** crew (trip dates contain today) → one shared
   group, and this **overrides a `just_me` answer** so a crew member cannot split
   the crew;
3. else `just_me` → the user is their own independent group;
4. else (`one_other`/`two_to_four`/`five_plus` with no crew, or no answer) → no
   group credit.

The stored token is an ephemeral, non-reversible hash — **no names or membership
are ever stored or transmitted.** Exact party size beyond the bucket is never used.

## Privacy rules for the client UI

- Collect **only** the size bucket. Never collect or send the names/identities of
  companions.
- `partyId` is the trip id the app already holds — not a new piece of personal
  data, and not anyone's identity.
- The question is informational; a skip is always allowed and is the safe default.

## After this ships

Once real captures carry these fields, run `pnpm run report:intel-funnel` to see
the pipeline fill in — including the **insufficient-groups vs group-identity-
unavailable** split, which tells you whether the limiter is adoption, the party
model, or simply not-enough-independent-parties-yet. Then the full lifecycle
certificate (`capture → … → LIVE label → expiry → disappears`) becomes runnable.
