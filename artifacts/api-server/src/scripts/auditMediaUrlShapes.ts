/**
 * auditMediaUrlShapes — URL-SHAPE HISTOGRAM of the durable media URL columns.
 * STRICTLY READ-ONLY. COUNTS ONLY. NO URL VALUE IS EVER SELECTED OR PRINTED.
 *
 * THE QUESTION THIS ANSWERS
 * =========================
 *
 * The upload-consolidation design needs to know whether converting the two
 * writers that still mint absolute public storage URLs is the WHOLE job, or
 * only the first half of it.
 *
 *   - `lib/visuals/service.ts:429` calls `getPublicUrl()` on the post-media
 *     bucket and writes the absolute result into `events.cover_url` /
 *     `trips.cover_url` (`:540`, `:560`).
 *   - The client `memories.ts` / `stories.ts` uploaders do the same into the
 *     media URL fields.
 *
 * Those are code, and code can be changed. The columns are DURABLE: whatever is
 * already in them survives every code change. So:
 *
 *   large legacy population of absolute storage URLs
 *       → converting the writers is NECESSARY BUT NOT SUFFICIENT, and the
 *         consolidation also needs a backfill or a read-time rewrite;
 *   population already relay-shaped or bare keys
 *       → converting the writers is the whole job.
 *
 * A histogram of SHAPES answers that. The URLs themselves do not, and they are
 * user content: they carry user ids, post ids, and filenames. They must not
 * reach a terminal, a CI log, or a commit.
 *
 * WHAT IT DELIBERATELY NEVER DOES
 * ===============================
 *
 * IT NEVER SELECTS A URL. Every statement below classifies inside SQL with a
 * CASE expression and returns `(column, url_shape, count)`. No statement has a
 * bare column in its select list, none returns a row per object, and there is
 * no verbose flag and no code path that could add one. The only way to not
 * print a value is to never fetch it — the same rule `auditStorageExif.ts`
 * applies to coordinates, for the same reason.
 *
 * IT NEVER WRITES. Five SELECTs. No INSERT/UPDATE/DELETE/DDL, no `.insert`/
 * `.update`/`.upsert`/`.delete`/`.rpc`, no Storage call of any kind, no
 * `--apply` and no code path that could take one.
 *
 * THE PRODUCTION QUESTION
 * =======================
 *
 * This imports `src/lib/ciProdReadOnlyAuditGuard.mjs` as its first statement,
 * the same front door as the other read-only audits, and is listed in
 * READ_ONLY_AUDIT_ENTRY_POINTS in `scripts/check-guard-coverage.mjs`. Auditing
 * production is the point: the legacy corpus is the thing being measured, and a
 * census of the non-production project would say nothing about it — exactly the
 * defect that voided the EXIF census's tag (fact layer §7.3, §10.3).
 *
 * Outside CI, with PORTAVA_PROD_READ_ONLY_AUDIT set to the exact sentence, and
 * only against the ref in KNOWN_PROD_PROJECT_REF. In CI, always exit 2.
 *
 * RECORD THE PROJECT REF WITH THE RESULT. The output prints it for that reason:
 * a `[DB]` tag that does not name the project is void under the fact layer's
 * own rule, and two entries in that document are currently void for exactly
 * this.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run audit:media-url-shapes
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";

const EXIT_OK = 0;
const EXIT_CANNOT_RUN = 2;

/**
 * The shape classifier, shared by every statement.
 *
 * `absolute_storage_PUBLIC` is the finding that decides the design question:
 * an absolute `/storage/v1/object/public/` URL is a durable dependency on the
 * bucket being public, sitting in a column, immune to any code change.
 */
const SHAPE_CASE = `
  CASE
    WHEN v IS NULL OR btrim(v) = ''                            THEN 'null_or_empty'
    WHEN v ~ '^https?://' AND v ~ '/storage/v1/object/public/' THEN 'absolute_storage_PUBLIC'
    WHEN v ~ '^https?://' AND v ~ '/storage/v1/object/sign/'   THEN 'absolute_storage_signed'
    WHEN v ~ '^https?://' AND v ~ '/storage/v1/'               THEN 'absolute_storage_other'
    WHEN v ~ '^https?://' AND v ~ '/api/media/file/'           THEN 'absolute_relay'
    WHEN v ~ '^https?://'                                      THEN 'absolute_OTHER_HOST'
    WHEN v LIKE '/api/media/file/%'                            THEN 'app_relative_relay'
    WHEN v LIKE '/%'                                           THEN 'app_relative_other'
    WHEN v ~ '^(post-media|profile-media)/'                    THEN 'bare_key_known_bucket'
    WHEN v ~ '^[A-Za-z0-9._-]+/'                               THEN 'bare_key_other_prefix'
    ELSE 'other'
  END`;

/**
 * Five statements, one per durable column. Kept separate rather than UNIONed
 * into one so that a column that does not exist live fails on its own and the
 * other four still report — a single UNION would lose the whole census to one
 * missing column, and `post_media.feed_url` (0208) is exactly the column whose
 * live existence is worth learning from this run.
 */
