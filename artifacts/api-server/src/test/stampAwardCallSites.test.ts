/**
 * Every stamp AWARD call site, enumerated and classified — census-highlights-memories H4.
 *
 * H4: "Planned/saved/nearby never represented as 'experienced' without
 * occurrence evidence or user confirmation." The claim is universal, so it
 * holds only if EVERY place that mints a `user_stamps` row through
 * `StampAwardEngine.awardStamp` is known and has a stated basis. §F.2 enumerated
 * family one (`createStamp`); §BD.3 counted this family once by hand. This file
 * makes that count executable: it walks every non-test source file, finds every
 * award call expression, and fails when one appears that is not in REGISTRY
 * below, when one in REGISTRY disappears, or when a site's stated guard is no
 * longer in its file.
 *
 * A NEW AWARD SITE MUST BE ADDED HERE WITH ITS BASIS. That is the ratchet.
 *
 * THE BASES
 *   occurrence_evidence  a presence slug, minted only behind evidence that THIS
 *                        person was there (a GPS-eligible postcard verdict, a
 *                        check-in on the trip).
 *   confirmed_occurrence the person, or a party to the thing, confirmed it
 *                        happened (a started booking marked complete, a started
 *                        event completed by its host, a Safe Return confirmed),
 *                        or the evidence is a check-in at the event. No place.
 *   action_itself        a slug that names an action the person took at award
 *                        time (created a trip, RSVPed, followed, posted, was
 *                        approved). Must be non-presence and must carry no place.
 *   criteria_derived     the criteria engine: awards carry no place; its two
 *                        been-there metrics read presence stamps only, and
 *                        `trips_completed` reads evidenced trips only.
 *   admin_attestation    an authenticated admin grant, reason required, audited.
 *   internal_service     a secret-guarded service endpoint with no in-tree caller.
 *   unreachable          defined, and called by nothing in the tree.
 *
 * Run: node --import tsx/esm --test src/test/stampAwardCallSites.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPresenceStamp, PRESENCE_STAMP_SLUGS } from "../services/passport/nonPresenceStampAwards.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Basis =
  | "occurrence_evidence"
  | "confirmed_occurrence"
  | "action_itself"
  | "criteria_derived"
  | "admin_attestation"
  | "internal_service"
  | "unreachable";

interface Site {
  /** Path under src/. */
  file: string;
  /** Matches exactly one award call's argument text in that file. */
  args: RegExp;
  /** The slugs this site can award; "caller" when the request supplies it. */
  slugs: readonly string[] | "caller";
  basis: Basis;
  /** Text that must be in the file: the guard the basis rests on. */
  guard: RegExp;
  why: string;
}

const TRIP_COMPLETION_SLUGS = [
  "first_trip_completed", "long_haul", "weekend_wanderer", "international_voyager",
  "solo_traveler", "group_tripper", "good_host", "road_warrior", "frequent_flyer",
] as const;

