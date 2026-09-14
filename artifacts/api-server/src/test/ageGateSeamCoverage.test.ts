/**
 * THE MECHANISM THAT MAKES THE EIGHTH GATE FAIL SAFE.
 *
 * Routing seven existing gates through `lib/gateAge.ts` fixes seven gates. It
 * does nothing about the eighth, added next month by someone who writes what
 * the surrounding code looks like — `.select("date_of_birth")` and some
 * arithmetic — and is wrong in exactly the way these seven were, with nobody
 * the wiser. That is how this defect got to be seven gates wide in the first
 * place.
 *
 * Two things change that, and this file is the second of them.
 *
 *   1. THE TYPE. `GateAge` is a discriminated union whose `age` lives only in
 *      the `ok` arm, so `resolved.age` does not COMPILE until the author has
 *      narrowed past `verified_minor` and `unreadable`. Asserted below both as
 *      a compile-time `@ts-expect-error` (checked by tsconfig.test.json) and as
 *      a shape assertion on the declaration, because a future "convenience"
 *      widening of the union would silently disarm the compiler half.
 *
 *   2. THIS SCAN. A file under `src/routes/**`, `src/services/**` or `src/lib/**`
 *      that reads
 *      `profiles.date_of_birth` must be routed through the seam — or be listed
 *      here with a reason someone wrote down. An eighth gate written the old way
 *      goes red on the commit that introduces it.
 *
 * Neither half is a substitute for the other: the type stops a gate that USES
 * the seam from using it wrongly, and the scan stops a gate from not using it.
 *
 * Run: node --import tsx --test src/test/ageGateSeamCoverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { ageForFailClosedFilter, type GateAge } from "../lib/gateAge.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, "..");

/**
 * Files that reference `date_of_birth` and are NOT age gates. Every entry names
 * what it does instead; an entry whose file later grows a gate must be removed
 * rather than left to launder it.
 */
const NOT_A_GATE: Record<string, string> = {
  "lib/gateAge.ts": "THE SEAM. It is the one place allowed to read the column.",
  "lib/travelerVerification.ts":
    "The Rent-a-Buddy identity helper, which applies the same contradiction rule " +
    "(verifiedAgeSignalFromRows) that the seam composes.",
  "lib/deletion/signalRules.ts":
    "A REGEX of PII field NAMES for the deletion-signal classifier. It matches the " +
    "string 'date_of_birth'; it does not read the column.",
  "lib/visuals/sanitize.ts":
    "A list of field NAMES stripped from visual-generation prompts. Same shape as " +
    "signalRules.ts — a redaction list, not a read.",
  "routes/profile.ts":
    "WRITE side (PATCH /me/profile sets the column) plus the PROFILE_COLUMNS select list. " +
    "The READ side — the ageGateRequired flag — is routed through the seam in the same file.",
  "routes/rentABuddy.ts":
    "WRITE side (the admin profile patch sets the column). The read side goes through " +
    "lib/travelerVerification.ts#loadTravelerIdentity, which applies the same rule.",
};

/**
 * GATES THIS CHANGE FOUND AND DID NOT OWN.
 *
 * These are not "not a gate" and they are not fixed. They are age gates reached
 * through `src/compass/**`, which is outside the file set this change was scoped
 * to, and they have the SAME defect the seven fixed ones had: a verified minor's
 * typed adult birthday passes them.
 *
 * They are listed here rather than left outside the scan because a gate nothing
 * is looking at is exactly how this became a seven-gate defect. The count below
 * may only SHRINK: routing one through the seam means deleting its line, and
 * adding a new unrouted gate to this ledger fails the count assertion instead of
 * being waved through.
 */
const KNOWN_UNROUTED: Record<string, string> = {
  "compass/CompassTools.ts":
    "prefsFromRow() derives GroupMemberPrefs.age from profiles.date_of_birth for the " +
    "group-travel tools. Feeds CompassSocialEngine.eventSatisfiesGroup, below.",
  "compass/CompassSocialEngine.ts":
    "eventSatisfiesGroup() gates an age-restricted event on the group's youngest KNOWN " +
    "age (`agg.youngestAge < ev.age_min`), and ageFromDob() is this file's own copy of " +
    "the un-contradicted arithmetic. A provider-verified minor in the group contributes " +
    "their typed adult age and the group passes an 18+ event.",
};

