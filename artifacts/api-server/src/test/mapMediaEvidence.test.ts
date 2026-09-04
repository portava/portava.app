/**
 * §22's eighth prompt — media lands as EVIDENCE, and only as evidence.
 *
 * The ruling under test is not "media works now". It is a set of things that
 * must all hold at once, and each of which is a way this could have gone wrong:
 *
 *   1. media still mints no claim, and no claim type exists for it;
 *   2. media alone — with no observation to support — is still refused;
 *   3. a client `mediaUri` is never stored as sent, and a reference to somebody
 *      else's object, or to somebody else's host, is refused;
 *   4. attaching evidence does not raise confidence (the paid-contribution rule
 *      applies to artifacts for exactly the same reason);
 *   5. every gate the observation arrow passes — both flags, consent, the
 *      observed-at clamp, the strict schema, idempotency — is also on the
 *      evidence arrow, and is the SAME function, not a second copy;
 *   6. evidence has a retention story and is reachable by account deletion.
 *
 * Everything runs in memory against a fake supabase client in the shape used by
 * mapObservations.test.ts. Nothing on the path is mocked out: attachMediaEvidence,
 * appStorageUrlInfo, ownerFromPath, hasValidIntelConsent, clampObservedAt,
 * assembleClaimInput and scoreConfidence are all the shipping implementations.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAP_CONTRIBUTION_KINDS,
  MEDIA_KINDS,
  SUPPORTED_CONTRIBUTION_KINDS,
  UNSUPPORTED_CONTRIBUTION_KINDS,
  ingestMapContribution,
  mapContributionSchema,
  mapContributionToClaim,
} from "../routes/mapObservations.js";
import {
  EVIDENCE_SOURCE_MAP_CONTRIBUTION,
  MEDIA_EVIDENCE_KIND,
  attachMediaEvidence,
  resolveOwnedMediaReference,
} from "../lib/intelEvidenceCapture.js";
import { publicUrlFor } from "../lib/mediaAccess.js";
import { CLAIM_TYPES } from "../lib/intelContracts.js";
import { INTEL_IDENTIFIABLE_RETENTION_SECONDS } from "../lib/locationPurposes.js";
import { assembleClaimInput } from "../lib/intelProjectionAggregator.js";
import { scoreConfidence } from "../lib/confidenceScore.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";
import { ERASED_BY_CASCADE } from "../lib/deletionDispositions.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");
const MIGRATIONS = join(SRC_ROOT, "migrations");

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "11111111-1111-4111-8111-111111111112";
const ACTOR_C = "11111111-1111-4111-8111-111111111113";
const PLACE = "22222222-2222-4222-8222-222222222222";
const PLACE_2 = "22222222-2222-4222-8222-222222222223";
const OBSERVED = new Date(Date.now() - 5 * 60_000).toISOString();

/** The shape POST /api/media/upload returns: `post-media/<uid>/<ts>.<ext>`. */
const OWN_MEDIA = `post-media/${ACTOR}/1756600000000.jpg`;
const OTHER_MEDIA = `post-media/${ACTOR_B}/1756600000000.jpg`;

// ── Fake supabase client ──────────────────────────────────────────────────────
//
// Same generic-filter shape as mapObservations.test.ts, plus two things this
// unit needs: an `intel_evidence` store with the real unique index emulated, and
// a record of which tables were READ. The read log is how "nothing scores off
// evidence" is proved behaviourally rather than by reading the aggregator.

interface FakeOpts {
  places?: string[];
  consent?: Record<string, boolean | "withdrawn">;
}

