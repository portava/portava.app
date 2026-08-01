/**
 * Stamp generation worker — placeholder provider detection tests.
 *
 * Covers:
 *   P1: runGenerationCycle emits a provider_degraded WARN when STAMP_WORKER_ENABLED=true
 *       and all candidates are placeholder SVGs.
 *   P2: No provider_degraded WARN when candidates are real (data:image/png) URLs.
 *   P3: No provider_degraded WARN when STAMP_WORKER_ENABLED is not "true",
 *       even if all candidates are placeholders.
 *   P4: Placeholder candidates are stored with generation_source = "placeholder"
 *       (not "ai_generated"), so the admin review screen can filter them.
 *   P5: Real (non-placeholder) candidates are stored with generation_source = "ai_generated".
 *   P6: queryStampWorkerHealth returns provider_degraded=true when last N versions
 *       are all placeholders and STAMP_WORKER_ENABLED=true.
 *   P7: queryStampWorkerHealth returns provider_degraded=false when at least one
 *       recent version is "ai_generated".
 *   P8: queryStampWorkerHealth returns provider_degraded=false when the worker is disabled,
 *       even if all recent versions are placeholders.
 *   P9: evaluateWorkerHealth includes a provider_degraded warning when the flag is true.
 *   P10: evaluateWorkerHealth does NOT emit provider_degraded when the flag is false.
 *
 * Run: node --import tsx/esm --test src/test/stampPlaceholderProviderWarn.test.ts
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// Disable auto-requeue sweep to keep cycles predictable.
process.env.STAMP_FAILED_REQUEUE_HOURS = "0";

const {
  runGenerationCycle,
  queryStampWorkerHealth,
  evaluateWorkerHealth,
} = await import("../lib/stamps/generationWorker.js");
const { _setTestStampImageProvider, _resetProviderCache } = await import(
  "../lib/stamps/imageProvider.js"
);
const { _setTestServiceClient } = await import("../lib/supabase.js");

// ── Fake builders ─────────────────────────────────────────────────────────────

const JOB = {
  id: "job-ph-1",
  catalog_id: "cat-ph-1",
  attempts: 0,
  max_attempts: 3,
  triggered_by_action: "test",
};

const CATALOG_ROW = {
  id: "cat-ph-1",
  canonical_location_key: "jp/tokyo",
  stamp_type: "city",
  display_name: "Tokyo",
  country: "Japan",
  country_code: "JP",
  region: null,
  city: "Tokyo",
  neighborhood: null,
};

/**
 * Minimal fake Supabase client for runGenerationCycle.
 * Captures version inserts for inspection.
 * Includes a no-op storage mock so real-image paths (data:image/png upload) don't crash.
 */
