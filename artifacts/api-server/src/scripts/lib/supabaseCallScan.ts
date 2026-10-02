/**
 * supabaseCallScan — the text-level primitives both supabase resolve-don't-throw
 * guards are built on.
 *
 * `checkSilentSupabaseWrites.ts` (the WRITE half) and
 * `checkSilentSupabaseReads.ts` (the READ half) ask different questions about
 * the same language fact: supabase-js RESOLVES `{ data, error }` instead of
 * throwing, so ordinary JavaScript error handling does not see a DB failure.
 * They share how they *look at source*: comments and string bodies blanked so
 * brace counting cannot be fooled, brace matching, nested-try stripping, and a
 * two-sided shrink-only baseline comparison.
 *
 * These four helpers lived in checkSilentSupabaseWrites.ts first and were
 * lifted here verbatim in behaviour when the read guard was written. The write
 * guard re-exports `sanitize` and `compareToBaseline` from its own module so its
 * existing unit tests keep importing them from where they always did.
 *
 * ── LIMITS, STATED RATHER THAN IMPLIED ──────────────────────────────────────
 *   * This is text, not an AST. Everything built on it inherits that: a call
 *     reached through a helper is invisible, and unusual formatting can hide a
 *     site. Neither guard claims otherwise.
 *   * `sanitize` preserves length and newlines so every index into the
 *     sanitized string is also a valid index into the original. Callers rely on
 *     that to read comments (escape hatches) out of the ORIGINAL text at an
 *     offset discovered in the sanitized one.
 *   * Template-literal interpolations are blanked wholesale. An awaited
 *     supabase call inside `${…}` is pathological and out of scope for both
 *     guards.
 */

// ── Source sanitizer ─────────────────────────────────────────────────────────
/**
 * Blank out comments and string/template contents (preserving length and
 * newlines) so brace counting and pattern matching cannot be confused by braces
 * or keywords inside literals. The ORIGINAL text is kept by callers for reading
 * comments (escape-hatch detection).
 */
export function sanitize(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        if (src[j] === "\n") break; // unterminated — bail at line end
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j, n) + 1;
    } else if (c === "`") {
      // Template literal: blank everything through the closing backtick,
      // including interpolations (an awaited supabase call inside `${}` is
      // pathological and out of scope).
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") j++;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j, n) + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Index of the matching close brace for the open brace at `open`. -1 if none. */
export function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the matching close paren for the open paren at `open`. -1 if none.
 * (Read-guard addition: `.then(…)` argument spans are parenthesised, not
 * braced, so the write guard never needed this.)
 */
export function matchParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Blank nested `try { … } catch { … } [finally { … }]` spans inside a try body. */
export function stripNestedTry(body: string): string {
  let code = body;
  for (;;) {
    const m = /\btry\s*\{/.exec(code);
    if (!m) return code;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(code, open);
    if (close === -1) return code;
    let end = close + 1;
    // absorb catch/finally blocks attached to this try
    for (;;) {
      const tail = code.slice(end);
      const cm = /^\s*(catch\s*(\([^)]*\))?|finally)\s*\{/.exec(tail);
      if (!cm) break;
      const bOpen = end + cm[0].length - 1;
      const bClose = matchBrace(code, bOpen);
      if (bClose === -1) break;
      end = bClose + 1;
    }
    code = code.slice(0, m.index) + code.slice(m.index, end).replace(/[^\n]/g, " ") + code.slice(end);
  }
}

/** 1-indexed line number of `index` in `src`. */
export function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

// ── Baseline ratchet ────────────────────────────────────────────────────────
/**
 * Two-sided shrink-only comparison against a per-key count baseline.
 *
 * `found > allowed` is a NEW violation and fails. `found < allowed` is a STALE
 * entry and ALSO fails — the count must be lowered when a site is fixed, which
 * is what makes the baseline a ratchet rather than a permanent amnesty. Keyed by
 * COUNT, not line numbers, so unrelated edits to a file do not churn it.
 *
 * `keyOf` defaults to the file path (what the write guard has always keyed on).
 * The read guard passes `<file>::<shape>` so that fixing one shape cannot pay
 * for introducing another in the same file.
 */
export function compareToBaseline<T extends { file: string }>(
  violations: T[],
  baseline: Record<string, number>,
  keyOf: (v: T) => string = (v) => v.file,
): { newViolations: T[]; staleEntries: Array<{ file: string; baselined: number; found: number }> } {
  const byKey = new Map<string, T[]>();
  for (const v of violations) {
    const k = keyOf(v);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(v);
  }
  const newViolations: T[] = [];
  const staleEntries: Array<{ file: string; baselined: number; found: number }> = [];
  for (const [key, vs] of byKey) {
    const allowed = baseline[key] ?? 0;
    if (vs.length > allowed) newViolations.push(...vs.slice(0, vs.length - allowed));
  }
  for (const [key, allowed] of Object.entries(baseline)) {
    if (key.startsWith("__")) continue; // reserved keys (e.g. "__total") are not sites
    const found = byKey.get(key)?.length ?? 0;
    if (found < allowed) staleEntries.push({ file: key, baselined: allowed, found });
  }
  return { newViolations, staleEntries };
}