const STATEMENTS: Array<{ label: string; sql: string }> = [
  {
    label: "events.cover_url",
    sql: `SELECT 'events.cover_url' AS col, ${SHAPE_CASE} AS url_shape, count(*)::text AS n
          FROM (SELECT cover_url AS v FROM events) t GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    label: "trips.cover_url",
    sql: `SELECT 'trips.cover_url' AS col, ${SHAPE_CASE} AS url_shape, count(*)::text AS n
          FROM (SELECT cover_url AS v FROM trips) t GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    label: "post_media.public_url",
    sql: `SELECT 'post_media.public_url' AS col, ${SHAPE_CASE} AS url_shape, count(*)::text AS n
          FROM (SELECT public_url AS v FROM post_media) t GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    label: "post_media.feed_url",
    sql: `SELECT 'post_media.feed_url' AS col, ${SHAPE_CASE} AS url_shape, count(*)::text AS n
          FROM (SELECT feed_url AS v FROM post_media) t GROUP BY 1,2 ORDER BY 3 DESC`,
  },
  {
    // text[] — one row per ELEMENT, so the count is elements, not posts.
    label: "posts.media_urls (per element)",
    sql: `SELECT 'posts.media_urls[elem]' AS col, ${SHAPE_CASE} AS url_shape, count(*)::text AS n
          FROM (SELECT unnest(COALESCE(media_urls, '{}')) AS v FROM posts) t GROUP BY 1,2 ORDER BY 3 DESC`,
  },
];

function abort(headline: string, detail: string, code: number): never {
  console.error(`✖ auditMediaUrlShapes: ${headline}`);
  console.error(detail);
  process.exit(code);
}

function requireTransport(): { mgmtUrl: string; accessToken: string } {
  const token =
    process.env.SUPABASE_PROJECT_TOKEN?.trim() ||
    process.env.SUPABASE_ACCESS_TOKEN?.trim() ||
    "";
  if (!token) {
    abort(
      "no Management API token, so nothing was measured",
      "       Set SUPABASE_PROJECT_TOKEN (preferred, project-scoped) or\n" +
        "       SUPABASE_ACCESS_TOKEN. See docs/eas-runbook.md:310-325.",
      EXIT_CANNOT_RUN,
    );
  }
  const url = process.env.SUPABASE_URL?.trim() ?? "";
  if (!url) {
    abort("SUPABASE_URL is not set, so nothing was measured", "       Expected https://<project-ref>.supabase.co", EXIT_CANNOT_RUN);
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch (e) {
    return abort(
      "SUPABASE_URL is not a parsable URL, so nothing was measured",
      `       ${e instanceof Error ? e.message : String(e)}`,
      EXIT_CANNOT_RUN,
    );
  }
  const projectRef = hostname.split(".")[0] ?? "";
  if (!projectRef) {
    abort("no project ref could be derived from SUPABASE_URL", `       hostname '${hostname}' yielded no leading label.`, EXIT_CANNOT_RUN);
  }
  return {
    mgmtUrl: `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    accessToken: token,
  };
}

/** Run one read-only SELECT through the Management API. */
async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const { mgmtUrl, accessToken } = requireTransport();
  const res = await fetch(mgmtUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 600)}`);
  try {
    return JSON.parse(text) as T[];
  } catch {
    throw new Error(`Management API returned a body that is not JSON: ${text.slice(0, 600)}`);
  }
}

async function main(): Promise<void> {
  const projectRef = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
  console.log(`auditMediaUrlShapes — project ref: ${projectRef}`);
  console.log("RECORD THIS REF alongside the result; a [DB] tag without it is void.\n");

  let anyFailed = false;
  let absolutePublicTotal = 0;

  for (const { label, sql } of STATEMENTS) {
    let rows: Array<{ col: string; url_shape: string; n: string }>;
    try {
      rows = await liveQuery(sql);
    } catch (e) {
      // A missing column is information, not a reason to lose the other four.
      console.log(`── ${label}`);
      console.log(`   UNREADABLE: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}\n`);
      anyFailed = true;
      continue;
    }
    console.log(`── ${label}`);
    if (rows.length === 0) {
      console.log("   (no rows)\n");
      continue;
    }
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      if (!Number.isFinite(n)) throw new Error(`${label}: non-numeric count ${JSON.stringify(r.n)}`);
      total += n;
      if (r.url_shape === "absolute_storage_PUBLIC") absolutePublicTotal += n;
      console.log(`   ${r.url_shape.padEnd(26)} ${String(n).padStart(9)}`);
    }
    console.log(`   ${"TOTAL".padEnd(26)} ${String(total).padStart(9)}\n`);
  }

  console.log("─".repeat(60));
  console.log(`absolute_storage_PUBLIC across all columns: ${absolutePublicTotal}`);
  console.log(
    absolutePublicTotal > 0
      ? "→ Durable rows depend on the public URL shape. Converting the two writers is\n" +
          "  NECESSARY BUT NOT SUFFICIENT: the consolidation also needs a backfill or a\n" +
          "  read-time rewrite for these rows. Note the app hydrator rescues them on\n" +
          "  authenticated surfaces only — routes/og.ts, routes/featured.ts and\n" +
          "  routes/placeLiving.ts do not hydrate."
      : "→ No durable public-URL rows. Converting the two writers is the whole job.",
  );
  if (anyFailed) {
    console.log("\n⚠ At least one column was UNREADABLE (see above). The totals above are\n" +
      "  therefore a LOWER BOUND, not a census. Do not record them as complete.");
  }
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error("✖ auditMediaUrlShapes failed:", e instanceof Error ? e.message : String(e));
  process.exit(EXIT_CANNOT_RUN);
});
