#!/usr/bin/env node
//
// check-guard-coverage.mjs — who is actually behind the chokepoint.
//
// Plain node, builtins only, no dependencies, no network, no node_modules.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// src/lib/ciSupabaseGuard.mjs is described as THE CHOKEPOINT: the first thing
// that executes inside every process that can reach Supabase. That description
// is true of the processes that IMPORT IT, and of no others. It is an opt-in
// chokepoint, and nothing counted who opted in.
//
// At the time this check was written: NINE files import it. Roughly thirty more
// files under src/ name a Supabase credential env var or call createClient()
// and do not. Reading the guard's own header, one would conclude the set of
// database-reaching entry points is eight; it is not, and the difference was
// invisible because nobody was counting.
//
// So this check counts. Every file under src/ that can reach Supabase must
// either import the guard or appear on EXEMPT below WITH A WRITTEN REASON. The
// list is in this file, in source, where a diff shows it — not in a config, not
// derived, not inferred.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT AN EXEMPTION MEANS. READ THIS BEFORE ADDING ONE.
// ─────────────────────────────────────────────────────────────────────────────
//
// AN EXEMPTION MEANS THE FILE IS UNGUARDED. IT DOES NOT MEAN THE FILE IS SAFE.
//
// An exempt file that is handed SUPABASE_URL pointing at production will talk
// to production. Nothing stops it. The exemption is a statement that CI never
// invokes it, so CI cannot be the thing that points it at production — it says
// nothing whatsoever about a human running it from a laptop with a production
// .env, which is exactly how most of the seed and backfill tooling below is
// normally run and exactly how it would destroy production data.
//
// The rule for CI is absolute and is enforced below: anything on the CI surface
// that can reach Supabase must import the guard. Exemption is available only to
// files CI does not invoke.
//
// ─────────────────────────────────────────────────────────────────────────────
// VACUITY IS FAILURE
// ─────────────────────────────────────────────────────────────────────────────
//
// A check that examines nothing passes trivially, and this repo has already
// been bitten by a rule whose subject shrank to the empty set while it kept
// printing a green count. So: an empty EXEMPT list, zero files scanned, zero
// reachable files, an empty CI surface, an exempt entry with no reason, an
// exempt entry naming a file that does not exist or is not reachable, and an
// unparseable source file are each a non-zero exit.
//
// Exit 0 only if every reachable file is guarded or exempt-with-reason, and
// every exemption is still true. Exit 1 otherwise.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..'); // artifacts/api-server
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SRC = join(PKG_ROOT, 'src');

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO FRONT DOORS, AND THE MODULE BEHIND THEM.
//
// There is one policy implementation and two ways in. The difference between
// them is a hard-coded constant at each call site, and it is the whole of the
// difference between "the sanctioned CI project, or exit 2" and "that, or —
// outside CI, on a deliberate request — a read-only audit of declared
// production".
//
// The scoping rule this file enforces is what makes that safe: the write-
// capable entry points import the STRICT door, and the read-only capability is
// not reachable from them because it is not in the module they import. That is
// only true while the importer sets stay as declared below, so they are
// checked here on every run rather than assumed.
// ─────────────────────────────────────────────────────────────────────────────
const GUARD_REL = 'src/lib/ciSupabaseGuard.mjs';
const READONLY_GUARD_REL = 'src/lib/ciProdReadOnlyAuditGuard.mjs';
const POLICY_REL = 'src/lib/supabaseTargetPolicy.mjs';

/** The guard's own machinery. It is not its own client. */
const GUARD_MACHINERY = new Set([
  GUARD_REL,
  READONLY_GUARD_REL,
  POLICY_REL,
  'src/lib/ciSupabaseGuard.d.mts',
  'src/lib/ciProdReadOnlyAuditGuard.d.mts',
]);

/** Only these two may import the policy module. Everything else uses a door. */
const FRONT_DOORS = new Set([GUARD_REL, READONLY_GUARD_REL]);