function makeDb(flags: Record<string, boolean>, opts: FakeOpts = {}) {
  const tables: Record<string, any[]> = {
    feature_flags: Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })),
    places: (opts.places ?? []).map((id) => ({ id })),
    intel_contribution_consent: Object.entries(opts.consent ?? {}).map(([user_id, state]) => ({
      user_id,
      enabled: state !== false,
      withdrawn_at: state === "withdrawn" ? new Date().toISOString() : null,
    })),
    freshness_policies: CLAIM_TYPES.map((c) => ({
      claim_type: c.claimType,
      ttl_seconds: c.ttlSeconds,
      note: c.note,
    })),
    intel_observations: [],
    intel_evidence: [],
    intel_claims: [],
    intel_confirmations: [],
    intel_reward_ledger: [],
  };
  const writes: Record<string, number> = {};
  const reads: string[] = [];
  let seq = 0;

  function from(table: string) {
    let op: "select" | "insert" | "insert_select" = "select";
    let payload: any = null;
    const filters: Array<{ col: string; val: any; kind: string }> = [];

    const match = (row: any) =>
      filters.every((f) => {
        const cell = row[f.col];
        switch (f.kind) {
          case "in": return (f.val as any[]).includes(cell);
          case "is": return (cell ?? null) === f.val;
          case "lte": return String(cell ?? "") <= String(f.val);
          case "gte": return String(cell ?? "") >= String(f.val);
          default: return cell === f.val;
        }
      });

    function run(): { data: any; error: any } {
      const store = tables[table] ?? (tables[table] = []);
      if (op === "insert" || op === "insert_select") {
        // uuid-SHAPED ids: the route validates `observationId` as a uuid, so a
        // `row-1` id would make every attachment fail for the wrong reason.
        const row = {
          id: `44444444-4444-4444-8444-${String(++seq).padStart(12, "0")}`,
          created_at: new Date().toISOString(),
          ...payload,
        };
        // The real unique indexes, emulated:
        //   intel_observations (actor_id, idempotency_key)          — 2130
        //   intel_evidence     (observation_id, reference) NOT NULL — 2223
        const dup =
          (table === "intel_observations" &&
            store.some((r) => r.actor_id === row.actor_id && r.idempotency_key === row.idempotency_key)) ||
          (table === "intel_evidence" &&
            row.reference != null &&
            store.some((r) => r.observation_id === row.observation_id && r.reference === row.reference));
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
        store.push(row);
        writes[table] = (writes[table] ?? 0) + 1;
        return { data: op === "insert_select" ? row : null, error: null };
      }
      reads.push(table);
      return { data: store.filter(match), error: null };
    }

    const first = () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    };

    const b: any = {
      select() { op = op === "insert" ? "insert_select" : "select"; return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      eq(col: string, val: any) { filters.push({ col, val, kind: "eq" }); return b; },
      in(col: string, val: any[]) { filters.push({ col, val, kind: "in" }); return b; },
      is(col: string, val: any) { filters.push({ col, val, kind: "is" }); return b; },
      lte(col: string, val: any) { filters.push({ col, val, kind: "lte" }); return b; },
      gte(col: string, val: any) { filters.push({ col, val, kind: "gte" }); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return Promise.resolve(first()); },
      single() { return Promise.resolve(first()); },
      then(resolve2: (r: any) => any) { return Promise.resolve(run()).then(resolve2); },
    };
    return b;
  }

  return { from, _tables: tables, _writes: writes, _reads: reads } as unknown as SupabaseClient & { _tables: typeof tables; _writes: typeof writes; _reads: typeof reads };
}

function openDb(actors: string[] = [ACTOR], places: string[] = [PLACE]) {
  const consent: Record<string, boolean | "withdrawn"> = {};
  for (const a of actors) consent[a] = true;
  return makeDb(
    { map_contributions_enabled: true, intel_capture_quick_signal: true },
    { places, consent },
  );
}

const crowdContribution = (over: Record<string, unknown> = {}) => ({
  objectId: PLACE,
  objectKind: "place",
  kind: "crowd_level",
  value: "busy",
  observedAt: OBSERVED,
  ...over,
});

const mediaContribution = (over: Record<string, unknown> = {}) => ({
  objectId: PLACE,
  objectKind: "place",
  kind: "media",
  value: "photo",
  mediaUri: OWN_MEDIA,
  observedAt: OBSERVED,
  ...over,
});

