/**
 * W146 — the fixture corpus for the Wall's first-page benchmark against a REAL
 * Postgres, and the TARGET DECISION that says whether the production-safety
 * guard applies to the configured target.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE HARNESS
 * ============================================
 * `src/test/wallFirstPageLiveDb.test.ts` must make its guard decision BEFORE
 * `@supabase/supabase-js` is loaded — see the header of that file. Everything
 * here is therefore deliberately free of any runtime import of supabase-js:
 * the client type is imported with `import type`, which TypeScript erases, so
 * importing this module pulls in no Supabase code at all. `isLoopbackTarget`
 * can be called, and unit-tested, in a process that never loads a client.
 *
 * WHAT THE CORPUS IS
 * ==================
 * The SAME shape as the in-memory benchmark in `wallPerformance.test.ts` —
 * 150 posts, 24 authors, 30 places, the same five cities and five categories,
 * the same `seededRandom(20260905)` draw order — so the two numbers describe
 * the same world and are comparable. The differences are forced by the real
 * schema and nothing else:
 *
 *   • ids are real UUIDs, because `posts.id`, `profiles.id`,
 *     `places.id` and `posts.canonical_place_id` are `uuid` columns with real
 *     foreign keys. They are DERIVED deterministically from a fixed namespace
 *     so a run is reproducible and a leftover row is identifiable.
 *   • every NOT NULL column that has no default is supplied: `profiles.handle`,
 *     `profiles.name`, `places.name`, `places.normalized_name`.
 *   • `auth.users` rows exist, because `profiles.id` REFERENCES `auth.users(id)`.
 *     There is no GoTrue locally, so they are inserted as plain rows through
 *     PostgREST's `auth` schema rather than through the admin API.
 *
 * EVERY ROW CARRIES A NAMESPACED MARKER
 * =====================================
 * Teardown does not remember what it created — it DELETES BY MARKER
 * (`w146fp…`), so a run that dies halfway, or a run whose process is killed,
 * cannot leave rows behind that the next run then measures. `seedCorpus` calls
 * `teardownCorpus` first for exactly that reason (the heal-then-create lesson
 * recorded in `rlsHardening.test.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A supabase-js client at ANY PostgREST profile. The harness holds two — one on
 * `public` (the measured path) and one on `auth` (fixture users only) — and
 * their schema type parameters differ, so the seeding helpers take the widened
 * shape rather than forcing a cast at every call site.
 */
type AnyClient = SupabaseClient<any, any, any, any, any>;

import { seededRandom } from "./benchmark.js";

// ── The target decision ──────────────────────────────────────────────────────

/**
 * Hosts that cannot possibly be a Supabase project, because they never leave
 * the machine. `::1` appears both bare and bracketed depending on who wrote the
 * URL.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);

/**
 * True when `url` names a LOOPBACK host — and therefore cannot be a Supabase
 * project, so `../lib/ciSupabaseGuard.mjs` has nothing to allowlist.
 *
 * WHY THIS PREDICATE EXISTS AT ALL (W146). The guard refuses whenever
 * CI_SUPABASE_PROJECT_REF / KNOWN_PROD_PROJECT_REF are unset, which is every
 * ordinary run, and that refusal IS this repository's production denylist. It
 * must stay unconditional for every remote target. A local PostgREST on
 * 127.0.0.1 is not a remote target: there is no project ref to resolve, the
 * allowlist has nothing to bind to, and no packet leaves the host. So the
 * harness may skip the guard for a loopback URL — but only if "loopback" is a
 * decision made in code, on the parsed URL, and pinned by tests. Deleting the
 * import instead would be the same act with no evidence behind it.
 *
 * IT FAILS CLOSED. Anything that is not a parseable http/https URL with a
 * loopback hostname returns false, which sends the caller through the full
 * guard. That covers the empty string, a bare hostname, a non-http scheme, and
 * every shape that merely CONTAINS a loopback literal:
 *
 *   https://127.0.0.1.evil.example        hostname is evil.example      -> false
 *   http://user@127.0.0.1@evil.example    hostname is evil.example      -> false
 *   https://evil.example/?h=127.0.0.1     hostname is evil.example      -> false
 *   https://evil.example#127.0.0.1        hostname is evil.example      -> false
 *
 * A substring or regular-expression test over the raw string gets every one of
 * those wrong, which is why this parses instead of matching.
 */
export function isLoopbackTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // unparseable -> not provably loopback -> guard applies
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(host)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. Matched on
  // four decimal octets so "127.0.0.1.evil.example" (five labels) cannot pass.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map((n) => Number(n));
  if (octets.some((n) => n > 255)) return false;
  return octets[0] === 127;
}

