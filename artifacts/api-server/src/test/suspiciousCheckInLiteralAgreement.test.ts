/**
 * The admin suspicious-check-in reader must name the literal the geofence
 * writer actually writes.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `plan_attendance_events` is written from exactly one place —
 * `routes/geofence.ts`'s `writeAttendanceEvent` — and read for safety review
 * from exactly one place: `GET /admin/geofence/:tripId/suspicious-checkins`.
 * The two sit in different files, touch no shared constant, and are covered by
 * different tests, so nothing in this repository made them agree.
 *
 * They came within one merge of disagreeing. Two open PRs fixed the same
 * reader/writer/CHECK triangle from OPPOSITE sides:
 *
 *   - the live CHECK on `plan_attendance_events.event_type` was added out of
 *     band with a SHORTER vocabulary than the code has ever emitted
 *     (suspicious | late | override | excused), so every insert of
 *     'suspicious_check_in' was rejected 23514 and the table held 0 rows;
 *   - PR #416 widened that CHECK (migration 2302) to admit what the writer
 *     writes — so rows begin landing for the first time;
 *   - PR #418 repointed the READER at 'suspicious', a label no writer in src/
 *     has ever produced.
 *
 * Neither PR touched a line the other touched, so git would have merged them
 * silently. The result would have been strictly worse than the bug it replaced:
 * before, the safety queue was empty because nothing could be recorded; after,
 * it would have been empty BY FILTER while suspicious check-ins were being
 * recorded — a review surface that hides real signals and looks healthy doing
 * it.
 *
 * WHY EVERY EXISTING GUARD MISSED IT
 * ----------------------------------
 * `check:enum-literals` compares each literal against the SCHEMA, so with 2302
 * applied BOTH spellings are legal and it has nothing to say. The fake Supabase
 * clients compare a literal against a fixture, so a fixture written from either
 * spelling pins that spelling. `check:schema-references` models columns, not
 * values. The one relationship none of them models is the one that matters
 * here: reader and writer must name the SAME string.
 *
 * WHAT WOULD MAKE THIS TEST VACUOUS
 * ---------------------------------
 * Either side silently resolving to nothing. Both are asserted directly: the
 * writer walk must find the real attendance writers (and must not pick up
 * `recordTrustEvent`, which writes 'plan_attended' to a DIFFERENT table), and
 * the reader extraction must find exactly one filter on
 * `plan_attendance_events.event_type` in admin.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { extractFilterLiterals } from "../scripts/lib/filterLiteralExtract.js";
import { API_ROOT } from "../scripts/checkEnumLiterals.js";

const GEOFENCE = resolve(API_ROOT, "src/routes/geofence.ts");
const ROUTES_DIR = resolve(API_ROOT, "src/routes");

/**
 * The helpers that insert into `plan_attendance_events`.
 *
 * Restricting to these two is load-bearing, not decoration: geofence.ts also
 * calls `recordTrustEvent({ eventType: "plan_attended", … })`, which writes to
 * `trust_events`. Collecting every `eventType:` property in the file would let
 * the admin reader "agree" with a literal that never reaches this table.
 */
const ATTENDANCE_WRITERS = new Set(["writeAttendanceEvent", "upsertCheckin"]);

interface WriterSite {
  /** The literal written into plan_attendance_events.event_type. */
  literal: string;
  /** Source text of the call's `metadata` property, for branch identification. */
  metadata: string;
}

function calleeName(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

function stringsOf(expr: ts.Expression | undefined): string[] {
  if (!expr) return [];
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isConditionalExpression(expr)) {
    return [...stringsOf(expr.whenTrue), ...stringsOf(expr.whenFalse)];
  }
  return [];
}

/**
 * Every `event_type` string `routes/geofence.ts` can write into
 * `plan_attendance_events`, with the branch's metadata for identification.
 *
 * Resolves the one indirection the file uses: `upsertCheckin` is handed an
 * `eventType` shorthand bound to `const eventType = isLate ? "late_check_in" :
 * "checked_in_successfully"`, so a plain "string literal in the object" walk
 * would miss both of those.
 */
