/**
 * Telegraph §27.2 — the twelve adversarial fixtures, as data.
 *
 * §27.2 does not ask for coverage of a feature; it names twelve INTERLEAVINGS
 * and abuses and asks what the system does in each. Four of them describe races
 * against mechanisms this tree does not have, and the honest way to record that
 * is a fixture that asserts the absence and fails when it ends — not a passing
 * test over a feature nobody built.
 *
 * Every entry is driven by `src/test/telegraphAdversarialFixtures.test.ts`
 * against the real route, resolver or bus. Where the outcome today is the wrong
 * one, the fixture asserts TODAY'S outcome with the required one written beside
 * it and the status set to `divergent`, so the fixture goes red when the
 * behaviour is fixed and the record must be updated. A fixture that passes both
 * before and after a fix is not measuring anything.
 */

import type { AdversarialFixture } from "../contracts/certification.js";

export const TELEGRAPH_ADVERSARIAL_FIXTURES: readonly AdversarialFixture[] = [
  {
    id: "F-01",
    censusRow: "T328",
    requirement: "Stranger spam and request flooding",
    scenario:
      "One stranger fires message requests at a recipient in a tight loop, then " +
      "the same stranger under a trust restriction",
    status: "divergent",
    enforcedBy: ["src/routes/messaging.ts", "src/services/interactionPermissions.ts"],
    note:
      "Three separate facts, and only one of them is the gap. (1) Flooding ONE " +
      "recipient is bounded to a single delivered request: the route " +
      "short-circuits on an existing pending or accepted row, and refuses " +
      "outright when that table is unreadable rather than delivering a second " +
      "unsolicited request — a genuine anti-harassment property the census did " +
      "not record. (2) Flooding MANY recipients is unbounded: twelve strangers, " +
      "twelve delivered requests, because no per-sender limit exists across " +
      "recipients. (3) In-thread sends are unbounded too. The fixture asserts " +
      "all three, so a limiter landing on either path turns it red.",
  },
  {
    id: "F-02",
    censusRow: "T329",
    requirement: "Blocked sender retrying on a stale device",
    scenario:
      "A sender blocked after their thread was opened keeps posting with a client " +
      "that still believes it is a member, including while the blocks table is " +
      "unreadable and while the roster read fails",
    status: "enforced",
    enforcedBy: ["src/routes/messaging.ts", "src/lib/blockGuard.ts"],
    note:
      "The stale device is the point: blocking does not close an existing thread, " +
      "so the client's cached membership is CORRECT and the only thing standing " +
      "between the sender and delivery is the per-send re-check. The fixture " +
      "drives three retries — healthy, blocks-table-down, roster-read-down — and " +
      "all three are refused. The second and third are the ones worth having: " +
      "both are paths a retry loop would find on its own.",
  },
  {
    id: "F-03",
    censusRow: "T330",
    requirement: "Duplicate send and offline resend",
    scenario: "The same clientId is posted twice, as an offline client's retry would",
    status: "divergent",
    enforcedBy: ["src/routes/messaging.ts"],
    note:
      "TWO canonical rows are created. clientId is accepted, truncated to 64 " +
      "characters and echoed back for optimistic correlation, and that is all it " +
      "does — there is no uniqueness constraint, no upsert and no idempotency key " +
      "on the insert, so a resend after a timeout duplicates the message. The " +
      "fixture asserts the two rows and names the §28 metric this makes " +
      "unmeasurable (duplicate canonical messages = 0, T347).",
  },
  {
    id: "F-04",
    censusRow: "T331",
    requirement: "Out-of-order realtime events",
    scenario:
      "Events are published to one subscriber in an order that does not match " +
      "their causal order, and one subscriber throws mid-fan-out",
    status: "enforced",
    enforcedBy: ["src/lib/telegraphEvents.ts"],
    note:
      "Two guarantees, both real and both proved here. Per-subscriber ORDER is " +
      "preserved — the bus delivers synchronously in publish order, so no " +
      "reordering is introduced by the transport itself. And no event can lose a " +
      "message: a subscriber that throws is counted (subscriberErrors) and the " +
      "fan-out continues to the others, and the canonical row was committed " +
      "before the publish, so the client's poll re-reads it. The fixture asserts " +
      "the counter moves, because a swallow that is not counted is invisible.",
  },
  {
    id: "F-05",
    censusRow: "T332",
    requirement: "Location expires while the owner's device is offline",
    scenario:
      "An availability window and a safe-return live share both pass their expiry " +
      "with no writer, no sweep and no owner device online",
    status: "enforced",
    enforcedBy: [
      "src/services/passport/OpenToPlansService.ts",
      "src/services/safeReturn/SafeReturnPrivacyGuard.ts",
    ],
    note:
      "This is the fixture that separates expiry-as-state from expiry-as-job. " +
      "Both surfaces recompute expiry on the READ: the availability predicate " +
      "compares against the caller's instant, and the live-share middleware " +
      "refuses an expired share before the handler runs. The fixture never runs a " +
      "sweep and never touches the owner's session, which is exactly the " +
      "condition under which a sweep-based design leaks.",
  },
  {
    id: "F-06",
    censusRow: "T333",
    requirement: "Edit while translation/transcript is generating",
    scenario:
      "A message is edited while per-recipient translations for the previous body " +
      "are still pending",
    status: "enforced",
    enforcedBy: ["src/routes/messaging.ts", "src/services/messageTranslation.ts"],
    note:
      "Driven as the race rather than as unit coverage of the gate, which is what " +
      "the census asked for: the fixture leaves in-flight translation rows for the " +
      "OLD body, edits through the real route, and asserts the rows were " +
      "invalidated rather than merged — and that the original body is what the " +
      "translation regenerates from. The invariant underneath is §29's 'no " +
      "derived translation overwriting original content'.",
  },
  {
    id: "F-07",
    censusRow: "T334",
    requirement: "Participant removed mid-send",
    scenario:
      "The sender's membership row disappears between the membership check and " +
      "the insert",
    status: "divergent",
    enforcedBy: ["src/routes/messaging.ts"],
    note:
      "The send COMPLETES. Membership is checked once, at the top of the handler, " +
      "and the insert that follows is not conditioned on it — there is no " +
      "compare-and-set and no re-check, so a removal landing inside that window " +
      "produces a message from a non-member. The window is small and the fixture " +
      "makes it deterministic by mutating the roster between the two reads. " +
      "Asserted as today's outcome; closing it is a route change (a conditional " +
      "insert or a membership-scoped RLS write path), not a test change.",
  },
  {
    id: "F-08",
    censusRow: "T335",
    requirement: "Trip membership revoked while the thread is open",
    scenario:
      "A trip member is removed and the chat sync reconciles while their client " +
      "still holds the thread open",
    status: "enforced",
    enforcedBy: ["src/services/groupChatSync.ts", "src/routes/messaging.ts"],
    note:
      "Once the sync has marked left_at, the next read AND the next send both " +
      "deny — there is no cached capability object to go stale, which is the " +
      "thing that makes this fixture pass. It is deliberately paired with RLS-09, " +
      "which records the other half: the sync is invoked fire-and-forget, so the " +
      "fixture proves the gate rather than the propagation delay.",
  },
  {
    id: "F-09",
    censusRow: "T336",
    requirement: "Buddy booking cancelled during coordination",
    scenario:
      "A booking moves to cancelled while its thread is open and a call is being " +
      "started",
    status: "divergent",
    enforcedBy: [
      "src/lib/calls/callGatewayAdapter.ts",
      "travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx",
    ],
    note:
      "Eligibility is re-derived from the booking row at call start, and the " +
      "fixture walks the whole status vocabulary to prove that cancelled is " +
      "refused while disputed and completed-with-both-parties-opted-in stay " +
      "callable — a deliberate policy, quoted in that module. The divergence is " +
      "the card: the fixture reads the milestone component and asserts it " +
      "performs no fetch and no capability read, so its buttons outlive the state " +
      "they were rendered from.",
  },
  {
    id: "F-10",
    censusRow: "T337",
    requirement: "AI summary sees conflicting messages",
    scenario:
      "A thread contains a plan and its later contradiction; the suggestion layer " +
      "is asked what to do",
    status: "enforced",
    enforcedBy: ["src/services/telegraphChatSuggestions.ts", "src/routes/telegraphChat.ts"],
    note:
      "The safe answer to a conflicting thread is not a correct summary — it is " +
      "refusing to act on one. The fixture asserts the property that makes " +
      "conflict harmless: no suggestion mutates canonical state on its own. Every " +
      "action the tray offers is a PROPOSAL that a person must confirm, and the " +
      "confirming route re-verifies membership at execution rather than trusting " +
      "the proposal, so an AI that read the thread wrongly can produce a wrong " +
      "SUGGESTION and never a wrong TRIP.",
  },
  {
    id: "F-11",
    censusRow: "T338",
    requirement: "Unsend races recipient seen update",
    scenario: "A recipient's read receipt lands between the unsend check and the write",
    status: "enforced",
    enforcedBy: [
      "src/migrations/3000_telegraph_unsend_authoritative.sql",
      "src/services/telegraph/unsend.ts",
      "src/routes/telegraphLifecycle.ts",
      "src/server/telegraph/commandRoute.ts",
    ],
    note:
      "Was `vacuous` until 2026-09-23. The race is resolved in the DATABASE, " +
      "which is where it has to be: supabase-js issues each statement in its own " +
      "implicit transaction, so a route that read, decided and wrote had a window " +
      "between the read and the write no matter how it was written, and both " +
      "unsend routes did exactly that. telegraph_unsend_message_before_seen takes " +
      "FOR UPDATE locks on the message row and on every eligible recipient's " +
      "receipt row BEFORE reading last_read_at, and the fixture asserts that " +
      "ORDER against the migration text rather than counting lock clauses — two " +
      "locks placed after the seen-check satisfy a count and close nothing. It " +
      "also asserts that neither route updates public.messages directly, because " +
      "a direct update is the old shape and the old window coming back. The locks " +
      "themselves are executed by the `api-server · kernel SQL executed on a " +
      "throwaway database` job; no in-process fixture can serialise transactions.",
  },
  {
    id: "F-12",
    censusRow: "T339",
    requirement: "Source object revoked while a cached share card is open",
    scenario:
      "The source object behind a rendered share card is revoked while the " +
      "conversation is open",
    status: "divergent",
    enforcedBy: [
      "travel-buddy-standalone/src/components/DiscoveryCardMessage.tsx",
      "travel-buddy-standalone/src/components/PostCardMessage.tsx",
      "src/domain/telegraph/policies/shareAuthorizationPolicy.ts",
    ],
    note:
      "The card cannot notice. The fixture reads both card components and asserts " +
      "each contains no fetch, no effect and no capability read — they render " +
      "frozen JSON from messages.body forever. This is §29's revocation-bypass " +
      "invariant failing at the card, and it is structural rather than timing " +
      "dependent, which is why the fixture is a static assertion over the real " +
      "components rather than a race. It goes red the moment a card learns to " +
      "re-resolve, which is the change that fixes it.",
  },
];

export const TELEGRAPH_FIXTURE_IDS: readonly string[] =
  TELEGRAPH_ADVERSARIAL_FIXTURES.map((f) => f.id);
