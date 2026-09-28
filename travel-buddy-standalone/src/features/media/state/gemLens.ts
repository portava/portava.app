/**
 * features/media — the §16 Hidden Gems LENS model (spec §3/§5/§16/§16.2/§46.1).
 *
 * PURE and framework-free, so every rule the lens keeps is testable without a
 * renderer:
 *
 *   • mapGemLensProjection — reads the REAL `GET /media/gems` payload
 *     (MediaGemStateService's `MediaGemStateProjection`). It never reads a
 *     coordinate, because the server never sends one and a client that looked
 *     for one would be the first place a regression could smuggle it in.
 *   • gemLensReadState — `determined:false` with `'gems'` undetermined is an
 *     UNREADABLE list, not an empty city. The two render differently, because
 *     "there are no gems here" is a claim about the world and "the gem table did
 *     not answer" is not.
 *   • sectionGemLens — the §3 lens output ("Recently confirmed, worth the
 *     detour, seasonal, access-changed") as ordered sections. Every gem lands
 *     in exactly ONE section and the server's `rankGems` order is preserved
 *     inside it: this module groups, it never re-ranks, and no input to it is a
 *     save or visit count (§16.2 "no popularity-first ranking").
 *   • gemContourTreatment — the §46.1 "subtle edge glow or contour treatment",
 *     as data, keyed on the state's TONE: a calm glow for a confirmed/hidden
 *     gem, a protective contour for a fragile one, a muted edge for one that is
 *     unavailable. A fragile gem is never given the brightest treatment.
 *   • gemCardCopy — every string the HiddenGemCard shows, assembled here so a
 *     test can hold the whole card to §46.1's "avoid Viral / Trending / Hot /
 *     popularity-counter language" — including that no count is printed.
 */
import type { HiddenGemLensItem, HiddenGemLensProjection, HiddenGemState } from '../types/hiddenGemMedia.ts';
import {
  GEM_STATES,
  gemStateTreatment,
  gemConfidenceIndicator,
  type GemTone,
} from '../../../lib/gems/gemStateDisplay.ts';

// ── Defensive coercion ────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asState(v: unknown): HiddenGemState {
  return typeof v === 'string' && (GEM_STATES as readonly string[]).includes(v)
    ? (v as HiddenGemState)
    : // An unknown state from a newer server reads as the most conservative
      // calm state, never as "recently confirmed" (which would overstate it).
      'still_hidden';
}

