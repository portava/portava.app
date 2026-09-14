/**
 * discoveryReasonCodes — `01` §11 Explainability: the internal reason
 * vocabulary, and the plain-language strings a user may be shown.
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md` §11 (`:242`):
 *
 *   "Every served recommendation must have internal reasons such as:
 *    trail_affinity, trip_match, nearby_now, trending_local, creator_affinity,
 *    exploration, saved_similar, social_context, season_match."
 *
 *   "User-facing explanations should be plain language, e.g.
 *    'Popular with solo travelers this week.' · 'Frequently added to Tokyo
 *    trips.' · 'Rising near your hotel.' · 'Because you saved similar rooftop
 *    bars.'"
 *
 * census-discovery DV-18, which recorded **zero of nine** in the repository and
 * no plain-language string produced anywhere on this surface. What existed was
 * adjacent and was not this: the candidate projection carried the ranker's own
 * FEATURE KEYS (`categoryAffinity`, `followedAuthor`, `distance`) — internal
 * variable names, not a reason vocabulary, and not language.
 *
 * THIS MODULE TRANSLATES; IT DOES NOT PRODUCE
 * ===========================================
 * Every code emitted here is backed by a signal one of the two rankers actually
 * computed for that row:
 *
 *   Compass  the grounded `RankingFactor.key` list its pipeline attaches to each
 *            candidate (compass/CompassRecommendationEngine.ts), carried to the
 *            projection by lib/discoveryRankProvenance.
 *   PDE      the positive per-feature contributions portavaRank logs to
 *            `rank_events.features` (lib/portavaRank.ts), plus the exploration
 *            governor's `governorSlot` / `governor_<reason>` stamps
 *            (lib/discoveryPde.ts).
 *
 * A signal that did not fire produces no code. A code with no signal is never
 * emitted at all — see below.
 *
 * THREE OF THE NINE HAVE NO PRODUCER, AND ARE NOT FAKED
 * =====================================================
 * `REASON_CODES_WITHOUT_PRODUCER` names them, so the absence is checkable
 * rather than silent:
 *
 *   trail_affinity   There is no Trail object in this repository or in
 *                    production (census-discovery DV-20; `trails`,
 *                    `content_trails`, `trail_edges` all absent). Nothing can
 *                    compute affinity to a thing that does not exist.
 *   trip_match       The trip projection Discovery consumes
 *                    (lib/discoveryTripProjectionConsumer.ts) reaches the
 *                    SEARCH route, not the recommendation ranker; no trip-fit or
 *                    route-fit term exists in either ranker (DV-09). `cityMatch`
 *                    is destination affinity, not trip fit, and calling it
 *                    trip_match would be the over-claim this module exists to
 *                    avoid.
 *   season_match     No seasonality signal exists under any name. Compass's
 *                    `time_relevance` is hours-to-event, not season.
 *
 * Emitting any of the three would be exactly the defect `00-readme` §1 and
 * Sensing §5.1 name for why-now: a prediction rendered as an observation.
 *
 * THE GUARDRAIL IS PART OF THE MAPPING, NOT A LAYER OVER IT
 * ========================================================
 * `01` §10 — PDE must never "expose block/unfollow reasons" or "make
 * safety/private-control events into public reputation penalties"; DSV2's
 * privacy section — "Public explanations must not disclose private social
 * context, block reasons, sensitive locations or restricted evidence."
 *
 * So safety, moderation, trust and penalty signals are ABSENT FROM THE MAP.
 * They are listed in `UNMAPPED_SIGNALS` with the reason, because an omission
 * that is not written down is indistinguishable from an oversight, and the next
 * person to add a signal needs to know which bucket it belongs in. An unmapped
 * signal contributes nothing — never a fallback code, never the raw key.
 *
 * PLAIN LANGUAGE IS FIXED TEXT, NOT A TEMPLATE OVER USER DATA
 * ===========================================================
 * The strings below name no person, no circle, no place and no id. `01` §11's
 * own examples interpolate ("Frequently added to Tokyo trips"), and that shape
 * is deliberately NOT adopted yet: every interpolatable value available here is
 * either private social context or a place the sensitive-location policy
 * governs, and there is no ruling on which are safe to render. Fixed text is
 * the honest amount of specificity until there is one.
 */

