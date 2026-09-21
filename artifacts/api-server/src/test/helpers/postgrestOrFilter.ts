/**
 * A REAL `.or()` for the in-memory supabase fakes.
 *
 * WHY THIS EXISTS, measured rather than assumed
 * =============================================
 * The fakes used to model `.or()` as a NO-OP — it returned the builder and
 * narrowed nothing. That is not a harmless simplification, it inverts the
 * meaning of the one query that matters most:
 *
 *   lib/blockGuard.ts `isBlockedBetween` narrows ENTIRELY inside its `.or()`:
 *     .from("blocks").select("blocker_id")
 *     .or(`and(blocker_id.eq.${A},blocked_id.eq.${B}),
 *          and(blocker_id.eq.${B},blocked_id.eq.${A})`)
 *
 * With a no-op `.or()`, a fixture that seeds ONE `blocks` row makes EVERY pair
 * read as blocked. `compassSurfaces.test.ts` seeds exactly one such row, so the
 * permission engine returned the minimal `restricted` card for every traveler
 * and the route (correctly) dropped them all — five assertions failed against
 * code that is right in production, where `.or()` narrows.
 *
 * The honest fix is to make the fake behave like the server, not to relax the
 * assertions or to keep half-rendered people so the fixture passes.
 *
 * WHAT IT SUPPORTS: the PostgREST `or` grammar these fakes actually issue —
 * comma-separated disjuncts at the top level, each either a bare
 * `column.op.value` or an `and(...)` of them. Operators: eq, neq, is, gt, gte,
 * lt, lte, in. Anything it cannot parse THROWS, so a query shape this helper
 * does not model fails loudly instead of silently matching everything — the
 * exact failure mode it was written to end.
 */

/** Split on commas that are NOT inside parentheses. */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function coerce(raw: string): unknown {
  const v = raw.trim().replace(/^"(.*)"$/s, "$1");
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

type Pred = (row: Record<string, any>) => boolean;

/** One `column.op.value` leaf. */
function leaf(term: string): Pred {
  const m = /^([A-Za-z0-9_]+)\.([a-z]+)\.([\s\S]*)$/.exec(term.trim());
  if (!m) throw new Error(`postgrestOrFilter: cannot parse term ${JSON.stringify(term)}`);
  const [, col, op, rawVal] = m;
  const val = coerce(rawVal);
  switch (op) {
    case "eq":  return (r) => r[col] === val;
    case "neq": return (r) => r[col] !== val;
    case "is":  return (r) => (val === null ? r[col] == null : r[col] === val);
    case "gt":  return (r) => r[col] > (val as any);
    case "gte": return (r) => r[col] >= (val as any);
    case "lt":  return (r) => r[col] < (val as any);
    case "lte": return (r) => r[col] <= (val as any);
    case "in": {
      const list = String(rawVal).trim().replace(/^\(/, "").replace(/\)$/, "").split(",").map(coerce);
      return (r) => list.includes(r[col]);
    }
    default:
      throw new Error(`postgrestOrFilter: unsupported operator ${JSON.stringify(op)} in ${JSON.stringify(term)}`);
  }
}

/** One top-level disjunct: `and(a,b)` or a bare leaf. */
function disjunct(part: string): Pred {
  const and = /^and\(([\s\S]*)\)$/.exec(part.trim());
  if (and) {
    const preds = splitTopLevel(and[1]).map(leaf);
    return (r) => preds.every((p) => p(r));
  }
  return leaf(part);
}

/** The predicate a PostgREST `or=` expression denotes. */
export function orPredicate(expr: string): Pred {
  const parts = splitTopLevel(expr);
  if (parts.length === 0) throw new Error("postgrestOrFilter: empty or() expression");
  const preds = parts.map(disjunct);
  return (r) => preds.some((p) => p(r));
}
