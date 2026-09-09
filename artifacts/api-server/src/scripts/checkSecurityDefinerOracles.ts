/**
 * checkSecurityDefinerOracles — a SECURITY DEFINER function that nothing in the
 * database references is an authorization oracle exposed to the internet.
 *
 * Every function in `public` is reachable over PostgREST as `POST /rpc/<name>`,
 * and Supabase's default privileges grant EXECUTE to `anon` and `authenticated`
 * on creation. A SECURITY DEFINER function runs as its owner, so it answers
 * questions the caller could not otherwise ask. When such a function is called
 * by a policy, a trigger, a view or the application, that exposure is the price
 * of the mechanism. When NOTHING calls it, the exposure is the whole of its
 * effect: an anonymous caller with a uuid gets an authorization answer, and the
 * product gets nothing back.
 *
 * That is not hypothetical here. `public.shares_trip_with(uuid)` was exactly
 * this — a membership oracle callable by anon over PostgREST, referenced by no
 * surviving policy — and migration 2533 dropped it for that reason. This check
 * exists so the next one is caught in the diff rather than in an advisory.
 *
 * ── WHY THIS DOES NOT ASK FOR A REVOKE ───────────────────────────────────────
 * The obvious remedy for "anon can execute this" is to REVOKE EXECUTE. For a
 * function a POLICY calls, that remedy BREAKS THE TABLE. This was measured, not
 * reasoned about, on the CI project:
 *
 *     create policy p on t for select using (probe(id));   -- probe is DEFINER
 *     set role authenticated; select count(*) from t;      -- 1 row
 *     revoke execute on function probe(uuid) from public, anon, authenticated;
 *     set role authenticated; select count(*) from t;
 *       -> ERROR: permission denied for function probe
 *
 * The policy expression is evaluated as the querying role, and the EXECUTE
 * privilege is checked there. It fails the same way for `language sql` and
 * `language plpgsql`; both were run. So for a policy-referenced function the
 * EXECUTE grant is LOAD-BEARING, and revoking it turns a working read into a
 * hard error for every end-user token. The remedy for an unreferenced one is to
 * DROP it — which is what 2533 did — and the remedy for a referenced one is
 * that there is nothing to remedy at this layer. A future session reading a
 * "SECURITY DEFINER callable by anon" advisory should read this paragraph
 * before writing a REVOKE migration.
 *
 * ── WHAT COUNTS AS A REFERENCE ───────────────────────────────────────────────
 * Five sources, all read from the corpus rather than assumed: a surviving RLS
 * policy's USING/WITH CHECK text, another function's body, a view definition, a
 * trigger's EXECUTE FUNCTION clause, and the function's name appearing as a
 * STRING LITERAL in comment-stripped src/ TypeScript. A function with none of
 * the five must carry a ledger entry in SECURITY_DEFINER_ORACLES.json saying
 * why it still exists.
 *
 * The application half is deliberately loose. The first version of this check
 * looked for `.rpc("name")` and reported eleven functions as called by nothing;
 * every one of them was in fact called, through
 * `tryRpc(client, "rb_adjust_buddy_counter", …)` — a helper that takes the name
 * as an argument, so the literal never sits next to `.rpc`. Matching any string
 * literal over-counts (a name in a test fixture counts as a reference), and
 * that is the direction to err in: a missed finding costs an oracle nobody
 * revisits, while a false finding invites a DROP migration against a live call
 * site. Comments are stripped first, so prose about a function is not a use of
 * it — the distinction that survived that fix is exactly the one that mattered.
 *
 * ── RETURNS trigger IS NOT AN RPC SURFACE ────────────────────────────────────
 * A function declared `RETURNS trigger` cannot be called as one: PostgREST does
 * not expose it, and Postgres itself refuses with "trigger functions can only
 * be called as triggers". So `handle_new_user`, whose trigger lives on
 * `auth.users` and therefore outside this public-schema corpus, is not an
 * unreferenced oracle merely because no CREATE TRIGGER for it is visible here.
 * These are counted separately and excluded from the finding, rather than
 * ledgered away — an exclusion on a stated mechanism, not on a judgement.
 *
 * ── IT MUST PROVE IT LOOKED ──────────────────────────────────────────────────
 * "No unreferenced SECURITY DEFINER functions" is also what this prints for a
 * corpus it could not parse: if the CREATE FUNCTION shape changed, zero
 * functions are found and every one of them is trivially referenced. So the
 * populations are counted and printed, and a zero in any of them FAILS: corpus
 * files read, SECURITY DEFINER functions alive at the end of the corpus,
 * surviving policies, and reference edges actually resolved.
 *
 * ── WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ───────────────────────
 * (1) It reads the REPOSITORY corpus, not the live database. A function created
 *     by hand in production is invisible to it; `mcp__Supabase__get_advisors`
 *     and auditMigrationsVsLive are the live-side instruments.
 * (2) It does not judge whether a REFERENCED function leaks more than its
 *     policy needs. `viewer_is_blocked(target_id)` tells its caller that a
 *     particular user has blocked them, which is information a blocked party is
 *     not otherwise given; it is referenced by seven policies, so it is not
 *     reported here, and the EXECUTE grant cannot be withdrawn without breaking
 *     them. That is a product question, recorded in the blocker ledger, not a
 *     defect this check can decide.
 * (3) It does not check the grants themselves. Whether `anon` actually holds
 *     EXECUTE is a live fact; what is checked here is the shape that makes the
 *     grant matter.
 *
 * Run: node --import tsx/esm src/scripts/checkSecurityDefinerOracles.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripSqlComments, splitStatements } from "./lib/canonicalSchema.js";
import { stripComments } from "./lib/stripComments.js";
/**
 * A DO block can author a function body without a CREATE statement — the Trips
 * kernel transforms do exactly that. See lib/transformedFunction.ts for the
 * concrete defect this closes (trip_proposal_tally reported as referenced by
 * nothing) and for why the marker requires BOTH halves of a transform.
 */