/** `01` §11's nine codes, in the specification's own order. */
export const DISCOVERY_REASON_CODES = [
  "trail_affinity",
  "trip_match",
  "nearby_now",
  "trending_local",
  "creator_affinity",
  "exploration",
  "saved_similar",
  "social_context",
  "season_match",
] as const;

export type DiscoveryReasonCode = (typeof DISCOVERY_REASON_CODES)[number];

/**
 * The codes no signal in this repository can currently ground. Never emitted.
 * Listed rather than merely absent so a test can pin the absence and a reader
 * can tell "not built" from "forgotten".
 */
export const REASON_CODES_WITHOUT_PRODUCER: readonly DiscoveryReasonCode[] = [
  "trail_affinity",
  "trip_match",
  "season_match",
];

/**
 * Ranker signal key → reason code.
 *
 * Keys on the left are verbatim: Compass `RankingFactor.key` values and
 * portavaRank `RankFeatures` field names. Nothing is normalised or
 * lower-cased, so a rename on either side fails loudly here rather than
 * silently dropping a reason.
 */
const SIGNAL_TO_CODE: Readonly<Record<string, DiscoveryReasonCode>> = {
  // ── nearby_now — near the viewer, and actionable now ───────────────────────
  distance:          "nearby_now",   // Compass + PDE
  city_match:        "nearby_now",   // Compass
  cityMatch:         "nearby_now",   // PDE
  neighborhoodMatch: "nearby_now",   // PDE
  open_now:          "nearby_now",   // Compass
  availability:      "nearby_now",   // Compass
  time_relevance:    "nearby_now",   // Compass — "Happening soon"
  actionability:     "nearby_now",   // PDE
  availabilityFit:   "nearby_now",   // PDE
  capacityOpen:      "nearby_now",   // PDE

  // ── trending_local — more activity here than this place's own baseline ─────
  localMomentum:     "trending_local", // PDE (lib/discoveryLocalMomentum.ts)

  // ── creator_affinity — this viewer's relationship to the author ────────────
  followedAuthor:    "creator_affinity", // PDE
  engagedAuthor:     "creator_affinity", // PDE

  // ── saved_similar — the viewer's own past taste ────────────────────────────
  interest_match:    "saved_similar",  // Compass
  history:           "saved_similar",  // Compass — "You've liked similar picks before"
  memory_preference: "saved_similar",  // Compass — the viewer's own stated preferences
  interestTag:       "saved_similar",  // PDE
  categoryAffinity:  "saved_similar",  // PDE

  // ── social_context — people, not the anonymous crowd ───────────────────────
  social_style:              "social_context", // Compass
  circle_memory_preference:  "social_context", // Compass — the viewer's circle
  socialProof:               "social_context", // PDE
  mutualAuthor:              "social_context", // PDE

  // ── exploration — reserved inventory, not earned rank ──────────────────────
  governorSlot:      "exploration",  // PDE exploration governor
};

/** `governor_<reason>` keys are all one reason: the exploration governor placed this row. */
const GOVERNOR_PREFIX = "governor_";

/**
 * Signals deliberately NOT mapped, with why. Exported so the omission is
 * auditable and so a test can assert none of them ever produces a code.
 *
 * Two different reasons appear here and they must not be conflated:
 *   GUARDRAIL  `01` §10 / DSV2 privacy — rendering it publicly is forbidden.
 *   NO CODE    a real, publishable signal that none of the nine codes describes;
 *              mapping it to the nearest code would be an over-claim.
 */
export const UNMAPPED_SIGNALS: Readonly<Record<string, string>> = {
  // GUARDRAIL — safety, moderation and penalty state never becomes public text.
  safety_fit:   "GUARDRAIL 01 §10 — safety/private-control state must not become a public signal",
  trust:        "GUARDRAIL 01 §10 — author trust is a moderation input, not a public reason",
  verifiedBonus:"GUARDRAIL 01 §10 — verification state is moderation-adjacent; not a travel reason",
  seenPenalty:  "GUARDRAIL — a repetition penalty is a negative, and a negative is not a reason FOR",
  risk:         "GUARDRAIL — moderation signal",
  reports:      "GUARDRAIL — moderation signal",
  spam:         "GUARDRAIL — moderation signal",
  blocked:      "GUARDRAIL 01 §10 — block reasons must never be exposed",

  // NO CODE — publishable, but none of the nine describes it.
  language_match:   "NO CODE — accessibility fit; none of 01 §11's nine codes covers language",
  budget_fit:       "NO CODE — budget tendency; none of the nine covers it",
  community_popular:"NO CODE — all-time popularity is not a TREND; calling it trending_local would over-claim `rising`",
  recency:          "NO CODE — item age is freshness, which the projection already reports separately",
};