/** Make the observation a photo can attach to, and return its id. */
async function makeObservation(db: any, actor = ACTOR, objectId = PLACE): Promise<string> {
  const r = await ingestMapContribution(db, actor, crowdContribution({ objectId }));
  assert.equal(r.ok, true, `setup observation failed: ${JSON.stringify(r)}`);
  return (r as any).observation.id;
}

// ── A. The ruling survives ────────────────────────────────────────────────────

describe("media is still not a claim", () => {
  it("mints no claim type, no mapping, and stays out of the supported set", () => {
    for (const value of MEDIA_KINDS) {
      assert.equal(mapContributionToClaim("media", value), null, `media/${value} must not map`);
    }
    assert.equal((SUPPORTED_CONTRIBUTION_KINDS as readonly string[]).includes("media"), false,
      "SUPPORTED_CONTRIBUTION_KINDS is the set of PROPOSITIONS; a photo is not one");
    for (const c of CLAIM_TYPES) {
      assert.doesNotMatch(c.claimType, /^media\.|photo|video/i,
        `${c.claimType} invents a claim for an artifact`);
    }
  });

  it("keeps media in the no-claim set, with a reason that says where it goes instead", () => {
    assert.deepEqual(Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS), ["media"]);
    const why = UNSUPPORTED_CONTRIBUTION_KINDS.media;
    assert.match(why, /evidence/i);
    assert.match(why, /intel_evidence/);
    assert.match(why, /observationId/, "the refusal must say what to do instead, not just what is wrong");
    assert.doesNotMatch(why, /no route wires yet/, "a route wires it now");
  });

  it("still partitions the eight prompts totally", () => {
    const supported = new Set<string>(SUPPORTED_CONTRIBUTION_KINDS);
    const refused = new Set(Object.keys(UNSUPPORTED_CONTRIBUTION_KINDS));
    for (const kind of MAP_CONTRIBUTION_KINDS) {
      assert.equal(supported.has(kind) !== refused.has(kind), true, `${kind} is in neither or both`);
    }
  });

  it("maps each §22 asset type onto its OWN evidence kind — a video is not filed as a photo", () => {
    assert.deepEqual(Object.keys(MEDIA_EVIDENCE_KIND).sort(), [...MEDIA_KINDS].sort());
    for (const k of MEDIA_KINDS) assert.equal(MEDIA_EVIDENCE_KIND[k], k);
  });
});

// ── B. Evidence may not arrive alone ──────────────────────────────────────────

describe("evidence cannot precede the observation it supports (§21)", () => {
  it("refuses a media contribution that names no observation, and stores nothing", async () => {
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({ mediaUri: "file:///tmp/x.jpg" }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unsupported_kind");
    assert.match((r as any).detail, /evidence/i);
    assert.equal(db._tables.intel_observations.length, 0);
    assert.equal(db._tables.intel_evidence.length, 0);
    assert.equal(JSON.stringify(db._tables).includes("file:///tmp/x.jpg"), false,
      "nothing resembling the asset may be stored anywhere");
  });

  it("refuses even a PERFECTLY VALID asset when no observation is named", async () => {
    // The point of ordering the observation check first: a good URI does not
    // make a bare artifact into a contribution.
    const db = openDb();
    const r = await ingestMapContribution(db, ACTOR, mediaContribution());
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "unsupported_kind");
    assert.equal(db._tables.intel_evidence.length, 0);
  });

  it("refuses at the service too, so the rule does not live only in the route", async () => {
    const db = openDb();
    const r = await attachMediaEvidence(db, ACTOR, {
      observationId: null,
      subjectId: PLACE,
      mediaUri: OWN_MEDIA,
      mediaKind: "photo",
      observedAt: OBSERVED,
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "evidence_requires_observation");
  });

  it("refuses an observation that is not this actor's, without saying whether it exists", async () => {
    const db = openDb([ACTOR, ACTOR_B]);
    const theirs = await makeObservation(db, ACTOR_B);
    const mine = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: theirs }));
    const missing = await ingestMapContribution(db, ACTOR, mediaContribution({
      objectId: PLACE,
      observationId: "33333333-3333-4333-8333-333333333333",
    }));
    assert.equal((mine as any).reason, "unknown_observation");
    assert.equal((missing as any).reason, (mine as any).reason,
      "a real-but-foreign observation and a non-existent one must be indistinguishable");
    assert.equal((mine as any).code, (missing as any).code);
    assert.equal(db._tables.intel_evidence.length, 0);
  });

  it("refuses evidence aimed at an observation about a DIFFERENT subject", async () => {
    const db = openDb([ACTOR], [PLACE, PLACE_2]);
    const obs = await makeObservation(db, ACTOR, PLACE_2);
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "observation_subject_mismatch");
    assert.equal(db._tables.intel_evidence.length, 0);
  });
});