/**
 * Why the suite cannot run, or null when it can.
 *
 * Unlike `wallSessionIntentLiveDb.test.ts`, a loopback URL is NOT a reason to
 * skip here — a loopback PostgREST is precisely this harness's target. What is
 * still a reason to skip is an ABSENT target, and the curated `test` script's
 * deliberately-dead pin (`SUPABASE_URL=http://127.0.0.1:9`,
 * `SUPABASE_SERVICE_ROLE_KEY=dummy`), which must never read as a database.
 */
export function missingLiveDbReason(url: string, key: string): string | null {
  if (!url) return "SUPABASE_URL is not set";
  if (!key) return "SUPABASE_SERVICE_ROLE_KEY is not set";
  if (/^(dummy|test|placeholder|changeme)$/i.test(key)) {
    return `SUPABASE_SERVICE_ROLE_KEY is the placeholder "${key}"`;
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return `SUPABASE_URL is not a URL (${url})`;
  }
  // Port 9 is the discard protocol, and the curated `test` script pins it on
  // purpose so the api tests never reach a network. It is a configured
  // NON-database and must read as one even though it is loopback.
  if (parsed.port === "9") {
    return `SUPABASE_URL is the curated suite's dead pin (${url}), not a database`;
  }
  return null;
}

// ── The namespaced fixture marker ────────────────────────────────────────────

/**
 * Every row this harness writes carries this prefix in a text column, and
 * teardown deletes by it. A crashed run therefore cannot orphan data: the next
 * run removes it before it seeds.
 */
export const FIXTURE_NS = "w146fp";
/** `posts.source` is free text (default 'api_server'); this marks ours. */
export const POST_SOURCE_MARKER = `${FIXTURE_NS}-first-page-benchmark`;
/**
 * The one namespaced flag name. Its presence at the start of a run means the
 * previous run died before teardown, so the Wall flags in the table are ours.
 */
export const SENTINEL_FLAG = `${FIXTURE_NS}_benchmark_in_progress`;
/** PostgREST spells the LIKE wildcard `*`, not `%`. */
const NS_PATTERN = `${FIXTURE_NS}*`;

/**
 * A deterministic UUID in the fixture namespace: `a146<kind>-…-<index>`. Fixed
 * so a run is reproducible and any leftover row is recognisable by eye.
 */
function fixtureUuid(kind: number, index: number): string {
  const k = kind.toString(16).padStart(4, "0");
  const i = index.toString(16).padStart(12, "0");
  return `a146${k}-0000-4000-8000-${i}`;
}

const KIND_PROFILE = 1;
const KIND_PLACE = 2;
const KIND_POST = 3;

/** The viewer whose first page is measured. Index 0 of the profile namespace. */
export const VIEWER_ID = fixtureUuid(KIND_PROFILE, 0);

// ── Corpus shape — identical to wallPerformance.test.ts ──────────────────────

export const AUTHORS = 24;
export const POSTS = 150; // CANDIDATE_FETCH — a full first-page candidate window
export const PLACES = 30;
const CITIES = ["Da Nang", "Bangkok", "Tokyo", "Manila", "Miami"];
const CATEGORIES = ["food", "nightlife", "nature", "culture", "beach"];

/**
 * Everything the first page can do, ON — the benchmark must measure the WORST
 * realistic page, not the cheapest one. Same list as `wallPerformance.test.ts`.
 */
export const FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: true,
  wall_input_intelligence_enabled: true,
  wall_discovery_insertions_enabled: true,
  wall_compass_handoff_enabled: true,
  wall_context_threads_enabled: true,
  wall_rab_integration_enabled: true,
  intel_live_label_crowd: true,
  intel_claim_projection_crowd: true,
  intel_limited_live: true,
  disable_intel_live_labels: false,
};

export interface LiveCorpus {
  authUsers: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  places: Array<Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
  follows: Array<Record<string, unknown>>;
}

/** Row counts actually written, for the measurement report. */
export interface SeedCounts {
  authUsers: number;
  profiles: number;
  places: number;
  posts: number;
  userFollows: number;
  featureFlags: number;
}

/**
 * The whole corpus, built from a FIXED seed so every run measures the same
 * world and a failure is reproducible. The seed and the draw order match
 * `wallPerformance.test.ts` exactly.
 */
