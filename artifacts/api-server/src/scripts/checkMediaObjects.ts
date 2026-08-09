/**
 * checkMediaObjects — reconcile post_media rows against actual Storage objects.
 *
 * WHY THIS EXISTS
 * ---------------
 * `post_media.processing_status` records what the pipeline BELIEVED happened,
 * never what is actually in the bucket. On 2026-08-09 all 116 rows read
 * `processing_status = 'ready'` while 114 of them pointed at objects that do
 * not exist. Every one sat on a `published`/`public` post with `public_url`
 * populated, so clients rendered them and got a broken image, and nothing
 * anywhere flagged it. The status column was not wrong about its own step —
 * it simply cannot see the bucket, and that blindness is what hid this for
 * three weeks.
 *
 * This check closes the loop by comparing the two directly:
 *
 *   DANGLING ROW    a post_media row whose storage object is absent
 *                   → users see a broken image
 *   ORPHAN OBJECT   a Storage object no row references
 *                   → wasted storage, and content believed deleted that is
 *                     still fetchable by URL
 *
 * Both are reported; only dangling rows fail the check, because only they are
 * user-visible. Orphans are printed as a count so a sweep can be scheduled
 * deliberately rather than triggered by a red build.
 *
 * REQUIRES LIVE CREDENTIALS — it reads `storage.objects`, which no snapshot
 * captures. Same env contract as checkMissingLiveColumns.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:media-objects
 *
 * Exit 0 → every post_media row has its object
 * Exit 1 → at least one dangling row
 * Exit 2 → credentials missing (cannot tell; deliberately not "pass")
 */

// Marks this file as a MODULE rather than a global script. Without it, every
// top-level `const` here shares one scope with every other import-less script
// under src/scripts/, and two of them declaring `ACCESS_TOKEN` is a typecheck
// error in whichever landed second — a collision this file caused on first
// write, against checkRankEventsSurfaces.ts.
export {};

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).\n" +
      "       Exiting 2 rather than 0: an unrunnable check must not read as a passing one.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

interface DanglingRow {
  id: string;
  user_id: string | null;
  post_id: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  processing_status: string | null;
  post_status: string | null;
  visibility: string | null;
}

const dangling = await liveQuery<DanglingRow>(`
  select pm.id, pm.user_id, pm.post_id, pm.storage_bucket, pm.storage_path,
         pm.processing_status, po.post_status, po.visibility
    from post_media pm
    left join posts po on po.id = pm.post_id
   where pm.storage_path is not null
     and not exists (
       select 1 from storage.objects o
        where o.bucket_id = coalesce(pm.storage_bucket, 'post-media')
          and o.name = pm.storage_path
     )
   order by pm.created_at
`);

const [orphanRow] = await liveQuery<{ orphans: string }>(`
  select count(*) as orphans
    from storage.objects o
   where o.bucket_id = 'post-media'
     and not exists (
       select 1 from post_media pm
        where pm.storage_path = o.name
     )
`);
const orphanCount = Number(orphanRow?.orphans ?? 0);

if (dangling.length === 0) {
  console.log(
    `✅ check-media-objects: every post_media row has its Storage object` +
      (orphanCount > 0
        ? `\n   (note: ${orphanCount} orphan object(s) in post-media reference no row — not a failure, but they are wasted storage and remain fetchable)`
        : ""),
  );
  process.exit(0);
}

// A dangling row is only user-VISIBLE when its post is live. Split the report
// so an operator can tell "someone is looking at a broken image right now" from
// "a draft references a missing file".
const visible = dangling.filter(
  (d) => d.post_status === "published" && d.visibility === "public",
);

console.error(
  `\n❌ check-media-objects: ${dangling.length} post_media row(s) point at a Storage object that does not exist.\n` +
    `   ${visible.length} of them sit on a published, public post — those render as broken images right now.\n`,
);

const shown = dangling.slice(0, 20);
for (const d of shown) {
  const live = d.post_status === "published" && d.visibility === "public" ? "VISIBLE" : "hidden ";
  console.error(
    `   [${live}] media=${d.id} user=${d.user_id ?? "?"} status=${d.processing_status ?? "?"} path=${d.storage_bucket ?? "post-media"}/${d.storage_path}`,
  );
}
if (dangling.length > shown.length) {
  console.error(`   … and ${dangling.length - shown.length} more (not truncated silently — this is the full count above)`);
}

console.error(`
processing_status says these are fine; it only records what the pipeline
believed, and cannot see the bucket. Do not "fix" this by trusting the column.

Decide per row:
  - object recoverable  → restore it, leave the row alone
  - object never existed → the row is the artefact; remove it or mark it so the
                           client stops rendering a broken image
`);

if (orphanCount > 0) {
  console.error(`Separately: ${orphanCount} orphan object(s) in post-media reference no row.\n`);
}

process.exit(1);
