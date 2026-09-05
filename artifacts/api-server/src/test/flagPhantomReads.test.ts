/**
 * PHANTOM FEATURE FLAGS — a flag the code reads that no migration seeds.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A PHANTOM IS AND WHY IT IS QUIETER THAN THE BUG IT RESEMBLES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every flag reader in this codebase is fail-closed. isFlagEnabled returns
 * false when the row is missing; compass/flags.ts isEnabled returns
 * `flags[name] ?? false`; a direct `.in([...])` select simply never sees the
 * name and keeps its compiled-in default; the app's FeatureFlagsContext is
 * `flags[key] === true`. So a read of a name no migration created does not
 * throw, does not log, and does not degrade. It returns false. Forever. The
 * gate looks like a deliberate off-switch and is actually a wall.
 *
 * That is worse than an inert seeded row, which at least appears in the admin
 * flag list where an operator can see a value that does nothing. A phantom
 * appears NOWHERE. The only way to notice is to grep the migrations for a name
 * nobody has any reason to doubt.
 *
 * Eight were live on main on 2026-09-05, one of them —
 * MEDIA_WORLD_SHELL_ENABLED — gating the entire Media v2 client surface, which
 * therefore could not be enabled by any operator action at all: it needed a
 * migration first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY check:flag-polarity DID NOT CATCH THEM, AND WHY THIS TEST EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The guard compared its two populations in ONE direction. R6 asked "does this
 * SEEDED flag have a reader" and had a careful, well-argued exemption list for
 * the 33 that did not. Nothing asked "does this READ have a row".
 *
 * MEDIA_SHARING_ENABLED is the proof that the missing direction was not a
 * technicality. Both halves of that defect were already written down in
 * check-flag-polarity.mjs: a CLASSIFIED entry for MEDIA_SHARING_ENABLED (the
 * name that does not exist) and an INERT_SEEDED_FLAGS entry for
 * MEDIA_SHARES_ENABLED (the name that does, seeded false, "read by nothing...
 * wire the reader when the corresponding surface ships"). The surface HAD
 * shipped. The two entries sat 300 lines apart, each individually plausible,
 * and the check went green because no rule ever put them side by side.
 *
 * R9 in that script is the durable fix. This test is what keeps R9 honest:
 * a rule that cannot be shown to fail is indistinguishable from no rule.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH NAMING CONVENTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This repo names flags in two schemes — snake_case (`map_search_enabled`) and
 * SCREAMING_CASE (`MEDIA_TAB_ENABLED`). The audit that surfaced these ran a
 * lowercase-only regex on its first pass and reported ZERO phantoms; seven of
 * the eight are SCREAMING_CASE. A sweep that matches one convention on a
 * codebase that uses two does not find fewer defects — it finds none, and
 * reports that as clean. The fixture cases below therefore assert BOTH.
 *
 * Run: node --import tsx/esm --test src/test/flagPhantomReads.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(PKG_ROOT, "scripts", "check-flag-polarity.mjs");
const MIGRATIONS_DIR = join(PKG_ROOT, "src", "migrations");
const APP_ROOT = join(PKG_ROOT, "..", "..", "travel-buddy-standalone");

// ─────────────────────────────────────────────────────────────────────────────
// A seeded-flag scan written INDEPENDENTLY of the script's own.
//
// Deliberately not imported from check-flag-polarity.mjs: a test that asks the
// script whether the script is right proves nothing. This is a plain, broad
// matcher over the same directory.
// ─────────────────────────────────────────────────────────────────────────────
function seededFlags(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // Strip line comments outside string literals so migration PROSE naming a
    // flag is never counted as seeding it — 2300's header names all eight.
    let text = "";
    let inStr = false;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i], d = sql[i + 1];
      if (inStr) { text += c; if (c === "'") inStr = d === "'" ? (text += sql[++i], true) : false; continue; }
      if (c === "'") { inStr = true; text += c; continue; }
      if (c === "-" && d === "-") { while (i < sql.length && sql[i] !== "\n") i++; text += "\n"; continue; }
      text += c;
    }
    for (const m of text.matchAll(/INSERT\s+INTO\s+(?:"?[A-Za-z_]\w*"?\s*\.\s*)?"?feature_flags"?\b/gi)) {
      const rest = text.slice(m.index);
      let semi = -1, q = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "'") q = !q;
        else if (rest[i] === ";" && !q) { semi = i; break; }
      }
      for (const row of (semi > 0 ? rest.slice(0, semi) : rest).matchAll(/\(\s*'([A-Za-z0-9_]+)'\s*,/g)) {
        if (!out.has(row[1])) out.set(row[1], f);
      }
    }
  }
  return out;
}

function readSrc(rel: string): string {
  return readFileSync(join(PKG_ROOT, "src", rel), "utf8");
}
function readApp(rel: string): string {
  return readFileSync(join(APP_ROOT, rel), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SIX REPAIRS — one case per flag, each RED before its fix.
// ─────────────────────────────────────────────────────────────────────────────

describe("phantom feature flags — the six repaired reads", () => {
  const seeded = seededFlags();

  it("the seeded-flag scan has a subject (vacuity)", () => {
    assert.ok(
      seeded.size > 150,
      `Only ${seeded.size} seeded flags found. Every assertion below is "this name is in the seeded set"; ` +
        `an empty or tiny set would make them all pass while proving nothing.`,
    );
  });

  // ── 1. MEDIA_SHARING_ENABLED → MEDIA_SHARES_ENABLED (a misspelling) ────────
  //
  // RED before the fix: routes/mediaFeed.ts read "MEDIA_SHARING_ENABLED".
  // BEHAVIOUR WHEN IT RESOLVES: none today. MEDIA_SHARES_ENABLED is seeded
  // false, so POST /api/media/:id/share still answers feature_disabled — but it
  // now does so because an operator chose that, not because the name was wrong.
  it("the media share gate reads MEDIA_SHARES_ENABLED, which is seeded", () => {
    const src = readSrc("routes/mediaFeed.ts");
    assert.ok(
      src.includes('isFlagEnabled(sc, "MEDIA_SHARES_ENABLED")'),
      "routes/mediaFeed.ts must gate POST /api/media/:id/share on MEDIA_SHARES_ENABLED",
    );
    assert.ok(
      !/isFlagEnabled\([^)]*"MEDIA_SHARING_ENABLED"/.test(src),
      'routes/mediaFeed.ts must not read "MEDIA_SHARING_ENABLED" — no migration and neither live database ' +
        "has ever held that row, so the gate closes unconditionally and no operator can open it",
    );
    assert.equal(seeded.get("MEDIA_SHARES_ENABLED"), "2038_media_admin_flags.sql");
    assert.ok(!seeded.has("MEDIA_SHARING_ENABLED"), "MEDIA_SHARING_ENABLED must NOT be seeded — the fix was the literal, not a second row");
  });

  // ── 2. MEDIA_WORLD_SHELL_ENABLED — app-tree only, the most serious ─────────
  //
  // BEHAVIOUR WHEN IT RESOLVES: none today (seeded false, and the app read was
  // already false). What changes is that the Media v2 World shell becomes
  // reachable at all — before, enabling it required shipping a migration.
  it("MEDIA_WORLD_SHELL_ENABLED is seeded, and is read only in the app tree", () => {
    assert.equal(seeded.get("MEDIA_WORLD_SHELL_ENABLED"), "2300_phantom_feature_flag_rows.sql");
    assert.ok(
      readApp("app/(tabs)/media.tsx").includes("isEnabled('MEDIA_WORLD_SHELL_ENABLED')"),
      "app/(tabs)/media.tsx must still gate the World pill on this flag — if the read moved, the seed's " +
        "justification and the APP_TREE_READS entry both need updating",
    );
    assert.ok(readApp("app/media-viewer/[id].tsx").includes("MEDIA_WORLD_SHELL_ENABLED"));
  });

  // ── 3. MEDIA_HIDDEN_GEMS_NEARBY_ENABLED — two readers, one row ─────────────
  //
  // BEHAVIOUR WHEN IT RESOLVES: none today (seeded false). GET
  // /api/media/gems-feed?areaMode=near_me still answers feature_disabled.
  it("MEDIA_HIDDEN_GEMS_NEARBY_ENABLED is seeded and read on both sides", () => {
    assert.equal(seeded.get("MEDIA_HIDDEN_GEMS_NEARBY_ENABLED"), "2300_phantom_feature_flag_rows.sql");
    assert.ok(readSrc("routes/mediaFeed.ts").includes('isFlagEnabled(sc, "MEDIA_HIDDEN_GEMS_NEARBY_ENABLED")'));
    assert.ok(readApp("app/(tabs)/media.tsx").includes("isEnabled('MEDIA_HIDDEN_GEMS_NEARBY_ENABLED')"));
  });

  // ── 4/5. The two PORTAVA_* ranking boosts ──────────────────────────────────
  //
  // BEHAVIOUR WHEN THEY RESOLVE: none. Both seeded false, and
  // loadMediaRankingFlags already defaulted both to false, so ranking output is
  // byte-for-byte unchanged.
  //
  // PORTAVA_PUBLISHER_BOOST_ENABLED is the false-positive candidate and is NOT
  // one: a seed for it does exist at artifacts/api-server/supabase/migrations/
  // 20260809_portava_publisher_boost_flag.sql, but that tree is frozen and
  // never applied (src/scripts/frozenMigrationRoots.ts), and the row is absent
  // from both live databases. This case pins the distinction so nobody
  // "rediscovers" the frozen file and deletes 2300's row.
  it("both PORTAVA_* boost flags are seeded in the CANONICAL chain", () => {
    assert.equal(seeded.get("PORTAVA_PUBLISHER_BOOST_ENABLED"), "2300_phantom_feature_flag_rows.sql");
    assert.equal(seeded.get("PORTAVA_FEATURED_BOOST_ENABLED"), "2300_phantom_feature_flag_rows.sql");
    const rank = readSrc("services/ranking/MediaFeedRankingService.ts");
    assert.ok(rank.includes('"PORTAVA_PUBLISHER_BOOST_ENABLED"'));
    assert.ok(rank.includes('"PORTAVA_FEATURED_BOOST_ENABLED"'));
    assert.ok(readSrc("routes/pulse.ts").includes('isFlagEnabled(sc, "PORTAVA_PUBLISHER_BOOST_ENABLED")'));
  });

  // ── 6. COMPASS_TELEGRAPH ───────────────────────────────────────────────────
  //
  // BEHAVIOUR WHEN IT RESOLVES: none (seeded false). GET
  // /api/compass/telegraph still answers feature_disabled. Notable because the
  // COMPASS_% bulk loader made the name LOOK loadable — it matches the LIKE
  // pattern — while resolving to nothing.
  it("COMPASS_TELEGRAPH is seeded", () => {
    assert.equal(seeded.get("COMPASS_TELEGRAPH"), "2300_phantom_feature_flag_rows.sql");
    assert.ok(readSrc("routes/compass.ts").includes('isEnabled(sc, "COMPASS_TELEGRAPH")'));
  });

  // ── The two deliberate non-seeds ───────────────────────────────────────────
  //
  // These must STAY unseeded. Seeding SEARCH_SIGNAL_DECAY_DAYS adds a switch
  // that still does nothing (feature_flags has no numeric_value column, so the
  // select 42703s before the row is read); seeding
  // place_provenance_stamping_enabled hands an operator a switch whose ON
  // position breaks place-supply writes on any database without 2101's
  // source_id column. The absence is the interlock in both cases.
  // ── The mirror-image defect, found by reconciling the OTHER direction ──────
  //
  // Six flags carried INERT_SEEDED_FLAGS entries reading "read by nothing...
  // OWNER DECISION: wire the reader when the corresponding surface ships". All
  // six were being read, in the app tree, and had been for months. R6 asked
  // "read by nothing UNDER src/" and its answer was written down as "read by
  // nothing", because nothing walked the app tree for reads.
  //
  // A phantom makes a live gate look dead to the CODE. A false inert entry
  // makes a live gate look dead to the READER — and hands them a work item to
  // build a surface that already exists. Same root cause: one population was
  // never compared against the other.
  it("no flag is declared inert while the app tree reads it", () => {
    const guard = readFileSync(join(PKG_ROOT, "scripts", "check-flag-polarity.mjs"), "utf8");
    // The six corrected on 2026-09-05. Each assertion is two-sided: the entry
    // must be gone AND the read must still be there — a one-sided check would
    // pass if someone deleted the reader instead of the entry.
    const corrected: Array<[string, string]> = [
      ["MEDIA_TAB_ENABLED", "src/navigation/portavaRoutes.ts"],
      ["MEDIA_VIEW_MODE_FULLSCREEN_ENABLED", "app/(tabs)/media.tsx"],
      ["MEDIA_UPLOAD_ENABLED", "src/components/media/AddGemForm.tsx"],
      ["MEDIA_UPLOAD_PHOTO_ENABLED", "src/components/media/AddGemForm.tsx"],
      ["MEDIA_UPLOAD_VIDEO_ENABLED", "src/components/media/AddGemForm.tsx"],
      ["ai_event_auto_suggest_enabled", "src/components/EventComposerSheet.tsx"],
    ];
    for (const [flag, appFile] of corrected) {
      assert.ok(
        !new RegExp(`flag:\\s*'${flag}',\\s*seededIn:`).test(guard),
        `"${flag}" is declared inert again in check-flag-polarity.mjs, but ${appFile} reads it. ` +
          `An inert declaration for a live gate is a false statement with an action item attached.`,
      );
      assert.ok(
        readApp(appFile).includes(flag),
        `${appFile} no longer reads "${flag}". If the reader was genuinely removed the flag IS inert now — ` +
          `but say so deliberately in INERT_SEEDED_FLAGS rather than by deleting this assertion.`,
      );
    }
  });

  it("the two deliberately-unseeded reads are still unseeded", () => {
    for (const flag of ["SEARCH_SIGNAL_DECAY_DAYS", "place_provenance_stamping_enabled"]) {
      assert.ok(
        !seeded.has(flag),
        `${flag} is now seeded by ${seeded.get(flag)}. Read the UNSEEDED_READS entry in ` +
          `scripts/check-flag-polarity.mjs before assuming that is an improvement — both entries argue that ` +
          `a row would be WORSE than no row.`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION PROOF — R9 must actually go red.
//
// Each case builds a throwaway tree containing one read of a flag no migration
// seeds, points the script at it, and asserts a non-zero exit carrying the
// PHANTOM FLAG message naming that exact flag. Then the control: the SAME
// fixture with a flag that IS seeded must not produce that message.
//
// Without the control every case would pass on a script that printed "PHANTOM
// FLAG" unconditionally.
// ─────────────────────────────────────────────────────────────────────────────

describe("check-flag-polarity R9 — mutation proof", () => {
  let tmp: string;

  before(() => { tmp = mkdtempSync(join(tmpdir(), "flag-phantom-")); });
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  /** A minimal API src/ fixture: one route file reading `flag`. */
  function srcFixture(name: string, flag: string): string {
    const dir = join(tmp, name, "routes");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmp, name, "lib"), { recursive: true });
    // The shared helper must be DEFINED in the fixture, or the scanner sees a
    // call to something it does not recognise as a reader.
    writeFileSync(
      join(tmp, name, "lib", "featureFlags.ts"),
      "export async function isFlagEnabled(_db: unknown, _f: string) { return false; }\n" +
        "export async function isKillSwitchEngaged(_db: unknown, _f: string) { return true; }\n",
    );
    writeFileSync(
      join(dir, "fixture.ts"),
      `import { isFlagEnabled } from "../lib/featureFlags.js";\n` +
        `export async function handler(db: unknown) {\n` +
        `  return isFlagEnabled(db, "${flag}");\n` +
        `}\n`,
    );
    return join(tmp, name);
  }

  /** A minimal app fixture: one screen reading `flag` via FeatureFlagsContext. */
  function appFixture(name: string, flag: string): string {
    const dir = join(tmp, name, "app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "screen.tsx"),
      `import { useFeatureFlags } from '../src/context/FeatureFlagsContext.tsx';\n` +
        `export default function Screen() {\n` +
        `  const { isEnabled } = useFeatureFlags();\n` +
        `  return isEnabled('${flag}') ? 1 : 0;\n` +
        `}\n`,
    );
    // R8 verifies APP_TREE_READS entries against files in this tree, so the
    // fixture must carry the real declared reader too or R8 fails for an
    // unrelated reason and the assertion below stops being about R9.
    mkdirSync(join(dir, "(tabs)"), { recursive: true });
    writeFileSync(
      join(dir, "(tabs)", "media.tsx"),
      `export const x = ['MEDIA_WORLD_SHELL_ENABLED'];\n`,
    );
    mkdirSync(join(tmp, name, "src", "components", "media"), { recursive: true });
    writeFileSync(
      join(tmp, name, "src", "components", "media", "MediaQuickCreateSheet.tsx"),
      `export const y = ['MEDIA_HIDDEN_GEMS_CREATE_ENABLED'];\n`,
    );
    return join(tmp, name);
  }

  function run(env: Record<string, string>): { code: number; out: string } {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: PKG_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  const phantomLine = (flag: string) => `PHANTOM FLAG — READ BUT NEVER SEEDED: "${flag}"`;

  // SCREAMING_CASE — the convention seven of the eight real phantoms used, and
  // the one the audit's first lowercase-only regex pass missed entirely.
  it("goes RED for a SCREAMING_CASE phantom read in the API tree", () => {
    const { code, out } = run({ FLAG_POLARITY_SRC: srcFixture("src-screaming", "ZZ_FIXTURE_PHANTOM_ENABLED") });
    assert.equal(code, 1, `expected a failing exit.\n${out}`);
    assert.ok(out.includes(phantomLine("ZZ_FIXTURE_PHANTOM_ENABLED")), `R9 did not name the phantom.\n${out}`);
  });

  // snake_case — the other convention. Both, or the rule has a blind half.
  it("goes RED for a snake_case phantom read in the API tree", () => {
    const { code, out } = run({ FLAG_POLARITY_SRC: srcFixture("src-snake", "zz_fixture_phantom_enabled") });
    assert.equal(code, 1, `expected a failing exit.\n${out}`);
    assert.ok(out.includes(phantomLine("zz_fixture_phantom_enabled")), `R9 did not name the phantom.\n${out}`);
  });

  // The app half. This is the one that matters most: MEDIA_WORLD_SHELL_ENABLED
  // was read ONLY here, and the pre-R9 script did not walk this tree for reads
  // at all — which is exactly why the most serious of the eight survived a
  // guard that was otherwise thorough.
  it("goes RED for a phantom read that exists ONLY in the app tree", () => {
    const { code, out } = run({
      FLAG_POLARITY_SRC: srcFixture("src-clean", "MEDIA_TAB_ENABLED"),
      FLAG_POLARITY_APP_ROOT: appFixture("app-phantom", "ZZ_FIXTURE_APP_PHANTOM_ENABLED"),
    });
    assert.equal(code, 1, `expected a failing exit.\n${out}`);
    assert.ok(out.includes(phantomLine("ZZ_FIXTURE_APP_PHANTOM_ENABLED")), `R9 did not name the app-tree phantom.\n${out}`);
    assert.ok(out.includes("read ONLY in the app tree"), `the message should say where the read lives.\n${out}`);
  });

  // CONTROL. Without this, a script that printed PHANTOM FLAG for every flag —
  // or exited 1 for any reason at all — would pass all three cases above.
  it("does NOT report a phantom when the same fixture reads a SEEDED flag", () => {
    const { out } = run({
      FLAG_POLARITY_SRC: srcFixture("src-control", "MEDIA_TAB_ENABLED"),
      FLAG_POLARITY_APP_ROOT: appFixture("app-control", "map_search_enabled"),
    });
    assert.ok(
      !out.includes("PHANTOM FLAG"),
      `R9 fired on flags that ARE seeded (MEDIA_TAB_ENABLED, map_search_enabled). The rule is not ` +
        `discriminating and the RED cases above prove nothing.\n${out}`,
    );
  });

  // ── The failure report must arrive WHOLE ───────────────────────────────────
  //
  // Found while red-proofing the cases above: the script ended with
  // `console.error(bigReport); process.exit(1)`, and process.exit() does not
  // flush an asynchronous stderr write. Piped to a test harness or a CI log,
  // roughly one run in eight lost the tail of a ~100 KB report — including, in
  // the run that mattered, the PHANTOM FLAG line itself. The exit code was
  // still 1, so it still "failed"; it just told the reader the wrong reason,
  // intermittently. Fixed by setting process.exitCode instead.
  //
  // The summary footer is printed LAST, so requiring it is the cheap, exact
  // test for "nothing was dropped off the end".
  it("emits its whole failure report when stderr is a pipe", () => {
    const fixture = srcFixture("src-truncation", "ZZ_FIXTURE_TRUNCATION_ENABLED");
    // Repeat: the old bug was intermittent, so a single green run proved nothing.
    for (let i = 0; i < 8; i++) {
      const { code, out } = run({ FLAG_POLARITY_SRC: fixture });
      assert.equal(code, 1, `run ${i}: expected a failing exit.`);
      assert.ok(
        out.includes(phantomLine("ZZ_FIXTURE_TRUNCATION_ENABLED")),
        `run ${i}: the PHANTOM FLAG line is missing from a ${out.length}-byte report — the report was truncated.`,
      );
      assert.match(
        out,
        /problem\(s\)\.\s*$/,
        `run ${i}: the report does not end with its summary footer, so output was dropped off the end ` +
          `(${out.length} bytes captured).`,
      );
    }
  });

  // The real tree must be green. Belt and braces with `npm run check:flag-polarity`,
  // but this file is where a reader looks for the R9 story, so the end state
  // belongs here too.
  it("the real repository passes R9", () => {
    const { code, out } = run({});
    assert.equal(code, 0, `check-flag-polarity must pass on the real tree.\n${out}`);
    assert.ok(out.includes("Read-but-unseeded: 0 phantoms"), `expected the R9 line in the report.\n${out}`);
  });
});
