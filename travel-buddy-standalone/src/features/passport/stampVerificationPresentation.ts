/**
 * stampVerificationPresentation — the ONE place a stamp's provenance treatment
 * is turned into something a person sees (Passport spec §12, §27).
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `deriveStampVerification` (services/passportStampMappers.ts) already decides
 * WHAT a stamp's provenance is, from `sourceType` + `verificationLevel`, and
 * fails closed: unknown provenance is `decorative`, so nothing can impersonate a
 * verified stamp. That decision had exactly one presentation, and it was
 * module-private inside PassportStampCollection.tsx — so the stamp DETAIL view,
 * which spec §12 names as the place issue date *and verification treatment* must
 * appear, showed neither the badge nor the word (census-passport P68).
 *
 * The obvious fix is to write the label and colour again in the modal. That is
 * how two vocabularies for one fact begin: this session already found the
 * universal display-name rule copied into five places, one of which had drifted
 * to a different answer. So the presentation moves here and both surfaces import
 * it, and `stampVerificationPresentation.test.ts` asserts neither has a local
 * copy.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL (§27): every entry carries a distinct glyph
 * AND a distinct word, so the treatment survives greyscale, colour-blindness and
 * a screen reader.
 */
import { ShieldCheck, PenLine, Sparkles } from 'lucide-react-native';
import type { StampVerification } from '../../types/models.ts';
import { PP } from '../../theme/passportTokens.ts';

export interface VerificationPresentation {
  /** The word shown to a person, and spoken by a screen reader. */
  label: string;
  color: string;
  Icon: typeof ShieldCheck;
}

/**
 * ONLY `verified` wears the green shield. A self-reported or decorative stamp
 * must never be able to read as a verified one — that is the whole point of the
 * three-way split, and it is asserted rather than left to the reader.
 */
export const VERIFICATION_META: Record<StampVerification, VerificationPresentation> = {
  verified: { label: 'Verified', color: '#2E7D5B', Icon: ShieldCheck },
  reported: { label: 'Self-reported', color: '#B4791F', Icon: PenLine },
  decorative: { label: 'Decorative', color: PP.inkMuted, Icon: Sparkles },
};

/**
 * The legacy `PassportStamp` carries an already-derived `verification`, which is
 * optional on older rows. Absent reads as `decorative` — never `verified` — for
 * the same fail-closed reason the derivation itself uses.
 */
export function stampVerification(stamp: { verification?: StampVerification }): StampVerification {
  return stamp.verification ?? 'decorative';
}
