/**
 * auditPostMediaIntegrity — where does a post's media actually live?
 *
 * WHY THIS EXISTS
 * ---------------
 * Three different defects share one symptom — a blank/fallback tile — and
 * folding them together produces a fix for the wrong one:
 *
 *   A. MUTATION ECHO      the response to a PATCH/publish carried the raw posts
 *                         row: media_urls stripped by 2083 and no `media` key.
 *                         Fixed in the #3585 PR. RESPONSE SHAPE ONLY — it
 *                         cannot affect a persisted row.
 *
 *   B. READ-PATH GAP      the row is fine (post_media rows exist) but some
 *                         surface reads only media_urls, which 2083 emptied.
 *                         Fix is in the reader.
 *
 *   C. ORPHANED COUNT     media_count > 0, media_urls empty, AND no post_media
 *                         row. The count claims media that exists nowhere. This
 *                         is a DATA INTEGRITY gap; no response-shape change
 *                         touches it.
 *
 * B and C are indistinguishable from the client — both render the designed
 * fallback — and indistinguishable from `media_count > 0 AND media_urls = '{}'`
 * alone, which is why that condition is not a diagnosis. The only thing that
 * separates them is whether post_media rows exist, which is what this reads.
 *
 * It also reports posts whose media_urls hold EXTERNAL references, because
 * "external media does not render" is a fourth, genuinely separate question and
 * must not be answered with B's or C's evidence.
 *
 * READ-ONLY. Two SELECTs over public.posts and public.post_media. It reports;
 * it repairs nothing — the remedy differs per bucket and each is a decision.
 *
 * USAGE
 *   npm run audit:post-media-integrity            — whole corpus
 *   npm run audit:post-media-integrity -- <id>…   — plus a focus list, always
 *                                                   printed even if clean
 *
 * EXIT CODES
 *   0  report produced (findings are reported, not failed — this is a census)
 *   2  environment / API error — cannot run
 *
 * See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error("ERROR: SUPABASE_URL and a Supabase token must be set.");
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

/** UUIDs passed after `--`. Validated so nothing unquoted reaches the SQL. */
const focusIds = process.argv.slice(2).filter((a) => /^[0-9a-fA-F-]{36}$/.test(a));

interface PostRow {
  id: string;
  author_id: string | null;
  media_count: number | null;
  url_count: number | null;
  external_count: number | null;
  storage_shaped_count: number | null;
  pm_total: number | null;
  pm_ready: number | null;
  post_status: string | null;
  status: string | null;
  visibility: string | null;
  url_shapes: string | null;
  media_urls_raw: string | null;
}

// One statement. `media_urls` element classification is done in SQL so the
// external-vs-storage split is computed from the same row the counts come from.
const SQL = `
  select p.id,
         p.author_id,
         p.media_count,
         coalesce(array_length(p.media_urls, 1), 0)                       as url_count,
         (select count(*) from unnest(coalesce(p.media_urls,'{}')) u
           where u ~ '^https?://'
             and u !~ '/storage/v1/object/public/(post-media|profile-media)/') as external_count,
         (select count(*) from unnest(coalesce(p.media_urls,'{}')) u
           where u ~ '^(post-media|profile-media)/'
              or u ~ '/storage/v1/object/public/(post-media|profile-media)/')  as storage_shaped_count,
         (select count(*) from post_media pm where pm.post_id = p.id)          as pm_total,
         (select count(*) from post_media pm where pm.post_id = p.id
            and pm.processing_status = 'ready'
            and coalesce(pm.moderation_status,'') not in ('rejected','flagged')) as pm_ready,
         p.post_status,
         p.status,
         p.visibility,
         (select string_agg(
                   case
                     when pm.public_url ~ '/storage/v1/object/public/' then 'ABSOLUTE-PUBLIC(dead: bucket is private)'
                     when pm.public_url ~ '/storage/v1/object/sign/'   then 'SIGNED'
                     when pm.public_url ~ '^https?://'                 then 'ABSOLUTE-OTHER'
                     when pm.public_url ~ '^(post-media|profile-media)/' then 'BARE-KEY'
                     when pm.public_url is null                        then 'NULL'
                     else 'OTHER'
                   end
                   || case when pm.thumbnail_url is null then ' thumb=NULL' else ' thumb=set' end
                   || ' bucket=' || coalesce(pm.storage_bucket,'NULL')
                   || ' storage_path='
                   || case
                        when pm.storage_path is null then 'NULL'
                        when pm.storage_path ~ '^(post-media|profile-media)/' then 'HAS-BUCKET-PREFIX'
                        else 'bare-path'
                      end
                   || ' path_owner='
                   || case
                        when pm.storage_path is null then 'n/a'
                        when split_part(pm.storage_path,'/',1) = p.author_id::text then 'MATCHES-AUTHOR'
                        else 'not-author(' || left(split_part(pm.storage_path,'/',1), 12) || ')'
                      end
                   || ' OBJECT='
                   || case
                        when pm.storage_path is null then 'n/a'
                        when exists (
                               select 1 from storage.objects o
                                where o.bucket_id = coalesce(pm.storage_bucket,'post-media')
                                  and o.name = pm.storage_path
                             ) then 'PRESENT'
                        else 'MISSING'
                      end,
                   ' | ' order by pm.sort_order)
            from post_media pm where pm.post_id = p.id)                            as url_shapes,
         array_to_string(coalesce(p.media_urls,'{}'), ' ~~ ')                       as media_urls_raw
    from posts p
   where p.media_count > 0
      or coalesce(array_length(p.media_urls, 1), 0) > 0
      or exists (select 1 from post_media pm where pm.post_id = p.id)
   order by p.created_at
`;