function makeFakeClient() {
  const inserts: Array<{ table: string; rows: any[] }> = [];
  const updates: Array<{ table: string; payload: any; eqFilters: Array<[string, any]> }> = [];

  const sc: any = {
    from(table: string) {
      return {
        select(_cols: string) {
          const b: any = {
            eq() { return b; },
            or() { return b; },
            lt() { return b; },
            order() { return b; },
            limit() { return b; },
            range() { return b; },
            maybeSingle() {
              if (table === "stamp_generation_queue") {
                return Promise.resolve({ data: { ...JOB }, error: null });
              }
              if (table === "universal_stamp_catalog") {
                return Promise.resolve({ data: { ...CATALOG_ROW }, error: null });
              }
              // feature_flags — both flags off by default
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve: any, reject: any) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return b;
        },
        update(payload: any) {
          const call: any = { table, payload, eqFilters: [] };
          updates.push(call);
          const b: any = {
            eq(col: string, val: any) { call.eqFilters.push([col, val]); return b; },
            select(_c: string) { return Promise.resolve({ data: [{ id: JOB.id }], error: null }); },
            then(resolve: any, reject: any) {
              return Promise.resolve({ data: [{ id: JOB.id }], error: null }).then(resolve, reject);
            },
          };
          return b;
        },
        insert(rows: any[]) {
          inserts.push({ table, rows });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    // No-op storage mock — needed for real-image (data:image/png) upload paths.
    storage: {
      from(_bucket: string) {
        return {
          upload(_path: string, _buf: Buffer) {
            return Promise.resolve({ error: null });
          },
          remove(_paths: string[]) {
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };

  return { sc, inserts, updates };
}

/** Provider returning placeholder SVG data-URLs (like PlaceholderProvider). */
function makePlaceholderProvider(n = 3) {
  return {
    async generate(_prompt: string) {
      return Array.from({ length: n }, (_, i) => ({
        url: `data:image/svg+xml,placeholder-${i}`,
        metadata: { model: "placeholder", candidate_index: i },
      }));
    },
  };
}

/** Provider returning real PNG data-URLs (like gpt-image-1 b64_json). */
function makeRealProvider(n = 3) {
  // Minimal valid 1×1 transparent PNG base64
  const pngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  return {
    async generate(_prompt: string) {
      return Array.from({ length: n }, (_, i) => ({
        url: `data:image/png;base64,${pngB64}`,
        metadata: { model: "gpt-image-1", candidate_index: i },
      }));
    },
  };
}

/**
 * Fake Supabase client for queryStampWorkerHealth.
 * Lets the caller specify which generation_source values the last N versions have.
 */
function makeHealthFakeClient(opts: {
  recentSources: string[];
  workerEnabled?: boolean;
}) {
  const sc: any = {
    from(table: string) {
      return {
        select(_cols: string) {
          const b: any = {
            eq() { return b; },
            lt() { return b; },
            order() { return b; },
            limit() { return b; },
            maybeSingle() {
              // last_success_at query
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve: any, reject: any) {
              if (table === "stamp_generation_queue") {
                // status depth
                return Promise.resolve({ data: [], error: null }).then(resolve, reject);
              }
              if (table === "stamp_artwork_versions") {
                // recent generation_source window
                const rows = opts.recentSources.map((s) => ({ generation_source: s }));
                return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
              }
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return b;
        },
      };
    },
  };
  return sc;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stampPlaceholderProviderWarn", () => {
  afterEach(() => {
    _resetProviderCache();
    _setTestServiceClient(null as any);
    delete process.env.STAMP_WORKER_ENABLED;
  });

  it("P1: emits provider_degraded WARN when all candidates are placeholder SVGs and worker is enabled", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    const { sc } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnMessages.push(args.map(String).join(" "));
    };
    try {
      await runGenerationCycle();
    } finally {
      console.warn = origWarn;
    }

    const degradedWarn = warnMessages.find((m) => m.includes("provider_degraded"));
    assert.ok(degradedWarn, `Expected a provider_degraded warn; got: ${JSON.stringify(warnMessages)}`);
    assert.ok(
      degradedWarn.includes("STAMP_WORKER_ENABLED=true"),
      "WARN should mention STAMP_WORKER_ENABLED=true",
    );
  });

  it("P2: no provider_degraded WARN when candidates are real (data:image/png) images", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    const { sc } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeRealProvider(3));

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnMessages.push(args.map(String).join(" "));
    };
    try {
      await runGenerationCycle();
    } finally {
      console.warn = origWarn;
    }

    const degradedWarn = warnMessages.find((m) => m.includes("provider_degraded"));
    assert.equal(degradedWarn, undefined, "Should not emit provider_degraded for real images");
  });

  it("P3: no provider_degraded WARN when STAMP_WORKER_ENABLED is not 'true'", async () => {
    // Leave STAMP_WORKER_ENABLED unset (or set to 'false')
    process.env.STAMP_WORKER_ENABLED = "false";
    const { sc } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnMessages.push(args.map(String).join(" "));
    };
    try {
      await runGenerationCycle();
    } finally {
      console.warn = origWarn;
    }

    const degradedWarn = warnMessages.find((m) => m.includes("provider_degraded"));
    assert.equal(degradedWarn, undefined, "Should not emit provider_degraded when worker is disabled");
  });

  it("P4: placeholder candidates are stored with generation_source='placeholder'", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    const { sc, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    await runGenerationCycle();

    const versionInsert = inserts.find((i) => i.table === "stamp_artwork_versions");
    assert.ok(versionInsert, "Expected stamp_artwork_versions insert");
    assert.ok(versionInsert.rows.length > 0, "Expected at least one version row");
    for (const row of versionInsert.rows) {
      assert.equal(
        row.generation_source,
        "placeholder",
        `Expected generation_source='placeholder' but got '${row.generation_source}'`,
      );
    }
  });

  it("P5: real candidates are stored with generation_source='ai_generated'", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    const { sc, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeRealProvider(3));

    await runGenerationCycle();

    const versionInsert = inserts.find((i) => i.table === "stamp_artwork_versions");
    assert.ok(versionInsert, "Expected stamp_artwork_versions insert");
    for (const row of versionInsert.rows) {
      assert.equal(
        row.generation_source,
        "ai_generated",
        `Expected generation_source='ai_generated' but got '${row.generation_source}'`,
      );
    }
  });

  it("P6: queryStampWorkerHealth returns provider_degraded=true when all recent sources are 'placeholder' and worker is enabled", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    const sc = makeHealthFakeClient({ recentSources: ["placeholder", "placeholder", "placeholder"] });
    _setTestServiceClient(sc);

    const health = await queryStampWorkerHealth();
    assert.ok(health, "Expected health result");
    assert.equal(health!.provider_degraded, true);
  });

  it("P7: queryStampWorkerHealth returns provider_degraded=false when at least one recent source is 'ai_generated'", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    const sc = makeHealthFakeClient({ recentSources: ["placeholder", "ai_generated", "placeholder"] });
    _setTestServiceClient(sc);

    const health = await queryStampWorkerHealth();
    assert.ok(health, "Expected health result");
    assert.equal(health!.provider_degraded, false);
  });

  it("P8: queryStampWorkerHealth returns provider_degraded=false when worker is disabled even if all recent are placeholder", async () => {
    process.env.STAMP_WORKER_ENABLED = "false";
    const sc = makeHealthFakeClient({ recentSources: ["placeholder", "placeholder"] });
    _setTestServiceClient(sc);

    const health = await queryStampWorkerHealth();
    assert.ok(health, "Expected health result");
    assert.equal(health!.provider_degraded, false);
  });

  it("P9: evaluateWorkerHealth includes provider_degraded warning when flag is set", () => {
    const health = {
      worker_enabled: true,
      worker_running: true,
      worker_id: "w-test",
      last_success_at: null as string | null,
      queue_depth: {} as Record<string, number>,
      stuck_jobs: [] as any[],
      provider_degraded: true,
    };
    const warnings = evaluateWorkerHealth(health, null);
    const w = warnings.find((x) => x.key === "provider_degraded");
    assert.ok(w, "Expected a provider_degraded warning");
    assert.ok(w!.message.includes("placeholder"), "Warning should mention placeholder SVGs");
  });

  it("P10: evaluateWorkerHealth does NOT emit provider_degraded when flag is false", () => {
    const health = {
      worker_enabled: true,
      worker_running: true,
      worker_id: "w-test",
      last_success_at: null as string | null,
      queue_depth: {} as Record<string, number>,
      stuck_jobs: [] as any[],
      provider_degraded: false,
    };
    const warnings = evaluateWorkerHealth(health, null);
    const w = warnings.find((x) => x.key === "provider_degraded");
    assert.equal(w, undefined, "Should not emit provider_degraded when flag is false");
  });

  it("P11: queryStampWorkerHealth returns provider_degraded=false when recent sources include 'recomposed' — recomposed is a valid non-placeholder source", async () => {
    process.env.STAMP_WORKER_ENABLED = "true";
    // Mix of recomposed + ai_generated: neither is placeholder, so degraded must be false.
    const sc = makeHealthFakeClient({
      recentSources: ["recomposed", "ai_generated", "recomposed"],
    });
    _setTestServiceClient(sc);

    const health = await queryStampWorkerHealth();
    assert.ok(health, "Expected health result");
    assert.equal(
      health!.provider_degraded,
      false,
      "'recomposed' versions should not trigger provider_degraded",
    );
  });
});
