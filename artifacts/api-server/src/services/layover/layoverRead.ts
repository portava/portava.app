/**
 * layoverRead — the typed read-result convention for the layover stores
 * (census-layover L294 / C2, as §55.9 framed it).
 *
 * THE DEFECT CLASS
 * ================
 * C2: "Never swallow a schema/data error into plausible empty operational
 * state without structured logging and degraded confidence." The layover
 * stores stopped swallowing site by site (§19, §21, §23), and the last half
 * §55.9 left open is that "degraded confidence a handler cannot skip is a
 * property of every layover read's RETURN TYPE". The shape these reads used —
 *
 *     Promise<{ ghostMode: boolean; degraded: boolean }>
 *     Promise<{ count; travelers; degraded; degradedReasons }>
 *
 * — puts the substitute value BESIDE a boolean. A handler that reads the value
 * and never looks at the boolean compiles, passes its tests, and serves a
 * fail-closed fallback ("nobody is here", "ghost mode on") as if it had been
 * measured. Nothing in the type stops it, and the repo has shipped that exact
 * mistake (§21.6, §23.1).
 *
 * THE CONVENTION
 * ==============
 * A layover read that can answer with a fail-closed substitute returns
 * `LayoverRead<T>`, a discriminated union in which the substitute is NOT
 * called `value`:
 *
 *     { kind: "read";     value: T }                       measured
 *     { kind: "degraded"; fallback: T; reasons: [r, …] }   NOT measured
 *
 * So `r.value` does not type-check until the handler has narrowed to "read",
 * and the only way to reach the substitute is to write the word `fallback` in
 * a branch that also has `reasons` in scope. Skipping the degraded case is no
 * longer a silent omission; it is code a reviewer can see. `matchRead` makes
 * both branches mandatory at compile time, and `readDisclosure` turns any
 * number of reads into the `{ degraded, degradedReasons }` pair the wire
 * already speaks, so no client contract moves.
 *
 * A degraded read MUST name why: `reasons` is a non-empty tuple, checked again
 * at runtime, because a degraded answer with no reason is the boolean again.
 *
 * WHAT IS NOT THIS
 * ================
 * A read with NO honest substitute already has a typed shape in these folders —
 * the `{ ok: true, … } | { ok: false, reason }` union — and stays on it: there
 * the handler cannot reach data without checking `ok`. This convention is for
 * the reads that DO answer when the store fails, which is where the boolean
 * was being skipped.
 *
 * `src/test/layoverReadResultGuard.test.ts` forbids NEW data-beside-boolean
 * reads in services/airport, services/layover, routes/airport.ts and
 * routes/layover*.ts, and holds the not-yet-migrated ones in a ledger that may
 * only shrink.
 */

/** A named, machine-readable reason a read is not a measurement, e.g. "ghost_mode_unreadable". */
export type LayoverReadReason = string;

export type LayoverReadReasons = readonly [LayoverReadReason, ...LayoverReadReason[]];

export type LayoverRead<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "degraded"; readonly fallback: T; readonly reasons: LayoverReadReasons };

/** A measured answer. */
export function readValue<T>(value: T): LayoverRead<T> {
  return { kind: "read", value };
}

/**
 * A fail-closed substitute, with the reasons it is not a measurement. Throws on
 * an empty reason list: a degraded answer that cannot say why is the boolean
 * this convention replaces.
 */
export function readDegraded<T>(fallback: T, reasons: LayoverReadReasons): LayoverRead<T> {
  const named = reasons.filter((r) => typeof r === "string" && r.trim().length > 0);
  if (named.length === 0) throw new Error("readDegraded: a degraded layover read must name at least one reason");
  return { kind: "degraded", fallback, reasons: named as unknown as LayoverReadReasons };
}

/** Both branches, always. The compiler refuses a call that handles only one. */
export function matchRead<T, R>(
  r: LayoverRead<T>,
  on: { read: (value: T) => R; degraded: (fallback: T, reasons: LayoverReadReasons) => R },
): R {
  return r.kind === "read" ? on.read(r.value) : on.degraded(r.fallback, r.reasons);
}

/**
 * The wire's `{ degraded, degradedReasons }` for one or more reads: degraded if
 * ANY is, with every reason, de-duplicated in first-seen order. This is the
 * only place a layover read becomes a boolean again, and it is the boolean the
 * client already reads.
 */
export function readDisclosure(...reads: ReadonlyArray<LayoverRead<unknown>>): { degraded: boolean; degradedReasons: string[] } {
  const reasons: string[] = [];
  for (const r of reads) {
    if (r.kind !== "degraded") continue;
    for (const why of r.reasons) if (!reasons.includes(why)) reasons.push(why);
  }
  return { degraded: reasons.length > 0, degradedReasons: reasons };
}