// ── C. The untrusted mediaUri ─────────────────────────────────────────────────

describe("a client mediaUri is untrusted input", () => {
  const REFUSED: Array<[string, string, string]> = [
    ["a file: URI", "file:///tmp/x.jpg", "invalid_media_reference"],
    ["an arbitrary host", "https://evil.example.com/photo.jpg", "invalid_media_reference"],
    [
      "a foreign host wearing our storage path",
      `https://evil.example.com/storage/v1/object/public/post-media/${ACTOR}/x.jpg`,
      "invalid_media_reference",
    ],
    ["a bucket outside the media allow-list", `stamp-artwork/${ACTOR}/x.png`, "invalid_media_reference"],
    ["path traversal", "post-media/../secrets", "invalid_media_reference"],
    ["a bare word", "photo.jpg", "invalid_media_reference"],
    ["ANOTHER USER'S object in our own bucket", OTHER_MEDIA, "media_not_owned"],
    ["an object under no user at all", "post-media/generated-visuals/event/x/hero.webp", "media_not_owned"],
  ];

  for (const [label, uri, reason] of REFUSED) {
    it(`refuses ${label}`, async () => {
      const db = openDb();
      const obs = await makeObservation(db);
      const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs, mediaUri: uri }));
      assert.equal(r.ok, false, `${uri} was accepted`);
      assert.equal((r as any).reason, reason, uri);
      assert.equal(db._tables.intel_evidence.length, 0);
      assert.equal(JSON.stringify(db._tables).includes(uri), false,
        "a refused reference must not be persisted anywhere, not even as a rejected note");
    });
  }

  it("accepts the bare storage key the upload endpoint actually returns", () => {
    const r = resolveOwnedMediaReference(OWN_MEDIA, ACTOR);
    assert.equal(r.ok, true);
    assert.equal((r as any).reference, OWN_MEDIA);
  });

  it("stores a STORAGE KEY, never the URL the client sent", async () => {
    // A full URL on the app's own storage origin is accepted, and is normalised
    // down to `<bucket>/<path>` — no origin, no scheme, no query, no token.
    //
    // The origin comes from publicUrlFor rather than from an env var read here:
    // check-guard-coverage treats a file that NAMES a Supabase credential
    // variable as one that can reach the database, and a pure in-memory test is
    // not that file.
    const own = publicUrlFor("post-media", `${ACTOR}/1756600000000.jpg`);
    assert.ok(own, "this test needs the storage origin the suite already configures");
    const url = `${own}?width=400`;
    const db = openDb();
    const obs = await makeObservation(db);
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs, mediaUri: url }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const row = db._tables.intel_evidence[0];
    assert.equal(row.reference, OWN_MEDIA);
    assert.equal(JSON.stringify(db._tables).includes("http"), false,
      "no URL, origin or token may survive into storage");
  });
});

// ── D. What an accepted attachment actually writes ────────────────────────────