export function buildLiveCorpus(): LiveCorpus {
  const rnd = seededRandom(20260905);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const places = Array.from({ length: PLACES }, (_, i) => ({
    id: fixtureUuid(KIND_PLACE, i),
    name: `${FIXTURE_NS} Place ${i}`,
    // NOT NULL, no default — and the teardown marker for this table.
    normalized_name: `${FIXTURE_NS} place ${i}`,
    primary_category: "other",
    city: pick(CITIES),
    country_code: "VN",
    latitude: 16 + rnd(),
    longitude: 108 + rnd(),
    status: "active",
    merged_into_place_id: null,
  }));

  // index 0 is the viewer; 1..AUTHORS are the authors.
  const profiles: Array<Record<string, unknown>> = [
    {
      id: VIEWER_ID,
      handle: `${FIXTURE_NS}viewer`, // NOT NULL + UNIQUE
      name: "W146 Viewer", // NOT NULL
      display_name: "Viewer",
      username: `${FIXTURE_NS}viewer`,
      avatar_url: null,
      account_status: "active",
      current_city: "Da Nang",
      home_city: "Bangkok",
      interests: ["food", "nightlife"],
    },
  ];
  for (let i = 0; i < AUTHORS; i++) {
    // EVERY ROW CARRIES THE SAME KEYS. PostgREST builds one INSERT from the
    // UNION of the keys in a batch and writes NULL — not the column default —
    // wherever a row omits one. `profiles.interests` is `NOT NULL DEFAULT '{}'`,
    // so an author row that simply left it out failed with 23502 against the
    // real schema while a fake accepted it. That is the class of defect this
    // whole file exists to surface (W146).
    profiles.push({
      id: fixtureUuid(KIND_PROFILE, i + 1),
      handle: `${FIXTURE_NS}a${i}`,
      name: `W146 Author ${i}`,
      display_name: `Author ${i}`,
      username: `${FIXTURE_NS}a${i}`,
      avatar_url: null,
      account_status: "active",
      current_city: null,
      home_city: null,
      interests: [],
    });
  }

  const authorId = (i: number): string => fixtureUuid(KIND_PROFILE, (i % AUTHORS) + 1);

  const base = Date.parse("2026-09-01T12:00:00.000Z");
  const posts = Array.from({ length: POSTS }, (_, i) => {
    const place = places[Math.floor(rnd() * places.length)];
    const at = new Date(base - i * 60_000).toISOString();
    return {
      id: fixtureUuid(KIND_POST, i),
      author_id: authorId(i),
      trip_id: null,
      content: `Post ${i} about ${pick(CATEGORIES)} in ${place.city}`,
      visibility: "public",
      status: "active",
      post_status: "published",
      created_at: at,
      published_at: at,
      canonical_place_id: place.id,
      has_video: i % 7 === 0,
      media_count: i % 3 === 0 ? 0 : 2,
      category: pick(CATEGORIES),
      location_city: place.city,
      location_country: "VN",
      like_count: Math.floor(rnd() * 200),
      comment_count: Math.floor(rnd() * 40),
      save_count: Math.floor(rnd() * 60),
      // The teardown marker for this table. `source` is free text with a
      // default of 'api_server'; overriding it marks the row as ours without
      // adding a column the schema does not have.
      source: POST_SOURCE_MARKER,
    };
  });

  const follows = Array.from({ length: AUTHORS }, (_, i) => ({
    follower_id: VIEWER_ID,
    following_id: fixtureUuid(KIND_PROFILE, i + 1),
  }));

  const authUsers = profiles.map((p) => ({
    id: p.id,
    // The teardown marker for auth.users.
    email: `${FIXTURE_NS}-${String(p.handle)}@fixture.local`,
  }));

  return { authUsers, profiles, places, posts, follows };
}

// ── Seeding and teardown ─────────────────────────────────────────────────────

/** Throw with the table named, so a schema mismatch is never a silent skip. */
function must(table: string, error: { message: string; code?: string } | null): void {
  if (error) throw new Error(`W146 seed: ${table}: ${error.code ?? "?"} ${error.message}`);
}

/**
 * Delete every row this harness can have written, by marker, in FK-safe order.
 * Safe to call when nothing exists. Never throws on a missing row; a real error
 * is reported so a half-cleaned database is visible rather than inherited.
 */
