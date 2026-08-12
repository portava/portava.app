/**
 * auditUnreferencedObjects — census of storage objects that NOTHING references.
 * STRICTLY READ-ONLY.
 *
 * Step 02 of the upload staging boundary. It reports; it deletes nothing. It is
 * also the dry-run mode the sweeper will use, which is what makes the sweeper's
 * first live run predictable instead of a discovery.
 *
 * WHY checkMediaObjects DOES NOT ALREADY ANSWER THIS
 * ==================================================
 *
 * checkMediaObjects walks `post_media` ROWS and asks whether each one's object
 * exists. That finds broken images. It cannot find the opposite failure — an
 * object with no row at all — except as a bare count it prints and does not
 * fail on. Its own header says it "simply cannot see the bucket".
 *
 * The invariant this serves runs the other way:
 *
 *   no client-controlled or abandoned upload can leave a permanently
 *   retrievable original that bypasses the canonical processing/privacy
 *   pipeline
 *
 * An abandoned upload is precisely an object that no row and no column
 * references. A row walk is structurally blind to it, so this walks the BUCKET
 * and joins outward to every column that could name an object.
 *
 * WHY THE REFERENCE SET IS DERIVED, NOT LISTED
 * ============================================
 *
 * "Unreferenced" is only as true as the list of places a reference can live. A
 * hand-written list of columns is how "the six absolute_storage_PUBLIC rows"
 * turned out to be "the six in the five columns one script happened to scan".
 * So the referencing columns are discovered from information_schema at run
 * time, exactly as auditMediaUrlShapes now does, and a column added tomorrow is
 * included the day it appears.
 *
 * Matching is deliberately GENEROUS: an object counts as referenced if any
 * column value equals its key, ends with its key, or contains it. A false
 * "referenced" merely keeps an object alive; a false "unreferenced" is what
 * would delete a real user's photo once the sweeper exists. The asymmetry is
 * the whole design, and it is why this reports a LOWER BOUND on the orphan set.
 *
 * WHAT IT DOES NOT DO
 * ===================
 *
 * It does not delete, quarantine, or move anything. It does not read object
 * bytes — only names, sizes and timestamps from storage.objects. It cannot tell
 * an abandoned upload from a real photo whose reference was lost by a bug; that
 * distinction does not exist in the data, and it is the reason the ruling on
 * the existing backlog is quarantine-then-sweep rather than sweep.
 *
 * Run: pnpm --filter @workspace/api-server run audit:unreferenced-objects
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";

const EXIT_OK = 0;
const EXIT_CANNOT_RUN = 2;

/** Buckets whose objects this census covers. */
const BUCKETS = ["post-media", "profile-media"];

const DISCOVERY_SQL = `
  SELECT table_name, column_name, data_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND (column_name LIKE '%url%' OR column_name LIKE '%_urls' OR column_name LIKE '%path%')
     AND data_type IN ('text', 'character varying', 'ARRAY')
   ORDER BY table_name, column_name`;

function abort(headline: string, detail: string, code: number): never {
  console.error(`✖ auditUnreferencedObjects: ${headline}`);
  console.error(detail);
  process.exit(code);
}