describe("an accepted photo becomes one evidence row and nothing else", () => {
  it("writes exactly one intel_evidence row, keyed to the observation and the actor", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    const before = db._writes.intel_observations;

    const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((r as any).deduped, false);

    assert.equal(db._tables.intel_evidence.length, 1);
    const row = db._tables.intel_evidence[0];
    assert.equal(row.observation_id, obs);
    assert.equal(row.actor_id, ACTOR);
    assert.equal(row.evidence_kind, "photo");
    assert.equal(row.reference, OWN_MEDIA);

    // No second observation, no claim, no snapshot, no reward.
    assert.equal(db._writes.intel_observations, before, "attaching evidence must not write an observation");
    assert.equal(db._tables.intel_claims.length, 0);
    assert.equal(db._tables.intel_reward_ledger.length, 0);
    assert.deepEqual(Object.keys(db._writes).sort(), ["intel_evidence", "intel_observations"]);
  });

  it("files a video as a VIDEO", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({
      observationId: obs,
      value: "video",
      mediaUri: `post-media/${ACTOR}/1756600000001.mp4`,
    }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(db._tables.intel_evidence[0].evidence_kind, "video");
  });

  it("carries a retention deadline at the ruled 180 days, and no contributor free text", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    const row = db._tables.intel_evidence[0];

    const declared = new Date(row.expires_at).getTime() - new Date(row.created_at).getTime();
    const ruled = INTEL_IDENTIFIABLE_RETENTION_SECONDS * 1000;
    assert.ok(Math.abs(declared - ruled) < 5_000,
      `evidence must declare the ruled retention, got ${declared}ms vs ${ruled}ms`);

    // `detail` is the only free-form column, and this path writes a constant
    // into it. A contributor cannot put prose (or coordinates) there.
    assert.deepEqual(row.detail, { source: EVIDENCE_SOURCE_MAP_CONTRIBUTION });
  });

  it("carries no claim, confidence, value or TTL of its own", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    for (const key of Object.keys(db._tables.intel_evidence[0])) {
      assert.doesNotMatch(key, /claim|confidence|band|value|reward|ledger|paid|sponsor/i,
        `evidence must not carry ${key} — an artifact asserts nothing`);
    }
  });

  it("dedupes a double-tap of the same artifact on the same observation", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    const first = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    const replay = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal((replay as any).deduped, true);
    assert.equal((replay as any).evidence.id, (first as any).evidence.id);
    assert.equal(db._tables.intel_evidence.length, 1, "append-only: a duplicate would be permanent");
  });

  it("lets a SECOND, different artifact support the same observation", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    const second = await ingestMapContribution(db, ACTOR, mediaContribution({
      observationId: obs,
      mediaUri: `post-media/${ACTOR}/1756600000002.jpg`,
    }));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal((second as any).deduped, false);
    assert.equal(db._tables.intel_evidence.length, 2);
  });
});

// ── E. Every gate the observation arrow passes ────────────────────────────────