export async function teardownCorpus(
  pub: AnyClient,
  authSchema: AnyClient,
): Promise<string[]> {
  const problems: string[] = [];
  const step = async (label: string, run: () => PromiseLike<{ error: unknown }>) => {
    try {
      const { error } = await run();
      if (error) problems.push(`${label}: ${JSON.stringify(error)}`);
    } catch (err) {
      problems.push(`${label}: ${String(err)}`);
    }
  };

  // rank_events first: the page writes ~1 analytics row per scored candidate,
  // fire-and-forget, keyed by the fixture viewer. Left behind, a few benchmark
  // runs would bury the table.
  await step("rank_events", () => pub.from("rank_events").delete().eq("user_id", VIEWER_ID));
  await step("wall_session_intents", () =>
    pub.from("wall_session_intents").delete().eq("user_id", VIEWER_ID),
  );
  await step("posts", () => pub.from("posts").delete().eq("source", POST_SOURCE_MARKER));
  await step("user_follows", () =>
    pub.from("user_follows").delete().eq("follower_id", VIEWER_ID),
  );
  await step("profiles", () => pub.from("profiles").delete().like("handle", NS_PATTERN));
  await step("places", () =>
    pub.from("places").delete().like("normalized_name", NS_PATTERN),
  );
  // auth.users last: profiles CASCADE off it, so this also sweeps any profile
  // whose handle marker was somehow lost.
  await step("auth.users", () => authSchema.from("users").delete().like("email", `${NS_PATTERN}`));
  return problems;
}

/**
 * Heal, then seed. Returns the exact row counts written, which is what the
 * measurement report quotes.
 */
export async function seedCorpus(
  pub: AnyClient,
  authSchema: AnyClient,
  corpus: LiveCorpus,
): Promise<SeedCounts> {
  await teardownCorpus(pub, authSchema);

  // auth.users before profiles: profiles.id REFERENCES auth.users(id).
  must("auth.users", (await authSchema.from("users").insert(corpus.authUsers)).error);
  must("profiles", (await pub.from("profiles").insert(corpus.profiles)).error);
  must("places", (await pub.from("places").insert(corpus.places)).error);
  must("posts", (await pub.from("posts").insert(corpus.posts)).error);
  must("user_follows", (await pub.from("user_follows").insert(corpus.follows)).error);

  const flagRows = [
    ...Object.entries(FLAGS).map(([flag, enabled]) => ({ flag, enabled })),
    // See readExistingFlags: the one namespaced name in a table of global ones.
    { flag: SENTINEL_FLAG, enabled: false },
  ];
  must("feature_flags", (await pub.from("feature_flags").upsert(flagRows, { onConflict: "flag" })).error);

  return {
    authUsers: corpus.authUsers.length,
    profiles: corpus.profiles.length,
    places: corpus.places.length,
    posts: corpus.posts.length,
    userFollows: corpus.follows.length,
    featureFlags: flagRows.length,
  };
}

/**
 * Feature flags are GLOBAL names, not namespaced rows, so they cannot be swept
 * by marker. They are removed by name instead, and only the ones this harness
 * introduced — `seedFeatureFlagState` records what was there first.
 */
export async function clearFeatureFlags(
  pub: AnyClient,
  previouslyPresent: ReadonlyMap<string, boolean>,
): Promise<void> {
  for (const flag of Object.keys(FLAGS)) {
    const prior = previouslyPresent.get(flag);
    if (prior === undefined) {
      await pub.from("feature_flags").delete().eq("flag", flag);
    } else {
      await pub.from("feature_flags").upsert([{ flag, enabled: prior }], { onConflict: "flag" });
    }
  }
  await pub.from("feature_flags").delete().eq("flag", SENTINEL_FLAG);
}

/**
 * Which of this harness's flags already existed, and with what value — so
 * teardown RESTORES a flag the environment already had rather than deleting it.
 *
 * THE SENTINEL IS WHAT MAKES THAT SAFE AFTER A CRASH (W146). Flag names are
 * global; they cannot carry a `w146fp` marker the way every other fixture row
 * does. So a run that died between seeding and teardown would leave its eleven
 * flags behind, and the NEXT run would read them as "already present" and
 * faithfully restore them forever. `seedCorpus` therefore writes one extra flag
 * whose name IS namespaced; finding it here means the flags in the table belong
 * to a dead run, not to the environment, and the prior state is empty.
 */
export async function readExistingFlags(pub: SupabaseClient): Promise<Map<string, boolean>> {
  const { data } = await pub
    .from("feature_flags")
    .select("flag, enabled")
    .in("flag", [...Object.keys(FLAGS), SENTINEL_FLAG]);
  const rows = (data as Array<{ flag: string; enabled: boolean }> | null) ?? [];
  if (rows.some((r) => r.flag === SENTINEL_FLAG)) return new Map();
  const out = new Map<string, boolean>();
  for (const row of rows) out.set(row.flag, row.enabled);
  return out;
}
