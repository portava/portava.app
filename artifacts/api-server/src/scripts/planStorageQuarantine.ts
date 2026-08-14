/**
 * planStorageQuarantine — the D5 quarantine plan, and the sweep-eligibility check.
 *
 * READ-ONLY. It moves nothing, deletes nothing, and has no --apply flag.
 *
 * WHY IT HAS NO --apply FLAG
 * ==========================
 * This repository has exactly two sanctioned doors to a live Supabase project:
 * the STRICT guard (sanctioned CI project only, refuses production) and the
 * READ-ONLY AUDIT door (production, reads only, opened by typing a sentence).
 * There is no third door, and quarantining 34 real user objects in production is
 * not a thing to invent one for.
 *
 * So this produces the PLAN — the exact source→destination move list and the
 * manifest that makes it reversible — and execution against production is a
 * separate, deliberate, owner-authorized step against a concrete artifact, the
 * same shape as the 2089 policy apply. The plan is the thing that gets reviewed;
 * the move is mechanical once it is approved.
 *
 * WHAT QUARANTINE MEANS HERE
 * ==========================
 * D5=B (docs/media/staging-boundary-decisions.md): quarantine first, sweep after
 * a defined window. The window is 90 days (docs/ops/retention-policy.md).
 *
 * Quarantine MOVES an orphan inside its own bucket:
 *
 *     <bucket>/<key>  →  <bucket>/_quarantine/<YYYY-MM-DD>/<key>
 *
 * It does not delete and it does not leave the bucket, so a restore is a move
 * back to the key the manifest records.
 *
 * THE DATE IS IN THE KEY DELIBERATELY. Sweep eligibility is then legible from
 * the object's own name and does not depend on a database the sweeper might not
 * be able to reach, or on a timestamp column someone could backfill. An object
 * cannot become eligible early without being renamed, which is a visible act.
 *
 * WHY THE CENSUS IS RE-RUN RATHER THAN TAKING A LIST
 * ==================================================
 * The packet recorded 28 orphans on 2026-08-12. On 2026-08-14 there are 34.
 * A quarantine plan built from a stale list would move objects that are no
 * longer orphaned — which is to say, it would break live references. So the
 * census is re-derived here, every time, and the plan is only ever as old as the
 * run that produced it.
 *
 * The census reports a LOWER BOUND: matching is generous, so an object listed as
 * unreferenced is very likely orphaned while an object not listed may still be.
 * Nothing in the data distinguishes an abandoned upload from a real photo whose
 * reference was lost to a bug — which is exactly why the ruling is
 * quarantine-then-sweep and not sweep.
 *
 * MODES
 *   plan   (default)  re-run the census, emit the move list + manifest
 *   sweep             list quarantined objects and say which are ELIGIBLE
 *
 * EXIT CODES
 *   0  plan produced / sweep check completed
 *   1  refused — see the message
 *   2  environment / API error
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error("ERROR: SUPABASE_URL and a Supabase token must be set.");
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

/** The window, in days. Single source of truth for both tools. */
const WINDOW_DAYS = 90;
const QUARANTINE_PREFIX = "_quarantine";

/**
 * The stamp date for this plan.
 *
 * Passed in rather than read from the clock, so a plan is reproducible: running
 * the planner twice on the same day yields byte-identical destinations, and a
 * plan reviewed yesterday cannot silently retarget today. Defaults to today only
 * when not supplied.
 */
const args = process.argv.slice(2);
const mode = args.includes("sweep") ? "sweep" : "plan";
const dateIdx = args.indexOf("--date");
const STAMP =
  dateIdx >= 0 && args[dateIdx + 1]
    ? args[dateIdx + 1]!
    : new Date().toISOString().slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(STAMP)) {
  console.error(`ERROR: --date must be YYYY-MM-DD, got ${STAMP}`);
  process.exit(2);
}

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

interface ObjRow {
  bucket_id: string;
  name: string;
  size: number | null;
  created_at: string;
}

/**
 * Re-derive the referencing column set from information_schema, exactly as
 * auditUnreferencedObjects does, so a column added tomorrow is included the day
 * it appears rather than the day someone remembers to add it here.
 */
async function referencingColumns(): Promise<Array<{ t: string; c: string }>> {
  return liveQuery<{ t: string; c: string }>(`
    select table_name as t, column_name as c
      from information_schema.columns
     where table_schema = 'public'
       and data_type in ('text','character varying')
       and (column_name like '%url%' or column_name like '%path%'
            or column_name like '%image%' or column_name like '%photo%'
            or column_name like '%media%' or column_name like '%avatar%'
            or column_name like '%cover%' or column_name like '%thumbnail%')
     order by 1,2
  `);
}

console.log("═".repeat(74));
console.log(`STORAGE QUARANTINE — ${mode.toUpperCase()} — project ${projectRef}`);
console.log("═".repeat(74));

