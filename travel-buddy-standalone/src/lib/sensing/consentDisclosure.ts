/**
 * consentDisclosure — the exact words a person agrees to, keyed by the
 * disclosure VERSION the server records, and what each version covers.
 *
 * ── WHY THE TEXT IS KEYED BY VERSION ─────────────────────────────────────────
 * The server stamps `consent_version` on every grant (artifacts/api-server/src/
 * lib/intelConsent.ts, INTEL_CONSENT_DISCLOSURE_VERSION). That stamp is the
 * evidence of WHICH words a person agreed to — so the words on screen must be
 * the words that version names, or the record is false. Before this module the
 * consent screens hard-coded one text, and the day the server's version moved
 * every new grant would have been recorded against text nobody had seen.
 *
 * So every consent surface renders `disclosureFor(state.currentDisclosureVersion)`
 * — the version the server says it will stamp — sends that version back with
 * the grant, and the server refuses a grant whose displayed version is not the
 * one it stamps. A version this build has no text for is shown as "update the
 * app", never as the previous text.
 *
 * ── WHAT EACH VERSION COVERS ─────────────────────────────────────────────────
 *   intel_contributions_v1   Quick Signals — explicit taps — combined with other
 *                            travelers' reports. It says NOTHING about passive
 *                            motion or location sensing, so it does not permit
 *                            the passive capture loop to start.
 *   sensing_contributions_v2 written for passive sensing: coarse on-device
 *                            reduction, aggregation only above a crowd
 *                            threshold, and — explicitly — that other people
 *                            may see "people are here / not known", never a
 *                            count and never who. DEFINED HERE, NOT IN FORCE:
 *                            the server still stamps v1, so no one can hold it
 *                            until the owner approves this text and ships it.
 *                            The text under review, and what activating it
 *                            takes, is docs/contracts/sensing-consent-disclosure-v2.md.
 *
 * PURE. No I/O. Mirrors artifacts/api-server/src/lib/sensingConsentScopes.ts;
 * the two version strings are pinned equal by that module's tests and this one's.
 */

export const CONSENT_V1 = 'intel_contributions_v1';
export const CONSENT_V2 = 'sensing_contributions_v2';

export interface ConsentDisclosure {
  version: string;
  title: string;
  /** Rendered in order, verbatim. */
  paragraphs: readonly string[];
  footnote: string;
  /** Short line for a settings row. */
  summary: string;
  /** May the PASSIVE capture loop run under this consent? */
  coversPassiveSensing: boolean;
  /** May a contribution made under it be shown to other people (aggregated)? */
  coversSurface: boolean;
}

export const CONSENT_DISCLOSURES: Readonly<Record<string, ConsentDisclosure>> = Object.freeze({
  [CONSENT_V1]: Object.freeze({
    version: CONSENT_V1,
    title: 'Help improve live place intelligence',
    paragraphs: Object.freeze([
      'Your Quick Signals can be combined with reports from other travelers to show what a place is like right now.',
      "Your identity and exact location aren't shown publicly with the signal. Portava uses your contribution to generate aggregated place intelligence.",
    ]),
    footnote: 'You can turn Intelligence Contributions off anytime in Privacy settings.',
    summary: 'Your Quick Signals count toward aggregated intelligence. Your identity and exact location are never shown publicly with them.',
    coversPassiveSensing: false,
    coversSurface: false,
  }),
  [CONSENT_V2]: Object.freeze({
    version: CONSENT_V2,
    title: 'Help show what places are like right now',
    paragraphs: Object.freeze([
      "With this on, your phone can notice, in the background, coarse signals about how you're moving — for example walking, staying a while, or arriving — and the rough area you're in. It turns them into a few simple categories on your phone before anything is sent.",
      'No exact location, no recording, no contact list and no account ID is sent with these signals. They are only counted together with other travelers when enough different people are in the same area at the same time.',
      "When enough people are counted, other travelers may see that people are around a place right now, or that it isn't known. Never how many, and never who.",
      'Your Quick Signals are still combined with other reports to show what a place is like right now.',
    ]),
    footnote: 'Turning this off stops your phone from contributing at its next check. Sound level sensing is a separate choice with its own switch.',
    summary: 'In the background, coarse movement and area signals, reduced on your phone, count toward what a place is like right now. Others may see that people are here — never how many, never who.',
    coversPassiveSensing: true,
    coversSurface: true,
  }),
});

/** The text for a version, or null when this build has none (render "update the app", never older text). */
export function disclosureFor(version: string | null | undefined): ConsentDisclosure | null {
  if (typeof version !== 'string' || version.length === 0) return null;
  return CONSENT_DISCLOSURES[version] ?? null;
}

/** The consent fields this module reads — structurally, so it imports no service. */
export interface RecordedConsentView {
  enabled: boolean;
  consentVersion: string | null;
  withdrawnAt: string | null;
  currentDisclosureVersion?: string | null;
}

function isValid(state: RecordedConsentView | null | undefined): state is RecordedConsentView {
  return !!state && state.enabled === true && !state.withdrawnAt;
}

/** May the PASSIVE capture loop run? Valid consent AND a recorded version whose text covers it. */
export function consentCoversPassiveSensing(state: RecordedConsentView | null | undefined): boolean {
  if (!isValid(state)) return false;
  return disclosureFor(state.consentVersion)?.coversPassiveSensing === true;
}

/** Valid consent recorded against a version other than the one the server now stamps. */
export function needsReconsent(state: RecordedConsentView | null | undefined): boolean {
  if (!isValid(state)) return false;
  const current = state.currentDisclosureVersion;
  return typeof current === 'string' && current.length > 0 && current !== state.consentVersion;
}
