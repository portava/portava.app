/**
 * candidateProjection — the client reader for the server-built DiscoveryCandidate.
 * census-discovery DSV2-04 (the client leg split off A03) and DC-22 (reason labels).
 *
 * WHAT THIS IS READING
 * ====================
 * `artifacts/api-server/src/lib/discoveryCandidate.ts` builds one projection per
 * served place and `withDiscoveryCandidates` attaches it as `place.candidate`
 * on `GET /api/discovery` (`routes/discovery.ts:1850`, `:2100`, `:2192`,
 * `:2282`). `toPublic` is the identity function (`routes/discovery.ts:196`), so
 * the field arrives on the wire exactly as the server built it.
 *
 * THREE PROPERTIES OF THE WIRE THAT SHAPE THIS FILE
 * =================================================
 * 1. **The field is OPTIONAL and flag-gated.** `discovery_candidate_projection_enabled`
 *    is seeded FALSE by migration 2361, and with it off `withDiscoveryCandidates`
 *    returns the array it was handed — the field is simply ABSENT. Absent is the
 *    normal case today, not an error, and it must render as "nothing extra",
 *    never as an empty or unknown badge.
 * 2. **Null is a distinct value from empty.** The server is explicit that
 *    `whyNow` is `null` — never `[]` — whenever no reading backs it, "so
 *    'absent' cannot read as 'none apply'". This module preserves that: a null
 *    why-now yields no claim line at all.
 * 3. **The server never invents a class it cannot ground.** Sensing §5.1 names
 *    seven truth classes; `discoveryCandidate.ts:51-53` records that
 *    `inferred` / `predicted` / `conflicting` "have NO producer on this surface
 *    today and are never emitted — emitting them would be the forbidden
 *    rendering". This module still names all seven, because DSV2-04 is about
 *    what the CLIENT does when one arrives: a class that shows up must render
 *    distinctly on the day a producer exists, not be silently folded into
 *    "observed".
 *
 * WHY THE PARSE IS DEFENSIVE AND RETURNS NULL RATHER THAN A DEFAULT
 * ================================================================
 * A malformed or partial projection is indistinguishable, from here, from a
 * server that does not send one. Substituting a default would assert a truth
 * class nobody computed — the same over-claim §5.1 forbids — so anything this
 * module cannot fully recognise yields `null` and the surface renders as if the
 * flag were off. An UNRECOGNISED truth class is dropped for the same reason: a
 * client that cannot name a class cannot render it distinctly, and rendering it
 * indistinguishably is precisely the failure.
 */

/** Sensing §5.1's vocabulary, in full. Only the first four have a producer today. */
export const TRUTH_CLASSES = [
  'corroborated', 'observed', 'stale', 'unknown',
  'inferred', 'predicted', 'conflicting',
] as const;

export type DiscoveryTruthClass = (typeof TRUTH_CLASSES)[number];

export type DiscoveryFreshnessState = 'fresh' | 'stale' | 'unknown';

/** `01` §11 — an internal reason code with the plain language a user may see. */
export interface DiscoveryReason {
  code: string;
  text: string;
}

export interface DiscoveryCandidate {
  id: string;
  /** Grounded live reasons in the claims' OWN vocabulary. Null ⇒ no reading, never "none apply". */
  whyNow: string[] | null;
  /** Ranker feature keys with positive contribution, strongest first. */
  whyForUser: string[];
  confidence: number;
  freshness: { state: DiscoveryFreshnessState; ageMs: number | null; servedFrom: string };
  truthClass: DiscoveryTruthClass;
  /** DC-22's "reason labels". Empty ⇒ no ranker ran, or every signal is guardrailed. */
  reasons: DiscoveryReason[];
}

/**
 * How a truth class must be SHOWN.
 *
 * `kind` is the DSV2-04 distinction itself, and it is the reason this is a
 * table and not a formatter: "observed and predicted render distinctly" is a
 * claim about two FAMILIES, and a family membership that lives in a table can
 * be checked by a test. `conflicting` is neither — it is a statement that the
 * sources disagree, and calling it either an observation or a prediction would
 * assert something no source did.
 */
export type TruthClassKind = 'observation' | 'prediction' | 'conflict' | 'unknown';

export interface TruthClassPresentation {
  /** The chip text. Unique across all seven — a shared label is an indistinct rendering. */
  label: string;
  kind: TruthClassKind;
  /** Screen-reader text; says what KIND of claim this is, not only its name. */
  accessibilityLabel: string;
}