// ── sweep mode ──────────────────────────────────────────────────────────────
if (mode === "sweep") {
  const quarantined = await liveQuery<ObjRow>(`
    select bucket_id, name, (metadata->>'size')::bigint as size, created_at::text
      from storage.objects
     where name like '${QUARANTINE_PREFIX}/%'
     order by name
  `);

  if (quarantined.length === 0) {
    console.log(
      `\n  Nothing under ${QUARANTINE_PREFIX}/ in any bucket.\n\n` +
        `  Either the quarantine has not been executed yet, or it has already been\n` +
        `  swept. Those are different states and this tool cannot tell them apart —\n` +
        `  check the manifest in docs/ops/artifacts/ before concluding either.\n`,
    );
    process.exit(0);
  }

  const today = new Date(STAMP + "T00:00:00Z").getTime();
  let eligible = 0;

  console.log(`\n  Window: ${WINDOW_DAYS} days. Evaluated as of ${STAMP}.\n`);
  for (const o of quarantined) {
    const m = o.name.match(new RegExp(`^${QUARANTINE_PREFIX}/(\\d{4}-\\d{2}-\\d{2})/`));
    if (!m) {
      console.log(`  ??  ${o.bucket_id}/${o.name}`);
      console.log(
        `      NO DATE IN KEY — cannot compute eligibility. Not eligible. An object\n` +
          `      under the quarantine prefix without a date stamp was not placed there\n` +
          `      by this tooling; find out what put it there before touching it.`,
      );
      continue;
    }
    const placed = new Date(m[1]! + "T00:00:00Z").getTime();
    const ageDays = Math.floor((today - placed) / 86_400_000);
    const ok = ageDays >= WINDOW_DAYS;
    if (ok) eligible++;
    console.log(
      `  ${ok ? "ELIGIBLE" : "held    "}  ${o.bucket_id}/${o.name}  (${ageDays}d of ${WINDOW_DAYS})`,
    );
  }

  console.log(
    `\n  ${eligible} of ${quarantined.length} object(s) past the window.\n\n` +
      `  ELIGIBLE MEANS "THE WINDOW HAS PASSED", NOT "DELETE IT". Deletion at window\n` +
      `  end is a decision taken by a person against the agenda in\n` +
      `  docs/ops/retention-policy.md, never an automatic job. This tool deletes\n` +
      `  nothing and has no flag that would make it.\n`,
  );
  process.exit(0);
}

// ── plan mode ───────────────────────────────────────────────────────────────
const cols = await referencingColumns();
const objects = await liveQuery<ObjRow>(`
  select bucket_id, name, (metadata->>'size')::bigint as size, created_at::text
    from storage.objects
   where bucket_id in ('post-media','profile-media')
     and name not like '${QUARANTINE_PREFIX}/%'
   order by created_at
`);

// Generous matching, same asymmetry as the census: equals, ends-with, or
// contains. A false "referenced" keeps an object alive; a false "unreferenced"
// is what moves a real user's photo.
const refUnion = cols
  .map((c) => `select ${c.c}::text as v from public.${c.t} where ${c.c} is not null`)
  .join(" union all ");
const refs = refUnion
  ? await liveQuery<{ v: string }>(`select distinct v from (${refUnion}) u where v <> ''`)
  : [];
const refValues = refs.map((r) => r.v);

const orphans = objects.filter((o) => {
  const key = `${o.bucket_id}/${o.name}`;
  return !refValues.some(
    (v) => v === key || v === o.name || v.endsWith(key) || v.endsWith(o.name) || v.includes(key),
  );
});

const moves = orphans.map((o) => ({
  bucket: o.bucket_id,
  from: o.name,
  to: `${QUARANTINE_PREFIX}/${STAMP}/${o.name}`,
  bytes: Number(o.size ?? 0),
  createdAt: o.created_at,
}));

const totalBytes = moves.reduce((n, m) => n + m.bytes, 0);

console.log(`\n  Referencing columns discovered : ${cols.length}`);
console.log(`  Objects walked                 : ${objects.length}`);
console.log(`  Referenced                     : ${objects.length - orphans.length}`);
console.log(`  ORPHANED (to quarantine)       : ${orphans.length}  (${(totalBytes / 1e6).toFixed(1)} MB)`);
console.log(`\n  Destination prefix: ${QUARANTINE_PREFIX}/${STAMP}/\n`);

for (const m of moves) {
  console.log(`    ${m.bucket}/${m.from}`);
  console.log(`      → ${m.bucket}/${m.to}`);
}

const outPath = resolve("../../docs/ops/artifacts/storage-quarantine-plan.json");
const manifest = {
  kind: "storage-quarantine-plan",
  version: 1,
  projectRef,
  stampDate: STAMP,
  windowDays: WINDOW_DAYS,
  quarantinePrefix: QUARANTINE_PREFIX,
  orphanCount: moves.length,
  totalBytes,
  referencingColumnCount: cols.length,
  moves,
  restoreNote:
    "To restore an object, move it from `to` back to `from` within the same bucket. This " +
    "manifest is the ONLY record of the original key — the quarantine prefix rewrites it, and " +
    "the object's own metadata does not carry where it came from. Losing this file makes the " +
    "quarantine irreversible in practice even though nothing was deleted.",
  executionNote:
    "This is a PLAN. Nothing has been moved. Execution against production is a separate, " +
    "owner-authorized step; this repository has no sanctioned production-write door and this " +
    "tool deliberately does not invent one.",
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`\n${"═".repeat(74)}`);
console.log(`Plan written: ${outPath}`);
console.log(
  `\n  NOTHING HAS BEEN MOVED. This is a plan and a manifest.\n\n` +
    `  The manifest is the only record of each object's original key — quarantine\n` +
    `  rewrites the key, and the object carries no memory of where it came from.\n` +
    `  Losing it makes the quarantine irreversible in practice even though nothing\n` +
    `  was deleted. It belongs in git before any move happens, not after.\n`,
);
process.exit(0);