describe("the evidence arrow passes the same gates, not around them", () => {
  /** An observation to attach to, made while the gates were open. */
  async function seeded() {
    const open = openDb();
    const obs = await makeObservation(open);
    return obs;
  }

  it("is refused when the map contributions flag is off", async () => {
    const obs = await seeded();
    const db = makeDb({ map_contributions_enabled: false, intel_capture_quick_signal: true },
      { places: [PLACE], consent: { [ACTOR]: true } });
    db._tables.intel_observations.push({ id: obs, actor_id: ACTOR, subject_id: PLACE });
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    assert.equal((r as any).reason, "feature_disabled");
    assert.equal(db._tables.intel_evidence.length, 0);
  });

  it("is refused when the intel capture flag is off — the SECOND half of the double gate", async () => {
    const obs = await seeded();
    const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: false },
      { places: [PLACE], consent: { [ACTOR]: true } });
    db._tables.intel_observations.push({ id: obs, actor_id: ACTOR, subject_id: PLACE });
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    assert.equal((r as any).reason, "disabled");
    assert.equal(db._tables.intel_evidence.length, 0);
  });

  it("is refused without valid intel consent, and refused after withdrawal (D4)", async () => {
    const CONSENTS: Record<string, boolean | "withdrawn">[] = [{}, { [ACTOR]: "withdrawn" }];
    for (const consent of CONSENTS) {
      const obs = await seeded();
      const db = makeDb({ map_contributions_enabled: true, intel_capture_quick_signal: true },
        { places: [PLACE], consent });
      db._tables.intel_observations.push({ id: obs, actor_id: ACTOR, subject_id: PLACE });
      const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
      assert.equal((r as any).reason, "consent_required", JSON.stringify(consent));
      assert.equal((r as any).code, "forbidden");
      assert.equal(db._tables.intel_evidence.length, 0);
    }
  });

  it("is refused on a future observed_at, through the contract's own clamp", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({
      observationId: obs,
      observedAt: new Date(Date.now() + 600_000).toISOString(),
    }));
    assert.equal((r as any).reason, "invalid_observed_at");
    assert.equal(db._tables.intel_evidence.length, 0);
  });

  it("REFUSES a body carrying an actor or a reward field — the schema is still strict", async () => {
    for (const smuggled of ["actorId", "userId", "contributorId", "reward", "paid", "sponsored"]) {
      const db = openDb();
      const obs = await makeObservation(db);
      const r = await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs, [smuggled]: "x" }));
      assert.equal(r.ok, false, `media + ${smuggled} must be refused`);
      assert.equal((r as any).reason, "invalid_payload");
      assert.equal(db._tables.intel_evidence.length, 0);
    }
  });

  it("takes the actor from the caller, never from the body", async () => {
    const db = openDb([ACTOR, ACTOR_B]);
    const obs = await makeObservation(db, ACTOR);
    await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    assert.equal(db._tables.intel_evidence[0].actor_id, ACTOR);
  });

  it("still requires the asset on the payload, and still accepts a bare mediaUri at the SCHEMA layer", () => {
    const base = { objectId: PLACE, objectKind: "place" as const, kind: "media" as const,
      value: "photo" as const, observedAt: OBSERVED };
    assert.equal(mapContributionSchema.safeParse(base).success, false, "mediaUri is not optional");
    // The URI check needs the actor, so it deliberately is NOT in the schema —
    // a half-check here would read as the whole check.
    assert.equal(mapContributionSchema.safeParse({ ...base, mediaUri: "file:///x.jpg" }).success, true);
    // observationId is optional in the SCHEMA so the refusal is the ruling,
    // not a parse issue — and rejected outright when it is not a uuid.
    assert.equal(
      mapContributionSchema.safeParse({ ...base, mediaUri: OWN_MEDIA, observationId: "nope" }).success,
      false,
    );
  });

  it("refuses a media prompt on an object kind that cannot take one", async () => {
    const db = openDb();
    const obs = await makeObservation(db);
    const r = await ingestMapContribution(db, ACTOR, mediaContribution({
      objectKind: "activity_zone", observationId: obs,
    }));
    assert.equal((r as any).reason, "prompt_not_allowed");
    assert.equal(db._tables.intel_evidence.length, 0);
  });
});

// ── F. Evidence must not become a confidence backdoor ─────────────────────────
//
// §22 forbids a PAID contribution from scoring higher. An artifact is the same
// hazard by a different route: if attaching a photo raised evidence quality, a
// contributor could buy confidence with an upload instead of with money, and
// nothing about the photo would have been verified.

