/**
 * checkMediaUrlsExternalOnly — posts.media_urls holds EXTERNAL references only.
 * STRICTLY READ-ONLY.
 *
 * WHAT THIS ENFORCES
 * ==================
 *
 * As of 2026-08-12 the two media stores have separate, documented jobs:
 *
 *   post_media        canonical for STORAGE-BACKED media — anything in one of
 *                     this app's own buckets. Carries bucket, path, dimensions,
 *                     mime type, moderation and processing state, sort order.
 *   posts.media_urls  EXTERNAL references only — editorial posts pointing at
 *                     imagery hosted somewhere else.
 *
 * That split is a product ruling, not a cleanup that happens to have finished.
 * A ruling with nothing enforcing it decays back into the state it replaced,
 * and this repository has now watched that happen twice in one week: a flag
 * population that was clean only because the scanner could not see it, and a
 * "six rows" figure that was really the six in the five columns one script
 * happened to scan.
 *
 * So the narrowed role is checked rather than trusted. A storage-backed value
 * appearing in posts.media_urls fails this check, whatever wrote it.
 *
 * WHY BOTH SHAPES ARE REJECTED
 * ============================
 *
 * A storage-backed value can be spelled two ways, and both must fail:
 *
 *   post-media/<path>                                  the canonical bare key
 *   https://<ref>.supabase.co/storage/v1/object/public/post-media/<path>
 *                                                      the pre-2081 absolute form
 *
 * Accepting the absolute form because "it doesn't look like a bucket path"
 * would let the exact regression this line of work has been unwinding walk back
 * in through the older spelling.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ================================
 *
 * It does not check that external references RESOLVE. An editorial post may
 * point at a host that is slow, rate-limited, or gone, and that is a content
 * problem with its own remedy — not a reason to fail a structural check. This
 * script answers exactly one question: is anything storage-backed sitting in
 * the column that is no longer supposed to hold it.
 *
 * Run: pnpm --filter @workspace/api-server run check:media-urls-external-only
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_CANNOT_RUN = 2;

/**
 * Both spellings of a storage-backed value, for the two buckets this app owns.
 * `stamp-artwork` is deliberately absent: it is a genuinely public bucket whose
 * absolute URLs are correct, and it is not a valid posts.media_urls value in
 * either shape for a different reason — it is in neither ALLOWED_BUCKETS nor
 * APP_MEDIA_BUCKETS, so it would already fail validation on the way in.
 */
const VIOLATION_SQL = `
  SELECT p.id::text AS post_id,
         u          AS value,
         CASE
           WHEN u ~ '^(post-media|profile-media)/' THEN 'bare_key'
           ELSE 'absolute_public_url'
         END AS shape
    FROM posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u
   WHERE u ~ '^(post-media|profile-media)/'
      OR u ~ '/storage/v1/object/public/(post-media|profile-media)/'
   ORDER BY 1
   LIMIT 200`;

/** Total element count, so a zero-violation result can be distinguished from an empty column. */
const POPULATION_SQL = `
  SELECT count(*)::text AS n
    FROM posts p, LATERAL unnest(COALESCE(p.media_urls, '{}')) u`;

function abort(headline: string, detail: string, code: number): never {
  console.error(`✖ checkMediaUrlsExternalOnly: ${headline}`);
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
      "       Set SUPABASE_PROJECT_TOKEN (preferred, project-scoped) or SUPABASE_ACCESS_TOKEN.",
      EXIT_CANNOT_RUN,
    );
  }
  const url = process.env.SUPABASE_URL?.trim() ?? "";
  if (!url) abort("SUPABASE_URL is not set, so nothing was measured", "       Expected https://<project-ref>.supabase.co", EXIT_CANNOT_RUN);
  let ref: string;
  try {
    ref = new URL(url).hostname.split(".")[0] ?? "";
  } catch (e) {
    return abort("SUPABASE_URL is not a parsable URL", `       ${e instanceof Error ? e.message : String(e)}`, EXIT_CANNOT_RUN);
  }
  if (!ref) abort("no project ref could be derived from SUPABASE_URL", `       from '${url}'`, EXIT_CANNOT_RUN);
  return { mgmtUrl: `https://api.supabase.com/v1/projects/${ref}/database/query`, accessToken: token };
}

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const { mgmtUrl, accessToken } = requireTransport();
  const res = await fetch(mgmtUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text) as T[];
  } catch {
    throw new Error(`Management API returned a body that is not JSON: ${text.slice(0, 400)}`);
  }
}

async function main(): Promise<void> {
  const ref = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
  console.log(`checkMediaUrlsExternalOnly — project ref: ${ref}\n`);

  let population: number;
  try {
    const rows = await liveQuery<{ n: string }>(POPULATION_SQL);
    population = Number(rows[0]?.n ?? "0");
  } catch (e) {
    abort("could not read posts.media_urls", `       ${e instanceof Error ? e.message : String(e)}`, EXIT_CANNOT_RUN);
  }

  let violations: Array<{ post_id: string; value: string; shape: string }>;
  try {
    violations = await liveQuery(VIOLATION_SQL);
  } catch (e) {
    abort("violation query failed", `       ${e instanceof Error ? e.message : String(e)}`, EXIT_CANNOT_RUN);
  }

  console.log(`posts.media_urls holds ${population} element(s) in total.`);

  if (violations.length > 0) {
    console.error(`\n✖ ${violations.length} storage-backed value(s) in posts.media_urls:\n`);
    for (const v of violations) {
      console.error(`   ${v.post_id}  [${v.shape}]  ${v.value}`);
    }
    console.error(
      "\n  posts.media_urls is EXTERNAL REFERENCES ONLY as of 2026-08-12 " +
        "(2083_backfill_storage_backed_post_media.sql).\n" +
        "  Storage-backed media belongs in post_media, which carries the bucket, path,\n" +
        "  moderation state and sort order the array column cannot.\n\n" +
        "  Whatever wrote these needs fixing — not this check. If the ruling itself has\n" +
        "  changed, change it here deliberately and say why, rather than widening the\n" +
        "  pattern until the check passes.",
    );
    process.exit(EXIT_VIOLATION);
  }

  console.log("\n✓ No storage-backed values in posts.media_urls.");
  if (population === 0) {
    console.log(
      "  ⚠ The column is EMPTY, so this run proved nothing about the rule — it only\n" +
        "    proved there is nothing to violate it. On a seeded database expect a\n" +
        "    non-zero population of external references.",
    );
  }
  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error("✖ checkMediaUrlsExternalOnly: unexpected failure");
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(EXIT_CANNOT_RUN);
});
