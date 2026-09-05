/**
 * Composited stamp artwork — the PostgREST FK hint contract.
 *
 * THE RECURRENCE THIS EXISTS FOR
 * ------------------------------
 * `universal_stamp_catalog.active_version_id` references
 * `stamp_artwork_versions` through the constraint `fk_catalog_active_version`
 * (migration 0121). PostgREST cannot resolve the COLUMN-name form of the embed
 * hint on this relationship: `stamp_artwork_versions!active_version_id(...)`
 * does not error — it returns `null` for every catalog row, so the artwork
 * simply is not there and nothing anywhere reports a problem.
 *
 * The repo has hit this twice and written it down both times:
 *   lib/stamps/generationWorker.ts:26-29  "artwork never surfaced in
 *     GET /api/stamps/me even after admin approval … returning null for every
 *     catalog row"  → routes/stamps.ts fixed to !fk_catalog_active_version
 *   routes/passport.ts:1017-1019          "PostgREST cannot resolve the
 *     `!active_version_id` column hint (it returns null), so composited artwork
 *     was always null here"
 *
 * A third site survived both fixes: `UnifiedStampService.readArtwork`. That one
 * feeds the §29 passport projection, the yearbook and the unified view of
 * GET /api/stamps/me — i.e. every premium composited stamp image a user sees.
 * `unifiedStamps.test.ts` could not see it because its fake's `select()` takes
 * no argument and hands back the embed unconditionally.
 *
 * TWO DEFENCES, DELIBERATELY BOTH
 * -------------------------------
 *   static   — no source file may use the column-name hint again
 *   dynamic  — a fake that resolves the embed the way PostgREST does, so
 *              artwork actually has to arrive at the consumer
 *
 * Run: node --import tsx/esm --test src/test/stampArtworkFkHint.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildUnifiedStamps } from "../services/passport/UnifiedStampService.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");

/** The FK constraint declared in 0121 — the only hint PostgREST can resolve. */
const GOOD_HINT = "fk_catalog_active_version";
/** The column-name hint that silently yields null. */
const DEAD_HINT = "active_version_id";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "test" || e === "node_modules") continue;
      sourceFiles(p, out);
    } else if (e.endsWith(".ts") && e !== "database.types.ts") {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("stamp artwork embeds name the FK CONSTRAINT, never the column", () => {
  const files = sourceFiles(SRC);

  it("scans a plausible number of source files (guard against a vacuous run)", () => {
    assert.ok(files.length > 100, `only ${files.length} source files scanned — the walk broke`);
  });

  it("no production file embeds stamp_artwork_versions by column name", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(f, "utf8"));
      const re = /stamp_artwork_versions!([A-Za-z0-9_]+)/g;
      for (const m of src.matchAll(re)) {
        if (m[1] !== GOOD_HINT) offenders.push(`${relative(SRC, f)}: !${m[1]}`);
      }
    }
    assert.deepEqual(
      offenders, [],
      `PostgREST returns null for every row on the !${DEAD_HINT} hint — use ` +
      `!${GOOD_HINT} (the constraint name from migration 0121):\n  ` +
      offenders.join("\n  "),
    );
  });

  it("at least one production file still embeds it the correct way", () => {
    // Otherwise the check above passes because the feature was deleted.
    const users = files.filter((f) =>
      stripComments(readFileSync(f, "utf8")).includes(`stamp_artwork_versions!${GOOD_HINT}`));
    assert.ok(users.length >= 3,
      `expected the three composited-artwork readers to use !${GOOD_HINT}, found ${users.length}`);
  });
});

// ── Dynamic: the embed has to actually resolve ───────────────────────────────

/**
 * Fake Supabase that resolves a `stamp_artwork_versions!<hint>` embed the way
 * PostgREST does on this relationship: the constraint-name hint resolves to the
 * active version's row; the column-name hint resolves to null, silently.
 */
function makeSc(opts: {
  v2?: any[];
  /** catalog id → active version public_url */
  art?: Record<string, string>;
  catalogStatus?: string;
}) {
  const status = opts.catalogStatus ?? "approved";
  return {
    from(table: string) {
      const b: any = {
        _f: [] as Array<[string, any]>,
        _select: "*",
        select(f?: string) { if (typeof f === "string") b._select = f; return b; },
        eq(k: string, v: any) { b._f.push([k, v]); return b; },
        in(_k: string, v: any[]) { b._in = v; return b; },
        maybeSingle: async () => ({ data: null, error: null }),
        then(res: any) {
          if (table === "user_stamps") { res({ data: opts.v2 ?? [], error: null }); return; }
          if (table === "passport_stamps") { res({ data: [], error: null }); return; }
          if (table === "universal_stamp_catalog") {
            const wantStatus = b._f.find((f: any) => f[0] === "status")?.[1];
            if (wantStatus !== undefined && wantStatus !== status) { res({ data: [], error: null }); return; }
            const hint = /stamp_artwork_versions!([A-Za-z0-9_]+)/.exec(b._select)?.[1] ?? null;
            const resolvable = hint === GOOD_HINT;
            const rows = (b._in ?? []).map((id: string) => ({
              id,
              // Column-name hint: PostgREST cannot resolve it and returns null
              // rather than raising — the whole reason this defect was silent.
              stamp_artwork_versions: resolvable ? { public_url: opts.art?.[id] ?? null } : null,
            }));
            res({ data: rows, error: null }); return;
          }
          res({ data: [], error: null });
        },
      };
      return b;
    },
  } as any;
}

const CATALOG_ID = "cat-1";
const ART_URL = "stamp-artwork/tokyo/v3.png";

const v2Row = () => ({
  id: "us-1", city: "Tokyo", country: "Japan", earned_at: "2026-07-10T00:00:00Z",
  is_revoked: false, catalog_id: CATALOG_ID, source_type: "system",
  stamp_definitions: { name: "Tokyo", rarity: "rare", stamp_type: "city" },
});

describe("UnifiedStampService surfaces composited artwork", () => {
  it("a catalog-linked v2 stamp carries the active version's public_url", async () => {
    const sc = makeSc({ v2: [v2Row()], art: { [CATALOG_ID]: ART_URL } });
    const { stamps } = await buildUnifiedStamps(sc, "user-1");
    assert.equal(stamps.length, 1);
    assert.equal(
      stamps[0].artworkUrl, ART_URL,
      "composited artwork did not reach the unified stamp — the catalog embed " +
      `must use !${GOOD_HINT}, not the column name`,
    );
  });

  it("stays null when the catalog entry is not approved (negative control)", async () => {
    const sc = makeSc({ v2: [v2Row()], art: { [CATALOG_ID]: ART_URL }, catalogStatus: "pending_artwork" });
    const { stamps } = await buildUnifiedStamps(sc, "user-1");
    assert.equal(stamps[0].artworkUrl, null);
  });

  it("stays null when the stamp has no catalog link (negative control)", async () => {
    const sc = makeSc({ v2: [{ ...v2Row(), catalog_id: null }], art: { [CATALOG_ID]: ART_URL } });
    const { stamps } = await buildUnifiedStamps(sc, "user-1");
    assert.equal(stamps[0].artworkUrl, null);
  });
});