describe("attaching evidence raises nothing", () => {
  const claimFor = (subjectId: string) => ({
    id: `claim-${subjectId}`,
    subject_id: subjectId,
    zone_id: null,
    claim_type: "crowd.level",
    value: { level: "busy" },
    status: "active",
    observed_at: OBSERVED,
  });

  it("two identical cohorts score identically when only one attached photos", async () => {
    invalidateFreshnessPolicyCache();
    const actors = [ACTOR, ACTOR_B, ACTOR_C];
    const db = openDb(actors, [PLACE, PLACE_2]);

    const withEvidence: string[] = [];
    for (const actor of actors) {
      for (const place of [PLACE, PLACE_2]) {
        const r = await ingestMapContribution(db, actor, crowdContribution({ objectId: place }));
        assert.equal(r.ok, true, JSON.stringify(r));
        if (place === PLACE) withEvidence.push((r as any).observation.id);
      }
    }
    // Only PLACE gets photographic evidence — one artifact per contributor.
    for (const [i, actor] of actors.entries()) {
      const r = await ingestMapContribution(db, actor, mediaContribution({
        observationId: withEvidence[i],
        mediaUri: `post-media/${actor}/1756600000000.jpg`,
      }));
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    // Vacuity guard: the evidence really is there.
    assert.equal(db._tables.intel_evidence.length, 3);

    const now = new Date();
    db._reads.length = 0;
    const evidenced = await assembleClaimInput(db, claimFor(PLACE), now);
    const readsDuringScoring = [...db._reads];
    const bare = await assembleClaimInput(db, claimFor(PLACE_2), now);

    assert.equal(evidenced.distinctActors, 3, "a vacuous 0 on both sides would prove nothing");
    assert.deepEqual(evidenced.components, bare.components,
      "a photographed contribution scored differently from an identical unphotographed one");
    assert.deepEqual(evidenced.penalties, bare.penalties);
    assert.deepEqual(
      scoreConfidence(evidenced.components, evidenced.penalties),
      scoreConfidence(bare.components, bare.penalties),
    );
    assert.ok(scoreConfidence(evidenced.components, evidenced.penalties).confidence > 0);

    // And the mechanism, not just the outcome: the scorer never even LOOKED at
    // the evidence table, so there is no channel to drift.
    assert.equal(readsDuringScoring.includes("intel_evidence"), false,
      "the confidence path must not read intel_evidence until someone rules on evidence quality");
  });

  it("evidence quality stays at the evidence-thin value the aggregator hardcodes", async () => {
    invalidateFreshnessPolicyCache();
    const db = openDb([ACTOR], [PLACE]);
    const obs = await makeObservation(db);
    await ingestMapContribution(db, ACTOR, mediaContribution({ observationId: obs }));
    const input = await assembleClaimInput(db, claimFor(PLACE), new Date());
    assert.equal(input.components.evidenceQuality, 0.3,
      "0.8 would mean attaching a photo bought a confidence boost nobody ruled on");
  });
});

// ── G. Evidence is write-only, which is why it needs no moderation column ─────

describe("nothing reads intel_evidence", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...sourceFiles(p));
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("no route and no serving library selects from the table", () => {
    const scanned = [
      ...sourceFiles(join(SRC_ROOT, "routes")),
      ...sourceFiles(join(SRC_ROOT, "lib")),
    ];
    assert.ok(scanned.length > 50, "the scan found almost nothing — it is not looking where it thinks");

    const producer = join(SRC_ROOT, "lib", "intelEvidenceCapture.ts");
    assert.match(readFileSync(producer, "utf8"), /from\("intel_evidence"\)/,
      "the pattern this scan uses must actually match the one file that IS allowed to touch the table");

    // WHAT THIS ACTUALLY FORBIDS, narrowed 2026-09-03.
    //
    // The rule was written as "nothing touches the table", because at the time
    // nothing did. main then added lib/media/mediaEvidenceLink.ts, which reads
    // it — and reading the assertion literally would have called that a
    // violation. It is not, and the difference is worth stating precisely.
    //
    // The hazard is SERVING unmoderated contributor media: `reference` is a
    // storage key pointing at bytes a person uploaded, and there is no
    // moderation state on this table to gate them by. So `reference` may not
    // leave the table, and no ROUTE may read it at all.
    //
    // An internal boolean — "does this observation have eligible evidence?" —
    // exposes nothing to anyone and is a different act. mediaEvidenceLink
    // selects only media_asset_id, fails closed, and the aggregator still
    // hardcodes hasEvidence = false, so no confidence score moves either.
    //
    // The narrowing is deliberate and bounded: a route reading the table, or
    // ANY file selecting `reference`, still fails.
    const READ_ALLOWED: Record<string, string> = {
      "lib/media/mediaEvidenceLink.ts":
        "Boolean existence check feeding the aggregator's hasEvidence input. Selects media_asset_id only — never " +
        "`reference`, so no storage key and no contributor bytes leave the table. Fail-closed on error.",
    };

    const touching = scanned
      .filter((f) => f !== producer)
      .filter((f) => /from\(["']intel_evidence["']\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC_ROOT.length + 1));

    // 1. No ROUTE may read it, allowlist or not. A route is a serving path.
    assert.deepEqual(
      touching.filter((f) => f.startsWith("routes/")),
      [],
      "evidence has no moderation state, so it may not be served: a route reading intel_evidence is a serving path",
    );

    // 2. Any other reader must be allowlisted with a stated reason.
    assert.deepEqual(
      touching.filter((f) => !(f in READ_ALLOWED)),
      [],
      "a new reader of intel_evidence. If it only needs an internal boolean, add it to READ_ALLOWED with a reason " +
        "and confirm it never selects `reference`. If it needs the evidence itself, moderation must be ruled on first.",
    );

    // 3. The allowlist has no stale entries — one that outlives its file would
    //    silently pre-authorise a future reader at that path.
    assert.deepEqual(
      Object.keys(READ_ALLOWED).filter((f) => !touching.includes(f)),
      [],
      "this no longer reads intel_evidence — drop the entry rather than leaving a standing permission",
    );

    // 4. THE PROPERTY THAT MATTERS: nobody selects `reference`. This is what
    //    keeps unmoderated contributor media inside the table, and it applies
    //    to allowlisted readers too.
    const leaking = scanned
      .filter((f) => f !== producer)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        if (!/from\(["']intel_evidence["']\)/.test(src)) return false;
        return /\.select\([^)]*\breference\b/.test(src);
      })
      .map((f) => f.slice(SRC_ROOT.length + 1));
    assert.deepEqual(leaking, [],
      "`reference` is a storage key for unmoderated contributor media; selecting it outside the producer is the " +
        "serving path this rule exists to prevent",
    );
  });
});

// ── H. Retention and account deletion ─────────────────────────────────────────
//
// §22 evidence is user-generated content tied to a person's contribution. It
// must not become the one intel artifact with no retention story. All three of
// these existed before the table had a producer; they now have something to
// sweep, which is exactly why they are pinned here rather than assumed.

describe("evidence has a retention story and a deletion fate", () => {
  const sql = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

  it("is swept at the ruled 180 days by the contribution retention function", () => {
    const s = sql("2173_intel_contribution_retention.sql");
    assert.match(s, /DELETE FROM public\.intel_evidence WHERE created_at < p_cutoff/);
  });

  it("is deleted for the actor by the single erasure entry point", () => {
    const s = sql("2130_intel_storage.sql");
    assert.match(s, /DELETE FROM public\.intel_evidence WHERE actor_id = p_actor_id/);
  });

  it("is classified as erased by the account deletion manifest", () => {
    assert.ok((ERASED_BY_CASCADE as readonly string[]).includes("intel_evidence"),
      "a user-keyed table with no stated deletion fate is the defect check:deletion-coverage exists to catch");
  });
});

// ── I. Migration 2223 ─────────────────────────────────────────────────────────

describe("migration 2223 widens the taxonomy without minting a claim", () => {
  const s = readFileSync(join(MIGRATIONS, "2223_map_media_evidence.sql"), "utf8");

  it("admits video alongside the six kinds 2130 declared", () => {
    assert.match(s, /ADD CONSTRAINT intel_evidence_kind_check/);
    for (const kind of ["photo", "receipt", "official_feed", "partner_api", "sensor", "text_note", "video"]) {
      assert.ok(s.includes(`'${kind}'`), `the widened check dropped ${kind}`);
    }
  });

  it("adds the unique index that makes a replay detectable on an append-only table", () => {
    assert.match(s, /CREATE UNIQUE INDEX IF NOT EXISTS intel_evidence_observation_reference/);
    assert.match(s, /WHERE reference IS NOT NULL/);
  });

  it("creates no claim type, no freshness policy and no TTL", () => {
    assert.doesNotMatch(s, /INSERT INTO public\.freshness_policies/i);
    assert.doesNotMatch(s, /claim_type/i);
    assert.doesNotMatch(s, /ttl_seconds/i);
  });

  it("grants nothing new — a write-only store needs no wider grant", () => {
    assert.doesNotMatch(s, /^\s*GRANT /mi);
  });
});