/** Imports that mean "this file's age answers come from the seam". */
const SEAM_IMPORTS = [
  "../lib/gateAge.js", "../../lib/gateAge.js", "./gateAge.js",
  "../lib/travelerVerification.js", "../../lib/travelerVerification.js", "./travelerVerification.js",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Files allowed to DEFINE date-of-birth-to-age arithmetic.
 *
 * `lib/ageEligibility.ts` owns the primitive and the seam is built on it.
 * Everywhere else a private copy is how a gate gets an age without the
 * contradiction rule — `services/media/MediaProjectionService.ts` had exactly
 * such a copy and it is deleted in this change rather than left unused.
 */
const AGE_ARITHMETIC_OWNERS = new Set(["lib/ageEligibility.ts", "lib/gateAge.ts"]);

/** A private DOB→age helper: `function ageFromDob(` / `const ageFromDob = ` / a calculate*Age. */
function definesOwnAgeArithmetic(code: string): boolean {
  return /\b(?:function|const|let)\s+(?:age\w*FromDob|calculate\w*Age)\b/.test(code);
}

/** Comments stripped — a line of PROSE about `date_of_birth` is not a read of it. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => { const k = l.indexOf("//"); return k < 0 ? l : l.slice(0, k); })
    .join("\n");
}

/**
 * The arms of the `GateAge` union, split at TOP-LEVEL `|`.
 *
 * Both halves must respect brace depth: the declaration ends at the first `;`
 * OUTSIDE an object type, and the `;` separating `state` from `age` inside the
 * `ok` arm is not that. A naive `/=([\s\S]*?);/` stops there and reports one
 * arm, which is a guard that passes while measuring nothing.
 */
export function gateAgeUnionArms(src: string): string[] {
  const start = src.indexOf("export type GateAge =");
  if (start < 0) return [];
  let i = start + "export type GateAge =".length;
  let depth = 0;
  let body = "";
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) break;
    body += ch;
  }
  const arms: string[] = [];
  let cur = "";
  depth = 0;
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === "|" && depth === 0) { if (cur.trim()) arms.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) arms.push(cur.trim());
  return arms;
}

/**
 * `lib` is scanned too, and that is not decoration: a gate does not have to live
 * in a route file. `lib/mediaEligibility.ts` IS a gate and it lives there, so the
 * next one could read `date_of_birth` from that directory and escape a scan that
 * covered only routes and services.
 *
 * `lib/database.types.ts` is generated and is EXCLUDED rather than allowlisted —
 * it declares every column in the database, so listing it as "not a gate" would
 * be listing the schema itself.
 */
const GATE_DIRS = [
  join(SRC, "routes"), join(SRC, "services"), join(SRC, "lib"), join(SRC, "compass"), join(SRC, "domain"),
];
const GENERATED = new Set(["lib/database.types.ts"]);
const FILES = GATE_DIRS.flatMap((d) => walk(d))
  .map((f) => ({ rel: relative(SRC, f).split(sep).join("/"), src: readFileSync(f, "utf8") }))
  .filter((f) => !GENERATED.has(f.rel));

