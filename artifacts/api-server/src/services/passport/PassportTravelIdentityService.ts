/**
 * PassportTravelIdentityService — §19 "Travel Identity" / Travel DNA
 *
 * Produces an INFERRED, EXPLAINABLE and USER-CONTROLLED travel-style projection
 * (TABLE 20). Two kinds of signal are surfaced:
 *
 *   1. Dimensions   — a spectrum reading per axis (travel pace, planning,
 *                     spend, social, discovery, energy, rhythm, group style,
 *                     interests, languages). Each carries the EVIDENCE it was
 *                     inferred from so the reading is never a black box.
 *   2. Traits       — named "Travel DNA" badges (Night Explorer, Hidden Gem
 *                     Hunter, Food Driven, …) each derived from concrete signals.
 *
 * USER CONTROL (§19): every dimension and trait can be Shown, Hidden or marked
 * "Not Me". That state is stored per-user in `passport_travel_dna_prefs`
 * (migration 2261) and is read here best-effort — a missing table or an OFF
 * feature flag simply yields the default ("shown", no overrides), and the
 * inference still runs. Hidden / Not-Me items are still RETURNED to the owner
 * (so they can toggle them back) but are filtered out of any non-owner view by
 * `filterTravelIdentityForViewer`.
 *
 * NON-GOALS: this never invents a "compatibility" or "match" number, and it
 * never reads or writes trip/stamp storage of its own — it is a pure projection
 * over the canonical `profiles` row plus the light behavioural signals the
 * caller passes in.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

/** Feature flag (CAPABILITY, seeded OFF) gating the stored Show/Hide/Not-Me prefs. */
export const TRAVEL_DNA_FLAG = "passport_travel_dna_enabled";

export type TravelDnaState = "shown" | "hidden" | "not_me";

/** A single explainable spectrum reading (TABLE 20). */
export interface TravelDimension {
  key: string;
  label: string;
  /** Left/right pole labels for a spectrum axis; null for list-style dimensions. */
  poles: { low: string; high: string } | null;
  /** 0..1 position on the axis (null when the dimension is a value list). */
  position: number | null;
  /** Human-readable current reading, e.g. "Planner", "Night owl", "Fluent: EN, VI". */
  value: string;
  /** The concrete facts this reading was inferred from. Never empty when inferred. */
  evidence: string[];
  /** Owner-controlled visibility state. */
  state: TravelDnaState;
  /** True when the reading is a weak default with no supporting evidence. */
  inferred: boolean;
}

/** A named Travel DNA badge (Night Explorer, Food Driven, …). */
export interface TravelTrait {
  key: string;
  label: string;
  description: string;
  evidence: string[];
  state: TravelDnaState;
}

export interface TravelIdentityProjection {
  userId: string;
  dimensions: TravelDimension[];
  traits: TravelTrait[];
  /** True when stored Show/Hide/Not-Me prefs were applied (flag ON + table present). */
  preferencesApplied: boolean;
  /** Owner-only: whether the owner may edit these (self view). */
  editable: boolean;
}