const rows = await liveQuery<PostRow>(SQL);

if (rows.length === 0) {
  console.error(
    "VACUOUS: no post carries media_count, media_urls or a post_media row. " +
      "Refusing to report 'no integrity gaps' against an empty subject.",
  );
  process.exit(2);
}

const n = (v: number | null | undefined) => Number(v ?? 0);

/** The bucket a row falls in. Deliberately exhaustive — no default 'ok'. */
function classify(r: PostRow): string {
  const count = n(r.media_count);
  const urls = n(r.url_count);
  const ready = n(r.pm_ready);
  const total = n(r.pm_total);
  const ext = n(r.external_count);

  if (count > 0 && urls === 0 && total === 0) return "C · ORPHANED COUNT";
  if (count > 0 && urls === 0 && ready > 0) return "B · READ-PATH (post_media present)";
  if (count > 0 && urls === 0 && total > 0 && ready === 0) return "C· post_media present but NONE ready";
  if (ext > 0 && total === 0) return "EXTERNAL-ONLY (the #3586 question)";
  if (ready > 0 || urls > 0) return "ok";
  return "UNCLASSIFIED — investigate";
}

const buckets = new Map<string, PostRow[]>();
for (const r of rows) {
  const b = classify(r);
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b)!.push(r);
}

const line = "═".repeat(78);
console.log(line);
console.log("POST MEDIA INTEGRITY CENSUS");
console.log(line);
console.log(`  posts carrying any media signal : ${rows.length}`);
for (const [b, list] of [...buckets.entries()].sort()) {
  console.log(`  ${b.padEnd(46)} ${list.length}`);
}

const show = (r: PostRow) =>
  `  ${r.id}  author=${(r.author_id ?? "—").slice(0, 8)}  ` +
  `media_count=${n(r.media_count)}  urls=${n(r.url_count)} ` +
  `(ext ${n(r.external_count)}, storage-shaped ${n(r.storage_shaped_count)})  ` +
  `post_media=${n(r.pm_total)} (ready ${n(r.pm_ready)})  ${r.post_status ?? "—"}/${r.status ?? "—"}/vis=${r.visibility ?? "—"}` +
  (r.url_shapes ? `\n      url shape: ${r.url_shapes}` : "") +
  (n(r.external_count) > 0 && r.media_urls_raw
    ? `\n      media_urls: ${r.media_urls_raw.split(" ~~ ").join("\n                  ")}`
    : "");

for (const [b, list] of [...buckets.entries()].sort()) {
  if (b === "ok") continue;
  console.log(`\n${line}\n${b} — ${list.length}\n${line}`);
  for (const r of list) console.log(show(r));
}

