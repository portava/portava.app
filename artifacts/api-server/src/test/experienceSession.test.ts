/**
 * Sensing §5.4 / §19 — the ExperienceSession bridge (census-sensing S54) and
 * the outcome it closes with (S113).
 *
 * Every rule is pinned on its own: a session with no opportunity is not a
 * bridge; its life is bounded; it names ONE subject and cannot be given a
 * trail; closing is terminal; an EXPIRED session cannot be closed with an
 * outcome; the close rides the outcome's own existing verb so no second
 * outcome store appears; and the store has no history read to offer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SESSION_HOURS,
  EXPERIENCE_SESSION_PAYLOAD_KEY,
  MAX_SESSION_HOURS,
  SESSION_FORBIDDEN_KEYS,
  SESSION_OPEN_VERB,
  closeExperienceSession,
  foldSession,
  isExperienceSessionEnvelope,
  openExperienceSession,
  sessionForbiddenKeys,
  sessionState,
  type ExperienceSessionEnvelope,
} from "../lib/experienceSession.js";
import { SESSION_VERBS } from "../lib/experienceSessionStore.js";
import { ALLOWED_PAYLOAD_KEYS, projectEvent } from "../lib/canonicalEvents.js";
import { INTEL_OUTCOMES, OUTCOME_VERB, OUTCOME_VERBS } from "../lib/intelOutcomes.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const ACTOR = "11111111-aaaa-4aaa-8aaa-111111111111";
const PLACE = "22222222-bbbb-4bbb-8bbb-222222222222";
const SESSION = "33333333-cccc-4ccc-8ccc-333333333333";

const open = (over: Partial<Parameters<typeof openExperienceSession>[1]> = {}, nowMs = NOW) =>
  openExperienceSession(
    ACTOR,
    { sessionId: SESSION, subjectId: PLACE, opportunityKind: "go_now", claimRefs: ["snap-1"], ...over },
    nowMs,
  );

function openedEnvelope(over: Partial<ExperienceSessionEnvelope> = {}): ExperienceSessionEnvelope {
  const r = open();
  assert.ok(r.ok);
  return { ...r.envelope, ...over };
}

describe("ExperienceSession — the bridge, and what it refuses to be", () => {
  it("opens from an OPPORTUNITY, names one subject, and carries the claims it rested on", () => {
    const r = open();
    assert.ok(r.ok);
    assert.equal(r.envelope.subject_id, PLACE);
    assert.equal(r.envelope.opportunity_kind, "go_now");
    assert.deepEqual(r.envelope.claim_refs, ["snap-1"]);
    assert.equal(r.envelope.phase, "opened");
    assert.equal(r.envelope.opened_at, new Date(NOW).toISOString());
    assert.equal(r.envelope.expires_at, new Date(NOW + DEFAULT_SESSION_HOURS * 3_600_000).toISOString());
    assert.equal(r.event.verb, SESSION_OPEN_VERB);
    assert.equal(r.event.subjectId, PLACE);
    assert.equal(r.event.actorId, ACTOR);
  });

  it("a kind outside the opportunity vocabulary is NOT a bridge", () => {
    const r = open({ opportunityKind: "because_i_said_so" as never });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "no_opportunity_reference");
  });

  it("its life is bounded, and an unbounded one is refused rather than clamped", () => {
    assert.equal(open({ hours: MAX_SESSION_HOURS }).ok, true);
    const tooLong = open({ hours: MAX_SESSION_HOURS + 1 });
    assert.equal(tooLong.ok === false && tooLong.refusal, "lifetime_exceeds_maximum");
    const zero = open({ hours: 0 });
    assert.equal(zero.ok === false && zero.refusal, "lifetime_exceeds_maximum");
  });

  it("it cannot be given a trail — every trail-shaped key is refused, at any depth", () => {
    for (const key of ["path", "route", "trail", "waypoints", "visits", "previous_subject_id", "lat", "lng"]) {
      assert.ok(SESSION_FORBIDDEN_KEYS.includes(key), `${key} is forbidden`);
      assert.deepEqual(sessionForbiddenKeys({ [key]: 1 }), [key]);
    }
    assert.deepEqual(sessionForbiddenKeys({ a: { b: { track: [1, 2] } } }), ["a.b.track"]);
    assert.deepEqual(sessionForbiddenKeys(openedEnvelope()), [], "a real envelope carries none");
  });

  it("the envelope type guard is exact: drift is refused, not coerced", () => {
    const e = openedEnvelope();
    assert.equal(isExperienceSessionEnvelope(e), true);
    assert.equal(isExperienceSessionEnvelope({ ...e, opportunity_kind: "wandering" }), false);
    assert.equal(isExperienceSessionEnvelope({ ...e, claim_refs: [1] }), false);
    assert.equal(isExperienceSessionEnvelope({ ...e, expires_at: "soon" }), false);
    assert.equal(isExperienceSessionEnvelope({ ...e, outcome: "amazing" }), false);
    assert.equal(isExperienceSessionEnvelope({ ...e, experience_rating: 9 }), false);
    assert.equal(isExperienceSessionEnvelope({ ...e, path: ["a", "b"] }), false, "a trail is not an envelope");
    assert.equal(isExperienceSessionEnvelope(null), false);
  });

  it("open · expired · closed are folded, never stored as a status somebody could set", () => {
    const e = openedEnvelope();
    assert.equal(sessionState(e, NOW), "open");
    assert.equal(sessionState(e, NOW + DEFAULT_SESSION_HOURS * 3_600_000 + 1), "expired");
    assert.equal(sessionState({ ...e, phase: "closed" }, NOW), "closed");
  });
});

describe("ExperienceSession — the OUTCOME it closes with (§5.4, S113)", () => {
  it("closes with a result and optional feedback, on the outcome's OWN existing verb", () => {
    const r = closeExperienceSession(openedEnvelope(), ACTOR, { outcome: "better", experienceRating: 5 }, NOW + 60_000);
    assert.ok(r.ok);
    assert.equal(r.envelope.phase, "closed");
    assert.equal(r.envelope.outcome, "better");
    assert.equal(r.envelope.experience_rating, 5);
    assert.equal(r.envelope.close_reason, "outcome_reported");
    assert.equal(r.event.verb, OUTCOME_VERB.better, "the existing outcome verb, not a new one");
    assert.ok((OUTCOME_VERBS as readonly string[]).includes(r.event.verb));
  });

  it("every outcome in the existing vocabulary can close a session, and nothing else can", () => {
    for (const outcome of INTEL_OUTCOMES) {
      const r = closeExperienceSession(openedEnvelope(), ACTOR, { outcome }, NOW + 60_000);
      assert.ok(r.ok, `${outcome} closes`);
      assert.equal(r.event.verb, OUTCOME_VERB[outcome]);
    }
    const bad = closeExperienceSession(openedEnvelope(), ACTOR, { outcome: "great" as never }, NOW + 60_000);
    assert.equal(bad.ok === false && bad.refusal, "unknown_outcome");
  });

  it("closing is TERMINAL: a closed session cannot be closed again", () => {
    const closed = closeExperienceSession(openedEnvelope(), ACTOR, { outcome: "same" }, NOW + 60_000);
    assert.ok(closed.ok);
    const again = closeExperienceSession(closed.envelope, ACTOR, { outcome: "better" }, NOW + 120_000);
    assert.equal(again.ok === false && again.refusal, "already_closed");
  });

  it("an EXPIRED session cannot be closed with an outcome — the window it would describe has passed", () => {
    const late = NOW + (DEFAULT_SESSION_HOURS * 3_600_000) + 60_000;
    const r = closeExperienceSession(openedEnvelope(), ACTOR, { outcome: "better" }, late);
    assert.equal(r.ok === false && r.refusal, "expired");
  });

  it("a rating outside the existing 1..5 scale is refused", () => {
    const r = closeExperienceSession(openedEnvelope(), ACTOR, { outcome: "better", experienceRating: 0 }, NOW + 60_000);
    assert.equal(r.ok === false && r.refusal, "invalid_rating");
  });

  it("the fold takes the CLOSE over the open, and an unknown id folds to null — never a plausible session", () => {
    const opened = openedEnvelope();
    const closed = closeExperienceSession(opened, ACTOR, { outcome: "worse" }, NOW + 60_000);
    assert.ok(closed.ok);
    const folded = foldSession([opened, closed.envelope], SESSION, NOW + 120_000);
    assert.equal(folded?.state, "closed");
    assert.equal(folded?.envelope.outcome, "worse");
    assert.equal(foldSession([opened], "44444444-dddd-4ddd-8ddd-444444444444", NOW), null);
  });
});

describe("ExperienceSession — no second store, and no history to read", () => {
  it("the envelope rides an ALLOW-LISTED payload key beside `intel`, and survives the spine's projection", () => {
    assert.ok((ALLOWED_PAYLOAD_KEYS as readonly string[]).includes(EXPERIENCE_SESSION_PAYLOAD_KEY));
    const r = open();
    assert.ok(r.ok);
    const row = projectEvent(r.event);
    assert.ok(row, "the verb is canonical — a session event reaches the spine");
    assert.deepEqual(row.payload[EXPERIENCE_SESSION_PAYLOAD_KEY], r.envelope);
  });

  it("a coordinate cannot ride inside the envelope: the spine strips it at every depth", () => {
    const r = open();
    assert.ok(r.ok);
    const poisoned = { ...r.event, payload: { [EXPERIENCE_SESSION_PAYLOAD_KEY]: { ...r.envelope, latitude: 48.8, lng: 2.2 } } };
    const row = projectEvent(poisoned);
    const env = row!.payload[EXPERIENCE_SESSION_PAYLOAD_KEY] as Record<string, unknown>;
    assert.equal("latitude" in env, false);
    assert.equal("lng" in env, false);
    assert.equal(env.session_id, SESSION);
  });

  it("the four verbs a session can produce are the spine's own — no verb was invented", () => {
    assert.deepEqual([...SESSION_VERBS], [SESSION_OPEN_VERB, ...OUTCOME_VERBS]);
  });

  it("the store offers no list, no history and no by-subject read", () => {
    const code = readFileSync(join(SRC, "lib", "experienceSessionStore.ts"), "utf8");
    const exported = [...code.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(exported.sort(), ["appendSessionEvent", "readOpenSession", "readSessionById"]);
    for (const forbidden of [/listSessions/, /sessionHistory/, /readSessionsFor/, /bySubject/]) {
      assert.doesNotMatch(code, forbidden);
    }
    // The one read is bounded by a session lifetime, so no query here could
    // answer "where has this person been".
    assert.match(code, /MAX_SESSION_HOURS \* 3_600_000/);
  });

  it("the engine is pure: no clock of its own, no database, no randomness", () => {
    const code = readFileSync(join(SRC, "lib", "experienceSession.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(/);
    assert.doesNotMatch(code, /supabase|getServiceClient|\.from\(/);
    assert.doesNotMatch(code, /randomUUID|Math\.random/);
  });
});
