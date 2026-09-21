/**
 * PASSPORT RATIFIED IDENTITY — A DECISION GUARD, NOT A FEATURE TEST.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ IF THIS FILE IS FAILING, READ THE DECISION BEFORE CHANGING ANY CODE:       │
 * │   docs/architecture/brand-palette-decision.md                             │
 * │   ratified 2026-09-14, commit 5b60439b1                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS EXISTS
 * ===============
 * Three Passport requirements — P13, P128 and P133 — are recorded `W` in
 * `docs/architecture/census-passport.md` (first committed 2026-09-09,
 * `42aeac38e`). Five days later the owner ratified a decision that SUPERSEDES
 * the visual prose those rows were measured against:
 *
 *   "The mockup approves the palette only — not a new layout. Build upon
 *    existing components and shared tokens; do not rebuild working screens."
 *
 * That decision (line 131) rules on P13 BY NAME: **stays W**, change **"none"**.
 *
 * So those rows are `W` because the work was DECLINED, not because it is
 * pending. The census schema has no verdict for "intentionally out of scope"
 * (`checkCensusIntegrity.ts` admits only C | W | N | X), so nothing in the
 * documents themselves stops a future sweep from reading `W` as "unfinished"
 * and helpfully building the very thing the owner rejected.
 *
 * THIS FILE IS THAT STOP. Each assertion below pins a property the owner
 * ratified. If a future change trips one, the message says which decision it
 * contradicts and where to read it — so the next agent learns *why* rather than
 * concluding "the Passport is missing dark mode, I should add it".
 *
 * WHAT THIS FILE DOES **NOT** CLAIM
 * =================================
 *   - It does NOT make P13, P128 or P133 pass. They remain `W`. Nothing here is
 *     evidence that the superseded requirement was implemented, because it was
 *     not, and pretending otherwise would be worse than leaving them `W`.
 *   - It does NOT freeze the "restrained glass" question of P133. That one is
 *     genuinely UNDECIDED (the census asks "whether restrained glass survives
 *     the paper metaphor at all"), and a guard asserting glass stays absent
 *     would be this lane quietly deciding an open design question. Only
 *     RATIFIED properties are pinned here.
 *
 * It also discharges the cross-lane request in `census-passport.md` §15.5 —
 * that P129 and P132, both closed `C` on the palette ruling, are pinned by
 * nothing and would go false silently. They are pinned here.
 *
 * Source-text assertions (rather than render assertions) are deliberate: the
 * claim being guarded is about what the tree DECLARES, which is exactly what a
 * future sweep would edit.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const DECISION =
  'docs/architecture/brand-palette-decision.md (ratified 2026-09-14, commit 5b60439b1)';

function read(rel: string): string {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`guarded file has moved or been deleted: ${rel}`);
  return readFileSync(p, 'utf8');
}

/** Every .ts/.tsx file under a directory, recursively, excluding __tests__. */
function sourceFiles(relDir: string): string[] {
  const abs = join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__mocks__') continue;
      out.push(...sourceFiles(join(relDir, entry)));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(join(relDir, entry));
    }
  }
  return out;
}

// ── P128 · the theme half: the Passport is light-only, by ruling ──────────────

describe('P128 — the Passport has one light theme, and that is a decision', () => {
  /**
   * The census's own re-measurement: `useColorScheme` returns 0 across
   * src/theme/, src/components/passport/ and src/features/passport/. The
   * spec sentence "Dark-mode first" is superseded on its surface half (the
   * owner ratified the light paper identity by name) and RESERVED on its theme
   * half (`PASSPORT_DARK_MODE_FIRST` on the blocker ledger) — meaning nobody
   * has authorised a Passport dark mode, and building one would contradict the
   * ratified identity.
   */
  it('does not read the device colour scheme anywhere in the Passport surfaces', () => {
    const dirs = ['src/theme', 'src/components/passport', 'src/features/passport'];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of sourceFiles(dir)) {
        if (read(file).includes('useColorScheme')) offenders.push(file);
      }
    }

    // The explanatory throw comes FIRST, deliberately: a bare `toEqual([])` diff
    // would fail without ever telling the next agent which decision they just
    // contradicted, which is the entire purpose of this file.
    if (offenders.length > 0) {
      throw new Error(
        `A Passport surface now reads useColorScheme: ${offenders.join(', ')}.\n` +
        `This looks like someone building "dark-mode first" from census-passport.md P128.\n` +
        `DO NOT. That clause is SUPERSEDED on its surface half and RESERVED on its theme half by\n` +
        `  ${DECISION}\n` +
        `which ratified the LIGHT paper identity by name (Paper #FFFFFF, Ink #1C1C1A, Seal red #D32F2F)\n` +
        `and said: "retain the existing Passport and Wall colour identities".\n` +
        `P128 is W because the work was DECLINED, not because it is pending.\n` +
        `A Passport dark mode needs a NEW owner ruling (blocker-ledger.md: PASSPORT_DARK_MODE_FIRST).`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the ratified light paper surfaces in the Passport palette', () => {
    const tokens = read('src/theme/passportTokens.ts');
    const ratified: Array<[string, string]> = [
      ['paper', '#FFFFFF'],
      ['ink', '#1C1C1A'],
    ];
    for (const [role, hex] of ratified) {
      if (!new RegExp(`${role}:\\s*'${hex}'`).test(tokens)) {
        throw new Error(
          `Passport token "${role}" is no longer ${hex}.\n` +
          `That value is RATIFIED BY NAME in ${DECISION} §1.\n` +
          `Changing it is a new design decision and needs an owner, not a census row.`,
        );
      }
    }
    expect(tokens).toContain('#FFFFFF');
  });
});

