/**
 * eventFamilies (Phase 0 item 10) — the verb -> family map, and the SQL read
 * model it CLAIMS to mirror.
 *
 * ── WHY THIS FILE GREW ───────────────────────────────────────────────────────
 * The module header, migration 2123's header, 2277's header and this file's own
 * previous header all said the same thing: the `canonical_event_families` view's
 * `CASE ce.verb` mirrors VERB_FAMILY "exactly". Nothing checked it. This file
 * said so out loud — "the drift is a review catch" — which is another way of
 * saying two copies of one mapping were kept in step by hope.
 *
 * That is not hypothetical for this pair. 2123 defined nine WHEN arms; 2277 then
 * added the three §21 `intel.*` verbs to canonical_events' CHECK and re-created
 * the view with a fifth family. Had 2277 widened the CHECK and forgotten the
 * view — one line apart in the same migration — every intel domain event would
 * have carried `family = NULL`, `WHERE family = 'domain'` would have returned
 * nothing, and the only thing standing between that and production was somebody
 * noticing during review.
 *
 * So the mirror is now ASSERTED: the corpus is read in migration order, the LAST
 * definition of the view wins (that is what applying them in order produces),
 * its CASE arms are parsed, and the result must equal VERB_FAMILY exactly — not
 * a subset, not a superset. The parse has its own vacuity guard: a scan that
 * found no view definition, or a CASE with no arms, FAILS rather than passing
 * on an empty comparison.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_EVENT_VERBS } from "../lib/canonicalEvents.js";
import {
  EVENT_FAMILIES,
  VERB_FAMILY,
  familyForVerb,
} from "../lib/eventFamilies.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

/** SQL line comments removed: a `--` line quoting a WHEN arm is not a WHEN arm. */
function stripSqlComments(sql: string): string {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

interface ViewDef { file: string; arms: Record<string, string> }

/**
 * Every `CASE ce.verb … END AS family` in the migration corpus, in the order the
 * migrations are applied. The last entry is the definition a database ends up
 * with.
 */
function familyViewDefinitions(): ViewDef[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
    });
  const out: ViewDef[] = [];
  for (const f of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, f), "utf8"));
    if (!sql.includes("canonical_event_families")) continue;
    const re = /CASE\s+ce\.verb\b([\s\S]*?)END\s+AS\s+family/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const arms: Record<string, string> = {};
      const armRe = /WHEN\s+'([^']+)'\s+THEN\s+'([^']+)'/gi;
      let a: RegExpExecArray | null;
      while ((a = armRe.exec(m[1]!)) !== null) arms[a[1]!] = a[2]!;
      out.push({ file: f, arms });
    }
  }
  return out;
}

describe("eventFamilies — the map is total and valid", () => {
  it("every canonical verb has a family", () => {
    for (const verb of CANONICAL_EVENT_VERBS) {
      assert.ok(verb in VERB_FAMILY, `verb '${verb}' is unmapped`);
    }
  });
  it("no extra keys beyond the canonical verbs", () => {
    for (const verb of Object.keys(VERB_FAMILY)) {
      assert.ok(
        (CANONICAL_EVENT_VERBS as readonly string[]).includes(verb),
        `'${verb}' is not a canonical verb`,
      );
    }
  });
  it("every family value is one of the five", () => {
    for (const fam of Object.values(VERB_FAMILY)) {
      assert.ok(EVENT_FAMILIES.includes(fam), `'${fam}' is not a valid family`);
    }
  });
});

describe("eventFamilies — the documented categorization", () => {
  it("pins the funnel mapping (change here => change the 2123 view too)", () => {
    assert.deepEqual(VERB_FAMILY, {
      impression: "exposure",
      open: "action",
      save: "action",
      join: "action",
      direction: "action",
      arrival: "outcome",
      completion: "outcome",
      rejection: "outcome",
      satisfaction: "satisfaction",
      // I4a (2277): pipeline transitions, not traveler interactions.
      "intel.observation.recorded": "domain",
      "intel.claim.promoted": "domain",
      "intel.state.changed": "domain",
    });
  });
});

describe("eventFamilies — familyForVerb", () => {
  it("returns the family for a known verb", () => {
    assert.equal(familyForVerb("impression"), "exposure");
    assert.equal(familyForVerb("save"), "action");
    assert.equal(familyForVerb("completion"), "outcome");
    assert.equal(familyForVerb("satisfaction"), "satisfaction");
  });
  it("returns null for a non-canonical verb (fail-closed)", () => {
    assert.equal(familyForVerb("teleport"), null);
    assert.equal(familyForVerb(""), null);
  });
});

describe("eventFamilies — the SQL read model really does mirror the map", () => {
  const defs = familyViewDefinitions();

  it("the corpus scan found the view, and found arms in it (vacuity guard)", () => {
    // A scan that inspected nothing must FAIL. Without this, deleting the view
    // from the corpus entirely would make every case below trivially true.
    assert.ok(defs.length >= 1, "no canonical_event_families CASE found in the migrations");
    for (const d of defs) {
      assert.ok(Object.keys(d.arms).length > 0, `${d.file}: the CASE parsed to zero arms`);
    }
    // 2123 defines it, 2277 re-creates it. Both must still be found by name, or
    // the ordering claim below is about a corpus this scan cannot see.
    assert.ok(defs.some((d) => d.file.startsWith("2123")), "2123's definition was not found");
    assert.ok(defs.some((d) => d.file.startsWith("2277")), "2277's re-creation was not found");
  });

  it("the LAST definition's CASE equals VERB_FAMILY exactly — not a subset", () => {
    const last = defs[defs.length - 1]!;
    // deepEqual in both directions at once: a missing arm (a verb the view files
    // as NULL) and an extra arm (a family the code does not know) both fail.
    assert.deepEqual(last.arms, { ...VERB_FAMILY } as Record<string, string>,
      `${last.file}: the view's verb->family CASE has drifted from lib/eventFamilies.ts`);
  });

  it("every verb the code can produce is filed by the view — none lands as NULL family", () => {
    const last = defs[defs.length - 1]!;
    for (const verb of CANONICAL_EVENT_VERBS) {
      assert.ok(verb in last.arms,
        `verb '${verb}' has no WHEN arm: canonical_event_families would give it family = NULL, ` +
        `and every WHERE family = '…' query would silently drop it`);
    }
  });

  it("the drift 2277 avoided is the drift this test now catches", () => {
    // 2123 alone did NOT cover the three §21 intel verbs; 2277 added them in the
    // same migration that widened canonical_events' verb CHECK. Pinning the
    // earlier, incomplete definition here states what "kept in step by hope"
    // actually looked like, and proves the ordering (last wins) is doing work
    // rather than the two definitions happening to agree.
    const first = defs.find((d) => d.file.startsWith("2123"))!;
    assert.equal(first.arms["intel.observation.recorded"], undefined,
      "2123 is expected to predate the domain verbs — if it covers them, this control is stale");
    assert.equal(Object.keys(first.arms).length, 9);
    const last = defs[defs.length - 1]!;
    assert.equal(last.arms["intel.observation.recorded"], "domain");
    assert.notDeepEqual(first.arms, last.arms,
      "the two definitions are identical, so 'the last one wins' proves nothing here");
  });
});
