/**
 * Silent schema-error guard.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `buildPlaceProjection` read `places` with
 * `.select("id, name, city, country, neighborhood")`. The table has
 * `country_code`; it has never had `country`, in CI or in production. PostgREST
 * fails the WHOLE read on an unknown select-list column (PGRST100) — it does not
 * degrade one field — and that read sat inside a try/catch commented
 * "Best-effort; a failed read leaves nulls."
 *
 * So the mistake silently emptied place identity ENTIRELY, on every projection,
 * for as long as the line existed. Name, city, country and neighbourhood all
 * null, no error anywhere, and output indistinguishable from a place nobody had
 * labelled yet. The other three columns were correct, which is why nothing ever
 * looked broken.
 *
 * The general shape: A BEST-EFFORT CATCH COLLAPSING A SCHEMA/QUERY ERROR INTO
 * THE SAME VALUE AS "NO DATA". A missing row and a malformed query are different
 * facts and must not be indistinguishable.
 *
 * Two things make this worse than it reads. First, supabase-js does NOT throw on
 * a PostgREST rejection — it resolves `{ data: null, error }` — so a `catch` that
 * looks like it handles the failure never runs, and a destructure of `{ data }`
 * alone drops the only evidence on the floor. Second, when the read builds an
 * EXCLUSION set (blocks, mutes, suspended accounts, private authors), the empty
 * result does not merely lose information: it opens the gate.
 *
 * WHAT THIS GUARD CHECKS
 * ----------------------
 * Rule 1 — the double silence. A read of a safety/privacy gate table that is
 *   BOTH inside a comment-only `catch` AND discards its `error`. Benign sites are
 *   allowlisted below, each with a stated reason and its expected site count, so
 *   a NEW hole in an already-allowlisted file still fails.
 *
 * Rule 2 — the fixes stay fixed. Each site repaired by the 2026-08-31 audit is
 *   anchored by the log line its fix introduced. Deleting the diagnostic (the
 *   whole point of the fix) fails here even if the `error` binding survives.
 *
 * WHAT THIS GUARD CANNOT CHECK — read this before trusting it
 * -----------------------------------------------------------
 * This is a source scan, not a type checker or a data-flow analysis.
 *
 *  - It cannot tell a fail-OPEN discard from a fail-CLOSED one. Whether an empty
 *    set means "hide nobody" or "prove nothing, deny" depends on how the caller
 *    consumes it, which is beyond a scan. That judgement lives in the reasons.
 *  - Rule 1's table list is a NAMED SET. A gate that moves to a new table is
 *    invisible until someone adds it here.
 *  - It only sees `.from("literal")`. Dynamic table names (`.from(tableVar)`) and
 *    RPCs are out of scope.
 *  - It only sees `catch` bodies that are literally empty or comment-only. A
 *    catch containing any statement — even `void 0` — is treated as handled.
 *  - Binding `error` counts as compliance; the scan cannot verify the binding is
 *    then USED WELL, only that the evidence was not discarded at the destructure.
 *  - Statement boundaries are found by brace/paren balancing, not by the TS AST.
 *    Unusual formatting can hide a site.
 *
 * Sibling guard, deliberately not duplicated here: `check:write-path-columns`
 * (src/scripts/checkWritePathColumns.ts) diffs every select list against the LIVE
 * schema and is what caught the `country` column. That one asks "is the query
 * wrong?"; this one asks "would anyone find out?".
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");

/**
 * Tables read to decide who may see what. A discarded error on one of these does
 * not lose a label — it changes an access outcome.
 */
const GATE_TABLES = new Set([
  "blocks",
  "user_mutes",
  "post_hides",
  "close_friends",
  "profile_privacy_settings",
  "user_account_states",
  "message_thread_members",
]);

/** Columns that make an otherwise ordinary `profiles` read a privacy decision. */
const PRIVACY_PREDICATE =
  /\bis_private\b|\bpassport_visibility\b|\baccount_status\b|\bprofile_visibility\b|\bshow_real_name\b/;

/**
 * Sites that may keep discarding the error, keyed `<relative path>::<table>`.
 *
 * `sites` is the number of such reads expected in that file for that table. It
 * is part of the key on purpose: without it, one justified hole would
 * pre-authorise every future one in the same file.
 */