/** Light behavioural signals the caller may pass so inference is not profile-only. */
export interface TravelIdentitySignals {
  /** Distinct interest tags observed from stamps / saved places / contributions. */
  interestTags?: string[];
  /** Count of hidden-gem stamps or discoveries (drives "Hidden Gem Hunter"). */
  hiddenGemCount?: number;
  /** Count of nightlife-context stamps/plans (drives "Night Explorer"). */
  nightlifeCount?: number;
  /** Count of food-context stamps/plans (drives "Food Driven"). */
  foodCount?: number;
  /** Distinct countries visited (drives "Globe Trotter"). */
  countriesCount?: number;
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

/**
 * Map a small free-text vocabulary onto a 0..1 spectrum position.
 * Returns null when the value is unknown so the dimension reads as a neutral
 * default rather than a fabricated midpoint.
 */
function spectrumOf(
  raw: string | null | undefined,
  lowWords: string[],
  highWords: string[],
): number | null {
  const v = norm(raw);
  if (!v) return null;
  if (lowWords.some((w) => v.includes(w))) return 0.15;
  if (highWords.some((w) => v.includes(w))) return 0.85;
  // Known-but-middling terms → centre.
  if (v.includes("balanced") || v.includes("moderate") || v.includes("mixed") || v.includes("flexible")) {
    return 0.5;
  }
  return null;
}

/**
 * Pure inference core — builds the dimensions + traits from a profiles row and
 * optional behavioural signals. No IO. Exposed for unit testing.
 *
 * States default to "shown"; apply stored overrides afterwards.
 */
export function inferTravelIdentity(
  userId: string,
  profile: Record<string, any> | null,
  signals: TravelIdentitySignals = {},
): { dimensions: TravelDimension[]; traits: TravelTrait[] } {
  const p = profile ?? {};
  const dimensions: TravelDimension[] = [];

  // ── Travel pace: Relaxed ↔ Packed ──────────────────────────────────────────
  {
    const pos = spectrumOf(p.travel_pace, ["relax", "slow", "easy", "chill"], ["pack", "fast", "busy", "intense"]);
    dimensions.push({
      key: "travel_pace",
      label: "Travel pace",
      poles: { low: "Relaxed", high: "Packed" },
      position: pos,
      value: pos == null ? "Balanced" : pos < 0.4 ? "Relaxed" : pos > 0.6 ? "Packed" : "Balanced",
      evidence: p.travel_pace ? [`Profile travel pace: ${p.travel_pace}`] : [],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Planning: Spontaneous ↔ Planner ─────────────────────────────────────────
  {
    const pos = spectrumOf(p.planning_style, ["spontan", "improv", "wing"], ["planner", "organiz", "organis", "structured"]);
    dimensions.push({
      key: "planning",
      label: "Planning",
      poles: { low: "Spontaneous", high: "Planner" },
      position: pos,
      value: pos == null ? "Balanced" : pos < 0.4 ? "Spontaneous" : pos > 0.6 ? "Planner" : "Balanced",
      evidence: p.planning_style ? [`Profile planning style: ${p.planning_style}`] : [],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Spend style: Budget ↔ Luxury ────────────────────────────────────────────
  {
    const pos = spectrumOf(p.budget_style, ["budget", "cheap", "frugal", "backpack"], ["luxury", "premium", "high-end", "splurge"]);
    dimensions.push({
      key: "spend_style",
      label: "Spend style",
      poles: { low: "Budget", high: "Luxury" },
      position: pos,
      value: pos == null ? "Balanced" : pos < 0.4 ? "Budget" : pos > 0.6 ? "Luxury" : "Balanced",
      evidence: p.budget_style ? [`Profile spend style: ${p.budget_style}`] : [],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Social: Solo ↔ Social ───────────────────────────────────────────────────
  {
    const groups: string[] = Array.isArray(p.travel_group_style) ? p.travel_group_style : [];
    const gv = groups.map(norm);
    let pos: number | null = null;
    if (gv.some((g) => g.includes("solo"))) pos = 0.2;
    if (gv.some((g) => g.includes("group") || g.includes("social") || g.includes("large"))) pos = 0.8;
    if (p.open_to_meet === true) pos = pos == null ? 0.65 : Math.max(pos, 0.65);
    dimensions.push({
      key: "social",
      label: "Social",
      poles: { low: "Solo", high: "Social" },
      position: pos,
      value: pos == null ? "Balanced" : pos < 0.4 ? "Solo traveler" : pos > 0.6 ? "Social" : "Balanced",
      evidence: [
        ...(groups.length ? [`Group style: ${groups.join(", ")}`] : []),
        ...(p.open_to_meet === true ? ["Open to meeting travelers"] : []),
      ],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Discovery: Famous spots ↔ Hidden gems ───────────────────────────────────
  {
    const gems = Number(signals.hiddenGemCount ?? 0);
    let pos: number | null = null;
    if (gems >= 3) pos = 0.85;
    else if (gems >= 1) pos = 0.65;
    dimensions.push({
      key: "discovery",
      label: "Discovery",
      poles: { low: "Famous spots", high: "Hidden gems" },
      position: pos,
      value: pos == null ? "Balanced" : pos > 0.6 ? "Hidden gems" : "Balanced",
      evidence: gems > 0 ? [`${gems} hidden gem${gems === 1 ? "" : "s"} discovered`] : [],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Rhythm: Early riser ↔ Night owl ─────────────────────────────────────────
  {
    const night = Number(signals.nightlifeCount ?? 0);
    const interests: string[] = Array.isArray(p.interests) ? p.interests.map(norm) : [];
    const nightInterest = interests.some((i) => i.includes("night") || i.includes("bar") || i.includes("club"));
    let pos: number | null = null;
    if (night >= 3 || nightInterest) pos = 0.8;
    dimensions.push({
      key: "rhythm",
      label: "Rhythm",
      poles: { low: "Early riser", high: "Night owl" },
      position: pos,
      value: pos == null ? "Balanced" : pos > 0.6 ? "Night owl" : "Balanced",
      evidence: [
        ...(night > 0 ? [`${night} nightlife visit${night === 1 ? "" : "s"}`] : []),
        ...(nightInterest ? ["Nightlife in interests"] : []),
      ],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Energy: Low ↔ High ──────────────────────────────────────────────────────
  // A distinct axis from travel pace (Relaxed↔Packed): pace is about itinerary
  // density, energy is about the intensity of the activities themselves. Read
  // from nightlife behaviour + high/low-energy interests, with pace as a weak
  // tie-breaker. Every reading carries the concrete evidence it came from.
  {
    const night = Number(signals.nightlifeCount ?? 0);
    const interests: string[] = Array.isArray(p.interests) ? p.interests.map(norm) : [];
    const highEnergyInterest = interests.some((i) =>
      /night|party|adventure|hik|trek|climb|surf|sport|dance|festival|dive|kayak/.test(i),
    );
    const lowEnergyInterest = interests.some((i) =>
      /relax|spa|wellness|beach|caf|slow|read|retreat|meditat|lounge/.test(i),
    );
    const pacePos = spectrumOf(p.travel_pace, ["relax", "slow", "easy", "chill"], ["pack", "fast", "busy", "intense"]);
    let pos: number | null = null;
    const evidence: string[] = [];
    if (night >= 2 || highEnergyInterest) {
      pos = 0.8;
      if (night >= 2) evidence.push(`${night} nightlife visits`);
      if (highEnergyInterest) evidence.push("High-energy interests");
    } else if (lowEnergyInterest || (pacePos != null && pacePos <= 0.2)) {
      pos = 0.2;
      if (lowEnergyInterest) evidence.push("Low-key interests");
      if (pacePos != null && pacePos <= 0.2) evidence.push("Relaxed travel pace");
    } else if (pacePos != null && pacePos >= 0.8) {
      pos = 0.75;
      evidence.push("Packed travel pace");
    }
    dimensions.push({
      key: "energy",
      label: "Energy",
      poles: { low: "Low", high: "High" },
      position: pos,
      value: pos == null ? "Balanced" : pos > 0.6 ? "High energy" : pos < 0.4 ? "Low key" : "Balanced",
      evidence,
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Group style: 1:1 / small / large groups ─────────────────────────────────
  // TABLE 20's group-size axis, distinct from the Solo↔Social dimension above:
  // Social answers "alone or with others", Group style answers "how many". Read
  // from the explicit travel_group_style tags the profile carries.
  {
    const groups: string[] = Array.isArray(p.travel_group_style) ? p.travel_group_style : [];
    const gv = groups.map(norm);
    const wantsLarge = gv.some((g) => g.includes("large") || (g.includes("group") && !g.includes("small")));
    const wantsSmall = gv.some((g) => g.includes("small"));
    const wantsIntimate = gv.some(
      (g) => g.includes("1:1") || g.includes("1-on-1") || g.includes("one_on_one") || g.includes("one on one") || g.includes("solo") || g.includes("intimate"),
    );
    let pos: number | null = null;
    let value = "Balanced";
    if (wantsLarge) { pos = 0.85; value = "Large groups"; }
    else if (wantsSmall) { pos = 0.4; value = "Small groups"; }
    else if (wantsIntimate) { pos = 0.15; value = "1:1"; }
    dimensions.push({
      key: "group_style",
      label: "Group style",
      poles: { low: "1:1 / small", high: "Large groups" },
      position: pos,
      value,
      evidence: groups.length ? [`Group style: ${groups.join(", ")}`] : [],
      state: "shown",
      inferred: pos == null,
    });
  }

  // ── Interests (value list) ──────────────────────────────────────────────────
  {
    const interests: string[] = Array.isArray(p.interests) ? p.interests.filter(Boolean) : [];
    const merged = [...new Set([...interests, ...(signals.interestTags ?? [])])].slice(0, 12);
    dimensions.push({
      key: "interests",
      label: "Interests",
      poles: null,
      position: null,
      value: merged.length ? merged.join(", ") : "Not set",
      evidence: interests.length ? ["From profile interests"] : (signals.interestTags?.length ? ["From travel activity"] : []),
      state: "shown",
      inferred: merged.length === 0,
    });
  }

  // ── Languages (value list) ──────────────────────────────────────────────────
  {
    const langs: string[] = Array.isArray(p.spoken_languages) ? p.spoken_languages.filter(Boolean) : [];
    dimensions.push({
      key: "languages",
      label: "Languages",
      poles: null,
      position: null,
      value: langs.length ? langs.join(", ") : "Not set",
      evidence: langs.length ? ["From profile languages"] : [],
      state: "shown",
      inferred: langs.length === 0,
    });
  }

  // ── Traits (named Travel DNA badges) ────────────────────────────────────────
  const traits: TravelTrait[] = [];
  const interestsLc: string[] = Array.isArray(p.interests) ? p.interests.map(norm) : [];

  if (Number(signals.nightlifeCount ?? 0) >= 2 || interestsLc.some((i) => i.includes("night"))) {
    traits.push({
      key: "night_explorer",
      label: "Night Explorer",
      description: "Comes alive after dark — nightlife and late-evening plans.",
      evidence: [
        ...(signals.nightlifeCount ? [`${signals.nightlifeCount} nightlife visits`] : []),
        ...(interestsLc.some((i) => i.includes("night")) ? ["Nightlife interest"] : []),
      ],
      state: "shown",
    });
  }
  if (Number(signals.hiddenGemCount ?? 0) >= 2) {
    traits.push({
      key: "hidden_gem_hunter",
      label: "Hidden Gem Hunter",
      description: "Seeks out lesser-known spots over famous landmarks.",
      evidence: [`${signals.hiddenGemCount} hidden gems discovered`],
      state: "shown",
    });
  }
  if (Number(signals.foodCount ?? 0) >= 2 || interestsLc.some((i) => i.includes("food") || i.includes("cuisine") || i.includes("eat"))) {
    traits.push({
      key: "food_driven",
      label: "Food Driven",
      description: "Plans travel around food and local cuisine.",
      evidence: [
        ...(signals.foodCount ? [`${signals.foodCount} food visits`] : []),
        ...(interestsLc.some((i) => i.includes("food")) ? ["Food interest"] : []),
      ],
      state: "shown",
    });
  }
  if (Number(signals.countriesCount ?? 0) >= 8) {
    traits.push({
      key: "globe_trotter",
      label: "Globe Trotter",
      description: "Has traveled widely across many countries.",
      evidence: [`${signals.countriesCount} countries visited`],
      state: "shown",
    });
  }

  return { dimensions, traits };
}

/** Stored per-dimension/-trait override, keyed by dimension/trait key. */
type PrefMap = Map<string, TravelDnaState>;

/** Read stored Show/Hide/Not-Me prefs. Best-effort: OFF flag or missing table → empty. */
async function loadPrefs(sc: SupabaseClient, userId: string): Promise<{ prefs: PrefMap; applied: boolean }> {
  const empty = { prefs: new Map<string, TravelDnaState>(), applied: false };
  try {
    const on = await isFlagEnabled(sc, TRAVEL_DNA_FLAG);
    if (!on) return empty;
    const { data, error } = await sc
      .from("passport_travel_dna_prefs")
      .select("dimension_key, state")
      .eq("user_id", userId);
    if (error || !Array.isArray(data)) return empty;
    const prefs: PrefMap = new Map();
    for (const r of data as any[]) {
      const s = norm(r.state);
      if (s === "shown" || s === "hidden" || s === "not_me") prefs.set(r.dimension_key, s as TravelDnaState);
    }
    return { prefs, applied: true };
  } catch {
    return empty;
  }
}

/**
 * Build the full Travel Identity projection for an owner, applying stored
 * Show/Hide/Not-Me state. `editable` is true only on the owner's own view.
 */
export async function buildTravelIdentity(
  sc: SupabaseClient,
  userId: string,
  profile: Record<string, any> | null,
  signals: TravelIdentitySignals,
  opts: { isSelf: boolean },
): Promise<TravelIdentityProjection> {
  const { dimensions, traits } = inferTravelIdentity(userId, profile, signals);
  const { prefs, applied } = await loadPrefs(sc, userId);

  for (const d of dimensions) d.state = prefs.get(d.key) ?? "shown";
  for (const t of traits) t.state = prefs.get(t.key) ?? "shown";

  return {
    userId,
    dimensions,
    traits,
    preferencesApplied: applied,
    editable: opts.isSelf,
  };
}

/** The two namespaces a Travel DNA key can belong to (§19). */
export type TravelDnaKind = "dimension" | "trait";

/** Input for a single Show/Hide/Not-Me write (§19). */
export interface TravelDnaPrefWrite {
  key: string;
  kind: TravelDnaKind;
  state: string;
}

export type TravelDnaWriteResult =
  | { ok: true; pref: { userId: string; key: string; kind: TravelDnaKind; state: TravelDnaState } }
  | { ok: false; reason: "feature_disabled" | "invalid_state" | "invalid_key" | "db_error" };

/**
 * Upsert a traveller's own Show/Hide/Not-Me choice for one inferred Travel DNA
 * dimension or trait (§19).
 *
 * OWNER-SCOPED: the caller supplies `userId` (the authenticated session user)
 * and the row is written for exactly that user — the function never writes to
 * another user's subtree. It is called through the service_role client from an
 * owner-only route; RLS on the table (auth.uid() = user_id) is the second line
 * of defence for any client-scoped caller.
 *
 * FAIL-CLOSED CAPABILITY GATE: the write is refused unless
 * `passport_travel_dna_enabled` reads true (isFlagEnabled → false on any error),
 * so a partially-configured rollout can never persist prefs the read side would
 * ignore anyway.
 *
 * The stored key is the RAW dimension/trait key (not namespaced): the read side
 * (`loadPrefs`) looks up prefs by the same raw key, and dimension and trait keys
 * do not collide. `kind` is validated and echoed back for the client but is not
 * itself a stored column — the key alone identifies the row.
 */
export async function writeTravelDnaPref(
  sc: SupabaseClient,
  userId: string,
  input: TravelDnaPrefWrite,
): Promise<TravelDnaWriteResult> {
  const state = norm(input.state);
  if (state !== "shown" && state !== "hidden" && state !== "not_me") {
    return { ok: false, reason: "invalid_state" };
  }
  if (input.kind !== "dimension" && input.kind !== "trait") {
    return { ok: false, reason: "invalid_key" };
  }
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (!key || key.length > 120) {
    return { ok: false, reason: "invalid_key" };
  }
  const on = await isFlagEnabled(sc, TRAVEL_DNA_FLAG);
  if (!on) return { ok: false, reason: "feature_disabled" };

  const { error } = await sc.from("passport_travel_dna_prefs").upsert(
    { user_id: userId, dimension_key: key, state, updated_at: new Date().toISOString() },
    { onConflict: "user_id,dimension_key" },
  );
  if (error) return { ok: false, reason: "db_error" };

  return { ok: true, pref: { userId, key, kind: input.kind, state: state as TravelDnaState } };
}

/**
 * Non-owner view filter: hide dimensions/traits the owner marked "hidden" or
 * "not_me". The owner keeps everything (so they can toggle it back).
 */
export function filterTravelIdentityForViewer(
  projection: TravelIdentityProjection,
  isSelf: boolean,
): TravelIdentityProjection {
  if (isSelf) return projection;
  return {
    ...projection,
    editable: false,
    dimensions: projection.dimensions.filter((d) => d.state === "shown"),
    traits: projection.traits.filter((t) => t.state === "shown"),
  };
}