const REGISTRY: readonly Site[] = [
  // ── routes/trips.ts ──────────────────────────────────────────────────────
  {
    file: "routes/trips.ts",
    args: /^\s*sc,\s*\{\s*userId,\s*definitionSlug: slug,\s*sourceType: "trips",\s*sourceId: tripId,\s*city,\s*country,\s*\},\s*log\s*$/,
    slugs: TRIP_COMPLETION_SLUGS,
    basis: "occurrence_evidence",
    guard: /awards\.filter\(\(\{ userId \}\) => presence\.present\.has\(userId\)\)\.map\(/,
    why: "trip completion: each member must have a check-in on THIS trip (readTripPresenceEvidence); the calendar completing a plan is not a visit",
  },
  {
    file: "routes/trips.ts",
    args: /^\s*client,\s*placelessAward\(\{[^{}]*definitionSlug: "first_trip_created"[^{}]*\}\)\s*$/,
    slugs: ["first_trip_created"],
    basis: "action_itself",
    guard: /awardStamp\(client, placelessAward\(\{/,
    why: "trip creation: names the planning, carries no place (§BD.2)",
  },
  {
    file: "routes/trips.ts",
    args: /^\s*client,\s*placelessAward\(\{[^{}]*definitionSlug: "trip_planner"[^{}]*\}\)\s*$/,
    slugs: ["trip_planner"],
    basis: "action_itself",
    guard: /awardStamp\(client, placelessAward\(\{/,
    why: "trip creation: names the planning, carries no place (§BD.2)",
  },
  {
    file: "routes/trips.ts",
    args: /^\s*sc,\s*input\s*$/,
    slugs: "caller",
    basis: "unreachable",
    guard: /async function callInternalStampAward\(/,
    why: "callInternalStampAward's local fallback; the function has no caller (asserted below)",
  },
  // ── routes/posts.ts ──────────────────────────────────────────────────────
  {
    file: "routes/posts.ts",
    args: /^\s*sc,\s*\{\s*userId,\s*definitionSlug: slug,\s*sourceType:\s*"posts",\s*sourceId:\s*postId,\s*\}\s*$/,
    slugs: ["first_post", "storyteller", "photographer"],
    basis: "action_itself",
    guard: /socialAwards\.push\(\{ slug: "first_post" \}\)/,
    why: "posting counts; no place",
  },
  {
    file: "routes/posts.ts",
    args: /^\s*stampSc,\s*\{[^{}]*definitionSlug: slug,[^{}]*city:\s*locationCity \?\? undefined,[^{}]*\}\s*$/,
    slugs: ["city_explorer", "world_citizen"],
    basis: "occurrence_evidence",
    guard: /if \(verdict\.stampEligible && locationCity\) \{/,
    why: "inside the GPS stamp-eligibility verdict; counts only stamp_eligible postcards",
  },
  {
    file: "routes/posts.ts",
    args: /^\s*sc,\s*placelessAward\(\{[^{}]*definitionSlug: "first_postcard"[^{}]*\}\)\s*$/,
    slugs: ["first_postcard"],
    basis: "action_itself",
    guard: /placelessAward\(\{/,
    why: "first postcard: no place (§BD.2)",
  },
  // ── routes/hiddenGems.ts ─────────────────────────────────────────────────
  {
    file: "routes/hiddenGems.ts",
    args: /^\s*sc,\s*placelessAward\(\{[^{}]*definitionSlug: "hidden_gem_explorer"[^{}]*\}\)\s*$/,
    slugs: ["hidden_gem_explorer"],
    basis: "action_itself",
    guard: /parsed\.data\.result === "approved" && gemRow && \(gemRow as any\)\.submitted_by/,
    why: "admin approved the submitter's gem; vouches for the gem, not for a visit; no place",
  },
  // ── routes/events.ts ─────────────────────────────────────────────────────
  {
    file: "routes/events.ts",
    args: /definitionSlug: "first_event_joined"/,
    slugs: ["first_event_joined"],
    basis: "action_itself",
    guard: /if \(status === "going"\) \{\s*\n\s*void \(async \(\) => \{/,
    why: "names the RSVP, which is the action taken; no place",
  },
  {
    file: "routes/events.ts",
    args: /definitionSlug: "first_event_hosted"/,
    slugs: ["first_event_hosted"],
    basis: "action_itself",
    guard: /params: \{ location: "hosting your first event", stampId: r\.userStampId \}/,
    why: "names publishing an event as host; no place",
  },
  {
    file: "routes/events.ts",
    args: /^\s*sc,\s*\{\s*userId,\s*definitionSlug: slug,\s*sourceType: "events",\s*sourceId: id,\s*\}\s*$/,
    slugs: ["event_host", "event_participant"],
    basis: "confirmed_occurrence",
    guard: /\.from\("event_attendee_states"\)\s*\n\s*\.select\("user_id"\)\s*\n\s*\.eq\("event_id", id\)\s*\n\s*\.not\("checked_in_at", "is", null\);/,
    why: "the host completes a STARTED event; participants only from event_attendee_states with checked_in_at",
  },
  // ── routes/follows.ts ────────────────────────────────────────────────────
  {
    file: "routes/follows.ts",
    args: /^\s*sc,\s*\{ userId: user\.id, definitionSlug: slug, sourceType: "follows", sourceId: target \}\s*$/,
    slugs: ["community_connector"],
    basis: "action_itself",
    guard: /callerAwards\.push\(\{ slug: "community_connector" \}\)/,
    why: "follow counts; no place",
  },
  {
    file: "routes/follows.ts",
    args: /^\s*sc,\s*\{ userId: target, definitionSlug: slug, sourceType: "follows", sourceId: user\.id \}\s*$/,
    slugs: ["popular_traveler", "travel_influencer"],
    basis: "action_itself",
    guard: /targetAwards\.push\(\{ slug: "popular_traveler" \}\)/,
    why: "follower counts; no place",
  },
  // ── routes/rentABuddy.ts ─────────────────────────────────────────────────
  {
    file: "routes/rentABuddy.ts",
    args: /definitionSlug: "first_buddy_booking"/,
    slugs: ["first_buddy_booking"],
    basis: "confirmed_occurrence",
    guard: /if \(\(booking as any\)\.status !== "in_progress"\) \{/,
    why: "only a STARTED (in_progress) booking can be completed, by one of its two parties; no place",
  },
  {
    file: "routes/rentABuddy.ts",
    args: /^\s*sc,\s*\{\s*userId:\s*buddyUserId,\s*definitionSlug: slug,\s*sourceType:\s*"rent_buddy",\s*sourceId:\s*bookingId,\s*\}\s*$/,
    slugs: ["first_buddy_hosted", "buddy_veteran", "nightlife_guide", "food_guide"],
    basis: "confirmed_occurrence",
    guard: /if \(\(booking as any\)\.status !== "in_progress"\) \{/,
    why: "the same completed booking, credited to the buddy; no place",
  },
  {
    file: "routes/rentABuddy.ts",
    args: /definitionSlug: "top_rated_buddy"/,
    slugs: ["top_rated_buddy"],
    basis: "action_itself",
    guard: /avgRating >= 4\.8 && reviewCount >= 3/,
    why: "a ratings property; no place",
  },
  // ── routes/safeReturn.ts ─────────────────────────────────────────────────
  {
    file: "routes/safeReturn.ts",
    args: /definitionSlug: "safe_return_ready"/,
    slugs: ["safe_return_ready"],
    basis: "action_itself",
    guard: /const result = await awardStamp\(sc, \{\s*\n\s*userId:\s*user\.id,\s*\n\s*definitionSlug: "safe_return_ready",/,
    why: "names activating Safe Return, which happened; no place",
  },
  {
    file: "routes/safeReturn.ts",
    args: /definitionSlug: "safe_return_completed"/,
    slugs: ["safe_return_completed"],
    basis: "confirmed_occurrence",
    guard: /suggestionReason: "You confirmed a Safe Return"/,
    why: "the person confirmed their own return; no place",
  },
  // ── admin / internal / backfill ──────────────────────────────────────────
  {
    file: "routes/admin.ts",
    args: /definitionSlug: "verified_traveler"/,
    slugs: ["verified_traveler"],
    basis: "action_itself",
    guard: /\.update\(\{ verified: true, verification_status: "verified", verified_at: now \}\)/,
    why: "an identity verification, not a place; no place",
  },
  {
    file: "routes/adminStamps.ts",
    args: /definitionSlug: parsed\.data\.definitionSlug,[\s\S]*city:\s*decided\.input\.city,\s*country:\s*decided\.input\.country,/,
    slugs: "caller",
    basis: "admin_attestation",
    guard: /reason:\s*z\.string\(\)\.min\(1\)\.max\(500\)/,
    why: "requireAdmin + a required reason; the engine drops any place on a non-presence slug (OD-1012-STAMP-2); a place on a PRESENCE slug only through decidePresenceAward (a trip check-in or a verified postcard, read), whose place and source replace the caller's (wave 5)",
  },
  {
    file: "routes/stamps.ts",
    args: /^\s*sc,\s*decided\.input,\s*req\.log\s*$/,
    slugs: "caller",
    basis: "internal_service",
    guard: /if \(!requireInternalSecret\(req, res\)\) return;/,
    why: "X-Internal-Secret only; its one in-tree caller (callInternalStampAward) is itself uncalled; a place on a PRESENCE slug only through decidePresenceAward, coordinates refused (wave 5)",
  },
  {
    file: "routes/stampCatalog.ts",
    args: /sourceId:\s*"globe_trotter_backfill"/,
    slugs: ["globe_trotter_5", "globe_trotter_10"],
    basis: "criteria_derived",
    guard: /const result = await evaluateCriteria\(sc, userId, def\.criteria, \{\}\);/,
    why: "admin backfill; each award gated on evaluateCriteria(countries_visited), which counts presence stamps only; no place",
  },
  // ── lib/ ─────────────────────────────────────────────────────────────────
  {
    file: "lib/stamps/criteria/index.ts",
    args: /^\s*sc,\s*input as any\s*$/,
    slugs: "caller",
    basis: "criteria_derived",
    guard: /const award = await awardFn\(\{/,
    why: "the default awardFn the criteria engine calls below; carries what awardFn is given",
  },
  {
    file: "lib/stamps/criteria/index.ts",
    args: /definitionSlug: def\.slug,\s*sourceType: opts\.sourceType \?\? "criteria"/,
    slugs: "caller",
    basis: "criteria_derived",
    guard: /const result = await evaluateCriteria\(sc, userId, def\.criteria, opts\.ctx \?\? \{\}\);\s*\n\s*if \(!result\.met\)/,
    why: "awards only a met criteria definition, with no place",
  },
  {
    file: "lib/places/placeCollectionsWorker.ts",
    args: /definitionSlug: "place_contributor"/,
    slugs: ["place_contributor"],
    basis: "action_itself",
    guard: /async function tryAwardStamp\(/,
    why: "contribution count at a place; no place on the stamp",
  },
];

/** Callers of the criteria engine's award loop, each reaching the awardFn above. */
const CRITERIA_CALLERS: ReadonlyArray<{ file: string; args: RegExp; why: string }> = [
  { file: "routes/posts.ts", args: /onlySlugs:\s*\["globe_trotter_5", "globe_trotter_10"\]/, why: "presence slugs gated on countries_visited (presence stamps only)" },
  { file: "routes/events.ts", args: /onlySlugs: \[\.\.\.EVENT_CATEGORY_STAMP_SLUGS\]/, why: "event-category RSVP slugs; non-presence" },
  { file: "routes/stampCatalog.ts", args: /sourceType: "criteria_admin"/, why: "admin evaluate-all; road_warrior/frequent_flyer read evidenced trips_completed" },
];

// ── Source scanning ──────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "__tests__" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Comments blanked (newlines kept) so a call named in prose is not counted. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function callsOf(src: string, callee: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(callee.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // a declaration
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

const AWARD_CALL = /\b(?:_?awardStamp|awardFn)\s*\(/;
const CRITERIA_CALL = /\bevaluateAndAwardCriteria\s*\(/;
const ENGINE = "services/passport/StampAwardEngine.ts";
const CRITERIA_DEF = "lib/stamps/criteria/index.ts";

function scan(): Map<string, { src: string; raw: string; awards: string[]; criteria: string[] }> {
  const out = new Map<string, { src: string; raw: string; awards: string[]; criteria: string[] }>();
  for (const abs of walk(SRC)) {
    const rel = path.relative(SRC, abs).split(path.sep).join("/");
    if (rel === ENGINE) continue; // the definition, not a caller
    const raw = fs.readFileSync(abs, "utf8");
    const src = stripComments(raw);
    const awards = callsOf(src, AWARD_CALL);
    const criteria = rel === CRITERIA_DEF ? [] : callsOf(src, CRITERIA_CALL);
    if (awards.length || criteria.length) out.set(rel, { src, raw, awards, criteria });
  }
  return out;
}

const PLACE_KEY = /(?:^|[\s,{])(?:city|country|lat|lng)\s*[:,}\n]/;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("H4: every stamp award call site is enumerated and classified", () => {
  const found = scan();

  it("finds the award sites at all (non-vacuity)", () => {
    const n = [...found.values()].reduce((a, f) => a + f.awards.length, 0);
    assert.ok(n >= 25, `found only ${n} award call expressions — the scanner is broken`);
    assert.ok(found.size >= 13, `found award calls in only ${found.size} files`);
  });

  it("no file awards a stamp without being in the registry (the ratchet)", () => {
    const registered = new Set(REGISTRY.map((s) => s.file));
    const unregistered = [...found.entries()].filter(([f, v]) => v.awards.length > 0 && !registered.has(f)).map(([f]) => f);
    assert.deepEqual(unregistered, [], "a new file awards stamps; classify each call in REGISTRY:\n" + unregistered.join("\n"));
  });

  it("each registered file has exactly the registered number of award calls, each matched once", () => {
    const problems: string[] = [];
    for (const file of new Set(REGISTRY.map((s) => s.file))) {
      const calls = found.get(file)?.awards ?? [];
      const sites = REGISTRY.filter((s) => s.file === file);
      if (calls.length !== sites.length) problems.push(`${file}: ${calls.length} award calls, ${sites.length} registered`);
      const claimed = new Map<number, string>();
      for (const s of sites) {
        const hits = calls.map((a, i) => (s.args.test(a) ? i : -1)).filter((i) => i >= 0);
        if (hits.length !== 1) problems.push(`${file}: ${s.args} matched ${hits.length} calls`);
        for (const i of hits) {
          if (claimed.has(i)) problems.push(`${file}: call #${i} claimed twice`);
          claimed.set(i, String(s.args));
        }
      }
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("each site's guard is still in its file", () => {
    const missing = REGISTRY.filter((s) => !s.guard.test(found.get(s.file)?.src ?? "")).map((s) => `${s.file}: ${s.guard}`);
    assert.deepEqual(missing, [], "a classified site lost the guard its basis rests on:\n" + missing.join("\n"));
  });

  it("every listed slug is a string literal in its file", () => {
    const missing: string[] = [];
    for (const s of REGISTRY) {
      if (s.slugs === "caller") continue;
      for (const slug of s.slugs) if (!found.get(s.file)?.src.includes(`"${slug}"`)) missing.push(`${s.file}: ${slug}`);
    }
    assert.deepEqual(missing, [], missing.join("\n"));
  });

  it("an action_itself or confirmed_occurrence site awards no presence slug and passes no place", () => {
    const bad: string[] = [];
    for (const s of REGISTRY) {
      if (s.basis !== "action_itself" && s.basis !== "confirmed_occurrence") continue;
      if (s.slugs === "caller") { bad.push(`${s.file}: ${s.basis} with a caller-supplied slug`); continue; }
      for (const slug of s.slugs) if (isPresenceStamp(slug)) bad.push(`${s.file}: ${slug} is a presence slug under ${s.basis}`);
      const call = (found.get(s.file)?.awards ?? []).find((a) => s.args.test(a)) ?? "";
      if (PLACE_KEY.test(call)) bad.push(`${s.file}: ${s.slugs.join("/")} passes a place`);
    }
    assert.deepEqual(bad, [], bad.join("\n"));
  });

  it("every presence slug is minted only behind occurrence evidence, the presence-filtered criteria engine, or an attestation", () => {
    const allowed = new Set<Basis>(["occurrence_evidence", "criteria_derived", "admin_attestation", "internal_service", "unreachable"]);
    const bad: string[] = [];
    const named = new Set<string>();
    for (const s of REGISTRY) {
      if (s.slugs === "caller") continue;
      for (const slug of s.slugs) {
        if (!PRESENCE_STAMP_SLUGS.has(slug)) continue;
        named.add(slug);
        if (!allowed.has(s.basis)) bad.push(`${s.file}: presence slug ${slug} under ${s.basis}`);
      }
    }
    assert.deepEqual(bad, [], bad.join("\n"));
    // Every presence slug has a named writer, so none is minted from somewhere unread.
    assert.deepEqual([...PRESENCE_STAMP_SLUGS].filter((s) => !named.has(s)).sort(), []);
  });

  it("the trip-completion site is the only one awarding the nine completion slugs, and it awards only evidenced members", () => {
    const trips = found.get("routes/trips.ts")!;
    for (const slug of TRIP_COMPLETION_SLUGS) {
      const elsewhere = REGISTRY.filter((s) => s.slugs !== "caller" && s.slugs.includes(slug) && s.file !== "routes/trips.ts");
      assert.deepEqual(elsewhere.map((s) => s.file), [], `${slug} has a second writer`);
    }
    assert.match(trips.src, /const presence = await readTripPresenceEvidence\(sc, tripId, memberIds\);/);
    assert.match(trips.src, /await countEvidencedCompletedTrips\(sc, ownerId\);/);
  });

  it("callInternalStampAward has no caller (so its fallback award is unreachable)", () => {
    const trips = found.get("routes/trips.ts")!;
    const uses = trips.src.match(/\bcallInternalStampAward\s*\(/g) ?? [];
    assert.equal(uses.length, 1, "callInternalStampAward is now called; reclassify routes/trips.ts's `sc, input` site");
  });

  it("every evaluateAndAwardCriteria caller is registered", () => {
    const problems: string[] = [];
    const calls = [...found.entries()].flatMap(([f, v]) => v.criteria.map((a) => ({ f, a })));
    for (const { f, a } of calls) {
      const hits = CRITERIA_CALLERS.filter((c) => c.file === f && c.args.test(a));
      if (hits.length !== 1) problems.push(`${f}: an evaluateAndAwardCriteria call matched ${hits.length} registry rows`);
    }
    if (calls.length !== CRITERIA_CALLERS.length) problems.push(`${calls.length} criteria calls, ${CRITERIA_CALLERS.length} registered`);
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("the criteria engine's completed-trip metric reads evidenced trips", () => {
    const metrics = fs.readFileSync(path.join(SRC, "lib/stamps/criteria/metrics.ts"), "utf8");
    assert.match(metrics, /trips_completed: async \(sc, u\) => \(await countEvidencedCompletedTrips\(sc, u\)\)\.count \?\? 0,/);
  });
});

// ── Wave 5 (lane 5): BD-OD-2's remainder — the two caller-slug endpoints ─────
//
// `admin_attestation` and `internal_service` take the slug AND the place from
// the request. Since §BG the engine drops the place of a non-presence slug; a
// PRESENCE slug keeps it. These pins hold that each such endpoint hands the
// engine only what `decidePresenceAward` returned — a place that occurrence
// evidence read for THIS person shows, or no place — and refuses before the
// engine otherwise. The behaviour is tested in
// stampAwardEndpointPresenceEvidence.test.ts; this is the ratchet half.
describe("H4 (wave 5): a caller-slug award endpoint passes its place through the presence evidence gate", () => {
  const found = scan();
  const gated = REGISTRY.filter((s) => s.slugs === "caller" && (s.basis === "admin_attestation" || s.basis === "internal_service"));

  it("there are exactly the two caller-slug endpoints (non-vacuity, and a third must be classified)", () => {
    assert.deepEqual(gated.map((s) => s.file).sort(), ["routes/adminStamps.ts", "routes/stamps.ts"]);
  });

  for (const site of gated) {
    it(`${site.file}: decides before the engine, refuses on a refusal, and awards only the decided input`, () => {
      const src = found.get(site.file)?.src ?? "";
      assert.match(src, /const decided = await decidePresenceAward\(sc, /, "the evidence decision is gone");
      assert.match(src, /if \(!decided\.ok\) \{ refusePresenceAward\(res, decided\); return; \}/, "a refusal no longer stops the award");
      assert.match(src, /evidence: presenceEvidenceSchema\.optional\(\)/, "the request can no longer name evidence");
      const call = (found.get(site.file)?.awards ?? []).find((a) => site.args.test(a)) ?? "";
      assert.ok(call, "the registered award call is gone");
      assert.doesNotMatch(call, /parsed\.data\.(city|country|lat|lng)\b|parsed\.data\s*,/, "the engine is handed the request's own place again");
      // The decision runs before the award call in the file.
      assert.ok(src.indexOf("const decided = await decidePresenceAward(") < src.indexOf(call), "the decision must precede the award");
    });
  }
});
