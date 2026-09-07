/**
 * Trust engine — the declared-vs-produced event matrix, pinned.
 *
 * ── WHAT WAS MEASURED (production, 2026-09-07) ───────────────────────────────
 * `trust_engine_enabled` has been TRUE since 2026-07-17. In the 52 days since,
 * the ledger received FIVE events (4 `pulse_post_created`, 1 `first_event_joined`)
 * against 18 stamp awards, 7 posts and 1 completed trip. 56 of 58 users have no
 * trust profile, so the Passport builder substitutes a constant 50 and everyone
 * reads "Established". The engine is on and starved: the emitters are the
 * defect, not the scorer or the scheduler.
 *
 * `TRUST_EVENT_TYPES` (TrustEventService.ts) declares 31 event types. Eighteen of
 * them are emitted by NOTHING (the census said 15; it did not count the two
 * vocabulary mismatches or pulse_post_reported). Nothing pinned that number: a declared type with
 * no producer is a wish, and a wish reads like a capability to anyone who opens
 * the constant. This suite makes the gap explicit and makes both directions of
 * drift fail:
 *
 *   - a type is ADDED to the vocabulary with no producer  → must be added to
 *     KNOWN_UNPRODUCED (so the gap is stated, not silent);
 *   - a producer is WIRED for a listed type                → must be removed
 *     from KNOWN_UNPRODUCED (so the list is the truth, not a fossil).
 *
 * ── HOW PRODUCERS ARE FOUND ──────────────────────────────────────────────────
 * By walking the TypeScript AST of every non-test source file for CALLS to
 * `recordTrustEvent` / `recordAdjudicatedTrustEvent` and reading the
 * `eventType` property of the input object — not by grepping `eventType:`,
 * which in this repo also names notification templates ("passport.stamp_earned"),
 * audit events (routes/circle.ts) and attendance rows (routes/geofence.ts writes
 * three of those in the same file that emits `plan_attended`). A literal is
 * counted only when it sits inside a trust emitter call. Two indirections the
 * codebase actually uses are resolved: a same-file `const x = cond ? "a" : "b"`
 * feeding `eventType: x` (routes/rentABuddy.ts), and `recordLocationTrustEvent`'s
 * `gps_${reason}` template (services/location/LocationSafetyService.ts).
 * Anything else dynamic is refused and listed as such, never guessed.
 *
 * This is a STATIC test: it proves a producer exists in the tree, not that its
 * route is mounted or its trigger has ever fired. Reachability is a separate
 * fact and is recorded in the census, not here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { TRUST_EVENT_TYPES } from "../services/trust/TrustEventService.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");
const VOCABULARY_FILE = resolve(SRC_ROOT, "services/trust/TrustEventService.ts");

/**
 * Declared in TRUST_EVENT_TYPES and emitted by NO production call site.
 *
 * Every entry here is a statement of fact about the tree, verified by the AST
 * walk below. Owner decisions attached to each (census-trust.md §5 items 3, 5, 9):
 *
 *   stamp_verified            — trigger exists (StampAwardEngine.awardStamp,
 *                               Passport-owned). Trust's half is
 *                               recordStampVerifiedTrustEvent; the call is
 *                               Passport's to add.
 *   event_attendee_no_show    — routes/events.ts emits `event_no_show` (moderate,
 *                               -5) for the same action. Vocabulary mismatch.
 *   appeal_approved_reversal  — services/appeals emits `appeal_approved`. Same.
 *   event_host_cancelled      — trigger exists (DELETE /events/:id by host).
 *   event_positive_review /
 *   event_negative_review     — trigger exists (POST /events/:id/reviews).
 *   content_removed           — trigger exists (admin hide-content / avatar /
 *                               cover removal; moderation_actions rows).
 *   message_report_confirmed  — trigger exists (admin report resolve, message).
 *   pulse_post_reported       — the only honest trigger is an UPHELD report on
 *                               a post (admin resolve / hide-content), which is
 *                               the same adjudication content_removed names;
 *                               charging on FILING would be unadjudicated.
 *   plan_no_show, plan_late_cancel, host_positive_review, host_negative_review,
 *   responded_promptly, travel_circle_join, mutual_report, fake_gps_confirmed,
 *   event_host_no_show        — no triggering action exists anywhere in the
 *                               tree. Emitting these would be fabrication.
 */
