/**
 * Unit tests for the Visual Generation System pure logic + route authorization.
 * Pure-logic tests: no DB, no provider — deterministic functions only.
 * Route tests: minimal Express + fake Supabase client via _setTestClient.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { coerceStyle, isKnownStyle, styleIsIllustrated, DEFAULT_STYLE } from "../lib/visuals/styles.js";
import { imageDataToBuffer } from "../lib/visuals/service.js";
import { cleanText, cleanEnum, cleanList, isBannedKey, stripBanned, timeOfDayFromHour } from "../lib/visuals/sanitize.js";
import { promptHash, canonicalSnapshot, stableStringify } from "../lib/visuals/promptHash.js";
import { buildEventPrompt, buildPlacePrompt, NEGATIVE_PROMPT, promptVersionFor } from "../lib/visuals/promptBuilder.js";
import { resolveHeaderImage, sourceRank, mayApplyGenerated } from "../lib/visuals/priority.js";
import { fallbackSlug } from "../lib/visuals/providers/categoryFallbackProvider.js";
import type { VisualInputSnapshot } from "../lib/visuals/types.js";
import { _setTestClient } from "../lib/http.js";
import { requestGeneration } from "../lib/visuals/service.js";

function snap(over: Partial<VisualInputSnapshot> = {}): VisualInputSnapshot {
  return {
    entityType: "event",
    purpose: "event_header",
    title: "Sunset Rooftop Mixer",
    category: "nightlife",
    city: "Makati",
    country: "Philippines",
    setting: "rooftop",
    timeOfDay: "sunset",
    style: "portava_editorial",
    renderMode: "realistic",
    people: "auto",
    promptVersion: "event-header-v1",
    ...over,
  };
}

// ── styles ────────────────────────────────────────────────────────────────────
test("coerceStyle falls back to default for unknown", () => {
  assert.equal(coerceStyle("nonsense"), DEFAULT_STYLE);
  assert.equal(coerceStyle("cinematic_travel"), "cinematic_travel");
  assert.equal(coerceStyle(null), DEFAULT_STYLE);
});
test("isKnownStyle + styleIsIllustrated", () => {
  assert.ok(isKnownStyle("passport_poster"));
  assert.ok(!isKnownStyle("hacker"));
  assert.ok(styleIsIllustrated("minimal_illustration"));
  assert.ok(!styleIsIllustrated("portava_editorial"));
});

// ── sanitize ────────────────────────────────────────────────────────────────
test("cleanText clamps, collapses whitespace, strips control chars", () => {
  assert.equal(cleanText("  hello   world  "), "hello world");
  assert.equal(cleanText("a".repeat(300), 10), "aaaaaaaaaa");
  assert.equal(cleanText(""), null);
  assert.equal(cleanText(123 as any), null);
});
test("cleanEnum lowercases", () => {
  assert.equal(cleanEnum("Night Life"), "night life");
});
test("cleanList dedupes + caps", () => {
  assert.deepEqual(cleanList(["a", "A", "b", ""]), ["a", "b"]);
  assert.equal(cleanList(["x", "y", "z", "w"], 2).length, 2);
});
test("isBannedKey blocks PII fields", () => {
  assert.ok(isBannedKey("phone"));
  assert.ok(isBannedKey("email_address"));
  assert.ok(isBannedKey("passport"));
  assert.ok(isBannedKey("lat"));
  assert.ok(!isBannedKey("category"));
});
test("stripBanned removes PII keys", () => {
  const out = stripBanned({ title: "x", phone: "555", lat: 1, category: "bar" });
  assert.deepEqual(Object.keys(out).sort(), ["category", "title"]);
});
test("timeOfDayFromHour buckets", () => {
  assert.equal(timeOfDayFromHour(2), "night");
  assert.equal(timeOfDayFromHour(9), "morning");
  assert.equal(timeOfDayFromHour(13), "afternoon");
  assert.equal(timeOfDayFromHour(18), "sunset");
  assert.equal(timeOfDayFromHour(20), "evening");
  assert.equal(timeOfDayFromHour(null), null);
});

// ── prompt hash ───────────────────────────────────────────────────────────────
test("promptHash is stable + order-independent", () => {
  const h1 = promptHash(snap());
  const h2 = promptHash(snap());
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});
test("promptHash changes when a prompt-relevant field changes", () => {
  const base = promptHash(snap());
  assert.notEqual(base, promptHash(snap({ city: "Cebu" })));
  assert.notEqual(base, promptHash(snap({ style: "cinematic_travel" })));
  // description feeds into event prompts as "Activity" — must invalidate hash
  assert.notEqual(base, promptHash(snap({ description: "beach cleanup and bonfire" })), "description change must produce a different hash");
});
test("promptHash changes when description changes — cache invalidation contract", () => {
  const withDesc = snap({ description: "yoga at sunrise" });
  const different = snap({ description: "salsa dancing night" });
  const empty = snap({ description: undefined });
  assert.notEqual(promptHash(withDesc), promptHash(different), "different descriptions must hash differently");
  assert.notEqual(promptHash(withDesc), promptHash(empty), "adding description must change hash");
  // Same description normalizes the same way regardless of whitespace
  assert.equal(promptHash(withDesc), promptHash(snap({ description: "  yoga at sunrise  " })));
});
test("promptHash ignores case + whitespace on enum-ish fields", () => {
  assert.equal(promptHash(snap({ city: "Makati" })), promptHash(snap({ city: "  makati " })));
});
test("canonicalSnapshot drops empty fields", () => {
  const c = canonicalSnapshot(snap({ neighborhood: null, description: undefined }));
  assert.ok(!("neighborhood" in c));
});
test("stableStringify sorts keys", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

// ── prompt builder ────────────────────────────────────────────────────────────
test("event prompt includes context + safety constraints, excludes title text", () => {
  const p = buildEventPrompt(snap());
  assert.match(p, /social event/i);
  assert.match(p, /Makati/);
  assert.match(p, /No readable text/i);
  assert.match(p, /Do not render the event title as text/i);
});
test("place prompt is labeled a representation, not documentary", () => {
  const p = buildPlacePrompt(
    snap({
      entityType: "place",
      purpose: "place_header",
      title: "Harbor Catch",
      category: "restaurant",
      subcategory: "seafood",
      city: "Cebu City",
      traits: ["waterfront", "outdoor seating"],
      priceLevel: "premium",
    }),
  );
  assert.match(p, /representation/i);
  assert.match(p, /not a documentary image/i);
  assert.match(p, /Cebu City/);
});
test("NEGATIVE_PROMPT + promptVersionFor", () => {
  assert.match(NEGATIVE_PROMPT, /no logos/);
  assert.equal(promptVersionFor("event_header"), "event-header-v1");
  assert.equal(promptVersionFor("place_header"), "place-header-v1");
});

// ── priority resolver ─────────────────────────────────────────────────────────
test("sourceRank ordering: user_upload beats everything", () => {
  assert.ok(sourceRank("user_upload") > sourceRank("official"));
  assert.ok(sourceRank("official") > sourceRank("provider"));
  assert.ok(sourceRank("ai_generated") > sourceRank("category_fallback"));
});
test("resolveHeaderImage picks highest priority usable url", () => {
  const r = resolveHeaderImage([
    { url: "ai.webp", source: "ai_generated" },
    { url: "up.jpg", source: "user_upload" },
    { url: "", source: "official" }, // empty → ignored
  ]);
  assert.equal(r?.url, "up.jpg");
  assert.equal(r?.source, "user_upload");
});
test("resolveHeaderImage flags AI place image as representation", () => {
  const r = resolveHeaderImage([{ url: "ai.webp", source: "ai_generated" }], { entityType: "place" });
  assert.equal(r?.isRepresentation, true);
  const rEvent = resolveHeaderImage([{ url: "ai.webp", source: "ai_generated" }], { entityType: "event" });
  assert.equal(rEvent?.isRepresentation, false);
});
test("resolveHeaderImage returns null when nothing usable", () => {
  assert.equal(resolveHeaderImage([{ url: null, source: "ai_generated" }]), null);
});
test("mayApplyGenerated blocks overwriting a real source or a newer upload", () => {
  assert.ok(mayApplyGenerated({ source: "category_fallback", updatedAt: null }, "2026-07-25T00:00:00Z"));
  assert.ok(!mayApplyGenerated({ source: "user_upload", updatedAt: null }, "2026-07-25T00:00:00Z"));
  assert.ok(!mayApplyGenerated({ source: "ai_generated", updatedAt: "2026-07-26T00:00:00Z" }, "2026-07-25T00:00:00Z"));
});

// ── fallback provider ─────────────────────────────────────────────────────────
test("fallbackSlug maps known categories + generic default", () => {
  assert.equal(fallbackSlug("restaurant", "place"), "restaurant");
  assert.equal(fallbackSlug("cocktail bar", "place"), "cocktail-bar");
  assert.equal(fallbackSlug("unknownthing", "place"), "generic-place");
  assert.equal(fallbackSlug(null, "event"), "generic-event");
});

// ── imageDataToBuffer: URL vs base64 provider output shapes ───────────────────
test("imageDataToBuffer decodes a data: base64 URL to a Buffer", async () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
  const dataUrl = `data:image/png;base64,${raw.toString("base64")}`;
  const result = await imageDataToBuffer(dataUrl);
  assert.ok(result instanceof Buffer);
  assert.equal(result.length, raw.length);
  assert.equal(result[0], 0x89);
});

test("imageDataToBuffer fetches a remote https:// URL", async () => {
  // Use Uint8Array so the .buffer property is a fresh dedicated ArrayBuffer,
  // not the shared 8KB pool that Node.js Buffer.from([...]) uses internally.
  const imageBytes = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG magic bytes
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (_url: string) => ({
    ok: true,
    arrayBuffer: async () => imageBytes.buffer,
  });
  try {
    const result = await imageDataToBuffer("https://example.com/img.jpg");
    assert.ok(result instanceof Buffer);
    assert.equal(result[0], 0xff);
    assert.equal(result.length, 3);
  } finally {
    (globalThis as any).fetch = orig;
  }
});

test("imageDataToBuffer throws on non-OK remote URL response", async () => {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 403 });
  try {
    await assert.rejects(
      () => imageDataToBuffer("https://example.com/forbidden.jpg"),
      /403/,
    );
  } finally {
    (globalThis as any).fetch = orig;
  }
});

// ── requestGeneration force=true (regenerate semantics) ──────────────────────
test("requestGeneration force=true retires active rows and queues a fresh job", async () => {
  const TRIP_TEST_ID = "trip-regen-0001";
  const updatedToReplaced: string[] = [];
  let insertedCount = 0;

  // Fake client that mimics a DB with one 'ready' visual for the entity.
  const fakeClient = {
    from(table: string) {
      let _filters: Array<(r: any) => boolean> = [];
      let _isUpdate = false;
      let _updatePayload: any = null;
      let _isInsert = false;
      let _insertPayload: any = null;

      const b: any = {
        select()                     { return b; },
        insert(row: any)             { _isInsert = true; _insertPayload = row; return b; },
        update(row: any)             { _isUpdate = true; _updatePayload = row; return b; },
        delete()                     { return b; },
        eq(col: string, val: any)    { _filters.push((r) => r[col] === val); return b; },
        in(col: string, vals: any[]) { _filters.push((r) => vals.includes(r[col])); return b; },
        gte()                        { return b; },
        lte()                        { return b; },
        not()                        { return b; },
        or()                         { return b; },
        limit()                      { return b; },
        order()                      { return b; },
        head: true,
        maybeSingle() { return b.single(); },
        async single() {
          if (_isInsert) {
            insertedCount++;
            return { data: { id: "new-visual-id", ..._insertPayload }, error: null };
          }
          if (_isUpdate) {
            if (table === "generated_visuals" && _updatePayload?.status === "replaced") {
              updatedToReplaced.push("replaced-call");
            }
            return { data: null, error: null };
          }
          // feature_flags: return false (provider + purpose disabled → category fallback path)
          if (table === "feature_flags") return { data: null, error: null };
          // events: return the entity row
          if (table === "events") return { data: { id: EVENT_ID, title: "Test Event", header_image_source: null, header_image_updated_at: null }, error: null };
          // generated_visuals: return existing ready visual for the cache-hit check
          if (table === "generated_visuals") {
            return { data: { id: VISUAL_ID, status: "ready" }, error: null };
          }
          return { data: null, error: null };
        },
        async then(onF: any, onR: any) {
          if (_isUpdate) {
            if (table === "generated_visuals" && _updatePayload?.status === "replaced") {
              updatedToReplaced.push("replaced-call");
            }
            return onF({ data: null, error: null, count: 1 });
          }
          // count queries (usage limits)
          return onF({ data: [], error: null, count: 0 });
        },
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };

  _setTestClient(fakeClient as any, true);
  try {
    const outcome = await requestGeneration({
      entityType: "event",
      entityId: EVENT_ID,
      purpose: "event_header",
      ownerUserId: ALICE_ID,
      force: true,
    });
    // With force=true the old ready row must be retired and a new job queued.
    assert.ok(outcome.ok, `expected ok but got: ${outcome.error}`);
    assert.equal(outcome.status, "queued");
    // The prior active row must have been marked replaced.
    assert.ok(updatedToReplaced.length > 0, "expected at least one 'replaced' update call");
    // A new row must have been inserted.
    assert.ok(insertedCount > 0, "expected a new visual job to be inserted");
  } finally {
    _setTestClient(null as any, false);
  }
});

test("finalizeVisual applies heroUrl to trips.cover_url", async () => {
  let tripsUpdated: any = null;

  const TRIP_ID_X = "trip-cover-test-001";
  const fakeClient = {
    from(table: string) {
      const b: any = {
        select()                     { return b; },
        update(row: any)             {
          if (table === "trips") tripsUpdated = row;
          return b;
        },
        delete()                     { return b; },
        insert()                     { return b; },
        eq()                         { return b; },
        in()                         { return b; },
        gte()                        { return b; },
        limit()                      { return b; },
        order()                      { return b; },
        maybeSingle()                { return b.single(); },
        async single() {
          if (table === "generated_visuals") {
            return { data: { id: "vis-trip-1", entity_type: "trip", entity_id: TRIP_ID_X, purpose: "trip_cover", attempt_count: 0, provider: "category_fallback", style: "portava_editorial", input_snapshot: { category: "travel", entityType: "trip" }, final_prompt: "trip prompt", negative_prompt: "", aspect_ratio: "16:9" }, error: null };
          }
          if (table === "trips") return { data: { id: TRIP_ID_X, cover_url: null, header_image_source: null, header_image_updated_at: null }, error: null };
          return { data: null, error: null };
        },
        async then(onF: any) { return onF({ data: null, error: null, count: 0 }); },
      };
      return b;
    },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example.com/trip.webp" } }),
      }),
    },
  };

  _setTestClient(fakeClient as any, true);
  try {
    const { processJob } = await import("../lib/visuals/service.js");
    // processJob with a job whose provider is category_fallback skips derivatives
    // and calls finalizeVisual, which should update trips.cover_url.
    await processJob("vis-trip-1");
    // If trip branch runs, trips table is updated with cover_url.
    // (provider=category_fallback is used since feature_flags returns null → false)
    assert.ok(tripsUpdated !== null, "expected trips table to be updated with cover_url");
    assert.ok("cover_url" in tripsUpdated, `trips update payload should include cover_url, got: ${JSON.stringify(tripsUpdated)}`);
  } finally {
    _setTestClient(null as any, false);
  }
});

// ── route authorization ───────────────────────────────────────────────────────
// Minimal Express server + fake Supabase client tests for the /api/visuals routes.
// Tests the authorization model: authenticated but unauthorized users get 403 on
// both read and write endpoints; the event host gets through.

const ALICE_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-0000-0000-000000000002";
const EVENT_ID  = "eeeeeeee-0000-0000-0000-000000000001";
const VISUAL_ID = "ffffffff-0000-0000-0000-000000000001";

function makeVisualsClient(opts: {
  aliceIsHost?: boolean;
  aliceIsAdmin?: boolean;
  visualExists?: boolean;
}) {
  const db: Record<string, any[]> = {
    profiles: [
      { id: ALICE_ID, role: opts.aliceIsAdmin ? "admin" : "user" },
      { id: BOB_ID,   role: "user" },
    ],
    events: opts.aliceIsHost
      ? [{ id: EVENT_ID, host_id: ALICE_ID }]
      : [{ id: EVENT_ID, host_id: BOB_ID }],
    generated_visuals: opts.visualExists
      ? [{
          id: VISUAL_ID,
          entity_type: "event",
          entity_id: EVENT_ID,
          purpose: "event_header",
          status: "ready",
          style: "portava_editorial",
          source_image_url: "https://cdn.example.com/img.webp",
          hero_path: null,
          card_path: null,
          thumbnail_path: null,
          share_path: null,
          moderation_status: null,
          failure_code: null,
          created_at: "2026-07-26T00:00:00Z",
          updated_at: "2026-07-26T00:00:00Z",
        }]
      : [],
    feature_flags: [],
    trips: [],
  };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let insertPayload: any = null;

    const b: any = {
      select()           { return b; },
      insert(row: any)   { insertPayload = row; return b; },
      update()           { return b; },
      delete()           { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any)    {
        filters.push((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      or()     { return b; },
      not()    { return b; },
      limit()  { return b; },
      order()  { return b; },
      gte()    { return b; },
      lte()    { return b; },
      gt()     { return b; },
      lt()     { return b; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows() {
      return (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }
    async function resolveSingle(maybe: boolean) {
      if (insertPayload) return { data: { id: VISUAL_ID, ...insertPayload }, error: null };
      const matched = rows();
      if (!maybe && matched.length === 0) return { data: null, error: { message: "not found" } };
      return { data: matched[0] ?? null, error: null };
    }
    async function resolveList() {
      if (insertPayload) return { data: { id: VISUAL_ID, ...insertPayload }, error: null };
      return { data: rows(), error: null };
    }
    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        if (token === "alice-tok") return { data: { user: { id: ALICE_ID } }, error: null };
        if (token === "bob-tok")   return { data: { user: { id: BOB_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

function makeExpressApp(router: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", router);
  return app;
}

async function listenRandom(app: any): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r as any)),
      });
    });
  });
}

describe("visuals route — authorization", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    const { default: router } = await import("../routes/visuals.js");
    _setTestClient(makeVisualsClient({ aliceIsHost: true, visualExists: true }), true);
    const srv = await listenRandom(makeExpressApp(router));
    url = srv.url;
    close = srv.close;
  });
  after(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  // ── read endpoints must enforce auth ──────────────────────────────────────

  test("GET /visuals/:id — no auth → 401", async () => {
    const res = await fetch(`${url}/api/visuals/${VISUAL_ID}`);
    assert.equal(res.status, 401);
  });

  test("GET /visuals/:id — non-host (bob) → 403", async () => {
    const bobClient = makeVisualsClient({ aliceIsHost: true, visualExists: true });
    // Override so the authenticated user is bob (non-host)
    const bobOverride = {
      ...bobClient,
      auth: {
        getUser: async (token: string) => {
          if (token === "bob-tok") return { data: { user: { id: BOB_ID } }, error: null };
          return { data: { user: null }, error: { message: "invalid token" } };
        },
      },
    };
    _setTestClient(bobOverride, true);
    const res = await fetch(`${url}/api/visuals/${VISUAL_ID}`, {
      headers: { Authorization: "Bearer bob-tok" },
    });
    assert.equal(res.status, 403);
    // Restore host client
    _setTestClient(makeVisualsClient({ aliceIsHost: true, visualExists: true }), true);
  });

  test("GET /visuals/:id — host (alice) → 200 with visual", async () => {
    _setTestClient(makeVisualsClient({ aliceIsHost: true, visualExists: true }), true);
    const res = await fetch(`${url}/api/visuals/${VISUAL_ID}`, {
      headers: { Authorization: "Bearer alice-tok" },
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.visual?.id, VISUAL_ID);
  });

  test("GET /visuals/entity/:type/:id — no auth → 401", async () => {
    const res = await fetch(`${url}/api/visuals/entity/event/${EVENT_ID}`);
    assert.equal(res.status, 401);
  });

  test("GET /visuals/entity/:type/:id — non-host (bob) → 403", async () => {
    const bobOverride = makeVisualsClient({ aliceIsHost: true, visualExists: true });
    bobOverride.auth = {
      getUser: async (token: string) => {
        if (token === "bob-tok") return { data: { user: { id: BOB_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    };
    _setTestClient(bobOverride, true);
    const res = await fetch(`${url}/api/visuals/entity/event/${EVENT_ID}`, {
      headers: { Authorization: "Bearer bob-tok" },
    });
    assert.equal(res.status, 403);
    _setTestClient(makeVisualsClient({ aliceIsHost: true, visualExists: true }), true);
  });

  test("GET /visuals/entity/:type/:id — host (alice) → 200 with list", async () => {
    _setTestClient(makeVisualsClient({ aliceIsHost: true, visualExists: true }), true);
    const res = await fetch(`${url}/api/visuals/entity/event/${EVENT_ID}`, {
      headers: { Authorization: "Bearer alice-tok" },
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(Array.isArray(body.visuals));
  });

  // ── write endpoints already enforced auth, smoke-test one ────────────────

  test("POST /visuals/generate — no auth → 401", async () => {
    const res = await fetch(`${url}/api/visuals/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "event", entityId: EVENT_ID, purpose: "event_header" }),
    });
    assert.equal(res.status, 401);
  });
});