const ALLOWED: Record<string, { sites: number; reason: string }> = {
  // The `routes/discovery.ts::blocks` entry that stood here was the one deferred
  // item of the 2026-08-31 audit — unfixed by ownership, not by judgement. The
  // file's owner has since taken the fix, so the entry is gone and the site is
  // pinned under FIXED_SITES instead. That is the intended exit for a deferral:
  // it moves to Rule 2, it does not lapse.
  "routes/follows.ts::message_thread_members": {
    sites: 2,
    reason:
      "Ranking weight only. A shared message thread lifts a mutual connection from decayed weight to 1.0 in follow suggestions; " +
      "an unreadable result costs that boost and nothing else. No row is shown or hidden by this read, so the empty set is the " +
      "correct value for both 'no shared threads' and 'could not check'.",
  },
  "routes/posts.ts::post_hides": {
    sites: 2,
    reason:
      "The VIEWER'S OWN hide list, on the following feed and the global feed. A failure re-shows posts that viewer had hidden — " +
      "wrong, but visible to the one person who can tell it is wrong, recoverable by hiding again, and with no cross-user " +
      "exposure: nothing here decides what OTHER people may see.",
  },
  "routes/pulse.ts::post_hides": {
    sites: 1,
    reason: "Same read, same reasoning, on the Pulse feed: the viewer's own hide list, no cross-user exposure.",
  },
};

/** Every .ts file under src/, excluding tests, scripts, migrations and baselines. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(["test", "scripts", "migrations", "node_modules", "baseline", "__tests__"]);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!skip.has(name)) walk(full);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue;
      out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** [start, end] spans of every `try` block whose `catch` body is empty or comment-only. */
function silentCatchRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\btry\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    const catchHead = text.slice(end + 1).match(/^\s*catch\s*(\([^)]*\))?\s*\{/);
    if (!catchHead) continue;
    let j = end + 1 + catchHead[0].length - 1;
    let d2 = 0;
    let cEnd = -1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "{") d2++;
      else if (c === "}") {
        d2--;
        if (d2 === 0) { cEnd = j; break; }
      }
    }
    if (cEnd === -1) continue;
    const body = text
      .slice(end + 1 + catchHead[0].length, cEnd)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .trim();
    if (body.length === 0) out.push([m.index, end]);
  }
  return out;
}

/**
 * Destructuring statements, from `const {`/`const [` to the matching depth-0 `;`
 * (or an ASI-style line end). One statement can hold several reads — a
 * `Promise.all([...])` of two `blocks` queries is the common case, and both must
 * be judged together because one shared destructure covers them.
 */
function statements(text: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const re = /\b(?:const|let|var)\s*[{[]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth--;
      else if (c === ";" && depth === 0) { end = i; break; }
      else if (c === "\n" && depth === 0 && i > start + 5) {
        const ws = text.slice(i + 1).match(/^\s*/)![0];
        const next = text[i + 1 + ws.length];
        // A chain continues across lines (`.eq(...)`, `)`, `?.`); anything else ends it.
        if (next && next !== "." && next !== ")" && next !== "?") { end = i; break; }
      }
    }
    if (end === -1) end = Math.min(text.length - 1, start + 3000);
    out.push({ start, end, text: text.slice(start, end + 1) });
  }
  return out;
}

/** Does this statement keep the error — bound inline, or consulted as `res.error` after? */
function keepsError(text: string, st: { end: number; text: string }): boolean {
  if (/\berror\b/.test(st.text)) return true;
  const declared = [...st.text.matchAll(/\b(?:const|let|var)\s*(?:\{([^}]*)\}|\[([^\]]*)\])/g)]
    .flatMap((m) => (m[1] ?? m[2] ?? "").split(","))
    .map((s) => s.trim().split(":").pop()!.trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
  const after = text.slice(st.end + 1, st.end + 2500);
  return declared.some((id) => new RegExp(`\\b${id}\\??\\.error\\b`).test(after));
}

export interface Violation { table: string; line: number; snippet: string }