// ── P129 · seal red, closed C on the ruling and pinned by nothing until now ───

describe('P129 — seal red is the Passport identity accent (census §15.5 request)', () => {
  it('keeps seal red #D32F2F in the Passport palette', () => {
    const tokens = read('src/theme/passportTokens.ts');
    if (!/seal:\s*'#D32F2F'/.test(tokens)) {
      throw new Error(
        `Passport "seal" is no longer #D32F2F.\n` +
        `census-passport.md P129 was moved W -> C on exactly this value, ratified in ${DECISION}.\n` +
        `§15.5 records that this row was pinned by NO test; this is that pin. Changing the hex\n` +
        `silently falsifies a closed census row.`,
      );
    }
    expect(tokens).toMatch(/seal:\s*'#D32F2F'/);
  });
});

// ── P132 · teal-ink availability, same situation ──────────────────────────────

describe('P132 — teal-ink carries availability / social context (census §15.5 request)', () => {
  it('keeps teal-ink #0A3D4A in the shared token set', () => {
    const tokens = read('src/theme/tokens.ts');
    if (!/deep:\s*'#0A3D4A'/.test(tokens)) {
      throw new Error(
        `Shared token "deep" is no longer #0A3D4A (teal-ink).\n` +
        `census-passport.md P132 was moved W -> C on this token carrying availability per §27,\n` +
        `ratified in ${DECISION} §2 ("two palettes, both ratified").\n` +
        `§15.5 records that this row was pinned by NO test; this is that pin.`,
      );
    }
    expect(tokens).toMatch(/deep:\s*'#0A3D4A'/);
  });

  it('keeps the availability screen drawing its accent from that token', () => {
    const screen = read('src/features/passport/AvailabilityScreen.tsx');
    if (!screen.includes('color.deep')) {
      throw new Error(
        `AvailabilityScreen no longer uses color.deep.\n` +
        `census-passport.md §15.4 closed P132 on precisely this: the availability screen imports the\n` +
        `SHARED token set, where teal-ink lives, and paints availability with it.\n` +
        `Moving off it falsifies a closed row. See ${DECISION}.`,
      );
    }
    expect(screen).toContain('color.deep');
  });
});

// ── P13 / P133 · the composition the owner declined to rebuild ────────────────

describe('P13 / P133 — the document-card composition is ratified, not a defect', () => {
  /**
   * P13 and P133 are `W` on a COMPOSITION: a cream document card with a
   * vertical spine and a LEFT-COLUMN avatar, where the older spec prose asks
   * for a circular portrait overlapping a travel hero.
   *
   * `brand-palette-decision.md` §4 uses P13 as its OWN worked counter-example
   * and line 131 records it: **stays W**, change **"none"**. The ruling's last
   * paragraph forbids the rebuild in terms: "do not rebuild working screens".
   *
   * So this guard pins the declined composition. It does not assert the card is
   * good; it asserts that removing the spine or the left column is a DESIGN
   * DECISION requiring an owner, not a census-row cleanup.
   */
  it('keeps the vertical spine and the left-column avatar', () => {
    const card = read('src/components/passport/PassportIdentityCard.tsx');
    /**
     * Matched as BOTH a rendered style reference (`style={s.spine}`) and a
     * style definition (`spine: {`), with end anchors, so that merely RENAMING
     * the style — `leftCol` -> `leftColumnRemoved` — cannot satisfy the guard.
     * A loose `includes('leftCol')` passed that exact mutation while the left
     * column was gone, which is the failure mode this file exists to prevent.
     */
    const required: Array<[string, RegExp]> = [
      ['vertical spine', /style=\{s\.spine\}/],
      ['vertical spine style', /^\s{2}spine:\s*\{/m],
      ['left-column avatar', /style=\{s\.leftCol\}/],
      ['left-column avatar style', /^\s{2}leftCol:\s*\{/m],
    ];
    for (const [what, needle] of required) {
      if (!needle.test(card)) {
        throw new Error(
          `PassportIdentityCard no longer has its ${what} (expected to match ${String(needle)}).\n` +
          `This looks like someone building the "portrait overlapping a hero" composition from\n` +
          `census-passport.md P13/P133. DO NOT. That is a LAYOUT change and the owner declined it:\n` +
          `  ${DECISION}\n` +
          `  "The mockup approves the palette only — not a new layout. ... do not rebuild working screens."\n` +
          `Line 131 of that document records P13 explicitly: stays W, change "none".\n` +
          `P13 and P133 are W because the rebuild was DECLINED, not because it is pending.`,
        );
      }
    }
    expect(card).toMatch(/style=\{s\.leftCol\}/);
  });
});
