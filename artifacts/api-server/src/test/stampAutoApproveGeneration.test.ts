/**
 * stamp auto-approve generation — when the stamp_auto_approve_artwork flag is
 * true, the worker promotes the first candidate to approved immediately after
 * generation so users see stamp artwork without a manual review step.
 *
 * Covers:
 * - Flag enabled: stamp_artwork_versions is updated to "approved", catalog
 *   active_version_id is set and status reaches "approved".
 * - Extra candidates (beyond the first) are archived automatically.
 * - The queue row still reaches "review_required" so admins can see the job
 *   and optionally switch to a different candidate.
 * - Flag disabled (default when flag row absent): no approve/archive updates
 *   happen; catalog stays at candidate / review_required flow.
 *
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/stampAutoApproveGeneration.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Disable the requeue sweep so runGenerationCycle doesn't try to hit the DB
// for retryable-failed jobs — unrelated to this test.
process.env.STAMP_FAILED_REQUEUE_HOURS = "0";
// Disable the stale-artwork sweep so the cycle doesn't try to reach the DB
// for artwork version rows — unrelated to this test.
process.env.STAMP_STALE_SWEEP_INTERVAL_MINUTES = "0";
// Use default MIN_CANDIDATES (1) so a 3-candidate run is never a failure.
delete process.env.STAMP_MIN_CANDIDATES;

const { runGenerationCycle } = await import("../lib/stamps/generationWorker.js");
const { _setTestStampImageProvider, _resetProviderCache } = await import(
  "../lib/stamps/imageProvider.js"
);
const { _setTestServiceClient } = await import("../lib/supabase.js");

// ── Fake image provider ───────────────────────────────────────────────────────

/** Returns `count` placeholder SVG data-URL candidates (no HTTP downloads). */
function makePlaceholderProvider(count: number) {
  return {
    async generate(_prompt: string, _n?: number) {
      return Array.from({ length: count }, (_, i) => ({
        url: `data:image/svg+xml,placeholder-${i}`,
        metadata: { model: "test-provider", candidate_index: i },
      }));
    },
  };
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const JOB = {
  id:                  "job-aa-1",
  catalog_id:          "cat-aa-1",
  attempts:            0,
  max_attempts:        3,
  triggered_by_action: "test",
};

const CATALOG_ROW = {
  id:                     "cat-aa-1",
  canonical_location_key: "jp/kyoto",
  stamp_type:             "city",
  display_name:           "Kyoto",
  country:                "Japan",
  country_code:           "JP",
  region:                 null,
  city:                   "Kyoto",
  neighborhood:           null,
};

// ── Fake client builder ───────────────────────────────────────────────────────

interface UpdateRecord {
  table:     string;
  payload:   any;
  eqFilters: Array<[string, any]>;
  inFilters: Array<[string, any[]]>;
}

interface InsertRecord {
  table: string;
  rows:  any[];
}

/**
 * Build a fake Supabase client.
 *
 * @param autoApproveFlag  Value returned for stamp_auto_approve_artwork flag.
 *                         Defaults to false (flag row absent → data null).
 */
function makeFakeClient(opts: { autoApproveFlag?: boolean } = {}) {
  const updates: UpdateRecord[] = [];
  const inserts: InsertRecord[] = [];

  function makeUpdateBuilder(table: string, payload: any) {
    const record: UpdateRecord = { table, payload, eqFilters: [], inFilters: [] };
    updates.push(record);
    const result = { data: [{ id: JOB.id }], error: null };
    const b: any = {
      eq(col: string, val: any)      { record.eqFilters.push([col, val]); return b; },
      in(col: string, vals: any[])   { record.inFilters.push([col, vals]); return b; },
      select(_c: string)             { return Promise.resolve(result); },
      then(resolve: any, reject: any) {
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return b;
  }

  const sc: any = {
    from(table: string) {
      // ── stamp_generation_queue ────────────────────────────────────────────
      if (table === "stamp_generation_queue") {
        return {
          select(_cols: string) {
            const b: any = {
              eq()     { return b; },
              or()     { return b; },
              lt()     { return b; },
              order()  { return b; },
              in()     { return b; },
              limit()  {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { ...JOB }, error: null });
                  },
                };
              },
              then(resolve: any, reject: any) {
                return Promise.resolve({ data: [], error: null }).then(resolve, reject);
              },
            };
            return b;
          },
          update: (payload: any) => makeUpdateBuilder(table, payload),
          insert(rows: any[]) {
            inserts.push({ table, rows });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      // ── universal_stamp_catalog ───────────────────────────────────────────
      if (table === "universal_stamp_catalog") {
        return {
          select(_cols: string) {
            const b: any = {
              eq()         { return b; },
              maybeSingle() {
                return Promise.resolve({ data: { ...CATALOG_ROW }, error: null });
              },
            };
            return b;
          },
          update: (payload: any) => makeUpdateBuilder(table, payload),
        };
      }

      // ── stamp_artwork_versions ────────────────────────────────────────────
      if (table === "stamp_artwork_versions") {
        return {
          insert(rows: any[]) {
            inserts.push({ table, rows });
            return Promise.resolve({ data: null, error: null });
          },
          update: (payload: any) => makeUpdateBuilder(table, payload),
        };
      }

      // ── stamp_definitions (rarityForCatalog — called only for premium) ────
      if (table === "stamp_definitions") {
        return {
          select(_cols: string) {
            const b: any = {
              eq()    { return b; },
              limit() { return Promise.resolve({ data: [], error: null }); },
            };
            return b;
          },
        };
      }

      // ── feature_flags ─────────────────────────────────────────────────────
      // autoApproveArtworkEnabled and premiumRenderingEnabled both do:
      //   .from("feature_flags").select("enabled").eq("flag", <name>).maybeSingle()
      if (table === "feature_flags") {
        let capturedFlag: string | null = null;
        const b: any = {
          select(_cols: string) { return b; },
          eq(_col: string, val: string) {
            // Only the second .eq() carries the flag name (first is column
            // "flag", second is the flag value — but both arrive as the
            // same chained call so we capture the last non-"enabled" value).
            capturedFlag = val;
            return b;
          },
          maybeSingle() {
            if (capturedFlag === "stamp_auto_approve_artwork") {
              const enabled = opts.autoApproveFlag ?? false;
              return Promise.resolve({
                data:  enabled ? { enabled: true } : null,
                error: null,
              });
            }
            // stamp_premium_rendering_enabled and any other flags — off.
            return Promise.resolve({ data: null, error: null });
          },
        };
        return b;
      }

      // Fallback — should not be reached in these tests.
      return {
        select() {
          const b: any = {
            eq()         { return b; },
            or()         { return b; },
            order()      { return b; },
            limit()      {
              return {
                maybeSingle() { return Promise.resolve({ data: null, error: null }); },
              };
            },
            maybeSingle() { return Promise.resolve({ data: null, error: null }); },
            then(resolve: any, reject: any) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return b;
        },
      };
    },
  };

  return { sc, updates, inserts };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function versionUpdates(updates: UpdateRecord[]) {
  return updates.filter((u) => u.table === "stamp_artwork_versions");
}

function catalogUpdates(updates: UpdateRecord[]) {
  return updates.filter((u) => u.table === "universal_stamp_catalog");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runGenerationCycle — stamp_auto_approve_artwork flag enabled", () => {
  beforeEach(() => {
    _resetProviderCache();
  });

  it("marks the first candidate approved and sets active_version_id on the catalog", async () => {
    const { sc, updates, inserts } = makeFakeClient({ autoApproveFlag: true });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    const result = await runGenerationCycle();

    assert.equal(result.processed, true, "cycle must report a job was processed");

    // Three candidates inserted.
    const versionInsert = inserts.find((i) => i.table === "stamp_artwork_versions");
    assert.ok(versionInsert, "stamp_artwork_versions must have been inserted");
    assert.equal(versionInsert!.rows.length, 3, "expected 3 candidate rows");
    // All inserted as candidate initially.
    assert.ok(
      versionInsert!.rows.every((r: any) => r.status === "candidate"),
      "all inserted rows must start as candidate",
    );

    // Auto-approve: the first candidate's version row is updated to approved.
    const approveVersionUpdate = versionUpdates(updates).find(
      (u) => u.payload.status === "approved",
    );
    assert.ok(
      approveVersionUpdate,
      "stamp_artwork_versions must have an update setting status=approved",
    );
    assert.ok(
      approveVersionUpdate!.payload.reviewed_at,
      "approved update must include reviewed_at",
    );
    // Must target the first candidate by id.
    const firstVersionId = versionInsert!.rows[0].id;
    assert.ok(
      approveVersionUpdate!.eqFilters.some(([col, val]) => col === "id" && val === firstVersionId),
      "approve update must target the first candidate version id",
    );
    assert.ok(
      approveVersionUpdate!.eqFilters.some(([col, val]) => col === "status" && val === "candidate"),
      "approve update must guard on status=candidate",
    );

    // Auto-approve: catalog row updated with active_version_id and status approved.
    const approveCatalogUpdate = catalogUpdates(updates).find(
      (u) => u.payload.status === "approved" && u.payload.active_version_id,
    );
    assert.ok(
      approveCatalogUpdate,
      "universal_stamp_catalog must have an update with active_version_id and status=approved",
    );
    assert.equal(
      approveCatalogUpdate!.payload.active_version_id,
      firstVersionId,
      "active_version_id must point to the first candidate",
    );
    assert.ok(
      approveCatalogUpdate!.eqFilters.some(([col, val]) => col === "id" && val === CATALOG_ROW.id),
      "catalog update must target the correct catalog id",
    );
  });

  it("archives the remaining candidates after approving the first", async () => {
    const { sc, updates, inserts } = makeFakeClient({ autoApproveFlag: true });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    await runGenerationCycle();

    const versionInsert = inserts.find((i) => i.table === "stamp_artwork_versions");
    const firstVersionId  = versionInsert!.rows[0].id;
    const secondVersionId = versionInsert!.rows[1].id;
    const thirdVersionId  = versionInsert!.rows[2].id;

    // Archive update must exist and target the non-first candidates.
    const archiveUpdate = versionUpdates(updates).find(
      (u) => u.payload.status === "archived",
    );
    assert.ok(archiveUpdate, "there must be an archive update for the non-first candidates");
    const archivedIds = archiveUpdate!.inFilters.find(([col]) => col === "id")?.[1] ?? [];
    assert.ok(
      !archivedIds.includes(firstVersionId),
      "the approved (first) candidate must NOT be in the archived set",
    );
    assert.ok(
      archivedIds.includes(secondVersionId),
      "the second candidate must be archived",
    );
    assert.ok(
      archivedIds.includes(thirdVersionId),
      "the third candidate must be archived",
    );
  });

  it("still sets the queue row to review_required so admins can see the job", async () => {
    const { sc, updates } = makeFakeClient({ autoApproveFlag: true });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    await runGenerationCycle();

    const queueUpdates = updates.filter((u) => u.table === "stamp_generation_queue");
    const reviewUpdate = queueUpdates.find((u) => u.payload.status === "review_required");
    assert.ok(
      reviewUpdate,
      "queue row must still reach review_required even when auto-approve runs",
    );
    assert.equal(reviewUpdate!.payload.locked_until, null, "lock must be released");
    assert.equal(reviewUpdate!.payload.locked_by, null,    "lock owner must be cleared");
  });
});

describe("runGenerationCycle — stamp_auto_approve_artwork flag disabled (default)", () => {
  beforeEach(() => {
    _resetProviderCache();
  });

  it("skips auto-approve: no approved update on stamp_artwork_versions", async () => {
    // Flag absent (data: null) — autoApproveArtworkEnabled returns false.
    const { sc, updates } = makeFakeClient({ autoApproveFlag: false });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    const result = await runGenerationCycle();

    assert.equal(result.processed, true, "cycle still processes the job without auto-approve");

    const approveUpdate = versionUpdates(updates).find(
      (u) => u.payload.status === "approved",
    );
    assert.equal(
      approveUpdate,
      undefined,
      "no approved update must be emitted when the flag is disabled",
    );
  });

  it("catalog is never updated to approved when flag is disabled", async () => {
    const { sc, updates } = makeFakeClient({ autoApproveFlag: false });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    await runGenerationCycle();

    const approvedCatalogUpdate = catalogUpdates(updates).find(
      (u) => u.payload.status === "approved",
    );
    assert.equal(
      approvedCatalogUpdate,
      undefined,
      "catalog must not be set to approved when the flag is disabled",
    );
  });

  it("queue row reaches review_required even without auto-approve", async () => {
    const { sc, updates } = makeFakeClient({ autoApproveFlag: false });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(3));

    await runGenerationCycle();

    const queueUpdates = updates.filter((u) => u.table === "stamp_generation_queue");
    const reviewUpdate = queueUpdates.find((u) => u.payload.status === "review_required");
    assert.ok(reviewUpdate, "queue row must reach review_required in the normal (flag-off) path");
  });
});

describe("runGenerationCycle — auto-approve with a single candidate", () => {
  beforeEach(() => {
    _resetProviderCache();
  });

  it("approves the sole candidate and sets it as active_version_id", async () => {
    const { sc, updates, inserts } = makeFakeClient({ autoApproveFlag: true });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makePlaceholderProvider(1));

    const result = await runGenerationCycle();
    assert.equal(result.processed, true);

    const versionInsert = inserts.find((i) => i.table === "stamp_artwork_versions");
    assert.ok(versionInsert, "must have inserted the version row");
    assert.equal(versionInsert!.rows.length, 1);

    const approveVersionUpdate = versionUpdates(updates).find(
      (u) => u.payload.status === "approved",
    );
    assert.ok(approveVersionUpdate, "sole candidate must be approved");

    const approveCatalogUpdate = catalogUpdates(updates).find(
      (u) => u.payload.active_version_id,
    );
    assert.ok(approveCatalogUpdate, "catalog must receive active_version_id");
    assert.equal(
      approveCatalogUpdate!.payload.active_version_id,
      versionInsert!.rows[0].id,
    );

    // No archive update when there is only one candidate.
    const archiveUpdate = versionUpdates(updates).find(
      (u) => u.payload.status === "archived",
    );
    assert.equal(
      archiveUpdate,
      undefined,
      "no archive update when there is only one candidate",
    );
  });
});