function attendanceWriterSites(): WriterSite[] {
  const src = readFileSync(GEOFENCE, "utf8");
  const sf = ts.createSourceFile(GEOFENCE, src, ts.ScriptTarget.Latest, true);

  // identifier -> the string literal(s) it is bound to, for shorthand resolution
  const bindings = new Map<string, string[]>();
  const bind = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const vals = stringsOf(node.initializer);
      if (vals.length > 0) bindings.set(node.name.text, vals);
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);

  const out: WriterSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && ATTENDANCE_WRITERS.has(name)) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          let metadata = "";
          const literals: string[] = [];
          for (const p of arg.properties) {
            const key =
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              ts.isIdentifier(p.name)
                ? p.name.text
                : null;
            if (key === "metadata" && ts.isPropertyAssignment(p)) {
              metadata = p.initializer.getText(sf);
            }
            if (key !== "eventType") continue;
            if (ts.isShorthandPropertyAssignment(p)) {
              literals.push(...(bindings.get(p.name.text) ?? []));
            } else if (ts.isPropertyAssignment(p)) {
              const direct = stringsOf(p.initializer);
              if (direct.length > 0) literals.push(...direct);
              else if (ts.isIdentifier(p.initializer)) {
                literals.push(...(bindings.get(p.initializer.text) ?? []));
              }
            }
          }
          for (const literal of literals) out.push({ literal, metadata });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every filter on `plan_attendance_events.event_type` in `src/routes/admin.ts`. */
function adminReaderLiterals(): string[] {
  const { sites } = extractFilterLiterals([ROUTES_DIR], API_ROOT);
  return sites
    .filter(
      (s) =>
        s.file === "src/routes/admin.ts" &&
        s.table === "plan_attendance_events" &&
        s.column === "event_type",
    )
    .map((s) => s.literal);
}

describe("plan_attendance_events — the admin reader and the geofence writer name one literal", () => {
  it("the writer walk finds the real attendance writers (positive control)", () => {
    const written = new Set(attendanceWriterSites().map((w) => w.literal));
    assert.ok(
      written.size >= 3,
      `only ${written.size} event_type literal(s) resolved from geofence.ts — the ` +
        `AST walk broke, and every assertion below would pass vacuously: ${[...written]}`,
    );
    // Named so a rename of any writer branch is a loud failure, not a silent
    // shrink of the set this test compares against.
    for (const expected of [
      "suspicious_check_in",
      "checked_in_successfully",
      "late_check_in",
      "host_manual_override",
    ]) {
      assert.ok(written.has(expected), `geofence.ts no longer writes "${expected}"`);
    }
  });

  it("does NOT pick up recordTrustEvent's 'plan_attended' (it writes trust_events)", () => {
    // Without this, the reader could "agree" with a literal that never reaches
    // plan_attendance_events at all.
    const written = new Set(attendanceWriterSites().map((w) => w.literal));
    assert.ok(
      !written.has("plan_attended"),
      "'plan_attended' is a trust_events event type — ATTENDANCE_WRITERS is too wide",
    );
  });

  it("admin.ts filters plan_attendance_events.event_type exactly once (positive control)", () => {
    assert.equal(
      adminReaderLiterals().length,
      1,
      "the suspicious-check-ins route must be the single reader of this column in " +
        "admin.ts — if that changed, this contract needs to be widened, not deleted",
    );
  });

  it("the admin reader's literal is one geofence.ts actually writes", () => {
    const written = new Set(attendanceWriterSites().map((w) => w.literal));
    const [read] = adminReaderLiterals();
    assert.ok(
      read !== undefined && written.has(read),
      `GET /admin/geofence/:tripId/suspicious-checkins filters event_type on ` +
        `"${read}", which no writer in routes/geofence.ts produces (it writes ` +
        `${[...written].sort().join(" | ")}). A safety-review queue that filters ` +
        `on a label nothing writes reports "no suspicious check-ins" while ` +
        `suspicious check-ins are being recorded.`,
    );
  });

  it("and it is specifically the suspicious-GPS branch's literal", () => {
    // Anchored on the branch's own metadata rather than on the string, so this
    // fails if EITHER side drifts — including a drift that keeps both sides
    // agreeing but on the wrong event (host_manual_override, say).
    const suspicious = attendanceWriterSites().filter((w) =>
      w.metadata.includes("suspicionReason"),
    );
    assert.equal(
      suspicious.length,
      1,
      "could not identify the suspicious-GPS write in geofence.ts by its " +
        "`suspicionReason` metadata — the branch moved; re-anchor this test",
    );
    assert.equal(
      adminReaderLiterals()[0],
      suspicious[0]!.literal,
      "the admin suspicious-check-in queue and geofence.ts's suspicious-GPS " +
        "write must name the same event_type literal",
    );
  });
});
