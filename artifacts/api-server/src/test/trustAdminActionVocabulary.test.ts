/**
 * VALUE-level guard for `trust_admin_actions.action_type`.
 *
 * ── WHAT IS ALREADY GUARDED, AND WHAT WAS NOT ───────────────────────────────
 * `trustAdminAuditInsertSchemaDrift.test.ts` asserts the insert payload's
 * COLUMN NAMES exist in the live table. Nothing anywhere asserted the VALUES.
 *
 * `trust_admin_actions.action_type` carries a CHECK constraint admitting exactly
 * nine strings — confirmed read-only against production (project
 * ajrurzioarfkagpuxfnb) on 2026-09-14. A tenth string is not a type error, not a
 * lint error and not a test failure: it compiles, it ships, and at runtime
 * PostgreSQL rejects the row with 23514.
 *
 * WHY THAT IS SILENT RATHER THAN LOUD, WHICH IS THE WHOLE REASON THIS EXISTS:
 *   • supabase-js RESOLVES on a database error. It does not throw. So a 23514
 *     arrives as `{ data: null, error }`, not as a rejection.
 *   • `routes/trust-admin.ts`'s audit insert is fire-and-forget inside
 *     `Promise.resolve().then(...).catch(() => {})`. The `.catch` catches
 *     REJECTIONS. A resolved error never reaches it, and the `error` field is
 *     never bound.
 *   • `TrustAdminService.logAdminAction` binds `error` and logs a warning —
 *     which is better, and is still a warning in a log nobody is paging on,
 *     attached to an action the admin was told succeeded.
 *
 * The outcome is that renaming one string stops recording admin actions in
 * production and every test stays green. The rename this repo actually wants —
 * `score_override` → `update_setting` for the settings-edit audit row — is
 * blocked on a migration, and this guard is what keeps it blocked HONESTLY: the
 * day the migration lands, the nine below change with it and this test is the
 * thing that says so.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
 * Every `action_type` string this codebase can send, by both routes it sends
 * them:
 *   1. literal `action_type: "…"` inside a `.from("trust_admin_actions")`
 *      insert payload (routes/trust-admin.ts);
 *   2. the `AdminActionType` union in TrustAdminService.ts, which is what the
 *      single `action_type: actionType` insert there is fed — plus the literal
 *      at every `logAdminAction(...)` call site, because a call site can pass a
 *      string the union has been widened to admit.
 *
 * Static, like its sibling: it reads the source rather than executing it, so it
 * covers branches no fixture reaches.
 *
 * Run: node --import tsx --test src/test/trustAdminActionVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * The CHECK constraint's vocabulary, verified read-only against production on
 * 2026-09-14. Changing this list without the migration that changes the
 * constraint is the failure this file exists to make loud.
 */
const ALLOWED_ACTION_TYPES = new Set([
  "confirm_event", "dismiss_event",
  "apply_restriction", "lift_restriction",
  "apply_cap", "lift_cap",
  "score_override", "resolve_review", "flag_gaming",
]);

const ROUTE_FILE   = join(__dir, "..", "routes", "trust-admin.ts");
const SERVICE_FILE = join(__dir, "..", "services", "trust", "TrustAdminService.ts");

// ── Tiny source utilities (shared shape with helpers/schemaColumnExtractor) ──