const problems = [];
const notes = [];
function problem(msg) {
  problems.push(msg);
  console.error(`::error::${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REACHABILITY. What "can reach Supabase" means here, stated so it can be
// argued with.
//
// A file is REACHABLE if it does either of these in its own text:
//
//   * names one of the Supabase credential environment variables, or
//   * calls createClient(  — the supabase-js constructor.
//
// This is deliberately DIRECT reachability, not transitive. Transitive
// reachability through src/lib/supabase.ts's getServiceClient() covers nearly
// three hundred files — every route module in the server — and putting the
// guard behind that factory is explicitly rejected in the guard's own header,
// because it would refuse to let the production API server boot, and the
// production API server is SUPPOSED to talk to production. A rule whose remedy
// is known to be wrong is not a rule worth stating, so the transitive set is
// out of scope here and is named in DOES-NOT-COVER at the bottom of this file.
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_CREDENTIAL_ENV_NAMES = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_PROJECT_TOKEN',
  'SUPABASE_ACCESS_TOKEN',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
];
const CREDENTIAL_NAME_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_])(?:${SUPABASE_CREDENTIAL_ENV_NAMES.join('|')})(?![A-Za-z0-9_])`,
);
const CREATE_CLIENT_RE = /(?:^|[^A-Za-z0-9_$.])createClient[ \t]*\(/;

/** An `import "…/ciSupabaseGuard.mjs";` statement — not a mention of the name. */
const GUARD_IMPORT_RE = /^[ \t]*import[ \t]+["'][^"']*ciSupabaseGuard\.mjs["'][ \t]*;?[ \t]*$/m;
/** The same, for the read-only audit front door. */
const READONLY_GUARD_IMPORT_RE =
  /^[ \t]*import[ \t]+["'][^"']*ciProdReadOnlyAuditGuard\.mjs["'][ \t]*;?[ \t]*$/m;
/** Either door, for the "is this file guarded at all" question. */
const EITHER_GUARD_IMPORT_RE = /ciSupabaseGuard\.mjs|ciProdReadOnlyAuditGuard\.mjs/;
/**
 * Any reference to the policy module in a module specifier. Deliberately looser
 * than the two above — it matches a quoted path anywhere, so a multi-line
 * `import { … } from "./supabaseTargetPolicy.mjs"` and a dynamic
 * `await import("…/supabaseTargetPolicy.mjs")` are both caught. Prose mentions
 * of the filename are not quoted and do not match.
 */
const POLICY_IMPORT_RE = /["'][^"']*supabaseTargetPolicy\.mjs["']/;
/** Any ESM import statement, used to check the guard import comes FIRST. */
const ANY_IMPORT_RE = /^[ \t]*import[ \t]+(?:["']|[A-Za-z_$*{])/;

// ─────────────────────────────────────────────────────────────────────────────
// THE READ-ONLY AUDIT LIST. Who may import the read-only front door.
//
// Importing READONLY_GUARD_REL is a capability: outside CI, with a deliberate
// intent variable, that process may point itself at declared PRODUCTION. It is
// granted to the files listed below and to nothing else, and both directions are
// enforced below — an unlisted importer fails, and a listed file that stops
// importing it fails.
//
// THE REASON IS THE SAME FOR ALL FOUR AND IT IS A FACT ABOUT THEIR SQL: each
// issues SELECTs and nothing else. That was established by reading them, not by
// a static rule, and THIS CHECK DOES NOT RE-ESTABLISH IT — no pattern here
// inspects the SQL a script sends. What this check does is make that set a
// closed, reviewable set, so that granting the capability to a fifth file is a
// diff in this list rather than an import nobody notices.
//
// If one of these four ever gains an INSERT, UPDATE, DELETE, DDL statement or
// auth-admin call, the fix is to move its first import back to GUARD_REL and
// delete its entry here, in the same change.
// ─────────────────────────────────────────────────────────────────────────────
const READ_ONLY_AUDIT_ENTRY_POINTS = [
  {
    file: 'src/scripts/auditMigrationsVsLive.ts',
    reason:
      'Reads the live schema through the Management API with SELECTs on pg_class, information_schema.columns, ' +
      'pg_proc, pg_indexes, pg_policies, pg_type/pg_enum and pg_trigger, and diffs them against migration files ' +
      'on disk. Auditing production is its purpose: the drift list in docs/migrations.md came from it.',
  },
  {
    file: 'src/scripts/reportDiscoveryServePoints.ts',
    reason:
      'One SELECT on rank_events (features, session_id, served_at) filtered to surface=discovery, ' +
      'outcome=impression and a served_at window, tallied in memory. It answers the question P1 Stage 0 ' +
      'exists to answer — what fraction of discovery serves reached a ranker — and that is a question about ' +
      'production, since the whole finding is that the ranked path scarcely runs there. It writes nothing and ' +
      'prints a verdict for a human to act on; the D5 revisit clause is the action it feeds.',
  },
  {
    file: 'src/scripts/auditShadowAppendOnly.ts',
    reason:
      'Three SELECTs through the Management API — pg_class for relrowsecurity, ' +
      'information_schema.role_table_grants for the privilege set, and pg_trigger for the append-only ' +
      'triggers — on the single table discovery_shadow_serves. It writes nothing and mutates nothing; it ' +
      'deliberately does NOT attempt an UPDATE or a TRUNCATE to prove the property, because an audit may not ' +
      'mutate production to test it. It exists because audit:schema compares OBJECTS and not PRIVILEGES: ' +
      'migration 2092 claimed service_role held INSERT and SELECT "and nothing else" and it in fact held all ' +
      'seven privileges, and every gate went green. That is a question about production specifically, since ' +
      'the append-only guarantee D7=A rests on is a property of the live catalog and of nothing else.',
  },
  {
    file: 'src/scripts/checkMissingLiveColumns.ts',
    reason:
      'Two SELECTs — information_schema.columns and pg_class — diffed against columns parsed out of migration ' +
      'files. It exists to catch the class of failure where a column a route writes is absent live, which is ' +
      'a question about production and is answered nowhere else.',
  },
  {
    file: 'src/scripts/checkMediaObjects.ts',
    reason:
      'Two SELECTs: a join of post_media against storage.objects for dangling rows, and a count of orphan ' +
      'objects. It reconciles rows against the bucket and changes neither — the remedy it prints is for a human ' +
      'to choose. Production is where its 114 broken images were found.',
  },
  {
    file: 'src/scripts/checkWritePathColumns.ts',
    reason:
      'Named for what it READS, not what it does: it extracts insert/upsert/update call sites from the ' +
      'TypeScript AST of src/routes and src/services and performs none of them. Its only database contact is ' +
      'three SELECTs — information_schema.columns, pg_class, and the one-row @portava profile smoke test.',
  },
  {
    file: 'src/scripts/checkDiscoveryCacheKeys.ts',
    reason:
      'Diagnostic for the Discovery cache-vs-ranking question. Sends seven statements, all reads: ' +
      'Q_CACHE_TOTALS, Q_AGE_BUCKETS, Q_TTL_SPAN, Q_TOP_DESTINATIONS and Q_KEYS_PER_CATEGORY are ' +
      'SELECTs over public.discovery_cache; Q_RANK_EVENTS_BY_SURFACE and Q_RANK_EVENTS_DISCOVERY_24H ' +
      'are a SELECT and a WITH-prefixed SELECT aggregating public.rank_events. No INSERT/UPDATE/DELETE ' +
      'and no .insert/.update/.upsert/.delete/.rpc call anywhere in the file. Auditing PRODUCTION is ' +
      'the point: the cache-dominance figure it reports is meaningless against an empty CI project.',
  },
  {
    file: 'src/scripts/checkMediaUrlsExternalOnly.ts',
    reason:
      'ENFORCES the 2026-08-12 ruling that posts.media_urls holds EXTERNAL references only, post_media being ' +
      'canonical for storage-backed media (2083_backfill_storage_backed_post_media.sql). Everything it sends, ' +
      'in full: TWO Management API statements, both SELECTs over public.posts. POPULATION_SQL is ' +
      '`SELECT count(*) FROM posts, LATERAL unnest(media_urls)` — the total element count, read so that a ' +
      'zero-violation result can be told apart from an empty column. VIOLATION_SQL is a SELECT over the same ' +
      'unnest, filtered to elements matching a storage-backed shape in either spelling (the bare ' +
      '`post-media/`|`profile-media/` key, and the pre-2081 absolute /storage/v1/object/public/ URL), LIMIT 200. ' +
      'No INSERT/UPDATE/DELETE, no .insert/.update/.upsert/.delete/.rpc anywhere in the file. It reports and ' +
      'exits non-zero; it never repairs what it finds, because the remedy is fixing whatever wrote the value. ' +
      'Auditing PRODUCTION is the point: the column it guards is a production data shape, and the CI project ' +
      'holds no posts, so a CI-only run proves only that there is nothing there to violate the rule — which ' +
      'the script says out loud rather than reporting a clean pass.',
  },
  {
    file: 'src/scripts/auditUnreferencedObjects.ts',
    reason:
      'Step 02 of the upload staging boundary: a census of storage objects that no column references — the ' +
      '"abandoned upload" half of the invariant, which checkMediaObjects is structurally blind to because it ' +
      'walks post_media ROWS. Everything it sends, in full: TWO Management API statements, both SELECTs. ' +
      'DISCOVERY_SQL reads information_schema.columns for candidate reference columns. The census statement is ' +
      'a WITH-prefixed SELECT joining storage.objects (names, sizes, created_at — never bytes) against a ' +
      'UNION ALL of those columns. No INSERT/UPDATE/DELETE, no .insert/.update/.upsert/.delete/.rpc, and no ' +
      'storage remove/move call anywhere in the file: it reports and exits 0 whatever it finds. Auditing ' +
      'PRODUCTION is the point — the orphan population is a production fact, and the CI project holds almost ' +
      'no objects, so a CI-only run proves nothing, which the script says out loud rather than reporting clean.',
  },
  {
    file: 'src/scripts/auditPostMediaPublicRead.ts',
    reason:
      'THE UNIT C GATE, as an instrument. It measures whether post_media_storage_public_read — SELECT TO ' +
      'public USING (bucket_id = \'post-media\'), declared by 0103_post_media.sql — is present AND actually ' +
      'reachable, and captures its body verbatim from pg_policies as the migration rollback. Everything it ' +
      'sends: FOUR Management API statements, all SELECTs (pg_policies over schema=storage/table=objects; ' +
      'three one-row `select name from storage.objects` samples for post-media, profile-media and ' +
      'stamp-artwork), plus HTTP probes against the Storage API. The probes are the point — a policy listing ' +
      'is a claim about the catalog, an HTTP 200 to an anonymous caller is a fact about exposure. It GETs one ' +
      'object and LISTs one bucket using EXPO_PUBLIC_SUPABASE_ANON_KEY (the publishable key that ships in the ' +
      'mobile client), does the same against profile-media as a negative control and stamp-artwork as a ' +
      'positive control, and mints ONE 60-second signed URL with the service role for a profile-media object ' +
      'and fetches it. THAT SIGNING CALL IS THE ONLY NON-SELECT THING IT DOES, and it is still read-only: ' +
      'creating a signed URL mutates no row and no object — it returns a token. The signed fetch is a GET. ' +
      'It DROPS NOTHING; applying the change is 2089_revoke_post_media_public_read.sql, a separate deliberate ' +
      'migration. EXEMPTION MEANS UNGUARDED, NOT SAFE — but the read-only audit door is the correct one here ' +
      'precisely because auditing production is the purpose: the question "can an anonymous caller read this ' +
      'bucket" is only answerable against the project that actually holds the data.',
  },
  {
    file: 'src/scripts/snapshotOrphanRows.ts',
    reason:
      'Retention snapshot for the orphaned-row backlog (docs/ops/retention-policy.md). Everything it ' +
      'sends is a SELECT: one type-distribution GROUP BY and one to_jsonb(t) capture per population, ' +
      'plus a matching count() it compares against the captured array so a PARTIAL snapshot exits 1 ' +
      'rather than being written — a truncated restore source is worse than none, because it looks ' +
      'like one. It writes exactly one LOCAL file and touches no row. Auditing production is the ' +
      'purpose: the question "which rows dangle" is only answerable against the project holding the ' +
      'data. EXEMPTION MEANS UNGUARDED, NOT SAFE.',
  },
  {
    file: 'src/scripts/planStorageQuarantine.ts',
    reason:
      'D5 quarantine PLANNER and sweep-eligibility check. It has no --apply flag and no write path: ' +
      'it re-derives the orphan census (information_schema for referencing columns, then storage.objects ' +
      'joined outward), emits the source -> destination move list, and writes one LOCAL manifest. In ' +
      'sweep mode it reads the quarantine prefix and reports which objects are past the 90-day window. ' +
      'It moves nothing and deletes nothing. Execution against production is a separate owner-authorized ' +
      'step, because this repo has two sanctioned doors — strict (CI only) and read-only audit — and ' +
      'moving 34 real user objects is not a reason to invent a third. EXEMPTION MEANS UNGUARDED, NOT SAFE.',
  },
  {
    file: 'src/scripts/auditStagingBoundaryGrant.ts',
    reason:
      'THE STEP 01 GATE of the upload staging boundary, as an instrument. Step 01 drops two live storage ' +
      'policies — post_media_storage_memories_stories_insert and post_media_memories_stories_delete — which ' +
      'are declared by NO migration and appear NOWHERE in git history (verified by `git log --all -S` on both ' +
      'names, which returns only prose documents). They were applied out of band, and the fact layer records ' +
      'their cmd and role but not their qual/with_check. So the LIVE CATALOG IS THE ONLY SURVIVING COPY of ' +
      'what these policies say: drop them without capturing the body first and the rollback does not exist, ' +
      'which is discovered at the moment someone needs it. Everything it sends, in full: FIVE Management API ' +
      'statements, all SELECTs. (1) pg_policies filtered to schemaname=storage, tablename=objects and the two ' +
      'policy names, reading policyname/cmd/permissive/roles/qual/with_check — this is the rollback, and the ' +
      'script prints the re-CREATE. (2) and (3) count(*) over storage.objects for bucket post-media under the ' +
      "memories/ and stories/ prefixes — the precondition, measured rather than trusted because the orphan " +
      'count has already moved since the packet was written (28 → 30), which is proof the bucket is not ' +
      'static. (4) count(*) over stories and (5) count(*) over storage.objects for post-media, reported as ' +
      'context because "stories has no production data" is load-bearing in the packet and should be visible ' +
      'rather than asserted. No INSERT/UPDATE/DELETE, no DDL — it never drops the policies it reads; applying ' +
      'the change is a separate deliberate migration. Exits 1 if a prefix is non-empty or a policy is absent, ' +
      'so the gate fails closed. Auditing PRODUCTION is the entire point: the policies exist only there.',
  },
  {
    file: 'src/scripts/auditMediaUrlShapes.ts',
    reason:
      'URL-SHAPE HISTOGRAM of the durable media URL columns, for the upload-consolidation question of whether ' +
      'converting the two writers that still mint absolute public storage URLs is the whole job or only half ' +
      'of it. Everything it sends, in full: FIVE Management API statements, all SELECTs, one per column — ' +
      '`events.cover_url`, `trips.cover_url`, `post_media.public_url`, `post_media.feed_url`, and ' +
      '`unnest(posts.media_urls)`. Each has the identical form `SELECT <literal> AS col, CASE … END AS ' +
      'url_shape, count(*)::text AS n FROM (SELECT <column> AS v FROM <table>) t GROUP BY 1,2` — the column is ' +
      'consumed by a CASE inside SQL and never appears in a select list, so the result set is (column, shape, ' +
      'count) triples and NO URL VALUE CROSSES THE WIRE. That is deliberate and structural: these URLs carry ' +
      'user ids, post ids and filenames, and a log line or CI artifact holding them is itself a disclosure — ' +
      'the same rule auditStorageExif.ts applies to coordinates. No INSERT, UPDATE, DELETE or DDL; no ' +
      '.insert/.update/.upsert/.delete/.rpc; no Storage call of any kind; no --apply flag and no code path ' +
      'that could take one. Auditing PRODUCTION is the point — the legacy corpus IS the measurement, and a ' +
      'census of the non-production project would say nothing about it, which is precisely the defect that ' +
      'voided the EXIF census tag (fact layer §7.3, listed for re-run in §10.3). The script prints the project ' +
      'ref it queried so the result can carry a valid [DB <date> · <project>] tag.',
  },
  {
    file: 'src/scripts/auditStorageExif.ts',
    reason:
      'EXIF/GPS census of the media buckets. Everything it sends, in full: (1) bucket ENUMERATION — GET ' +
      '/storage/v1/bucket, then POST /storage/v1/object/list/<bucket> paged by offset and recursed into ' +
      'prefixes, which is the Storage listing API and creates nothing; (2) ranged header GETs — GET ' +
      '/storage/v1/object/<bucket>/<name> with `Range: bytes=0-131071` per image object, so it reads a header ' +
      'segment and never the pixels; (3) two Management API statements, both reads — a SELECT on ' +
      'information_schema.columns for the public text/varchar columns whose names look like a path or a URL, ' +
      'then a UNION of `select distinct "<col>"::text from public."<table>" where "<col>" is not null` over ' +
      'exactly those columns, limit 200000, to decide which objects are still referenced. No INSERT, UPDATE, ' +
      'DELETE or DDL; no .insert/.update/.upsert/.delete/.rpc; no Storage upload, move, copy or remove; no ' +
      '--apply flag and no code path that could take one. Auditing PRODUCTION is the point — an empty CI ' +
      'project has no user photographs, so the census figure it exists to report is only meaningful there. ' +
      'HISTORY WORTH KEEPING: this file used to skip the guard entirely on its own ' +
      'AUDIT_READONLY_ACK_PRODUCTION variable. That was an override, not an acknowledgement — on that path ' +
      'nothing consulted the CI markers, so it would have permitted a production run from inside a workflow, ' +
      'and it compared the variable against the ref parsed from SUPABASE_URL itself, which any project ' +
      'satisfies. It was deleted when this entry was added; do not reintroduce it beside the front door.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// THE EXEMPT LIST. Every entry needs a reason, and the reason must say what
// makes CI unable to invoke this file — not that the file is harmless.
//
// `kind` groups the entries; `reason` is per entry and is what a reviewer
// reads. `pinnedTestEnv: true` marks entries whose exemption is CONDITIONAL on
// a fact about package.json that is re-verified on every run (see
// assertPinnedTestEnv below) — those are the only exempt files CI does invoke,
// and if the pin ever goes away the exemption evaporates and they fail here.
// ─────────────────────────────────────────────────────────────────────────────
const EXEMPT = [
  // ── Application code. The server is SUPPOSED to talk to production. ───────
  {
    file: 'src/lib/supabase.ts',
    reason:
      'The APPLICATION\'s client factory (getServiceClient/getAnonClient). Importing the guard here would ' +
      'refuse to let the production API server boot, which is the opposite of the intent — that process is ' +
      'supposed to talk to production. Unguarded, deliberately: the allowlist is a CI rule, not a runtime one.',
  },
  {
    file: 'src/lib/envValidation.ts',
    reason:
      'Startup env validation. Names the credential variables to assert they are PRESENT and well-formed; ' +
      'constructs no client and issues no request. Loaded by the production server on every boot, so a guard ' +
      'here would refuse production startup. Unguarded, and that is a property of the running server too.',
  },
  {
    file: 'src/lib/http.ts',
    reason:
      'HTTP helper that derives the API base URL from SUPABASE_URL for storage/functions endpoints. Library ' +
      'code loaded by the production server; it does not choose the target, its callers do. Unguarded.',
  },
  {
    file: 'src/lib/mediaAccess.ts',
    reason:
      'Builds and validates media object paths against the SUPABASE_URL host. Library code in the production ' +
      'request path; a guard here would refuse production startup. Unguarded.',
  },
  {
    file: 'src/lib/mediaUrl.ts',
    reason:
      'String construction of public/signed media URLs from SUPABASE_URL. Library code in the production ' +
      'request path. Unguarded.',
  },
  {
    file: 'src/lib/telegraphBroadcast.ts',
    reason:
      'Realtime broadcast helper that targets the SUPABASE_URL realtime endpoint. Library code in the ' +
      'production request path. Unguarded.',
  },
  {
    file: 'src/routes/mediaFeed.ts',
    reason:
      'Route module; references SUPABASE_URL to build media URLs for responses. Registered on the production ' +
      'server at boot, so a guard here would refuse production startup. Unguarded.',
  },
  {
    file: 'src/routes/passport.ts',
    reason:
      'Route module; references SUPABASE_URL to build stamp/media URLs for responses. Registered on the ' +
      'production server at boot. Unguarded.',
  },
  {
    file: 'src/routes/trips.ts',
    reason:
      'Route module; references SUPABASE_URL to build media URLs for responses. Registered on the production ' +
      'server at boot. Unguarded.',
  },

  // ── Manual seed / backfill / ops tooling. CI invokes none of it. ──────────
  //
  // Each of these is run by a human, by hand, against whatever project their
  // .env happens to name. THAT IS THE RISK, AND IT IS NOT MITIGATED HERE.
  // These are exactly the scripts that would do the most damage pointed at
  // production, and the reason they are exempt is narrow: CI cannot point them
  // anywhere, because CI never runs them. Wiring any of them into a workflow
  // means adding the guard import in the same change; the CI-surface rule below
  // enforces that mechanically.
  ...[
    ['src/scripts/backfill-canonical-places.ts', 'one-shot backfill of canonical place records'],
    ['src/scripts/backfill-media-assets.ts', 'one-shot backfill of media asset rows'],
    ['src/scripts/backfillLandmarkCategories.ts', 'one-shot backfill of landmark categories'],
    ['src/scripts/backfillStampCountries.ts', 'one-shot backfill of stamp country codes'],
    ['src/scripts/check-media-bucket-privacy.ts', 'manual audit of storage bucket privacy flags'],
    ['src/scripts/fix-demo-events-city.ts', 'manual repair of demo event city fields'],
    ['src/scripts/fix-demo-memories.ts', 'manual repair of demo memory rows'],
    ['src/scripts/fix-demo-stamps.ts', 'manual repair of demo stamp rows'],
    ['src/scripts/landmarkDedupSweep.ts', 'manual deduplication sweep over landmarks'],
    ['src/scripts/reconcileStampCatalog.ts', 'manual reconciliation of the stamp catalog'],
    ['src/scripts/seed-demo-buddies.ts', 'seeds demo buddy accounts'],
    ['src/scripts/seed-demo-city-events.ts', 'seeds demo city events'],
    ['src/scripts/seed-demo-profile.ts', 'seeds a demo profile'],
    ['src/scripts/seed-demo-social.ts', 'seeds demo social graph rows'],
    ['src/scripts/seed-portava-account.ts', 'seeds the official Portava account'],
    ['src/scripts/seed-test-media.ts', 'seeds test media objects'],
    ['src/scripts/set-media-buckets-private.ts', 'flips storage buckets to private'],
    ['src/scripts/stamp-smoke-check.ts', 'manual smoke check over stamp generation'],
    ['src/scripts/verify-approval-and-reconcile.ts', 'manual verification of approval/reconcile flow'],
    ['src/scripts/verify-buddy-live.ts', 'manual verification of live buddy data'],
    ['src/scripts/verify-demo-profile.ts', 'manual verification of the seeded demo profile'],
    ['src/scripts/verify-events-discovery.ts', 'manual verification of event discovery data'],
    ['src/scripts/verifyModerationFkE2E.ts', 'manual end-to-end verification of moderation foreign keys'],
  ].map(([file, what]) => ({
    file,
    reason:
      `Manual ops tooling: ${what}. No workflow under .github/ invokes it and no CI-invoked package script ` +
      'reaches it (the CI surface is derived, not assumed — see deriveCiSurface below). EXEMPTION MEANS ' +
      'UNGUARDED, NOT SAFE: run by hand with a production .env it writes to production, and nothing here ' +
      'prevents that. Wiring it into a workflow requires adding the guard import in the same change.',
  })),
  {
    file: 'src/scripts/backfillFeedVariants.ts',
    reason:
      'Backfill job for post_media.feed_url / feed_storage_path on rows that predate migration 0208, run by ' +
      'hand via `pnpm run backfill:feed-variants`. IT WRITES, in two places: with --apply it uploads a ' +
      're-encoded `<storage_path>.feed.jpg` object into the post-media bucket and then UPDATEs the ' +
      'post_media row to point at it. Its own header says it is deliberately not wired into check:all ' +
      'because a job a gate runs on every build is a job that will eventually run when nobody meant it to, ' +
      'and that is still true: no workflow under .github/ invokes backfill:feed-variants and no CI-invoked ' +
      'package script reaches this file. The near miss is worth naming — the CI-invoked `test` script runs ' +
      'src/test/backfillFeedVariants.test.ts, a DIFFERENT file, which imports only the pure parseArgs / ' +
      'variantPathFor / decideExitCode helpers; main() sits behind a RUN_DIRECTLY check that is false under ' +
      'the test runner, so no row is selected and no object is uploaded. EXEMPTION MEANS UNGUARDED, NOT ' +
      'SAFE: run by hand with a production .env and --apply it rewrites production rows and production ' +
      'Storage objects, and nothing here prevents that. BECAUSE IT WRITES, THE READ-ONLY AUDIT DOOR IS NOT ' +
      'AN OPTION FOR IT UNDER ANY CIRCUMSTANCE, and that holds for its --audit-exif mode too: the flag makes ' +
      'a single run read-only, it does not make the FILE read-only, and the capability granted by an import ' +
      'is a property of the file. If this is ever wired into a workflow the import to add is ' +
      'src/lib/ciSupabaseGuard.mjs as the first import, and it must never appear in ' +
      'READ_ONLY_AUDIT_ENTRY_POINTS.',
  },
  {
    file: 'src/test/smoke-live.ts',
    reason:
      'Hand-run live smoke script under src/test/. It is not a *.test.ts, so no test runner picks it up, and ' +
      'no package script names it — src/test/ is skipped wholesale by the node test runner config. EXEMPTION ' +
      'MEANS UNGUARDED, NOT SAFE: it constructs a real client from the ambient environment when a human runs it.',
  },

  // ── Unit tests CI DOES run, exempt only because CI pins the target. ───────
  //
  // These are the only exempt files on the CI surface. `pnpm run test` — the
  // script ci.yml invokes — sets SUPABASE_URL to the loopback discard port and
  // SUPABASE_SERVICE_ROLE_KEY to a dummy on the command line, so the target is
  // pinned by the invocation itself, more narrowly than the allowlist could
  // pin it. Adding the guard would be actively wrong: it would refuse
  // (a loopback URL resolves to no project ref) and take the whole unit suite
  // red for a target that cannot reach any database at all.
  //
  // The exemption is NOT taken on trust — assertPinnedTestEnv() below re-reads
  // package.json on every run and fails if the pin is gone.
  ...[
    'src/test/dailyBriefCleanup.test.ts',
    'src/test/eventAgendaItems.test.ts',
    'src/test/events-extension.test.ts',
    'src/test/mediaAccess.test.ts',
    'src/test/mediaFileWidthTransform.test.ts',
    'src/test/mediaFileQualityTransform.test.ts',
    'src/test/mediaLib.test.ts',
    'src/test/mediaSignBatchTransform.test.ts',
    'src/test/mediaUploadHardening.test.ts',
    'src/test/messaging.test.ts',
    'src/test/stamps.test.ts',
  ].map((file) => ({
    file,
    pinnedTestEnv: true,
    reason:
      'Unit test in the `test` script that ci.yml runs. It names SUPABASE_URL only to build or restore a URL ' +
      'string; it constructs no client and issues no request. CI runs it with SUPABASE_URL pinned to the ' +
      'loopback discard port and a dummy service key ON THE COMMAND LINE, so the target is fixed by the ' +
      'invocation. Importing the guard would refuse (a loopback URL has no project ref) and take the entire ' +
      'unit suite red. This exemption is conditional: it is void the moment that pin leaves package.json, ' +
      'which is re-checked here on every run.',
  })),
];

// ─────────────────────────────────────────────────────────────────────────────
// The pinned-target fact the unit-test exemptions depend on.
// ─────────────────────────────────────────────────────────────────────────────
const LOOPBACK_URL_RE = /SUPABASE_URL=(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\b/;

function assertPinnedTestEnv(pkg) {
  const body = (pkg.scripts ?? {}).test;
  if (typeof body !== 'string' || body.trim() === '') {
    problem(
      "artifacts/api-server/package.json defines no 'test' script, but EXEMPT entries marked pinnedTestEnv " +
        'depend on it: they are exempt only because that script pins SUPABASE_URL to a loopback address. ' +
        'With the script gone the premise is gone. Re-derive those exemptions.',
    );
    return false;
  }
  if (!LOOPBACK_URL_RE.test(body)) {
    problem(
      "artifacts/api-server/package.json's 'test' script no longer pins SUPABASE_URL to a loopback address. " +
        'That pin is the entire reason the unit tests marked pinnedTestEnv in ' +
        'artifacts/api-server/scripts/check-guard-coverage.mjs are exempt from the Supabase guard: CI runs ' +
        'them, and they were unguarded only because the invocation itself made the target unreachable. It no ' +
        'longer does. Either restore the pin, or import ' +
        GUARD_REL +
        ' in those files and drop their exemptions.',
    );
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CI SURFACE, DERIVED — not asserted, not copied from a comment.
//
// Read every workflow under .github/workflows/, take the api-server package
// scripts they invoke through the two wrappers, then follow those scripts
// through package.json and through scripts/run-all-checks.sh until the set
// stops growing. The entry files are whatever src/ paths the resolved script
// bodies name.
// ─────────────────────────────────────────────────────────────────────────────
const WRAPPER_INVOCATIONS = [
  // bash .github/scripts/pnpm-run.sh <dir> <name> <script>
  /pnpm-run\.sh[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)/g,
  // bash .github/scripts/run-live-suite.sh <label> <dir> <name> <script>
  /run-live-suite\.sh[ \t]+\S+[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)/g,
];
const API_SERVER_DIR = 'artifacts/api-server';
const SRC_PATH_RE = /(?:^|[\s"'`=])(src\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|mjs|js))/g;

function deriveCiSurface(pkg) {
  const workflowsDir = join(REPO_ROOT, '.github', 'workflows');
  if (!existsSync(workflowsDir)) {
    problem(
      '.github/workflows/ does not exist, so the CI surface cannot be derived and every "CI never invokes ' +
        'this" exemption below would be accepted on nothing. Refusing.',
    );
    return { scripts: new Set(), files: new Set() };
  }

  const scripts = new Set();
  for (const name of readdirSync(workflowsDir)) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(join(workflowsDir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*(#|\/\/)/.test(line)) continue;
      for (const re of WRAPPER_INVOCATIONS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const [, dir, , script] = m;
          if (dir === API_SERVER_DIR) scripts.add(script);
        }
      }
    }
  }

  // Transitive closure through package.json script bodies and through any shell
  // script they invoke inside this package (scripts/run-all-checks.sh is the
  // one that exists today; the rule is written for the shape, not the file).
  const seen = new Set();
  const files = new Set();
  const queue = [...scripts];
  while (queue.length > 0) {
    const scriptName = queue.pop();
    if (seen.has(scriptName)) continue;
    seen.add(scriptName);
    const body = (pkg.scripts ?? {})[scriptName];
    if (typeof body !== 'string') continue;

    const bodies = [body];

    // `bash scripts/foo.sh` inside a package script: read the shell script too.
    for (const m of body.matchAll(/(?:bash|sh)[ \t]+((?:\.\/)?[A-Za-z0-9_./-]+\.sh)\b/g)) {
      const shPath = join(PKG_ROOT, m[1]);
      if (existsSync(shPath)) bodies.push(readFileSync(shPath, 'utf8'));
    }

    for (const text of bodies) {
      for (const m of text.matchAll(/pnpm[ \t]+run[ \t]+([A-Za-z0-9:_-]+)/g)) {
        scripts.add(m[1]);
        queue.push(m[1]);
      }
      SRC_PATH_RE.lastIndex = 0;
      let f;
      while ((f = SRC_PATH_RE.exec(text)) !== null) files.add(f[1]);
    }
  }

  return { scripts, files };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan.
// ─────────────────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const relFromPkg = (abs) => relative(PKG_ROOT, abs).split(sep).join('/');

if (!existsSync(SRC) || !statSync(SRC).isDirectory()) {
  problem(
    `${relative(REPO_ROOT, SRC)} does not exist. This check is running outside the api-server package, or ` +
      'the tree moved. It scans nothing, which is a failure, not a pass.',
  );
  process.exit(1);
}

const pkgPath = join(PKG_ROOT, 'package.json');
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  problem(
    `artifacts/api-server/package.json is unparseable: ${err.message}. Neither the CI surface nor the ` +
      'pinned-test-env premise can be established, so nothing below can be evaluated. Refusing.',
  );
  process.exit(1);
}

const sourceFiles = walk(SRC).filter((f) => /\.(ts|tsx|mts|mjs|js)$/.test(f));

const reachable = [];
const guarded = [];
const guardedStrict = [];
const guardedReadOnly = [];
const readOnlyImporters = new Set();
for (const abs of sourceFiles) {
  const rel = relFromPkg(abs);

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    problem(
      `${rel} could not be read (${err.message}). A source file this check cannot open is a file whose ` +
        'Supabase reachability is unknown, and unknown is not exempt.',
    );
    continue;
  }
  // AN UNPARSEABLE SOURCE FILE IS A FAILURE, NOT A SKIP. A file that does not
  // decode as text cannot be classified, and "cannot be classified" is not a
  // synonym for "exempt" — that substitution is how a scan quietly stops
  // covering things. A NUL byte means it is not UTF-8 text at all; U+FFFD means
  // the decode replaced bytes it could not represent, so the text being matched
  // against is not the text on disk.
  if (text.includes('\u0000') || text.includes('\uFFFD')) {
    problem(
      `${rel} does not decode as UTF-8 text (it contains a NUL byte or a replacement character), so this ` +
        'check cannot read what it does. An unclassifiable source file fails rather than passing as exempt.',
    );
    continue;
  }

  // ── Who reaches the policy module directly. Checked for EVERY file, before
  // the machinery files are skipped below, because "only the two front doors
  // import it" is a claim about the whole tree — including about the machinery.
  if (POLICY_IMPORT_RE.test(text) && !FRONT_DOORS.has(rel)) {
    problem(
      `${rel} imports ${POLICY_REL} directly. That module takes the MODE as an argument, so importing it ` +
        'directly is how a write-capable entry point would hand itself the read-only production audit ' +
        'capability. Import a front door instead: ' +
        `${GUARD_REL} (the sanctioned CI project, or exit 2) or ${READONLY_GUARD_REL} (the same, plus a ` +
        'read-only audit of declared production, outside CI only, and available only to the files listed in ' +
        'READ_ONLY_AUDIT_ENTRY_POINTS in this file).',
    );
  }

  if (GUARD_MACHINERY.has(rel)) continue; // the guard is not its own client

  const importsStrictGuard = GUARD_IMPORT_RE.test(text);
  const importsReadOnlyGuard = READONLY_GUARD_IMPORT_RE.test(text);
  const importsGuard = importsStrictGuard || importsReadOnlyGuard;
  const canReach = CREDENTIAL_NAME_RE.test(text) || CREATE_CLIENT_RE.test(text);

  if (importsReadOnlyGuard) readOnlyImporters.add(rel);

  if (importsStrictGuard && importsReadOnlyGuard) {
    problem(
      `${rel} imports BOTH ${GUARD_REL} and ${READONLY_GUARD_REL}. Only one of them runs first, so which ` +
        'rule is in force depends on import order rather than on anything a reader can see. Pick the door ' +
        'that matches what this file does to the database and delete the other import.',
    );
  }

  if (importsGuard) {
    guarded.push(rel);
    if (importsStrictGuard) guardedStrict.push(rel);
    if (importsReadOnlyGuard) guardedReadOnly.push(rel);
    // The guard's whole mechanism is ES module evaluation order, so it has to
    // be the FIRST import. Placed after `@supabase/supabase-js`, that module is
    // already loaded before the refusal — a weaker property than the one the
    // guard's header claims.
    const importLines = text.split('\n').filter((l) => ANY_IMPORT_RE.test(l));
    if (importLines.length > 0 && !EITHER_GUARD_IMPORT_RE.test(importLines[0])) {
      problem(
        `${rel} imports a Supabase guard front door, but it is not the FIRST import — ` +
          `\`${importLines[0].trim()}\` comes before it. The guard works by ES module evaluation order: an ` +
          "import is evaluated before the importing module's body, and imports are evaluated in source " +
          'order. Placed second, every module above it — including @supabase/supabase-js — is fully loaded ' +
          'before the allowlist is consulted. Move the guard import to the top of the import block.',
      );
    }
  }
  if (canReach) reachable.push({ rel, importsGuard });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE READ-ONLY CAPABILITY IS SCOPED TO FOUR FILES, IN BOTH DIRECTIONS.
// ─────────────────────────────────────────────────────────────────────────────
if (!Array.isArray(READ_ONLY_AUDIT_ENTRY_POINTS) || READ_ONLY_AUDIT_ENTRY_POINTS.length === 0) {
  problem(
    'READ_ONLY_AUDIT_ENTRY_POINTS in artifacts/api-server/scripts/check-guard-coverage.mjs is empty or is ' +
      'not an array. With it empty, "only these files may audit production read-only" is a claim about a set ' +
      'this check can no longer describe, and every importer of ' +
      `${READONLY_GUARD_REL} would be reported instead of scoped. Restore the entries and their reasons.`,
  );
}

const readOnlyDeclared = new Set();
for (const entry of READ_ONLY_AUDIT_ENTRY_POINTS) {
  if (typeof entry?.file !== 'string' || entry.file === '') {
    problem(`A READ_ONLY_AUDIT_ENTRY_POINTS entry has no 'file': ${JSON.stringify(entry)}.`);
    continue;
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
    problem(
      `READ_ONLY_AUDIT_ENTRY_POINTS entry '${entry.file}' has no usable reason. Every entry must say, in ` +
        'prose, what this file sends to the database — the grant rests on the claim that it only reads, and ' +
        'a reason short enough to be a label is a reason nobody wrote.',
    );
    continue;
  }
  if (readOnlyDeclared.has(entry.file)) {
    problem(
      `READ_ONLY_AUDIT_ENTRY_POINTS lists '${entry.file}' twice. A duplicated grant hides which reason is in ` +
        'force.',
    );
    continue;
  }
  readOnlyDeclared.add(entry.file);

  if (!existsSync(join(PKG_ROOT, entry.file))) {
    problem(
      `READ_ONLY_AUDIT_ENTRY_POINTS names '${entry.file}', which does not exist. A stale grant is a line a ` +
        'reviewer reads as a considered decision about a file that is not there. Remove it.',
    );
    continue;
  }
  if (!readOnlyImporters.has(entry.file)) {
    problem(
      `READ_ONLY_AUDIT_ENTRY_POINTS names '${entry.file}', but that file does not import ` +
        `${READONLY_GUARD_REL} as an import statement. Either it moved back behind ${GUARD_REL} — in which ` +
        'case delete this entry in the same change — or its guard import was removed altogether, in which ' +
        'case it is now unguarded and this list is the only place that still claims otherwise.',
    );
  }
}

for (const rel of [...readOnlyImporters].sort()) {
  if (readOnlyDeclared.has(rel)) continue;
  problem(
    `${rel} imports ${READONLY_GUARD_REL} but is not listed in READ_ONLY_AUDIT_ENTRY_POINTS in ` +
      'artifacts/api-server/scripts/check-guard-coverage.mjs. That import is a capability: outside CI, with ' +
      'the intent variable set, this process may point itself at declared PRODUCTION. It is granted to a ' +
      'closed, reviewable set of read-only audits. If this file genuinely only issues SELECTs, add an entry ' +
      `saying which statements it sends. If it writes anything at all, import ${GUARD_REL} instead — the ` +
      'write-capable entry points cannot reach this capability precisely because it is not in the module ' +
      'they import.',
  );
}

// ── Vacuity gates. ──────────────────────────────────────────────────────────
if (sourceFiles.length === 0) {
  problem(
    'Zero source files were scanned under src/. Either the tree is empty or the file filter no longer ' +
      'matches anything; both mean this check is verifying nothing.',
  );
}
if (reachable.length === 0) {
  problem(
    'Zero files under src/ were classified as able to reach Supabase. That is not credible for this package ' +
      '(it ships a Supabase-backed API server), so the reachability patterns have stopped matching and this ' +
      'check has silently become a no-op. Re-derive CREDENTIAL_NAME_RE / CREATE_CLIENT_RE.',
  );
}
if (!Array.isArray(EXEMPT) || EXEMPT.length === 0) {
  problem(
    'The EXEMPT list in artifacts/api-server/scripts/check-guard-coverage.mjs is empty or is not an array. ' +
      'An empty exempt list makes "every reachable file is guarded or exempt" a claim about a set this ' +
      'check can no longer describe. Restore the entries and their reasons.',
  );
}

const exemptByFile = new Map();
for (const entry of EXEMPT) {
  if (typeof entry?.file !== 'string' || entry.file === '') {
    problem(`An EXEMPT entry has no 'file': ${JSON.stringify(entry)}.`);
    continue;
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
    problem(
      `EXEMPT entry '${entry.file}' has no usable reason. Every exemption must say, in prose, what makes CI ` +
        'unable to invoke this file — a reason short enough to be a label is a reason nobody wrote.',
    );
    continue;
  }
  if (exemptByFile.has(entry.file)) {
    problem(`EXEMPT lists '${entry.file}' twice. A duplicated exemption hides which reason is in force.`);
    continue;
  }
  exemptByFile.set(entry.file, entry);
}

const { scripts: ciScripts, files: ciFiles } = deriveCiSurface(pkg);
if (ciScripts.size === 0) {
  problem(
    'No api-server package scripts were found to be invoked by any workflow under .github/workflows/. The CI ' +
      'surface is what every "CI never invokes this" exemption rests on; with it empty, every exemption is ' +
      'accepted on no evidence. Either the workflows changed shape, or this derivation is broken.',
  );
}

const pinnedOk = assertPinnedTestEnv(pkg);

// ── The rule. ───────────────────────────────────────────────────────────────
const unguardedOnCiSurface = [];
const exemptUsed = new Set();

for (const { rel, importsGuard } of reachable) {
  if (importsGuard) {
    if (exemptByFile.has(rel)) {
      problem(
        `${rel} both imports a Supabase guard front door and is listed in EXEMPT. The exemption is stale ` +
          'and misleading — ' +
          'a reader of the list would conclude this file is unguarded. Remove the EXEMPT entry.',
      );
      exemptUsed.add(rel);
    }
    continue;
  }

  const onCiSurface = ciFiles.has(rel);
  const entry = exemptByFile.get(rel);

  if (entry) {
    exemptUsed.add(rel);
    if (onCiSurface && !entry.pinnedTestEnv) {
      problem(
        `${rel} is EXEMPT from ${GUARD_REL}, but CI invokes it: it is named by an api-server package script ` +
          `that a workflow runs (${[...ciScripts].sort().join(', ')}). Exemption is only available to files ` +
          'CI does not invoke — the reason on the entry says CI never runs it, and that is now false. Add ' +
          `\`import "…/${GUARD_REL.replace('src/lib/', 'lib/')}";\` as the first import and remove the entry.`,
      );
    }
    if (entry.pinnedTestEnv && !onCiSurface) {
      problem(
        `${rel} is marked pinnedTestEnv in EXEMPT — an exemption that exists ONLY because CI runs it with a ` +
          'pinned loopback target — but it is no longer on the CI surface at all. The narrower exemption no ' +
          'longer describes it. Reclassify it deliberately.',
      );
    }
    if (entry.pinnedTestEnv && !pinnedOk) {
      problem(
        `${rel} depends on the loopback pin in the 'test' script, which is gone (reported above). It is CI-` +
          'invoked and unguarded with no premise left. Import the guard or restore the pin.',
      );
    }
    continue;
  }

  if (onCiSurface) unguardedOnCiSurface.push(rel);

  problem(
    `${rel} can reach Supabase (it names a Supabase credential env var or calls createClient) but neither ` +
      `imports a guard front door (${GUARD_REL}, or ${READONLY_GUARD_REL} for the read-only audits) ` +
      'nor appears on the EXEMPT list in ' +
      'artifacts/api-server/scripts/check-guard-coverage.mjs. ' +
      (onCiSurface
        ? 'CI INVOKES IT, so it must import the guard — add the import as the first import in the file. '
        : 'If CI never invokes it, add an EXEMPT entry saying WHY CI cannot invoke it, and note that the ' +
          'exemption means the file is unguarded rather than safe. ') +
      'The guard is opt-in; a file that does not opt in is not covered by anything, whatever the guard\'s ' +
      'header says about "every process that can reach Supabase".',
  );
}

for (const [file] of exemptByFile) {
  if (exemptUsed.has(file)) continue;
  const abs = join(PKG_ROOT, file);
  if (!existsSync(abs)) {
    problem(
      `EXEMPT names '${file}', which does not exist. A stale exemption is a line a reviewer reads as a ` +
        'considered decision about a file that is not there. Remove it.',
    );
  } else {
    problem(
      `EXEMPT names '${file}', but this check no longer classifies it as able to reach Supabase. Either the ` +
        'file stopped touching Supabase — in which case delete the entry — or the reachability patterns ' +
        'stopped seeing how it does, in which case OTHER unguarded reachers are being missed too and the ' +
        'patterns must be re-derived. Both need a human.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report.
// ─────────────────────────────────────────────────────────────────────────────
notes.push(
  `${sourceFiles.length} source file(s) scanned under artifacts/api-server/src/; ${reachable.length} can ` +
    `reach Supabase directly; ${guarded.length} import a guard front door (${guardedStrict.length} strict, ` +
    `${guardedReadOnly.length} read-only-audit); ${exemptByFile.size} exempt with a written reason.`,
);
notes.push(
  `CI surface derived from .github/workflows/ + package.json: script(s) ${[...ciScripts].sort().join(', ') || 'none'}; ` +
    `${ciFiles.size} entry file path(s) named by them.`,
);
notes.push(
  'DOES NOT COVER, stated rather than implied: (1) TRANSITIVE reach — a file that calls into ' +
    'src/lib/supabase.ts getServiceClient() is not counted, because the guard deliberately does not sit in ' +
    'that factory (it would refuse production boot); (2) a file that reaches Supabase through an HTTP client ' +
    'with a hardcoded or externally-supplied URL, naming no credential variable and calling no createClient; ' +
    '(3) whether an exempt file is SAFE — it is not; exemption means unguarded; (4) anything outside ' +
    'artifacts/api-server/src/; (5) WHETHER THE READ-ONLY AUDITS ARE ACTUALLY READ-ONLY — no pattern ' +
    'here inspects the SQL a script sends. That was established by reading them; what is enforced here is ' +
    'that the set is closed, so granting the capability to a further file is a diff in ' +
    'READ_ONLY_AUDIT_ENTRY_POINTS rather than an import nobody notices.',
);

console.log('');
console.log('Supabase guard coverage');
console.log('=======================');
console.log('');
console.log(`| metric | count |`);
console.log(`| --- | --- |`);
console.log(`| source files scanned | ${sourceFiles.length} |`);
console.log(`| can reach Supabase directly | ${reachable.length} |`);
console.log(`| import ${GUARD_REL} (strict) | ${guardedStrict.length} |`);
console.log(`| import ${READONLY_GUARD_REL} | ${guardedReadOnly.length} |`);
console.log(`| exempt, with a written reason | ${exemptByFile.size} |`);
console.log(`| unguarded AND on the CI surface | ${unguardedOnCiSurface.length} |`);
console.log('');
console.log(`Strict entry points (${GUARD_REL} — sanctioned CI project only):`);
for (const g of guardedStrict.sort()) console.log(`  ${g}`);
console.log('');
console.log(
  `Read-only audit entry points (${READONLY_GUARD_REL} — the same, plus a read-only audit of declared`,
);
console.log('production outside CI on a deliberate request):');
for (const g of guardedReadOnly.sort()) console.log(`  ${g}`);
for (const n of notes) console.log(`\nNOTE: ${n}`);

if (problems.length > 0) {
  console.error('');
  console.error(`${problems.length} problem(s) found.`);
  console.error('The Supabase guard is OPT-IN. Every file that can reach the database is either behind it or');
  console.error('on a list that says, in writing, why CI cannot invoke it — and that an exemption means the');
  console.error('file is unguarded, not that it is safe.');
  process.exit(1);
}

console.log('');
console.log(
  `All ${reachable.length} Supabase-reaching file(s) accounted for: ${guarded.length} guarded, ` +
    `${exemptByFile.size} exempt with a reason.`,
);