describe("age-gate seam coverage — a new gate cannot read a date of birth around the rule", () => {
  it("the scan is actually looking at the tree", () => {
    assert.ok(FILES.length > 100, `expected the route/service/lib tree, found ${FILES.length} files`);
    for (const dir of ["routes/", "services/", "lib/", "compass/", "domain/"]) {
      assert.ok(FILES.some((f) => f.rel.startsWith(dir)), `the scan reached no file under ${dir}`);
    }
    assert.ok(
      FILES.some((f) => stripComments(f.src).includes("date_of_birth")),
      "found no date_of_birth reference at all — the scan has stopped covering anything",
    );
  });

  it("every route/service/lib file that reads date_of_birth is routed through the seam", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const code = stripComments(f.src);
      if (!code.includes("date_of_birth")) continue;
      if (NOT_A_GATE[f.rel]) continue;
      if (KNOWN_UNROUTED[f.rel]) continue;
      if (SEAM_IMPORTS.some((imp) => code.includes(imp))) continue;
      offenders.push(f.rel);
    }
    assert.deepEqual(offenders, [],
      "these files read profiles.date_of_birth without going through lib/gateAge.ts (or " +
      "lib/travelerVerification.ts). A provider result saying the user is NOT over 18 " +
      "cannot reach an age decision made that way — which is how seven gate families " +
      "came to admit verified minors. Route the read through resolveGateAge/gateAgeFrom, " +
      "or add the file to NOT_A_GATE with the reason it is not one.");
  });

  it("no route, service or lib gate imports the un-contradicted age arithmetic", () => {
    // `calculateUserAge` turns a typed birthday into a number with nothing
    // consulted. It is the correct primitive INSIDE the seam and the wrong one
    // at a gate, so the gate layer does not import it at all.
    const offenders = FILES
      .filter((f) => !NOT_A_GATE[f.rel] && !KNOWN_UNROUTED[f.rel])
      .filter((f) => /import[^;]*\bcalculateUserAge\b/.test(stripComments(f.src)))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [],
      "calculateUserAge is imported in the route/service layer — it answers from the " +
      "typed date of birth alone. Use lib/gateAge.ts.");
  });

  it("no scanned file carries its OWN date-of-birth-to-age arithmetic", () => {
    // The other way past the seam: not reading the column, but keeping a private
    // copy of the maths so an age arrives from somewhere the rule never saw.
    const offenders = FILES
      .filter((f) => !AGE_ARITHMETIC_OWNERS.has(f.rel) && !KNOWN_UNROUTED[f.rel])
      .filter((f) => definesOwnAgeArithmetic(stripComments(f.src)))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [],
      "a gate-layer file defines its own DOB->age helper. That is how an age reaches a " +
      "gate without the verified-minor rule ever being consulted. Use lib/gateAge.ts.");
  });

  it("the found-but-unrouted gate ledger may only shrink, and every entry is real", () => {
    // TWO assertions, and the second is the one that keeps this honest: an entry
    // whose file no longer reads a date of birth has been fixed or moved and must
    // be DELETED, not left as a permanent excuse.
    assert.ok(Object.keys(KNOWN_UNROUTED).length <= 2,
      `the unrouted-gate ledger grew to ${Object.keys(KNOWN_UNROUTED).length}. It may only shrink: ` +
      "route the new gate through lib/gateAge.ts instead of adding it here.");
    const stale = Object.keys(KNOWN_UNROUTED).filter((rel) => {
      const f = FILES.find((x) => x.rel === rel);
      if (!f) return true;
      const code = stripComments(f.src);
      // Either half of the defect makes the entry real: reading the raw column,
      // or carrying a private copy of the date-of-birth-to-age arithmetic.
      return !code.includes("date_of_birth") && !definesOwnAgeArithmetic(code);
    });
    assert.deepEqual(stale, [],
      "a ledgered gate no longer reads a date of birth and no longer carries its own " +
      "age arithmetic — delete its line");
  });

  it("the eight gate files this change routed are all still routed", () => {
    // A floor, so the guard above cannot be satisfied by DELETING a gate, and so
    // a revert of any single wiring is loud here as well as in the reach suite.
    const WIRED = [
      "routes/meetups.ts", "routes/requests.ts", "routes/events.ts",
      "routes/mediaFeed.ts", "routes/discovery.ts", "routes/profile.ts",
      "services/media/MediaProjectionService.ts",
    ];
    const missing = WIRED.filter((rel) => {
      const f = FILES.find((x) => x.rel === rel);
      if (!f) return true;
      const code = stripComments(f.src);
      return !SEAM_IMPORTS.some((imp) => code.includes(imp));
    });
    assert.deepEqual(missing, [], "a gate family lost its route through the age seam");
  });
});

describe("the GateAge type cannot hand a gate a number it has not earned", () => {
  it("`age` is unreachable without narrowing — compile-time", () => {
    const resolved = {} as GateAge;
    // @ts-expect-error `age` exists only on the `ok` arm. If this line ever
    // COMPILES, the union has been widened and the compiler half of the design
    // is gone — tsconfig.test.json turns an unused @ts-expect-error into an
    // error, so that widening fails the test typecheck rather than passing
    // silently.
    const leaked: number | null = resolved.age;
    assert.equal(typeof leaked, "undefined");
  });

  it("`age` is unreachable without narrowing — declaration shape", () => {
    // The compile-time half above is checked by a DIFFERENT program
    // (tsconfig.test.json) from the one that builds the server. This half runs
    // in the same suite as everything else, so the property is asserted by
    // whatever CI actually runs.
    const src = readFileSync(join(SRC, "lib", "gateAge.ts"), "utf8");
    const arms = gateAgeUnionArms(src);
    assert.equal(arms.length, 3, `expected exactly three arms, found ${arms.length}: ${arms.join(" / ")}`);
    const withAge = arms.filter((a) => /\bage\b\s*:/.test(a));
    assert.equal(withAge.length, 1, "exactly one arm may carry `age`");
    assert.ok(/state:\s*"ok"/.test(withAge[0]!), "and it must be the `ok` arm");
    for (const arm of arms) {
      if (arm === withAge[0]) continue;
      assert.ok(!/\bage\b/.test(arm),
        `a refusal arm gained an age field (${arm}) — a caller can now read a number without narrowing`);
    }
  });

  it("the fail-closed shortcut returns null for BOTH refusal states", () => {
    // `ageForFailClosedFilter` is the one narrowing escape hatch. It is only
    // safe because it cannot produce a number for a refusal; if it ever could,
    // the feed paths that use it would start admitting verified minors.
    assert.equal(ageForFailClosedFilter({ state: "verified_minor" }), null);
    assert.equal(ageForFailClosedFilter({ state: "unreadable" }), null);
    assert.equal(ageForFailClosedFilter({ state: "ok", age: 30, dateOfBirth: "1990-01-01" }), 30);
    assert.equal(ageForFailClosedFilter({ state: "ok", age: null, dateOfBirth: null }), null);
  });
});