export const TRUTH_CLASS_PRESENTATION: Readonly<Record<DiscoveryTruthClass, TruthClassPresentation>> = {
  corroborated: {
    label: 'Corroborated',
    kind: 'observation',
    accessibilityLabel: 'Corroborated — two independent sources observed this',
  },
  observed: {
    label: 'Observed',
    kind: 'observation',
    accessibilityLabel: 'Observed — one source observed this',
  },
  stale: {
    label: 'Last seen earlier',
    kind: 'observation',
    accessibilityLabel: 'Last seen earlier — a real observation whose age is unknown',
  },
  unknown: {
    label: 'Unverified',
    kind: 'unknown',
    accessibilityLabel: 'Unverified — no source class could be established',
  },
  inferred: {
    label: 'Inferred',
    kind: 'prediction',
    accessibilityLabel: 'Inferred, not observed — this was derived, not seen',
  },
  predicted: {
    label: 'Predicted',
    kind: 'prediction',
    accessibilityLabel: 'Predicted, not observed — this is a forecast',
  },
  conflicting: {
    label: 'Sources disagree',
    kind: 'conflict',
    accessibilityLabel: 'Sources disagree about this',
  },
};

function isTruthClass(v: unknown): v is DiscoveryTruthClass {
  return typeof v === 'string' && (TRUTH_CLASSES as readonly string[]).includes(v);
}

function parseFreshness(v: unknown): DiscoveryCandidate['freshness'] | null {
  if (typeof v !== 'object' || v === null) return null;
  const f = v as Record<string, unknown>;
  const state = f.state;
  if (state !== 'fresh' && state !== 'stale' && state !== 'unknown') return null;
  const ageMs = typeof f.ageMs === 'number' && Number.isFinite(f.ageMs) ? f.ageMs : null;
  return {
    state,
    ageMs,
    servedFrom: typeof f.servedFrom === 'string' ? f.servedFrom : '',
  };
}

function parseStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function parseReasons(v: unknown): DiscoveryReason[] {
  if (!Array.isArray(v)) return [];
  const out: DiscoveryReason[] = [];
  for (const r of v) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    // The server already drops a code whose plain language is missing, so a
    // blank `text` here means a shape this client does not understand. Skipped
    // rather than rendered bare: a code is not language.
    if (typeof rec.code !== 'string' || typeof rec.text !== 'string') continue;
    if (rec.text.trim().length === 0) continue;
    out.push({ code: rec.code, text: rec.text });
  }
  return out;
}

/**
 * Read a served `place.candidate`. Null whenever the projection is absent, or
 * is a shape this client cannot fully name — both render as "no projection".
 */
export function parseDiscoveryCandidate(raw: unknown): DiscoveryCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;

  if (!isTruthClass(c.truthClass)) return null;
  const freshness = parseFreshness(c.freshness);
  if (!freshness) return null;

  // `null` and a non-empty list are the only meaningful states the server
  // emits; anything else (including `[]`, which it promises never to send)
  // collapses to null so an absence cannot read as an endorsement.
  const whyNowList = parseStringList(c.whyNow);
  const whyNow = Array.isArray(c.whyNow) && whyNowList.length > 0 ? whyNowList : null;

  return {
    id: typeof c.id === 'string' ? c.id : '',
    whyNow,
    whyForUser: parseStringList(c.whyForUser),
    confidence: typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : 0,
    freshness,
    truthClass: c.truthClass,
    reasons: parseReasons(c.reasons),
  };
}

export interface WhyNowPresentation {
  /** The grounded claims, humanised for display. Empty ⇒ render no claim line. */
  claims: string[];
  /**
   * DSV2-04's second clause. True ⇒ the claims must NOT be shown as current;
   * the surface says so in words rather than dropping them, so a user can tell
   * "we saw this a while ago" from "we have nothing".
   */
  stale: boolean;
}

/**
 * A claim token rendered for a human. `crowd_busy` → `crowd busy`.
 *
 * Presentation only: the token itself is the claim's OWN vocabulary, copied
 * verbatim from `lib/discoveryLiveRank`. Nothing is translated into a different
 * claim, because a nicer sentence would be a claim this client made up.
 */
function humaniseClaim(token: string): string {
  return token.replace(/_/g, ' ').trim();
}

/**
 * Why-now, ready to render.
 *
 * A claim is EXPIRED when the projection itself says the serve was stale —
 * either the freshness block (`state === 'stale'`, which the server sets from
 * the `L2_stale` serve point) or the truth class the same serve produced. Those
 * are the only two expiry facts on the wire; this module invents no clock of
 * its own, because a client-side age threshold would be a freshness judgement
 * the server did not make.
 */
export function whyNowPresentation(
  candidate: DiscoveryCandidate | null | undefined,
): WhyNowPresentation {
  if (!candidate || !candidate.whyNow || candidate.whyNow.length === 0) {
    return { claims: [], stale: false };
  }
  const stale = candidate.freshness.state === 'stale' || candidate.truthClass === 'stale';
  return { claims: candidate.whyNow.map(humaniseClaim), stale };
}