function asCounts(v: unknown): Partial<Record<string, number>> {
  if (!isObj(v)) return {};
  const out: Partial<Record<string, number>> = {};
  for (const [k, raw] of Object.entries(v)) {
    const n = num(raw);
    if (n != null && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

/**
 * Map one server `MediaGemStateItem`. Returns null for anything without a gem
 * id. Reads ONLY the named coarse fields — a `latitude` / `lat` / `location`
 * key on the input is ignored, not forwarded.
 */
export function mapGemLensItem(raw: unknown): HiddenGemLensItem | null {
  if (!isObj(raw)) return null;
  const gemId = str(raw.gemId);
  if (!gemId) return null;
  const conf = isObj(raw.confidence) ? raw.confidence : {};
  return {
    gemId,
    name: str(raw.name),
    placeId: str(raw.placeId),
    category: str(raw.category),
    neighborhood: str(raw.neighborhood),
    city: str(raw.city),
    country: str(raw.country),
    state: asState(raw.state),
    confidence: { score: num(conf.score) ?? 0, band: str(conf.band) ?? 'unverified' },
    contributionCounts: asCounts(raw.contributionCounts),
    verificationLevel: str(raw.verificationLevel),
    lastUpdatedAt: str(raw.lastUpdatedAt),
    imageUrl: str(raw.imageUrl),
  };
}

/** Map the whole `GET /media/gems` body. Safe on `{}` / null / garbage. */
export function mapGemLensProjection(raw: unknown): HiddenGemLensProjection {
  const o = isObj(raw) ? raw : {};
  const gems = (Array.isArray(o.gems) ? o.gems : [])
    .map(mapGemLensItem)
    .filter((g): g is HiddenGemLensItem => g !== null);
  const undetermined = (Array.isArray(o.undetermined) ? o.undetermined : []).filter(
    (u): u is string => typeof u === 'string',
  );
  return {
    generatedAt: str(o.generatedAt),
    city: str(o.city),
    gems,
    total: gems.length,
    // Absent `determined` is NOT read as true: a payload that does not say it
    // was determined has not said so.
    determined: o.determined === true,
    undetermined,
  };
}

// ── Read state: unreadable ≠ empty ────────────────────────────────────────────

export type GemLensReadState =
  /** The list is real and the state behind it was read. */
  | 'determined'
  /** The list is real; per-gem state was derived over an aggregate that failed. */
  | 'state_partial'
  /** The gem list itself could not be read. Showing "no gems" would be a lie. */
  | 'list_unreadable';

export function gemLensReadState(p: HiddenGemLensProjection | null | undefined): GemLensReadState {
  if (!p) return 'list_unreadable';
  if (p.determined) return 'determined';
  if (p.undetermined.includes('gems')) return 'list_unreadable';
  // Undetermined for any other reason (or for none named) — the list stands but
  // the state is not a full answer.
  return 'state_partial';
}

/** Empty ONLY when the list was read and genuinely holds nothing. */
export function isGemLensEmpty(p: HiddenGemLensProjection): boolean {
  return gemLensReadState(p) !== 'list_unreadable' && p.gems.length === 0;
}

// ── §3 sections ───────────────────────────────────────────────────────────────

export type GemLensSectionKey =
  | 'recently_confirmed'
  | 'worth_the_detour'
  | 'still_hidden'
  | 'seasonal'
  | 'access_changed'
  | 'visit_gently';

/** Display order: §3's own sequence first, then the protective sections. */
export const GEM_LENS_SECTION_ORDER: readonly GemLensSectionKey[] = [
  'recently_confirmed',
  'worth_the_detour',
  'still_hidden',
  'seasonal',
  'access_changed',
  'visit_gently',
];

export const GEM_LENS_SECTION_LABELS: Record<GemLensSectionKey, string> = {
  recently_confirmed: 'Recently confirmed',
  worth_the_detour: 'Worth the detour',
  still_hidden: 'Still hidden',
  seasonal: 'Seasonal',
  access_changed: 'Access changed',
  visit_gently: 'Visit gently',
};

/**
 * The single section a gem belongs to. Precedence is PROTECTIVE FIRST: a gem
 * reported closed or overcrowded is never filed under an enticing heading just
 * because somebody also said it was worth it. "Worth the detour" is drawn from
 * the §16.3 `still_worth_it` OBSERVATION, never from saves.
 */
export function gemLensSectionOf(g: HiddenGemLensItem): GemLensSectionKey {
  switch (g.state) {
    case 'access_changed':
    case 'temporarily_unavailable':
      return 'access_changed';
    case 'overcrowding_risk':
    case 'getting_discovered':
    case 'no_longer_hidden':
      return 'visit_gently';
    case 'seasonal':
      return 'seasonal';
    case 'recently_confirmed':
      return 'recently_confirmed';
    default:
      break;
  }
  if ((g.contributionCounts.still_worth_it ?? 0) > 0) return 'worth_the_detour';
  return 'still_hidden';
}

export interface GemLensSection {
  key: GemLensSectionKey;
  label: string;
  gems: HiddenGemLensItem[];
}

/** Group into ordered, non-empty sections. Server order is kept inside each. */
export function sectionGemLens(gems: readonly HiddenGemLensItem[]): GemLensSection[] {
  const buckets = new Map<GemLensSectionKey, HiddenGemLensItem[]>();
  for (const g of gems) {
    const key = gemLensSectionOf(g);
    const arr = buckets.get(key);
    if (arr) arr.push(g);
    else buckets.set(key, [g]);
  }
  return GEM_LENS_SECTION_ORDER.filter((k) => (buckets.get(k)?.length ?? 0) > 0).map((key) => ({
    key,
    label: GEM_LENS_SECTION_LABELS[key],
    gems: buckets.get(key)!,
  }));
}

// ── §46.1 edge glow / contour ─────────────────────────────────────────────────

export type GemContourKind = 'glow' | 'protective' | 'muted';

export interface GemContourTreatment {
  kind: GemContourKind;
  /** The contour line itself. */
  borderColor: string;
  borderWidth: number;
  /** The soft outer glow (shadow on iOS, elevation tint on Android). */
  glowColor: string;
  glowRadius: number;
  glowOpacity: number;
}

/** The gem accent the media tab already uses for its Gems mode. */
export const GEM_ACCENT = '#10B981';

const CONTOURS: Record<GemContourKind, GemContourTreatment> = {
  // Calm discovery glow: the gem accent, soft and wide.
  glow: {
    kind: 'glow',
    borderColor: 'rgba(16,185,129,0.55)',
    borderWidth: 1.5,
    glowColor: GEM_ACCENT,
    glowRadius: 14,
    glowOpacity: 0.35,
  },
  // Fragile / becoming known: a warm contour with a DIMMER glow than a calm
  // gem — care, never enticement (§16.2).
  protective: {
    kind: 'protective',
    borderColor: 'rgba(200,133,26,0.6)',
    borderWidth: 1.5,
    glowColor: '#C8851A',
    glowRadius: 8,
    glowOpacity: 0.18,
  },
  // Unavailable / access changed: a quiet edge and no glow at all.
  muted: {
    kind: 'muted',
    borderColor: 'rgba(250,249,246,0.18)',
    borderWidth: 1,
    glowColor: 'transparent',
    glowRadius: 0,
    glowOpacity: 0,
  },
};

const TONE_TO_CONTOUR: Record<GemTone, GemContourKind> = {
  confirmed: 'glow',
  hidden: 'glow',
  calm: 'glow',
  aware: 'protective',
  protective: 'protective',
  caution: 'muted',
};

export function gemContourTreatment(state: HiddenGemState): GemContourTreatment {
  const tone = gemStateTreatment(state)?.tone ?? 'hidden';
  return CONTOURS[TONE_TO_CONTOUR[tone]];
}

// ── Card copy ─────────────────────────────────────────────────────────────────

export interface GemCardCopy {
  title: string;
  /** Coarse area: "An Thuong · Da Nang". Null when the server named none. */
  area: string | null;
  stateLabel: string;
  confidenceLabel: string | null;
  /** The §16.2 protective note for fragile states, when the state carries one. */
  note: string | null;
  /** "Worth the detour" when a visitor observed it; never a count. */
  observationLabel: string | null;
}

export function gemCardCopy(g: HiddenGemLensItem): GemCardCopy {
  const t = gemStateTreatment(g.state);
  const area = [g.neighborhood, g.city].filter((s): s is string => !!s).join(' · ') || null;
  return {
    title: g.name ?? 'Hidden gem',
    area,
    stateLabel: t?.label ?? 'Still hidden',
    confidenceLabel: gemConfidenceIndicator(g.confidence)?.label ?? null,
    note: t?.note ?? null,
    observationLabel: (g.contributionCounts.still_worth_it ?? 0) > 0 ? 'Worth the detour' : null,
  };
}

/**
 * Every string the CARD ITSELF authors for `g` — for the §46.1 copy test. The
 * gem's own name and area are excluded on purpose: they are the contributor's
 * and the place's words ("Hot Springs Cove" is a name, not hype), and holding
 * them to the vocabulary rule would be testing the wrong author.
 */
export function gemCardChromeStrings(g: HiddenGemLensItem): string[] {
  const c = gemCardCopy(g);
  return [c.stateLabel, c.confidenceLabel, c.note, c.observationLabel].filter(
    (s): s is string => typeof s === 'string',
  );
}