export const KNOWN_UNPRODUCED_TRUST_EVENT_TYPES: readonly string[] = [
  "appeal_approved_reversal",
  "content_removed",
  "event_attendee_no_show",
  "event_host_cancelled",
  "event_host_no_show",
  "event_negative_review",
  "event_positive_review",
  "fake_gps_confirmed",
  "host_negative_review",
  "host_positive_review",
  "message_report_confirmed",
  "mutual_report",
  "plan_late_cancel",
  "plan_no_show",
  "pulse_post_reported",
  "responded_promptly",
  "stamp_verified",
  "travel_circle_join",
];

// ── Source walk ──────────────────────────────────────────────────────────────

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "test" || name === "__tests__" || name === "node_modules" || name === "scripts") continue;
      listSourceFiles(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const EMITTERS = new Set(["recordTrustEvent", "recordAdjudicatedTrustEvent"]);
const LOCATION_EMITTER = "recordLocationTrustEvent";

export interface ProducerSite {
  file: string;
  line: number;
  eventType: string;
}

export interface CoverageScan {
  produced: ProducerSite[];
  /** Emitter calls whose eventType could not be resolved to a literal set. */
  dynamic: Array<{ file: string; line: number; expr: string }>;
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** All string literals reachable inside an expression (ternaries, parens). */
function literalsIn(expr: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isParenthesizedExpression(expr)) return literalsIn(expr.expression);
  if (ts.isConditionalExpression(expr)) {
    const a = literalsIn(expr.whenTrue);
    const b = literalsIn(expr.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

/** Resolve `eventType: <identifier>` to the literals of a same-file `const`. */
function resolveIdentifier(sf: ts.SourceFile, name: string): string[] | null {
  let found: string[] | null = null;
  let declarations = 0;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      declarations++;
      found = literalsIn(n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // Two declarations of the same name → ambiguous → refuse.
  return declarations === 1 ? found : null;
}

export function scanProducers(root: string = SRC_ROOT): CoverageScan {
  const produced: ProducerSite[] = [];
  const dynamic: CoverageScan["dynamic"] = [];

  for (const file of listSourceFiles(root)) {
    if (resolve(file) === VOCABULARY_FILE) continue; // the declaration, not a producer
    const text = readFileSync(file, "utf8");
    if (!text.includes("recordTrustEvent") && !text.includes("recordAdjudicatedTrustEvent") && !text.includes(LOCATION_EMITTER)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = relative(root, file);

    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

        if (name && EMITTERS.has(name)) {
          // recordTrustEvent(db, input) — input is arg 1; recordAdjudicatedTrustEvent(db, adminId, input) — arg 2.
          const inputArg = n.arguments[name === "recordTrustEvent" ? 1 : 2];
          if (inputArg && ts.isObjectLiteralExpression(inputArg)) {
            const prop = inputArg.properties.find(
              (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "eventType",
            ) as ts.PropertyAssignment | undefined;
            if (prop) {
              let lits = literalsIn(prop.initializer);
              if (!lits && ts.isIdentifier(prop.initializer)) lits = resolveIdentifier(sf, prop.initializer.text);
              if (lits) for (const l of lits) produced.push({ file: rel, line, eventType: l.toLowerCase() });
              else dynamic.push({ file: rel, line, expr: prop.initializer.getText(sf) });
            } else {
              dynamic.push({ file: rel, line, expr: "(no eventType property)" });
            }
          } else if (inputArg) {
            dynamic.push({ file: rel, line, expr: inputArg.getText(sf) });
          }
        }

        if (name === LOCATION_EMITTER) {
          // recordLocationTrustEvent(db, userId, suspicionReason, confidence) → `gps_${suspicionReason}`
          const reason = n.arguments[2];
          const lits = reason ? literalsIn(reason) : null;
          if (lits) for (const l of lits) produced.push({ file: rel, line, eventType: `gps_${l.toLowerCase()}` });
          else dynamic.push({ file: rel, line, expr: reason ? reason.getText(sf) : "(no reason argument)" });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { produced, dynamic };
}

// ── The matrix ───────────────────────────────────────────────────────────────

const declared = Object.keys(TRUST_EVENT_TYPES).map((k) => k.toLowerCase()).sort();
const scan = scanProducers();
const producedTypes = new Set(scan.produced.map((p) => p.eventType));

describe("Trust event vocabulary — declared vs produced", () => {
  it("the scan found the production emitter sites (not a vacuous walk)", () => {
    // If the walk examined nothing, every declared type would read as unproduced
    // and the KNOWN list would "pass" by accident. Pin a few sites that exist.
    assert.ok(scan.produced.length >= 20, `expected ≥20 producer sites, found ${scan.produced.length}`);
    assert.ok(producedTypes.has("plan_attended"), "routes/geofence.ts plan_attended not found");
    assert.ok(producedTypes.has("gps_impossible_speed"), "LocationSafetyService gps_impossible_speed not found");
    assert.ok(producedTypes.has("behavior_report_confirmed"), "routes/admin.ts behavior_report_confirmed not found");
    assert.ok(producedTypes.has("rent_buddy_late_cancel"), "rentABuddy.ts const-ternary eventType not resolved");
  });

  it("every emitter call resolved to a literal set, except the intel bridge (template, by design)", () => {
    // lib/intelScopedTrustApply.ts writes `intel_${signal}` from a graded row —
    // legitimately dynamic and documented there. Nothing else may be.
    const unexpected = scan.dynamic.filter((d) => !d.file.includes("intelScopedTrustApply"));
    assert.deepEqual(unexpected, [], `unresolvable eventType at: ${JSON.stringify(unexpected)}`);
  });

  it("the set of declared types with no producer is EXACTLY the stated list", () => {
    const unproduced = declared.filter((t) => !producedTypes.has(t));
    const known = [...KNOWN_UNPRODUCED_TRUST_EVENT_TYPES].sort();
    const newlyWired = known.filter((t) => producedTypes.has(t));
    const newlyOrphaned = unproduced.filter((t) => !known.includes(t));
    assert.deepEqual(
      unproduced, known,
      [
        newlyWired.length ? `now PRODUCED (remove from KNOWN_UNPRODUCED_TRUST_EVENT_TYPES): ${newlyWired.join(", ")}` : "",
        newlyOrphaned.length ? `declared with NO producer (add to KNOWN_UNPRODUCED_TRUST_EVENT_TYPES or wire it): ${newlyOrphaned.join(", ")}` : "",
      ].filter(Boolean).join("\n"),
    );
  });

  it("every entry in the stated list is actually declared (the list cannot outlive the vocabulary)", () => {
    for (const t of KNOWN_UNPRODUCED_TRUST_EVENT_TYPES) {
      assert.ok(declared.includes(t), `${t} is listed as unproduced but is not in TRUST_EVENT_TYPES`);
    }
  });

  it("prints the matrix (informational)", () => {
    const rows = declared.map((t) => {
      const sites = scan.produced.filter((p) => p.eventType === t);
      return `${t.padEnd(28)} ${sites.length ? "PRODUCED  " : "unproduced"} ${sites.map((s) => `${s.file}:${s.line}`).join(", ")}`;
    });
    const undeclared = [...producedTypes].filter((t) => !declared.includes(t)).sort();
    // eslint-disable-next-line no-console
    console.log(`\n# trust event matrix\n${rows.join("\n")}\n# emitted but NOT declared (${undeclared.length}): ${undeclared.join(", ")}\n`);
    assert.ok(true);
  });
});
