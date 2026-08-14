/**
 * snapshotOrphanRows — the complete restore source for the orphan-row backlog.
 *
 * WHAT AN ORPHAN ROW IS HERE
 * ==========================
 * Four tables reference `posts` POLYMORPHICALLY — a type column plus a loosely
 * typed id column — and none of them has a foreign key. When a post is deleted
 * nothing cascades and nothing warns, so rows survive pointing at an id that no
 * longer resolves.
 *
 *   content_stamps                 entity_type  + entity_id  (uuid)
 *   rank_events                    content_type + item_id    (text)
 *   compass_recommendation_scores  item_type    + item_id    (text)
 *   trip_plan_items                source_type  + source_id  (text)
 *
 * THE TYPE COLUMN IS LOAD-BEARING AND IS THE EASIEST THING TO GET WRONG.
 * Counting `WHERE id NOT IN (SELECT id FROM posts)` without filtering on the
 * type column counts every row that legitimately points at a place, an event, a
 * buddy or a trip. docs/migrations.md records exactly that mistake being made
 * and corrected once already ("a measurement artifact of the query that produced
 * it"). Measured here on 2026-08-14, unfiltered vs filtered on the same tables:
 *
 *   rank_events                    192,994 unfiltered → 86,476 content_type='post'
 *   compass_recommendation_scores   10,863 unfiltered →      99 item_type='post'
 *
 * So every query below states its type filter, and the output records both the
 * filtered count and the type distribution, so the next reader can see what was
 * excluded rather than trusting that something was.
 *
 * WHY A SNAPSHOT AND NOT A DELETE
 * ===============================
 * The retention ruling (docs/ops/retention-policy.md) is a 90-day
 * retention/restore window with NO automatic deletion of any of these rows.
 * Deletion at window end is a scheduled DECISION, not a job. This script
 * produces the artifact that makes such a decision reversible: if rows are ever
 * removed, this file is what puts them back, byte for byte.
 *
 * DETERMINISTIC RESTORATION IS THE POINT, so where rows are captured they are
 * captured WHOLE (`to_jsonb(t)`), not as ids. An id list is not a restore source
 * — it cannot recreate a row, and by the time anyone needs it the row is gone.
 *
 * Populations ruled out of deletion are CENSUSED rather than captured; see
 * `captureRows` below for why that is a proportionality judgement and not a
 * shortcut.
 *
 * STRICTLY READ-ONLY against the database. It writes one local artifact file.
 *
 * EXIT CODES
 *   0  snapshot written
 *   1  a population could not be captured
 *   2  environment / API error
 *
 * USAGE
 *   pnpm run snapshot:orphan-rows            # writes to docs/ops/artifacts/
 *   pnpm run snapshot:orphan-rows -- --out X # explicit path
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

/**
 * One orphan population.
 *
 * `typeFilter` is mandatory and there is no default. A population without a
 * stated type filter is a population whose count means nothing, and making the
 * field optional is how that mistake gets made a third time.
 */
interface Population {
  table: string;
  typeColumn: string;
  typeFilter: string;
  idColumn: string;
  /** SQL predicate identifying a dangling reference. */
  danglingPredicate: string;
  /**
   * Capture FULL ROWS, or census only?
   *
   * A snapshot exists to make a deletion reversible. A population that is ruled
   * out of deletion needs no restore source, and capturing one anyway is not
   * free: rank_events alone would put ~140,000 full rows — on the order of a
   * hundred megabytes — into git to guard against a deletion that is ruled out.
   * Those populations are CENSUSED (count + type distribution, so the number is
   * on the record and drift is visible) and not captured.
   *
   * If rank_events is ever brought into scope for deletion, flip this to true in
   * the same change that proposes it — never after.
   */
  captureRows: boolean;
  note: string;
}

const POPULATIONS: Population[] = [
  {
    table: "content_stamps",
    typeColumn: "entity_type",
    typeFilter: "post",
    idColumn: "entity_id",
    danglingPredicate: "not exists (select 1 from posts p where p.id = t.entity_id)",
    captureRows: true,
    note:
      "entity_id is uuid, so it joins to posts.id without a cast. docs/migrations.md " +
      "establishes by provenance that every one of these carries migrated_from='posts_likes' " +
      "from the one-off 2049_content_stamps backfill — none from an organic write — and that " +
      "the population is a fixed number rather than a growing floor.",
  },
  {
    table: "rank_events",
    typeColumn: "content_type",
    typeFilter: "post",
    idColumn: "item_id",
    danglingPredicate: "not exists (select 1 from posts p where p.id::text = t.item_id)",
    captureRows: false,
    note:
      "item_id is text; the cast is on posts.id, not on item_id, so a non-uuid item_id " +
      "cannot raise. THIS IS THE DOMINANT POPULATION BY THREE ORDERS OF MAGNITUDE and it is " +
      "the one docs/algorithm/rank-events-signal-gaps.md rules DELIBERATELY UNTOUCHED. Censused, " +
      "not captured: a restore source exists to make a deletion reversible, and there is no " +
      "deletion to reverse here. Capturing it would put ~86k full rows into git against a " +
      "deletion that is ruled out. The count is recorded so drift stays visible.",
  },
  {
    table: "rank_events",
    typeColumn: "content_type",
    typeFilter: "__NULL__",
    idColumn: "item_id",
    danglingPredicate: "not exists (select 1 from posts p where p.id::text = t.item_id)",
    captureRows: false,
    note:
      "content_type IS NULL — rows predating the column being populated. Captured as its own " +
      "population rather than folded into the 'post' bucket, because calling an untyped row a " +
      "post orphan asserts something the data does not say. Whether these are post references " +
      "at all is unresolved, and the snapshot records that rather than deciding it.",
  },
  {
    table: "compass_recommendation_scores",
    typeColumn: "item_type",
    typeFilter: "post",
    idColumn: "item_id",
    danglingPredicate: "not exists (select 1 from posts p where p.id::text = t.item_id)",
    captureRows: true,
    note: "Matches the 2026-08-10 backup figure of 99 exactly — this population has not moved.",
  },
  {
    table: "trip_plan_items",
    typeColumn: "source_type",
    typeFilter: "post",
    idColumn: "source_id",
    danglingPredicate: "not exists (select 1 from posts p where p.id::text = t.source_id)",
    captureRows: true,
    note:
      "The 2026-08-10 backup recorded 1 row here (68c2a847, a mis-typed source_type='place' " +
      "carrying a post id). Re-measured 2026-08-14: 0 under source_type='post'.",
  },
];

