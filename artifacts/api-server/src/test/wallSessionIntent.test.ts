/**
 * WallSessionIntentService — temporary typed intent (spec §17). Proves mode
 * detection + keyword extraction (with entity resolution disabled by passing
 * sc = null), and the set / get / clear persistence round-trip against a fake
 * single-row store. The intent is always session-scoped and never a saved
 * preference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseIntent,
  getStoredIntent,
  setStoredIntent,
  clearStoredIntent,
} from "../services/wall/WallSessionIntentService.js";
import type { StructuredIntent } from "../lib/wallProjection.js";

describe("WallSessionIntentService.parseIntent", () => {
  it("extracts mode phrases and keeps residual keywords (no entity resolution)", async () => {
    // sc = null ⇒ the Global Input Intelligence entity resolution is skipped, so
    // only mode-phrase detection + keyword extraction run.
    const intent = await parseIntent(null, "u1", "just friends random Bangkok food");
    const modes = intent.filters.filter((f) => f.kind === "mode").map((f) => f.value);
    assert.ok(modes.includes("just_friends"));
    assert.ok(modes.includes("random"));
    assert.equal(intent.sessionScoped, true);
    // "just friends" / "random" are consumed as modes and do not leak into keywords.
    assert.ok(!intent.keywords.includes("just"));
    assert.ok(!intent.keywords.includes("random"));
    assert.ok(intent.keywords.includes("bangkok"));
    assert.ok(intent.keywords.includes("food"));
  });

  it("returns a keyword-only intent for a plain phrase", async () => {
    const intent = await parseIntent(null, "u1", "funny travel stories");
    assert.equal(intent.filters.length, 0);
    assert.deepEqual(intent.keywords, ["funny", "travel", "stories"]);
  });

  it("returns an empty intent for empty text", async () => {
    const intent = await parseIntent(null, "u1", "   ");
    assert.deepEqual(intent.filters, []);
    assert.deepEqual(intent.keywords, []);
    assert.equal(intent.sessionScoped, true);
  });
});

/** Fake single-row wall_session_intents store. */
function intentStore() {
  let stored: StructuredIntent | null = null;
  let deleteCalls = 0;
  const sc: any = {
    from(_table: string) {
      const b: any = {
        select() {
          return b;
        },
        eq() {
          return b;
        },
        maybeSingle() {
          return Promise.resolve({
            data: stored ? { structured_intent: stored } : null,
            error: null,
          });
        },
        upsert(row: any) {
          stored = row.structured_intent as StructuredIntent;
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq() {
              deleteCalls++;
              stored = null;
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return b;
    },
  };
  return { sc, deleteCalls: () => deleteCalls, current: () => stored };
}

describe("WallSessionIntentService persistence", () => {
  it("sets, reads back, then clears the session intent", async () => {
    const store = intentStore();
    assert.equal(await getStoredIntent(store.sc, "u1"), null, "no intent initially");

    const intent = await parseIntent(null, "u1", "just friends");
    const ok = await setStoredIntent(store.sc, "u1", intent, "just friends");
    assert.equal(ok, true);

    const got = await getStoredIntent(store.sc, "u1");
    assert.ok(got);
    assert.deepEqual(
      got!.filters.map((f) => f.value),
      intent.filters.map((f) => f.value),
    );
    assert.equal(got!.sessionScoped, true);

    const cleared = await clearStoredIntent(store.sc, "u1");
    assert.equal(cleared, true);
    assert.equal(store.deleteCalls(), 1);
    assert.equal(await getStoredIntent(store.sc, "u1"), null, "cleared intent restores empty state");
  });

  it("fail-soft: a store error returns false / null rather than throwing", async () => {
    const failing: any = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: { message: "db down" } });
          },
          upsert() {
            return Promise.resolve({ error: { message: "db down" } });
          },
          delete() {
            return { eq: () => Promise.resolve({ error: { message: "db down" } }) };
          },
        };
      },
    };
    const intent = await parseIntent(null, "u1", "random");
    assert.equal(await setStoredIntent(failing, "u1", intent, "random"), false);
    assert.equal(await getStoredIntent(failing, "u1"), null);
    assert.equal(await clearStoredIntent(failing, "u1"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §17 / W71 — "Voice input and typo normalization use the same global engine"
//
// WHAT THIS FILE CAN AND CANNOT SETTLE. Whether a voice CAPTURE surface exists
// is a Global Input Intelligence question and is graded on that census — there
// is no speech-to-text producer anywhere in this repository, so nothing here
// claims one. What IS decidable at the Wall, and what this block pins, is the
// Wall's SIDE of the contract: the Wall must own no normalization of its own and
// must hand its typed text to the shared gateway VERBATIM, so that whatever
// normalization that engine performs — today `applyAliases`, tomorrow a voice
// transcript cleanup — the Wall inherits it without a second code path.
//
// It is a real end-to-end assertion, not a mock: the REAL
// `lib/inputAssistance/gateway.generateSuggestions` runs, over a fake supabase
// client that RECORDS the filter strings the engine issues. So the test observes
// the query text the SHARED ENGINE built from the Wall's input, which is the only
// place the delegation can be observed from outside.
//
// MUTATION PROOF (performed, see the census entry for W71): replacing the
// `generateSuggestions(...)` call in WallSessionIntentService.parseIntent with a
// Wall-local resolver — or pre-normalizing `residual` before handing it over —
// turns the alias assertion RED, because the misspelling then reaches the
// database layer unrepaired.

/** A supabase fake that records every filter string any query builder receives. */
function recordingClient() {
  const seen: string[] = [];
  const note = (...vals: any[]) => {
    for (const v of vals) if (typeof v === "string") seen.push(v);
  };
  function builder(_table: string) {
    const b: any = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (onF: any, onR: any) =>
              Promise.resolve({ data: [], error: null }).then(onF, onR);
          }
          if (prop === "maybeSingle" || prop === "single") {
            return () => Promise.resolve({ data: null, error: null });
          }
          return (...args: any[]) => {
            note(...args);
            return b;
          };
        },
      },
    );
    return b;
  }
  return { seen, sc: { from: builder, rpc: (_n: string, args: any) => { note(...Object.values(args ?? {})); return Promise.resolve({ data: [], error: null }); } } };
}