import { transformedFunctionName } from "./lib/transformedFunction.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url).pathname;
const BASELINE = new URL("../../baseline/20260819_baseline_structure.sql", import.meta.url).pathname;
const SRC_DIR = new URL("../", import.meta.url).pathname;
const LEDGER = new URL("./SECURITY_DEFINER_ORACLES.json", import.meta.url).pathname;

/** A corpus this small is a corpus this check could not find. */
const MIN_CORPUS_FILES = 400;
const MIN_DEFINER_FUNCTIONS = 20;
const MIN_POLICIES = 100;
const MIN_REFERENCE_EDGES = 20;

const CLASSIFICATIONS = ["RPC-BY-DESIGN:", "OPERATOR-ONLY:", "PENDING-OWNER:", "HOLD:", "DEAD:"];

interface Ledger {
  unreferenced: Record<string, string>;
}

interface DefinerFn {
  name: string;
  /** The file that last defined it — what a reviewer needs to go and read. */
  file: string;
  /** `RETURNS trigger`: not callable as an RPC by PostgREST or by Postgres. */
  triggerFn: boolean;
}

function ident(raw: string): string {
  // public.foo | "foo" | foo  ->  foo
  return raw.replace(/"/g, "").replace(/^[A-Za-z0-9_]+\./, "").toLowerCase();
}

// ── read the corpus ──────────────────────────────────────────────────────────
const corpus: Array<{ file: string; sql: string }> = [];
corpus.push({ file: "baseline/20260819_baseline_structure.sql", sql: readFileSync(BASELINE, "utf8") });
for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
  if (!name.endsWith(".sql")) continue;
  corpus.push({ file: `src/migrations/${name}`, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") });
}

const definers = new Map<string, DefinerFn>();
/** name -> the text that references it, for the edge count and for reporting. */
const references = new Map<string, Set<string>>();
/** "table::policy" -> predicate text, so a later DROP/CREATE replaces rather than adds. */
const policies = new Map<string, string>();
const viewBodies: string[] = [];
const triggerClauses: string[] = [];
const functionBodies: Array<{ name: string; body: string }> = [];
/** How many bodies came from a transform rather than a CREATE. Reported, so a
 *  drop to zero — the marker silently ceasing to match — is visible. */
let transformedBodies = 0;

const CREATE_FN = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+("?[A-Za-z0-9_."]+"?)\s*\(/i;
const DROP_FN = /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?("?[A-Za-z0-9_."]+"?)\s*\(/i;
const CREATE_POLICY = /\bCREATE\s+POLICY\s+("?[A-Za-z0-9_ ."-]+?"?)\s+ON\s+("?[A-Za-z0-9_."]+"?)/i;
const DROP_POLICY = /\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("?[A-Za-z0-9_ ."-]+?"?)\s+ON\s+("?[A-Za-z0-9_."]+"?)/i;
const CREATE_VIEW = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+("?[A-Za-z0-9_."]+"?)/i;
const CREATE_TRIGGER = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i;


for (const { file, sql } of corpus) {
  for (const raw of splitStatements(stripSqlComments(sql))) {
    const stmt = raw.trim();
    if (!stmt) continue;

    const dropFn = DROP_FN.exec(stmt);
    if (dropFn) definers.delete(ident(dropFn[1]!));

    // A verified transform authors a function body without a CREATE statement.
    // See TRANSFORM_READS above for why this is recognised and why the marker
    // is both halves rather than either.
    const transformed = transformedFunctionName(stmt);
    if (transformed) {
      transformedBodies += 1;
      functionBodies.push({ name: transformed, body: stmt });
      continue;
    }

    const createFn = CREATE_FN.exec(stmt);
    if (createFn) {
      const name = ident(createFn[1]!);
      if (/\bSECURITY\s+DEFINER\b/i.test(stmt)) {
        definers.set(name, { name, file, triggerFn: /\bRETURNS\s+trigger\b/i.test(stmt) });
      }
      else definers.delete(name); // redefined as INVOKER: no longer an oracle
      functionBodies.push({ name, body: stmt });
      continue;
    }

    const dropPol = DROP_POLICY.exec(stmt);
    if (dropPol) policies.delete(`${ident(dropPol[2]!)}::${ident(dropPol[1]!)}`);

    const createPol = CREATE_POLICY.exec(stmt);
    if (createPol) {
      policies.set(`${ident(createPol[2]!)}::${ident(createPol[1]!)}`, stmt);
      continue;
    }

    if (CREATE_VIEW.test(stmt)) { viewBodies.push(stmt); continue; }
    if (CREATE_TRIGGER.test(stmt)) { triggerClauses.push(stmt); continue; }
  }
}

// ── application .rpc("name") calls, over comment-stripped source ─────────────
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "migrations") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const literalNames = new Set<string>();
let tsFiles = 0;
for (const f of walkTs(SRC_DIR)) {
  tsFiles++;
  const s = stripComments(readFileSync(f, "utf8"));
  for (const m of s.matchAll(/(["'`])([A-Za-z0-9_]{4,})\1/g)) literalNames.add(m[2]!.toLowerCase());
}

// ── resolve reference edges ──────────────────────────────────────────────────
function noteRef(name: string, source: string): void {
  let set = references.get(name);
  if (!set) { set = new Set(); references.set(name, set); }
  set.add(source);
}

for (const name of definers.keys()) {
  const call = new RegExp(`\\b${name}\\s*\\(`, "i");
  for (const [key, text] of policies) if (call.test(text)) noteRef(name, `policy ${key}`);
  for (const { name: owner, body } of functionBodies) {
    if (owner !== name && call.test(body)) noteRef(name, `function ${owner}`);
  }
  for (const v of viewBodies) if (call.test(v)) noteRef(name, "view");
  for (const t of triggerClauses) if (call.test(t)) noteRef(name, "trigger");
  if (literalNames.has(name)) noteRef(name, "named as a string literal in src/");
}

const edges = [...references.values()].reduce((n, s) => n + s.size, 0);
/**
 * Functions kept alive ONLY by a name appearing in a string literal. That is
 * the weakest of the five reference kinds and the one most likely to be a stale
 * test fixture rather than a call site, so it is printed rather than left to be
 * inferred from a pass. claim_invite_link_slot is here: its only mention in
 * src/ is a fake's dispatch arm in tripsExpansion.test.ts, and the invite path
 * calls claim_invite_link_slot_for_user instead.
 */
const literalOnly = [...definers.values()]
  .filter((f) => !f.triggerFn)
  .filter((f) => {
    const refs = references.get(f.name);
    return refs !== undefined && [...refs].every((r) => r.startsWith("named as a string literal"));
  })
  .map((f) => f.name)
  .sort();
const triggerFns = [...definers.values()].filter((f) => f.triggerFn && !references.has(f.name));
const unreferenced = [...definers.values()]
  .filter((f) => !references.has(f.name) && !f.triggerFn)
  .sort((a, b) => a.name.localeCompare(b.name));

// ── the ledger ───────────────────────────────────────────────────────────────
const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
const ledgered = new Map(Object.entries(ledger.unreferenced ?? {}).filter(([k]) => !k.startsWith("//")));

const problems: string[] = [];

for (const fn of unreferenced) {
  const reason = ledgered.get(fn.name);
  if (reason === undefined) {
    problems.push(
      `::error::public.${fn.name} is SECURITY DEFINER (last defined in ${fn.file}) and NOTHING references it — ` +
        `no surviving policy, no other function body, no view, no trigger, no application .rpc() call. Over ` +
        `PostgREST it is POST /rpc/${fn.name}, and Supabase's default privileges grant EXECUTE on it to anon and ` +
        `authenticated, so its entire remaining effect is to answer an authorization question for anyone who ` +
        `asks. This is the shape migration 2533 dropped shares_trip_with for. Either DROP it, wire it to the ` +
        `thing that was meant to call it, or add an entry to src/scripts/SECURITY_DEFINER_ORACLES.json saying ` +
        `why it stays. Do NOT "fix" it with a REVOKE — see this check's header for the measurement showing that ` +
        `a revoke breaks every policy that calls a definer function.`,
    );
  }
}

for (const [name, reason] of ledgered) {
  if (!definers.has(name)) {
    problems.push(
      `::error::SECURITY_DEFINER_ORACLES.json names "${name}", which is not a SECURITY DEFINER function in the ` +
        `corpus any more — it was dropped, redefined as SECURITY INVOKER, or renamed. Delete the entry.`,
    );
    continue;
  }
  if (references.has(name)) {
    problems.push(
      `::error::SECURITY_DEFINER_ORACLES.json names "${name}" as unreferenced, but it is now referenced by ` +
        `${[...references.get(name)!].join(", ")}. The entry no longer describes it; delete it.`,
    );
    continue;
  }
  if (!CLASSIFICATIONS.some((c) => reason.startsWith(c))) {
    problems.push(
      `::error::SECURITY_DEFINER_ORACLES.json entry "${name}" must begin with one of ${CLASSIFICATIONS.join(" ")} ` +
        `— an unclassified reason is a note, not a decision.`,
    );
  } else if (reason.length < 80) {
    problems.push(
      `::error::SECURITY_DEFINER_ORACLES.json entry "${name}" is ${reason.length} characters. An exposed ` +
        `authorization oracle needs a reason a reviewer can act on, not a label.`,
    );
  }
}

// ── non-vacuity ──────────────────────────────────────────────────────────────
if (corpus.length < MIN_CORPUS_FILES) problems.push(`::error::read ${corpus.length} corpus file(s), expected at least ${MIN_CORPUS_FILES} — this check did not find the migrations.`);
if (definers.size < MIN_DEFINER_FUNCTIONS) problems.push(`::error::found ${definers.size} SECURITY DEFINER function(s), expected at least ${MIN_DEFINER_FUNCTIONS} — the CREATE FUNCTION shape is no longer recognised, and every function is trivially "referenced".`);
if (policies.size < MIN_POLICIES) problems.push(`::error::found ${policies.size} surviving policy/policies, expected at least ${MIN_POLICIES} — with no policies parsed, every definer function looks unreferenced.`);
if (edges < MIN_REFERENCE_EDGES) problems.push(`::error::resolved ${edges} reference edge(s), expected at least ${MIN_REFERENCE_EDGES} — the call-site pattern matched nothing.`);

for (const p of problems) console.error(p);

console.log(
  `\nNOTE: ${corpus.length} corpus file(s) read (baseline + ${corpus.length - 1} migration(s)) and ${tsFiles} TypeScript ` +
    `file(s) scanned for name literals; ${definers.size} SECURITY DEFINER function(s) alive at the end of the corpus; ` +
    `${policies.size} surviving policy/policies; ${edges} reference edge(s) resolved; ${unreferenced.length} function(s) ` +
    `unreferenced, ${ledgered.size} of them ledgered; ${triggerFns.length} further RETURNS trigger function(s) with no ` +
    `visible CREATE TRIGGER, excluded because Postgres refuses to call a trigger function any other way.`,
);
console.log(
  `NOTE: ${literalOnly.length} definer function(s) are referenced ONLY by a string literal in src/ and by nothing in ` +
    `the database — the weakest reference kind, and the one a stale test fixture produces` +
    `${literalOnly.length > 0 ? `: ${literalOnly.join(", ")}` : ""}. Not a failure; a place to look.`,
);
console.log(
  `NOTE: DOES NOT COVER — (1) the LIVE database: a function created by hand in production is invisible here; ` +
    `(2) whether a REFERENCED definer function leaks more than its policy needs (viewer_is_blocked does); ` +
    `(3) the grants themselves, which are a live fact. And the remedy for a finding is a DROP, never a REVOKE: ` +
    `revoking EXECUTE on a policy-referenced definer function makes the policy itself raise "permission denied ` +
    `for function", measured on CI for both language sql and language plpgsql.`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("check:security-definer-oracles PASSED");