// ── passport_postcards linkage ───────────────────────────────────────────────
//
// The Passport -> Postcards tile reads `card.media`, which the endpoint builds
// by keying post_media on passport_postcards.post_id. If no postcard row links
// to the post, or its post_id is null, the tile gets media: [] and — with the
// legacy media_url also null — no URI at all, so NO image request fires. That
// is a different cause from "the tile reads the wrong field", and only this
// join separates them.
const linkage = await liveQuery<{
  post_id: string | null; pc_id: string | null; media_url_null: boolean | null;
  pc_status: string | null; pc_visibility: string | null; media_url_shape: string | null; media_url_origin: string | null;
}>(`
  select p.id as post_id,
         pc.id as pc_id,
         (pc.media_url is null) as media_url_null,
         case
           when pc.media_url is null then 'NULL'
           when pc.media_url ~ '/storage/v1/object/public/' then 'ABSOLUTE-PUBLIC(dead endpoint)'
           when pc.media_url ~ '/storage/v1/object/sign/'   then 'ABSOLUTE-SIGNED'
           when pc.media_url ~ '^(post-media|profile-media)/' then 'BARE-KEY'
           when pc.media_url ~ '^https?://'                 then 'ABSOLUTE-OTHER'
           else 'OTHER'
         end as media_url_shape,
         split_part(pc.media_url, '/storage/', 1) as media_url_origin,
         pc.status as pc_status,
         pc.visibility as pc_visibility
    from posts p
    left join passport_postcards pc on pc.post_id = p.id
   where p.media_count > 0
     and coalesce(array_length(p.media_urls, 1), 0) = 0
   order by p.created_at
`);

console.log(`\n${line}`);
console.log("PASSPORT_POSTCARDS LINKAGE — for posts with media_count>0 and empty media_urls");
console.log(line);
for (const l of linkage) {
  console.log(
    `  ${l.post_id}  postcard_row=${l.pc_id ? "PRESENT" : "ABSENT"}` +
      (l.pc_id
        ? `  media_url=${l.media_url_shape}  origin=${l.media_url_origin || "—"}  ${l.pc_status ?? "—"}/${l.pc_visibility ?? "—"}`
        : "  → tile would receive media: [] and no legacy mediaUrl"),
  );
}

// ── Postcard grid size ───────────────────────────────────────────────────────
//
// The media_sign endpoint rate-limits 60 REQUESTS per user per minute. Sign
// calls are per-tile, not one batch per grid (PostcardsTab hydrates per tile and
// CachedImage hydrates again inside), so the reachable request count is roughly
// 2x the number of tiles a passport renders. Whether a grid can cross 60 is an
// arithmetic question about grid size, and it decides whether the rate-limit
// explanation is even available.
const grids = await liveQuery<{ user_id: string; n: number }>(`
  select user_id, count(*)::int as n
    from passport_postcards
   where status = 'active'
   group by user_id
   order by count(*) desc
   limit 10
`);
console.log(`\n${line}`);
console.log("POSTCARD GRID SIZE — top users by active postcard count");
console.log(line);
console.log("  media_sign limit is 60 REQUESTS/user/minute; hydration is per-tile (~2 calls/tile).");
for (const g of grids) {
  const calls = n(g.n) * 2;
  console.log(
    `  user=${g.user_id.slice(0, 8)}  postcards=${String(n(g.n)).padStart(3)}  ` +
      `~sign calls=${String(calls).padStart(3)}  ${calls > 60 ? "CAN exceed 60/min" : "cannot reach 60/min"}`,
  );
}

if (focusIds.length > 0) {
  console.log(`\n${line}\nFOCUS — ${focusIds.length} id(s) named on the command line\n${line}`);
  for (const id of focusIds) {
    const r = rows.find((x) => x.id === id);
    if (!r) {
      // Not "clean" — a post carrying no media signal at all cannot be the one
      // rendering a media tile, and that is a finding, not an absence.
      console.log(`  ${id}  NOT FOUND among posts carrying any media signal`);
      continue;
    }
    console.log(`  bucket: ${classify(r)}`);
    console.log(show(r));
  }
}

console.log(`\n${line}`);
console.log("Census only. Nothing repaired — the remedy differs per bucket:");
console.log("  B  fix the reader; the row is intact.");
console.log("  C  the count claims media that exists nowhere; decide whether to");
console.log("     re-derive media_count or to recover the objects.");
console.log("  EXTERNAL-ONLY  a separate question from both.");
process.exit(0);