/** Rule 1, over one file's source. Exported shape so the self-check can drive it directly. */
function scanText(text: string): Violation[] {
  const ranges = silentCatchRanges(text);
  if (ranges.length === 0) return [];
  const found: Violation[] = [];
  for (const st of statements(text)) {
    if (!ranges.some(([a, b]) => st.start > a && st.end < b)) continue;
    const tables = [...st.text.matchAll(/\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)].map((m) => m[1]);
    if (tables.length === 0) continue;
    if (!/\.(select|maybeSingle|single)\s*\(/.test(st.text)) continue;
    const gates = [...new Set(tables.filter((t) => GATE_TABLES.has(t)))];
    if (gates.length === 0 && !PRIVACY_PREDICATE.test(st.text)) continue;
    if (keepsError(text, st)) continue;
    for (const table of gates.length > 0 ? gates : [...new Set(tables)]) {
      found.push({
        table,
        line: text.slice(0, st.start).split("\n").length,
        snippet: st.text.replace(/\s+/g, " ").slice(0, 120),
      });
    }
  }
  return found;
}

/** Rule 1 across the tree, keyed `<relative path>::<table>`. */
function scanTree(): Map<string, Violation[]> {
  const byKey = new Map<string, Violation[]>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    if (!text.includes(".from(")) continue;
    const rel = file.slice(SRC.length + 1);
    for (const v of scanText(text)) {
      const key = `${rel}::${v.table}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(v);
    }
  }
  return byKey;
}

/**
 * Rule 2. Sites repaired by the 2026-08-31 audit, anchored by the diagnostic each
 * fix added. A revert that keeps the `error` binding but drops the log restores
 * the original defect — an operator who cannot tell a rejected query from an
 * empty one — so the log line, not the binding, is what is pinned.
 */
const FIXED_SITES: Array<{ file: string; markers: string[]; reason: string }> = [
  {
    file: "lib/mediaEligibility.ts",
    markers: [
      "mute gate is OFF for this request",
      "suspended/banned gate could not be evaluated, failing closed to an empty feed",
    ],
    reason:
      "A rejected user_mutes / profiles.account_status read left the exclusion set empty, serving muted creators' and " +
      "suspended-or-banned creators' media as if the check had passed. The mute read stays best-effort — losing it costs a " +
      "preference — but must not stay silent. The account_status read has since been made fail-closed to match the sibling " +
      "block read at the top of the same function: both are integrity gates, and the marker now pins that posture, so a " +
      "revert to best-effort changes the text and trips this rule.",
  },
  {
    file: "routes/posts.ts",
    markers: [
      "private accounts are NOT being excluded from this page",
      "stale-follow privacy cross-check",
    ],
    reason:
      "The global feed's private-author exclusion set: a rejected lookup emptied it and published every private account's " +
      "posts. The following feed's stale-follow cross-check fails the same way.",
  },
  {
    file: "routes/pulse.ts",
    markers: [
      "returning an empty rail (fail-closed)",
      "buddy-side block filter is OFF for this response",
    ],
    reason:
      "The Live rail's block set. It WAS fail-open in the same file whose feed endpoint treats the identical unknown as " +
      "fail-closed; the 2026-09-06 block fail-open sweep made the rail match the feed, so the marker now pins the " +
      "fail-CLOSED wording. If it ever reverts to 'blocked users are NOT being filtered from this response', the text " +
      "changes and this rule trips.",
  },
  {
    file: "routes/discovery.ts",
    markers: ["blocked users are NOT being filtered from event posts"],
    reason:
      "GET /discovery/feed's block set, and the one site the audit deferred rather than fixed: a rejected read left " +
      "blockedIds empty — indistinguishable from 'this viewer has blocked nobody' — and the event-post pipeline filters " +
      "on exactly that set. The enclosing catch is about an unresolved viewer, not a verdict on this read, and PostgREST " +
      "reports the failure in `error` rather than throwing, so it never fired. Fixed by the file's owner; the allowlist " +
      "entry that recorded the deferral was dropped in the same change.",
  },
  {
    file: "routes/follows.ts",
    markers: ["returning no suggestions (fail-closed)"],
    reason:
      "Follow suggestions bound `blockErr` already but the two outcomes were indistinguishable downstream: an unreadable " +
      "blocks table left the same empty set as a viewer who has blocked nobody, and every suggestion is filtered on that " +
      "set. The 2026-09-06 sweep made it fail CLOSED (serve nothing); the marker pins that wording, so a revert to " +
      "'blocked users are NOT being filtered from this response' trips this rule.",
  },
  {
    file: "routes/telegraph.ts",
    markers: ["suppressing every mention suggestion (fail-closed)"],
    reason:
      "A string-built or() predicate, so a malformed filter is the likely failure — and it emptied the block set for the " +
      "mention-suggestion list. The 2026-09-06 sweep made an unreadable block state treat every candidate as blocked; " +
      "the marker pins that wording.",
  },
  {
    file: "compass/CompassNotificationEngine.ts",
    markers: ["suppressing the push (fail-closed)"],
    reason:
      "maybeSingle() returns null both for 'no block row' and for a rejected query, against a gate whose stated contract is " +
      "that a blocked sender must never reach the recipient via push. The engine used to log and DELIVER anyway; the " +
      "2026-09-06 sweep made it suppress, and the marker pins that wording.",
  },
  {
    file: "lib/mediaAccess.ts",
    markers: ["noteLookupFailure", "falls through to deny"],
    reason:
      "Branches 3a-3g resolve which entity publishes an object. A rejected read reads exactly like 'nothing references it', " +
      "so the branch falls through and access is denied with no trace — the deny is safe and is kept, but it must not be " +
      "indistinguishable from a policy deny. The file's own urlForms comment records that incident from the outside.",
  },
];

describe("silent schema-error guard", () => {
  // ── Self-checks: a guard that scans nothing passes forever ────────────────
  test("the scan sees the api-server source tree", () => {
    const files = sourceFiles();
    assert.ok(files.length > 400, `expected the api-server source tree, found ${files.length} files`);
    for (const expected of ["lib/mediaEligibility.ts", "routes/posts.ts", "lib/mediaAccess.ts"]) {
      assert.ok(
        files.some((f) => f.slice(SRC.length + 1) === expected),
        `${expected} must be in scope`,
      );
    }
  });

  test("the scan actually reaches gate-table reads (it is not scanning past them)", () => {
    // Independent of any verdict: the tree must contain a large number of reads
    // from the named gate tables. If a rename or a refactor drops this to zero,
    // Rule 1 would pass by examining nothing.
    let gateReads = 0;
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]\s*\)/g)) {
        if (GATE_TABLES.has(m[1])) gateReads++;
      }
    }
    assert.ok(gateReads > 100, `expected the gate tables to be widely read; found ${gateReads} sites`);
  });

  test("the detector flags the defect and clears the fix (positive + negative control)", () => {
    const defective = `
      const blocked = new Set<string>();
      try {
        const { data: rows } = await sc.from("blocks").select("blocked_id").eq("blocker_id", me);
        for (const r of rows ?? []) blocked.add(r.blocked_id);
      } catch { /* non-fatal */ }
    `;
    const found = scanText(defective);
    assert.equal(found.length, 1, "the detector must flag a discarded error on a gate-table read");
    assert.equal(found[0].table, "blocks");

    const bound = defective.replace("const { data: rows }", "const { data: rows, error: err }");
    assert.deepEqual(scanText(bound), [], "binding the error must clear the site");

    const handled = defective.replace("catch { /* non-fatal */ }", "catch (e) { log.warn(e); }");
    assert.deepEqual(scanText(handled), [], "a catch that surfaces the failure must clear the site");

    const notAGate = defective.replace('from("blocks")', 'from("place_photos")');
    assert.deepEqual(scanText(notAGate), [], "non-gate tables are out of scope for Rule 1");
  });

  // ── Rule 1 ────────────────────────────────────────────────────────────────
  test("Rule 1: no gate-table read discards its error inside a silent catch", () => {
    const found = scanTree();
    const unlisted: string[] = [];
    for (const [key, hits] of found) {
      const entry = ALLOWED[key];
      if (!entry) {
        unlisted.push(`${key} (lines ${hits.map((h) => h.line).join(", ")})`);
        continue;
      }
      if (entry.sites !== hits.length) {
        unlisted.push(
          `${key} is allowlisted for ${entry.sites} site(s) but has ${hits.length} ` +
            `(lines ${hits.map((h) => h.line).join(", ")}) — judge the new one, do not bump the count blindly`,
        );
      }
    }
    assert.deepEqual(
      unlisted,
      [],
      "A read from a safety/privacy gate table discards its error inside a comment-only catch. " +
        "PostgREST reports a rejected query in `error` rather than throwing, so that catch never runs and the " +
        "failure becomes indistinguishable from an empty result — which, for an exclusion set, opens the gate. " +
        "Bind the error and log it with its code (the fallback can stay best-effort), or add the site to ALLOWED " +
        "with a reason that says why both outcomes are genuinely the same.",
    );
  });

  test("Rule 1: the allowlist has no stale entries", () => {
    // An approval that outlives its site quietly pre-authorises a future hole.
    const found = scanTree();
    const stale = Object.keys(ALLOWED).filter((k) => !found.has(k));
    assert.deepEqual(stale, [], "these sites no longer exist or were fixed — drop the allowlist entry");
  });

  test("Rule 1: every allowlist entry carries a reason and a site count", () => {
    for (const [key, entry] of Object.entries(ALLOWED)) {
      assert.ok(
        typeof entry.reason === "string" && entry.reason.length > 40,
        `${key} is allowlisted without a real reason`,
      );
      assert.ok(
        Number.isInteger(entry.sites) && entry.sites > 0,
        `${key} must state how many sites it covers`,
      );
    }
  });

  // ── Rule 2 ────────────────────────────────────────────────────────────────
  describe("Rule 2: the 2026-08-31 fixes are still in place", () => {
    for (const site of FIXED_SITES) {
      test(`${site.file} still distinguishes a query error from no data`, () => {
        const text = readFileSync(join(SRC, site.file), "utf8");
        const missing = site.markers.filter((m) => !text.includes(m));
        assert.deepEqual(
          missing,
          [],
          `${site.file} lost the diagnostic that made a schema error distinguishable from no data.\n` +
            `Why it was added: ${site.reason}\n` +
            `If the code legitimately moved, move the marker with it — do not delete it.`,
        );
      });
    }

    test("every fixed site states why it was fixed", () => {
      for (const site of FIXED_SITES) {
        assert.ok(site.markers.length > 0, `${site.file} pins no marker`);
        assert.ok(site.reason.length > 40, `${site.file} records no reason`);
      }
    });
  });
});