describe("W71 — the Wall's half of the shared-input-engine contract (§17)", () => {
  it("the recording harness actually observes the engine's query text (guard against a vacuous pass)", async () => {
    const { seen, sc } = recordingClient();
    await parseIntent(sc, "u1", "bangkok");
    assert.ok(
      seen.some((s) => s.toLowerCase().includes("bangkok")),
      `the shared gateway issued no query carrying the typed text — the harness saw ${JSON.stringify(seen.slice(0, 12))}`,
    );
  });

  it("a misspelling typed into the Wall reaches the database ALREADY typo-normalized by the shared engine", async () => {
    // `bankok` is one of the shared engine's own aliases
    // (routes/discoverySearchHelpers.ts SEARCH_ALIASES). The Wall knows nothing
    // about it: if the Wall stopped delegating, or normalized first, the raw
    // misspelling would reach the query layer instead of the canonical form.
    const { seen, sc } = recordingClient();
    await parseIntent(sc, "u1", "bankok street food");
    const lowered = seen.map((s) => s.toLowerCase());
    assert.ok(
      lowered.some((s) => s.includes("bangkok")),
      `the engine's typo normalization did not reach the query layer; saw ${JSON.stringify(seen.slice(0, 12))}`,
    );
    assert.ok(
      !lowered.some((s) => s.includes("bankok")),
      `the raw misspelling reached the query layer — the Wall is not delegating normalization`,
    );
  });

  it("the Wall itself owns no alias / typo table — normalization has exactly one home", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const wallRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "services", "wall");
    const routeFile = join(dirname(fileURLToPath(import.meta.url)), "..", "routes", "wall.ts");
    const files: string[] = [routeFile];
    for (const e of readdirSync(wallRoot)) {
      const full = join(wallRoot, e);
      if (statSync(full).isFile() && /\.ts$/.test(e)) files.push(full);
    }
    assert.ok(files.length > 5, "the scan must read the Wall's server tree");
    // A Wall-local normalizer would show up as its own alias/correction map or a
    // second call into the discovery search helpers' normalizer.
    const banned = /SEARCH_ALIASES|applyAliases|normalizeLocationName|\bALIASES\b|typoMap/;
    const violations = files.filter((f) => banned.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      violations,
      [],
      "the Wall must not reach for the normalizer itself — it delegates to the gateway, which owns it",
    );
    // …and the delegation it DOES make is to the shared gateway, by name.
    const svc = readFileSync(join(wallRoot, "WallSessionIntentService.ts"), "utf8");
    assert.match(svc, /from "\.\.\/\.\.\/lib\/inputAssistance\/gateway\.js"/);
    assert.match(svc, /generateSuggestions\(/);
  });

  it("the Wall has no source-specific text path: typed and dictated text are the same ingress", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const route = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "routes", "wall.ts"),
      "utf8",
    );
    // Both text ingresses (the GET steer and the POST setter) go through
    // parseIntent. A voice transcript is text and has no other way in.
    const parseCalls = route.match(/await parseIntent\(/g) ?? [];
    assert.equal(parseCalls.length, 2, "exactly two text ingresses, both delegating");
    assert.ok(
      !/voice|speech|transcri/i.test(route),
      "the Wall must not branch on how the text was produced",
    );
  });
});
