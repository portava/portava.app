/**
 * stampVerificationPresentation — Passport spec §12 ("issue date AND verification
 * treatment visible in the detail view") and §27 (never colour alone).
 *
 * WHAT WAS WRONG, AND WHY IT WAS INVISIBLE
 * ========================================
 * `deriveStampVerification` already decided a stamp's provenance and already
 * failed closed. Its PRESENTATION — the word, the colour, the glyph — was
 * module-private inside PassportStampCollection.tsx, so it existed on the stamp
 * STRIP and nowhere else. §12 names the DETAIL view as the place the treatment
 * must appear beside the issue date, and that view showed the issue date, a
 * source label, and nothing about verification at all (census-passport P68).
 *
 * The tempting fix is to write the label and colour again in the modal. That is
 * exactly how one fact grows two vocabularies — the universal display-name rule
 * in this repo reached FIVE copies, one of which had drifted to a different
 * answer. So the presentation has one home and both surfaces import it, and the
 * last test here asserts neither has grown a local copy back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  VERIFICATION_META,
  stampVerification,
} from '../stampVerificationPresentation.ts';
import { deriveStampVerification } from '../../../services/passportStampMappers.ts';

const SRC = join(process.cwd(), 'src');

describe('§12 — every provenance has a word and a glyph, and only one wears the shield', () => {
  it('covers all three provenance values with distinct words', () => {
    const labels = Object.values(VERIFICATION_META).map((m) => m.label);
    expect(labels.sort()).toEqual(['Decorative', 'Self-reported', 'Verified']);
    expect(new Set(labels).size).toBe(3); // two provenances sharing a word would be indistinguishable
  });

  it('§27: the glyph and the colour are BOTH distinct, so colour is never the only signal', () => {
    const icons = Object.values(VERIFICATION_META).map((m) => m.Icon);
    const colors = Object.values(VERIFICATION_META).map((m) => m.color);
    expect(new Set(icons).size).toBe(3); // a shared glyph would merge two provenances in greyscale
    expect(new Set(colors).size).toBe(3);
  });

  it('only `verified` is green — a self-reported stamp cannot impersonate one', () => {
    expect(VERIFICATION_META.verified.color).toBe('#2E7D5B');
    expect(VERIFICATION_META.reported.color).not.toBe(VERIFICATION_META.verified.color);
    expect(VERIFICATION_META.decorative.color).not.toBe(VERIFICATION_META.verified.color);
    expect(VERIFICATION_META.reported.Icon).not.toBe(VERIFICATION_META.verified.Icon);
  });

  it('an absent verification reads Decorative, never Verified', () => {
    // Fail-closed, matching the derivation's own posture for unknown provenance.
    expect(stampVerification({})).toBe('decorative');
    expect(stampVerification({ verification: undefined })).toBe('decorative');
    expect(stampVerification({ verification: 'verified' })).toBe('verified');
  });
});

describe('§12 — the detail view derives nothing of its own', () => {
  const modal = readFileSync(join(SRC, 'components/stamps/StampDetailModal.tsx'), 'utf8');
  const strip = readFileSync(join(SRC, 'components/passport/PassportStampCollection.tsx'), 'utf8');

  it('the detail view renders a verification treatment at all (the P68 gap)', () => {
    expect(modal).toMatch(/Verification/); // the P68 gap: no verification row at all
    expect(modal).toMatch(/deriveStampVerification\(stamp\.sourceType, stamp\.verificationLevel\)/);
  });

  it('BOTH surfaces import the shared presentation instead of writing their own', () => {
    for (const [name, src] of [['detail view', modal], ['stamp strip', strip]] as const) {
      expect({ surface: name, importsShared: /VERIFICATION_META[\s\S]{0,200}stampVerificationPresentation\.ts|stampVerificationPresentation\.ts[\s\S]{0,200}VERIFICATION_META/.test(src) })
        .toEqual({ surface: name, importsShared: true });
    }
  });

  it('neither surface has grown a local copy of the label or the colour back', () => {
    // Comments are stripped: a header explaining WHY 'Self-reported' lives
    // elsewhere must not be mistaken for a local copy of it. A check that
    // punishes its own documentation gets its documentation deleted.
    const strip_comments = (raw: string): string =>
      raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
    for (const [name, src] of [['detail view', modal], ['stamp strip', strip]] as const) {
      const code = strip_comments(src);
      expect({ surface: name, reDeclaresLabel: /'Self-reported'|"Self-reported"/.test(code) })
        .toEqual({ surface: name, reDeclaresLabel: false });
      expect({ surface: name, reDeclaresColor: code.includes('#2E7D5B') })
        .toEqual({ surface: name, reDeclaresColor: false });
    }
  });
});

describe('§12 — the decision the presentation renders is the canonical one', () => {
  it('a genuine verification level is Verified whatever the source says', () => {
    expect(deriveStampVerification('manual', 'host_verified')).toBe('verified');
  });

  it('an unknown source with no level is Decorative, not Verified', () => {
    expect(deriveStampVerification('something_new', null)).toBe('decorative');
    expect(deriveStampVerification(null, null)).toBe('decorative');
  });

  it('every value the derivation can return has a presentation', () => {
    // Guards the pairing: a fourth provenance added to the derivation without a
    // presentation would render `undefined` and crash the row.
    for (const v of ['verified', 'reported', 'decorative'] as const) {
      expect({ provenance: v, hasPresentation: !!VERIFICATION_META[v] }).toEqual({ provenance: v, hasPresentation: true });
      expect(typeof VERIFICATION_META[v].label).toBe('string');
    }
  });
});
