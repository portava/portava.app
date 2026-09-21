/**
 * checkTripWriteValidation — a trip write that reads `req.body` parses a schema.
 *
 * ── THE MEASUREMENT THAT PRODUCED THIS FILE ──────────────────────────────────
 * census-trips TR51 ("Command service validates schema") was recorded C with
 * this justification, and the justification IS the row's testable half:
 *
 *   "every trip write parses a zod schema first"
 *
 * Measured 2026-09-11 across the three files that row cites: **53 write
 * endpoints, 8 of which read `req.body` with no schema at all** — including
 * `POST /trips`, the primary create. 45 of 53 do validate, so the capability is
 * built and used; the word "every" was never counted. TR51 moved C -> W.
 *
 * ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────────
 * It is a SHRINK-ONLY ratchet, the same idiom as the RLS allowlists: the eight
 * known-unvalidated endpoints are listed below, and the check fails if a NINTH
 * appears or if a listed one is missing (meaning it was fixed, and the entry
 * must be deleted rather than left to excuse the next one).
 *
 * It is NOT a claim that these eight are a security hole. Authorization is
 * enforced separately and independently — `requireUser`, `canEditPlan`,
 * `canEditPlanItem`, `isAcceptedTripMember` — and `check:route-auth-gate`
 * already guards that. What is missing here is TYPE validation, whose absence
 * turns a malformed payload into a 500 from the database where a 400 belongs,
 * and leaves each endpoint's accepted shape undocumented.
 *
 * Run: node --import tsx/esm src/scripts/checkTripWriteValidation.ts
 */
import { readFileSync } from "node:fs";

const SRC = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** The files census-trips TR51 names. */
const FILES = [
  "routes/trips.ts",
  "routes/tripReservations.ts",
  "routes/trips-expansion.ts",
];

/**
 * KNOWN UNVALIDATED, 2026-09-11. Shrink-only: fix one, delete its line. An entry
 * asserts "this endpoint still reads req.body without parsing a schema" — leave
 * a fixed one here and it goes on excusing the next regression, which is exactly
 * what the four RLS allowlists emptied on this branch had been doing.
 */
const KNOWN_UNVALIDATED = new Set<string>([
  // "POST /trips" was here and is GONE, closed 2026-09-11 by CreateTripSchema —
  // the first entry this list shed. The remaining seven — /invite, /members,
  // /join-request, /invite-link and the three checklist writes — were closed
  // 2026-09-12 (census-trips §45, TR51). The list is EMPTY and stays
  // shrink-only: a new unvalidated trip write is a failure here, not an entry.
]);

const ROUTE_RE = /^router\.(post|patch|put|delete)\("([^"]+)"/;

const found = new Set<string>();
let endpoints = 0;

for (const rel of FILES) {
  const lines = readFileSync(`${SRC}/${rel}`, "utf8").split("\n");
  const starts: Array<{ i: number; name: string }> = [];
  lines.forEach((l, i) => {
    const m = ROUTE_RE.exec(l);
    if (m) starts.push({ i, name: `${m[1]!.toUpperCase()} ${m[2]!}` });
  });
  starts.forEach((s, k) => {
    endpoints += 1;
    const end = k + 1 < starts.length ? starts[k + 1]!.i : lines.length;
    const body = lines.slice(s.i, end).join("\n");
    if (!body.includes("req.body")) return;              // nothing to validate
    if (body.includes("safeParse") || body.includes(".parse(")) return;
    found.add(s.name);
  });
}

const problems: string[] = [];

// A pattern that matches nothing looks exactly like a clean tree.
if (endpoints === 0) {
  problems.push(
    "::error::checkTripWriteValidation found NO write endpoints at all in the files it scans. " +
      "The router shape changed and this check is verifying nothing. An empty result is not a clean result.",
  );
}

for (const name of found) {
  if (!KNOWN_UNVALIDATED.has(name)) {
    problems.push(
      `::error::${name} reads req.body without parsing a schema, and is not in KNOWN_UNVALIDATED. ` +
        `Parse a zod schema before using the body. census-trips TR51's testable claim is that every trip ` +
        `write does; it is W because eight already do not, and a ninth is the wrong direction.`,
    );
  }
}
for (const name of KNOWN_UNVALIDATED) {
  if (!found.has(name)) {
    problems.push(
      `::error::KNOWN_UNVALIDATED lists ${name}, which now validates (or no longer exists). ` +
        `DELETE the entry. This list is shrink-only: an entry that has stopped being true goes on ` +
        `excusing the next endpoint that is.`,
    );
  }
}

for (const p of problems) console.error(p);
console.log(
  `check:trip-write-validation — ${endpoints} trip write endpoint(s) scanned across ${FILES.length} file(s); ` +
    `${found.size} read req.body without a schema (baseline ${KNOWN_UNVALIDATED.size}).`,
);
console.log(
  "NOTE: DOES NOT COVER — authorization, which is enforced separately and guarded by check:route-auth-gate. " +
    "This is about TYPE validation only: its absence turns a malformed payload into a 500 where a 400 belongs.",
);
if (problems.length > 0) { console.error(`\n${problems.length} problem(s) found.`); process.exit(1); }
console.log("\ncheck:trip-write-validation PASSED");