function requireTransport(): { mgmtUrl: string; accessToken: string } {
  const token =
    process.env.SUPABASE_PROJECT_TOKEN?.trim() || process.env.SUPABASE_ACCESS_TOKEN?.trim() || "";
  if (!token) abort("no Management API token, so nothing was measured", "       Set SUPABASE_PROJECT_TOKEN or SUPABASE_ACCESS_TOKEN.", EXIT_CANNOT_RUN);
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

function refsUnion(cols: Array<{ table_name: string; column_name: string; data_type: string }>): string {
  return cols
    .map((c) => {
      const src =
        c.data_type === "ARRAY"
          ? `unnest(COALESCE("${c.column_name}", '{}'))`
          : `"${c.column_name}"`;
      return `SELECT ${src} AS v FROM public."${c.table_name}"`;
    })
    .join(" UNION ALL ");
}

async function main(): Promise<void> {
  const ref = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
  console.log(`auditUnreferencedObjects — project ref: ${ref}`);
  console.log("RECORD THIS REF alongside the result; a [DB] tag without it is void.\n");

  let cols: Array<{ table_name: string; column_name: string; data_type: string }>;
  try {
    cols = await liveQuery(DISCOVERY_SQL);
  } catch (e) {
    abort("column discovery failed, so nothing was measured", `       ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`, EXIT_CANNOT_RUN);
  }
  if (cols.length === 0) {
    abort(
      "column discovery returned zero candidate reference columns",
      "       Not credible for this schema. A census whose reference set is empty\n" +
        "       reports EVERY object as an orphan, which is the most destructive\n" +
        "       possible wrong answer for the sweeper that consumes it.",
      EXIT_CANNOT_RUN,
    );
  }
  console.log(`Reference set: ${cols.length} column(s) discovered from information_schema.`);

  const bucketList = BUCKETS.map((b) => `'${b}'`).join(",");
  const sql = `
    WITH refs AS (${refsUnion(cols)}),
    obj AS (
      SELECT bucket_id, name,
             COALESCE((metadata->>'size')::bigint, 0) AS bytes,
             created_at
        FROM storage.objects
       WHERE bucket_id IN (${bucketList})
    )
    SELECT o.bucket_id, o.name, o.bytes::text AS bytes, o.created_at::date::text AS created,
           (EXISTS (
              SELECT 1 FROM refs r
               WHERE r.v IS NOT NULL AND btrim(r.v) <> ''
                 AND (r.v = o.name OR r.v LIKE '%' || o.name OR r.v LIKE '%' || o.name || '%')
           )) AS referenced
      FROM obj o
     ORDER BY o.created_at`;

  let rows: Array<{ bucket_id: string; name: string; bytes: string; created: string; referenced: boolean }>;
  try {
    rows = await liveQuery(sql);
  } catch (e) {
    abort("census query failed", `       ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`, EXIT_CANNOT_RUN);
  }

  if (rows.length === 0) {
    console.log("\n⚠ Zero objects in the covered buckets. This run proved nothing about the rule —");
    console.log("  it only proved there is nothing to be orphaned. Expect a non-zero population");
    console.log("  on a seeded database.");
    process.exit(EXIT_OK);
  }

  const orphans = rows.filter((r) => !r.referenced);
  const bytes = orphans.reduce((a, r) => a + Number(r.bytes || 0), 0);

  console.log(`\nObjects scanned: ${rows.length}`);
  console.log(`Referenced:      ${rows.length - orphans.length}`);
  console.log(`UNREFERENCED:    ${orphans.length}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  if (orphans.length > 0) {
    const oldest = orphans[0];
    console.log(`Oldest orphan:   ${oldest.created}  ${oldest.bucket_id}/${oldest.name}`);
    console.log("\n  bucket/name                                                    bytes  created");
    for (const o of orphans.slice(0, 100)) {
      console.log(`  ${`${o.bucket_id}/${o.name}`.padEnd(60).slice(0, 60)} ${String(o.bytes).padStart(9)}  ${o.created}`);
    }
    if (orphans.length > 100) console.log(`  … and ${orphans.length - 100} more`);

    console.log(
      "\n→ These objects are referenced by no column in the discovered set. They are\n" +
        "  unreachable through any product surface and undeletable through any product\n" +
        "  action, which is the 'abandoned upload' half of the staging-boundary invariant.\n" +
        "\n  This is a LOWER BOUND. Matching is deliberately generous, so an object listed\n" +
        "  here is very likely orphaned, while an object NOT listed may still be. That\n" +
        "  asymmetry is intentional: a false 'unreferenced' is what deletes a real photo.\n" +
        "\n  NOTHING HERE DISTINGUISHES an abandoned upload from a real photo whose\n" +
        "  reference was lost by a bug. That distinction does not exist in the data, and\n" +
        "  it is why the ruled disposition for the existing backlog is quarantine-then-\n" +
        "  sweep rather than sweep.",
    );
  } else {
    console.log("\n✓ Every object in the covered buckets is referenced.");
  }

  process.exit(EXIT_OK);
}

main().catch((e) => {
  console.error("✖ auditUnreferencedObjects: unexpected failure");
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(EXIT_CANNOT_RUN);
});
