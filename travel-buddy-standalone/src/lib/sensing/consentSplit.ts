/**
 * consentSplit — the WORDS of OD-MAP-6's three separate passive-sensing
 * consents, keyed by the disclosure version the server records for each.
 *
 * OD-MAP-6 (docs/ops/owner-decisions-20261004.md): "Separate consent for
 * on-device capture, contribution upload, and each secondary use. Make it
 * revocable; don't bundle it with general app consent."
 *
 * Lead ruling on Q-L20 (2026-10-06): each consent says, in plain words, what is
 * captured, where it goes, who sees it, and how to turn it off. This is the
 * lane's draft, approved by the lead in review and PENDING LEGAL REVIEW
 * (docs/ops/lead-rulings-20261006.md; docs/contracts/sensing-consent-split-v1.md
 * carries the same text). The server's `sensing_consent_split_enabled` flag stays
 * off until that review signs off.
 *
 * The versions MUST equal the server's SENSING_CONSENT_DISCLOSURE_VERSIONS
 * (artifacts/api-server/src/lib/sensingConsentGrants.ts): both sides pin the same
 * literals in their tests. A version this build has no words for is shown as
 * "update the app", never as other words.
 *
 * PURE. No I/O.
 */

export type SensingConsentScope = 'capture' | 'upload' | 'surface';
export const SENSING_CONSENT_SCOPES: readonly SensingConsentScope[] = ['capture', 'upload', 'surface'];

export interface SensingConsentWords {
  version: string;
  title: string;
  /** What is captured or used. */
  what: string;
  /** Where it goes. */
  where: string;
  /** Who sees it. */
  who: string;
  /** How to turn it off, and what happens then. */
  off: string;
  /** When it has an effect only together with an earlier consent, say so. */
  needs?: string;
}

export const SENSING_CONSENT_WORDS: Readonly<Record<SensingConsentScope, SensingConsentWords>> = Object.freeze({
  capture: Object.freeze({
    version: 'sensing_capture_v1',
    title: 'Sense the area around me, on this phone',
    what: 'Your phone works out rough signals from its motion sensors and location: how much you are moving, and which neighbourhood-sized area you are in. Exact positions are not kept, and no sound is recorded.',
    where: 'Everything stays on this phone. Nothing is sent anywhere because of this switch.',
    who: 'Only you, inside the app — for example so Compass can tell which area you are in.',
    off: 'Turn this off at any time, here. Sensing stops on this phone straight away.',
  }),
  upload: Object.freeze({
    version: 'sensing_upload_v1',
    title: 'Send my area signals to improve live information',
    what: 'The rough signals from the switch above — never your exact location, never a recording, never your name or account.',
    where: 'Sent to Portava under a short-lived code that does not identify you, combined with other travellers’ signals, and deleted after a day — three days at the very most.',
    who: 'No one sees your signals on their own. They are only used combined with enough other people’s that no one can be picked out.',
    off: 'Turn this off at any time, here. This phone stops sending straight away; signals already sent are deleted on their normal schedule.',
    needs: 'Has an effect only while “Sense the area around me” is on.',
  }),
  surface: Object.freeze({
    version: 'sensing_surface_v1',
    title: 'Let combined results that include my signals be shown to others',
    what: 'Whether an area looks busy right now, worked out from many travellers’ signals, including yours.',
    where: 'Shown in Portava to other travellers as “people are here” or “not known” — never a number and never who. Portava does not show these results to anyone yet; this records your choice for when it does.',
    who: 'Other travellers using Portava, only ever as that combined result.',
    off: 'Turn this off at any time, here. Signals sent after that never count toward anything shown to others; ones already sent stop counting when they are deleted, within three days.',
    needs: 'Has an effect only while both switches above are on.',
  }),
});

/** The words for a scope if THIS build has the version the server says is in force, else null ("update the app"). */
export function wordsFor(scope: SensingConsentScope, serverVersion: string | null | undefined): SensingConsentWords | null {
  const w = SENSING_CONSENT_WORDS[scope];
  return serverVersion && w.version === serverVersion ? w : null;
}

/** The minimal shape of a consent read this decision needs (services/sensingConsent's SensingConsentRead). */
export type ConsentReadLike =
  | { status: 'ok'; state: { consents: Record<SensingConsentScope, { effective: boolean }> } }
  | { status: 'unreadable' };

/**
 * What the person's three consents allow the passive capture loop to do. A
 * consent that could not be read allows NOTHING. Upload needs capture.
 */
export function sensingCaptureDecision(read: ConsentReadLike | { status: string } | null | undefined): { capture: boolean; upload: boolean } {
  if (!read || read.status !== 'ok') return { capture: false, upload: false };
  const c = (read as Extract<ConsentReadLike, { status: 'ok' }>).state.consents;
  const capture = c.capture?.effective === true;
  return { capture, upload: capture && c.upload?.effective === true };
}