/** Strip comments so a line of PROSE naming a value cannot satisfy or break a scan. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => {
      // Not inside a string literal: these files have no `//` inside one on a
      // line that also carries an action_type, and the assertion below would
      // fail loudly rather than silently if that ever changed.
      const k = l.indexOf("//");
      return k < 0 ? l : l.slice(0, k);
    })
    .join("\n");
}

/** Split a call's argument text at TOP-LEVEL commas. */
export function splitTopLevelArgs(argText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let cur = "";
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "\\") { cur += argText[++i] ?? ""; }
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; cur += ch; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; cur += ch; continue; }
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The text between the parens of every `name(` call in `source`. */
export function callArgTexts(source: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    let inStr: string | null = null;
    while (i < source.length && depth > 0) {
      const ch = source[i]!;
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

/** `"x"` / `'x'` / `` `x` `` → `x`; anything else → null. */
export function asStringLiteral(text: string): string | null {
  const m = /^\s*(["'`])([^"'`]*)\1\s*$/.exec(text);
  return m ? m[2]! : null;
}

/**
 * Every `action_type:` VALUE written into a `.from("trust_admin_actions")`
 * payload in this source, as `{ value, literal }` — `literal:false` means the
 * value is an identifier and must be accounted for by the union check instead.
 */
export function actionTypeValues(source: string): Array<{ value: string; literal: boolean }> {
  const out: Array<{ value: string; literal: boolean }> = [];
  const fromRe = /\.from\(\s*["'`]trust_admin_actions["'`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) {
    // The payload of this chain: everything up to the end of the statement is
    // enough here because a single chain carries a single insert payload, and
    // the `action_type:` key is unambiguous inside it.
    const window = source.slice(m.index, m.index + 2000);
    const key = /\baction_type\s*:\s*([^,\n}]+)/.exec(window);
    if (!key) continue;
    const raw = key[1]!.trim();
    const lit = asStringLiteral(raw);
    out.push(lit === null ? { value: raw, literal: false } : { value: lit, literal: true });
  }
  return out;
}

/** The string members of the `AdminActionType` union declaration. */
export function unionMembers(source: string): string[] {
  const m = /type\s+AdminActionType\s*=([\s\S]*?);/.exec(source);
  if (!m) return [];
  return [...m[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!);
}

// ── The guard ───────────────────────────────────────────────────────────────

describe("trust_admin_actions.action_type — every value this codebase inserts is in the CHECK", () => {
  const routeSrc   = stripComments(readFileSync(ROUTE_FILE, "utf8"));
  const serviceSrc = stripComments(readFileSync(SERVICE_FILE, "utf8"));

  it("the guard is actually wired — it found the writers it claims to cover", () => {
    // A value check that extracted nothing would pass forever. These floors are
    // what stop that; if an insert moves or becomes dynamic, this goes red and
    // the guard gets updated rather than quietly covering nothing.
    assert.ok(
      actionTypeValues(routeSrc).length >= 1,
      "expected at least one trust_admin_actions insert with an action_type in routes/trust-admin.ts",
    );
    assert.ok(
      actionTypeValues(serviceSrc).length >= 1,
      "expected at least one trust_admin_actions insert with an action_type in TrustAdminService.ts",
    );
    assert.ok(
      callArgTexts(serviceSrc, "logAdminAction").length >= 8,
      "expected the logAdminAction call sites to be found (definition + callers)",
    );
    assert.ok(unionMembers(serviceSrc).length >= 9, "expected the AdminActionType union to be found");
  });

  it("routes/trust-admin.ts inserts only admitted action_type values", () => {
    const bad = actionTypeValues(routeSrc)
      .filter((v) => v.literal && !ALLOWED_ACTION_TYPES.has(v.value))
      .map((v) => v.value);
    assert.deepEqual(bad, [],
      "routes/trust-admin.ts writes an action_type the CHECK constraint rejects. " +
      "The insert would fail 23514, supabase-js would RESOLVE that error, the " +
      "fire-and-forget .catch() would never see it, and the audit row would " +
      "silently not exist. Changing this string needs a migration first.");
  });

  it("the AdminActionType union is exactly the nine admitted values", () => {
    const members = unionMembers(serviceSrc);
    assert.deepEqual(
      [...new Set(members)].sort(),
      [...ALLOWED_ACTION_TYPES].sort(),
      "the union that types every logAdminAction call has drifted from the CHECK constraint",
    );
  });

  it("every logAdminAction call site passes an admitted action_type", () => {
    // Positional signature: (db, adminId, targetUser, actionType, reason, …).
    const bad: string[] = [];
    for (const args of callArgTexts(serviceSrc, "logAdminAction")) {
      const parts = splitTopLevelArgs(args);
      if (parts.length < 5) continue;           // the declaration, not a call
      const lit = asStringLiteral(parts[3]!);
      if (lit === null) continue;               // a variable — covered by the union check
      if (!ALLOWED_ACTION_TYPES.has(lit)) bad.push(lit);
    }
    assert.deepEqual(bad, [],
      "a logAdminAction call passes an action_type the CHECK constraint rejects");
  });

  it("the service's own insert feeds action_type from the typed parameter, not a free string", () => {
    const vals = actionTypeValues(serviceSrc);
    for (const v of vals) {
      if (v.literal) {
        assert.ok(ALLOWED_ACTION_TYPES.has(v.value), `TrustAdminService inserts unadmitted "${v.value}"`);
      } else {
        assert.equal(v.value, "actionType",
          "the service insert stopped being fed by the typed AdminActionType parameter — " +
          "the union check above no longer covers what it writes");
      }
    }
  });
});

// ── The guard's own positive control ─────────────────────────────────────────
//
// A value guard that cannot be shown to reject a bad value is a value guard
// nobody should trust. These run the same extractors over synthetic sources
// carrying exactly the drift this file exists to catch.
describe("the vocabulary guard catches a bad value", () => {
  it("rejects an unadmitted literal in an insert payload", () => {
    const src = `
      sc.from("trust_admin_actions").insert({
        admin_id: adminId,
        action_type: "update_setting",
        reason: "x",
      });
    `;
    const vals = actionTypeValues(src);
    assert.deepEqual(vals, [{ value: "update_setting", literal: true }]);
    assert.ok(!ALLOWED_ACTION_TYPES.has(vals[0]!.value),
      "the rename that is blocked on a migration must NOT be in the admitted set");
  });

  it("rejects an unadmitted literal at a logAdminAction call site", () => {
    const src = `await logAdminAction(db, adminId, userId, "update_setting", reason, { a: 1 }, id);`;
    const parts = splitTopLevelArgs(callArgTexts(src, "logAdminAction")[0]!);
    assert.equal(asStringLiteral(parts[3]!), "update_setting");
    assert.ok(!ALLOWED_ACTION_TYPES.has("update_setting"));
  });

  it("rejects a WIDENED union", () => {
    const src = `type AdminActionType =\n  | "confirm_event" | "update_setting";\n`;
    assert.deepEqual(unionMembers(src), ["confirm_event", "update_setting"]);
    assert.ok(unionMembers(src).some((m) => !ALLOWED_ACTION_TYPES.has(m)));
  });

  it("is not fooled by an action_type named only in a comment", () => {
    const src = `
      // action_type: "update_setting" would need a migration
      sc.from("trust_admin_actions").insert({ action_type: "lift_cap" });
    `;
    assert.deepEqual(actionTypeValues(stripComments(src)), [{ value: "lift_cap", literal: true }]);
  });
});