function typePredicate(p: Population): string {
  return p.typeFilter === "__NULL__"
    ? `t.${p.typeColumn} is null`
    : `t.${p.typeColumn} = '${p.typeFilter}'`;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = resolve(
  outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]!
    : "../../docs/ops/artifacts/orphan-rows-snapshot.json",
);

console.log("═".repeat(74));
console.log(`ORPHAN ROW SNAPSHOT — project ${projectRef}`);
console.log("═".repeat(74));

const captured: Array<Record<string, unknown>> = [];
let failed = false;

for (const p of POPULATIONS) {
  const label = `${p.table} ${p.typeColumn}=${p.typeFilter === "__NULL__" ? "NULL" : p.typeFilter}`;

  // Type distribution, so the snapshot records what was EXCLUDED as well as
  // what was taken. A count with no denominator invites the same
  // unfiltered-count mistake this file exists to prevent.
  const dist = await liveQuery<{ v: string | null; n: number }>(
    `select ${p.typeColumn}::text as v, count(*)::int as n from ${p.table} group by 1 order by 2 desc`,
  );

  const rows = p.captureRows
    ? await liveQuery<{ row: Record<string, unknown> }>(
        `select to_jsonb(t) as row from ${p.table} t
          where ${typePredicate(p)} and ${p.danglingPredicate}`,
      )
    : [];

  const countCheck = await liveQuery<{ n: number }>(
    `select count(*)::int as n from ${p.table} t
      where ${typePredicate(p)} and ${p.danglingPredicate}`,
  );
  const expected = countCheck[0]?.n ?? -1;

  if (p.captureRows && rows.length !== expected) {
    console.error(
      `❌ ${label}: captured ${rows.length} rows but count() says ${expected}. ` +
        `A partial snapshot is worse than none — it looks like a restore source and is not.`,
    );
    failed = true;
  }

  console.log(`\n  ${label}`);
  console.log(
    p.captureRows
      ? `    orphan rows CAPTURED : ${rows.length}`
      : `    orphan rows CENSUSED : ${expected}  (rows not captured — out of deletion scope)`,
  );
  console.log(`    full-table type mix  : ${dist.map((d) => `${d.v ?? "NULL"}=${d.n}`).join(", ")}`);

  captured.push({
    table: p.table,
    typeColumn: p.typeColumn,
    typeFilter: p.typeFilter === "__NULL__" ? null : p.typeFilter,
    idColumn: p.idColumn,
    note: p.note,
    danglingPredicate: p.danglingPredicate,
    fullTableTypeDistribution: dist,
    orphanCount: expected,
    rowsCaptured: p.captureRows,
    rows: p.captureRows ? rows.map((r) => r.row) : null,
  });
}

if (failed) {
  console.error("\nSnapshot NOT written — at least one population was captured incompletely.\n");
  process.exit(1);
}

const artifact = {
  kind: "orphan-rows-snapshot",
  version: 1,
  projectRef,
  populations: captured,
  totalOrphanRows: captured.reduce((n, c) => n + (c.orphanCount as number), 0),
  totalRowsCaptured: captured.reduce(
    (n, c) => n + (c.rowsCaptured ? (c.orphanCount as number) : 0),
    0,
  ),
  restoreNote:
    "Each population's `rows` array holds COMPLETE rows as jsonb, not ids. To restore a " +
    "population: insert each element of `rows` back into its table. This is the deterministic-" +
    "restoration precondition recorded in docs/ops/retention-policy.md. An id list would not " +
    "satisfy it — by the time a restore is needed the row is gone and cannot be reconstructed " +
    "from its id.",
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");

console.log("\n" + "═".repeat(74));
console.log(`Snapshot written: ${outPath}`);
console.log(`  populations : ${captured.length}`);
console.log(`  orphan rows censused : ${artifact.totalOrphanRows}`);
console.log(`  full rows captured   : ${artifact.totalRowsCaptured}`);
console.log(
  "\n  This artifact is a RESTORE SOURCE, not a deletion plan. Nothing in this\n" +
    "  repository deletes any of these rows. Deletion at window end is a scheduled\n" +
    "  decision recorded in docs/ops/retention-policy.md, never an automatic job.\n",
);
process.exit(0);