/**
 * The code a signal grounds, or null when it grounds none.
 *
 * Null covers three different cases on purpose — a guardrailed signal, a
 * publishable signal with no code, and a key this module has never seen — and
 * all three must behave identically at the call site: contribute nothing.
 * Distinguishing them in the OUTPUT would leak exactly what the guardrail
 * exists to withhold.
 */
export function reasonCodeForSignal(signalKey: string): DiscoveryReasonCode | null {
  if (typeof signalKey !== "string" || signalKey.length === 0) return null;
  if (signalKey.startsWith(GOVERNOR_PREFIX)) return "exploration";
  return SIGNAL_TO_CODE[signalKey] ?? null;
}

/**
 * Translate a ranker's signal list into codes: first-seen order preserved
 * (both rankers hand their signals over strongest-first), each code once.
 */
export function reasonCodesFromSignals(signalKeys: readonly string[]): DiscoveryReasonCode[] {
  const out: DiscoveryReasonCode[] = [];
  const seen = new Set<DiscoveryReasonCode>();
  for (const key of signalKeys) {
    const code = reasonCodeForSignal(key);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Plain language for a code. Null for a code with no producer — a string there
 * would be a claim nothing backs.
 */
const PLAIN_LANGUAGE: Readonly<Partial<Record<DiscoveryReasonCode, string>>> = {
  nearby_now:       "Close to you and open around now.",
  trending_local:   "Picking up locally this week.",
  creator_affinity: "From travelers whose posts you follow.",
  exploration:      "Newer here, and worth a look.",
  saved_similar:    "Because you saved similar places.",
  social_context:   "Fits how you like to travel with others.",
};

export function explainReasonCode(code: DiscoveryReasonCode): string | null {
  return PLAIN_LANGUAGE[code] ?? null;
}

export interface DiscoveryReason {
  /** `01` §11 internal code. */
  code: DiscoveryReasonCode;
  /** `01` §11 user-facing plain language. Never blank — a code with no text is dropped. */
  text: string;
}

/**
 * The full translation a served row needs: signals in, explained reasons out.
 * A code whose plain language is missing is dropped rather than emitted bare,
 * so a caller can render `reasons` directly without a second null check.
 */
export function explainReasons(signalKeys: readonly string[]): DiscoveryReason[] {
  const out: DiscoveryReason[] = [];
  for (const code of reasonCodesFromSignals(signalKeys)) {
    const text = explainReasonCode(code);
    if (text) out.push({ code, text });
  }
  return out;
}

/**
 * `04` §5 "reason codes" for the exposure record — provenance in, codes out.
 *
 * The rank provenance carries the ranker's OWN signal keys (Compass
 * `RankingFactor.key`, portavaRank feature names). The recommendation record
 * wants `01` §11's vocabulary. This is the bridge, and it exists as one
 * function so the serve path cannot accidentally write raw signal names onto a
 * record that other systems will read as codes.
 *
 * Three properties are deliberate and each is pinned by a test:
 *   - every key in the map gets an entry, `[]` included. A missing key makes a
 *     reader guess between "no reasons" and "not measured"; those are different
 *     facts and only one of them is true here.
 *   - guardrailed signals (`UNMAPPED_SIGNALS`) yield nothing, so a moderation
 *     input cannot reach the record by this route any more than it can reach
 *     the user-facing projection.
 *   - a null/absent map is `{}`, never a throw: this runs on a fire-and-forget
 *     instrumentation path that must not break a served response.
 *
 * Typed structurally rather than against `DiscoveryRankProvenance` so the
 * reason vocabulary does not take a dependency on the provenance module; the
 * only field it needs is `reasons`.
 */
export function reasonCodesByIdFromProvenance(
  provenanceById: ReadonlyMap<string, { reasons?: readonly string[] }> | null | undefined,
): Record<string, DiscoveryReasonCode[]> {
  const out: Record<string, DiscoveryReasonCode[]> = {};
  if (!provenanceById || typeof provenanceById.forEach !== "function") return out;
  provenanceById.forEach((p, id) => {
    if (typeof id !== "string" || id.length === 0) return;
    out[id] = reasonCodesFromSignals(p?.reasons ?? []);
  });
  return out;
}
