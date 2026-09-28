/**
 * discoveryRankIntegrity — DV-12: never reward abusive engagement.
 * census-discovery §78 (lane W10-R2).
 *
 * THE ROW: `01` §10 — PDE must never "reward abusive engagement". §69.3: "No
 * Discovery candidate carries `authorTrustScore`, so the trust factor is the
 * constant 0.6 on every row … Abusive engagement is not detected (§58.5
 * design 4)."
 *
 * WHAT IS DETECTED — `03` §12's list, the part a save row can show
 * ===============================================================
 * The evidence Discovery's social proof counts is SAVES (`likeCount` is the
 * place's `saved_count`; `saved_places` holds one row per saver). For the
 * candidate set's saves this module finds, per save:
 *
 *   farm           the saver has an OPEN `gaming_suspected` trust review —
 *                  services/trust/TrustGamingDetectionService's check-in
 *                  cluster farming, mutual upvote rings and rapid score jumps
 *                  ("account farms", "engagement pods" at the account level).
 *                  Weight 0.
 *   automation     the saver made AUTOMATION_BURST_SAVES or more saves inside
 *                  AUTOMATION_BURST_WINDOW_MS across this candidate set — no
 *                  person browsing a city saves five places in a minute.
 *                  Every save in the burst: weight 0.
 *   pod            two savers who co-saved at least POD_MIN_SHARED_ITEMS of the
 *                  same places, each pair within POD_WINDOW_MS, are pod-linked;
 *                  a saver linked to POD_MIN_PARTNERS or more is in a pod
 *                  (a pod is three or more accounts). Their co-saves: weight 0.
 *   reciprocal     X saved a place S submitted AND S saved a place X submitted
 *                  ("repeated reciprocal actions"). Both saves: weight 0.
 *   self_network   the saver IS the submitter: weight 0. The saver and the
 *                  submitter follow each other: weight 0.5 ("creator
 *                  self-network amplification" — discounted, not erased,
 *                  because friends do genuinely like each other's places).
 *   new_account    the saver's account was younger than NEW_ACCOUNT_DAYS when it
 *                  saved ("velocity spikes from low-quality cohorts"). Weight
 *                  0.5.
 *
 * A save takes the LOWEST weight any pattern gives it; patterns never stack
 * below zero. Duplicate content and artificial sends are not visible in a save
 * row and are not claimed.
 *
 * WHAT IS DONE WITH IT — A DISCOUNT ON EVIDENCE, NEVER A PENALTY ON A PERSON
 * =========================================================================
 *   likeCount            savedCount − the discounted weight (never below 0);
 *   engagementIntegrity  effective ÷ raw over the rows read, in [0,1];
 *   authorTrustScore     the submitter's trust score, through the Trust seam
 *                        (services/trust getDisplayTrustScores), on authored
 *                        rows whose score is known; `authored` marks a row that
 *                        HAS a submitter even when the score is unknown.
 *
 * portavaRank then uses the measurement in place of the 0.6 proxy (see the DV-12
 * note at the end of portavaRank.ts). Engagement integrity and author trust are
 * SEPARATE factors, as the row asks. Nothing here reaches a public reason:
 * `trust` is a GUARDRAIL signal in lib/discoveryReasonCodes, and `01` §10
 * forbids turning a safety or moderation state into a public reputation
 * penalty — which is also why the per-person pattern list never leaves this
 * module; only per-PLACE counts do.
 *
 * FAILURE: any read that fails leaves the whole candidate set UNMEASURED —
 * today's numbers exactly — and says so (`degraded`). A partial measurement
 * would discount some places' evidence and not their neighbours', which is a
 * ranking change caused by an outage.
 *
 * The thresholds are this lane's decision D-W10-R2-2, stated with their
 * reasoning beside each constant; none is fitted.
 */
import { getDisplayTrustScores } from "../services/trust/TrustScoreService.js";

/** Five saves inside a minute across one city's candidates is not browsing. */
export const AUTOMATION_BURST_SAVES = 5;
export const AUTOMATION_BURST_WINDOW_MS = 60_000;
/** Co-saves count toward a pod link only when each pair lands inside this window. */
export const POD_WINDOW_MS = 15 * 60_000;
/** Shared items a pair needs before one coincidence becomes a pattern. */
export const POD_MIN_SHARED_ITEMS = 3;
/** Partners an account needs to be in a pod (a pod is ≥ 3 accounts). */
export const POD_MIN_PARTNERS = 2;
/** `03` §12's "low-quality cohort": the trust seam's own probation horizon is a week. */
export const NEW_ACCOUNT_DAYS = 7;
/** Save rows read per request; a larger set is truncated and then left unmeasured. */
export const MAX_SAVE_ROWS = 5_000;

export type AbusePattern = "farm" | "automation" | "pod" | "reciprocal" | "self_network" | "new_account";

export interface SaveEvent { userId: string; placeId: string; savedAtMs: number }

export interface IntegrityInputs {
  saves: readonly SaveEvent[];
  /** Accounts with an open `gaming_suspected` review. */
  flaggedAccounts: ReadonlySet<string>;
  /** Account id → account creation (ms). Absent ⇒ age unknown ⇒ not a new account. */
  accountCreatedAtMs: ReadonlyMap<string, number>;
  /** Directed follow edges among savers and submitters. */
  follows: ReadonlyArray<readonly [string, string]>;
  /** Place id → submitter id, for authored places. */
  submitterByPlace: ReadonlyMap<string, string>;
}

export interface PlaceIntegrity {
  raw: number;
  effective: number;
  integrity: number;
  patterns: Partial<Record<AbusePattern, number>>;
}

const DAY = 86_400_000;

/** The `03` §12 detector over one candidate set's saves. PURE. */
export function detectEngagementAbuse(inp: IntegrityInputs): Map<string, PlaceIntegrity> {
  const saves = inp.saves.filter((s) => s.userId && s.placeId && Number.isFinite(s.savedAtMs));
  const weight = saves.map(() => 1);
  const hit: Array<Set<AbusePattern>> = saves.map(() => new Set());
  const cut = (i: number, w: number, p: AbusePattern) => { if (w < weight[i]) weight[i] = w; hit[i].add(p); };

  // farm
  saves.forEach((s, i) => { if (inp.flaggedAccounts.has(s.userId)) cut(i, 0, "farm"); });

  // automation — a sliding window over each saver's own saves
  const byUser = new Map<string, number[]>();
  saves.forEach((s, i) => { const a = byUser.get(s.userId) ?? []; a.push(i); byUser.set(s.userId, a); });
  for (const idxs of byUser.values()) {
    const sorted = [...idxs].sort((a, b) => saves[a].savedAtMs - saves[b].savedAtMs);
    let lo = 0;
    for (let hi = 0; hi < sorted.length; hi++) {
      while (saves[sorted[hi]].savedAtMs - saves[sorted[lo]].savedAtMs > AUTOMATION_BURST_WINDOW_MS) lo++;
      if (hi - lo + 1 >= AUTOMATION_BURST_SAVES) for (let k = lo; k <= hi; k++) cut(sorted[k], 0, "automation");
    }
  }

  // pod — pairwise co-saves inside the window
  const byPlace = new Map<string, number[]>();
  saves.forEach((s, i) => { const a = byPlace.get(s.placeId) ?? []; a.push(i); byPlace.set(s.placeId, a); });
  const pairItems = new Map<string, Set<string>>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const [placeId, idxs] of byPlace) {
    for (let x = 0; x < idxs.length; x++) for (let y = x + 1; y < idxs.length; y++) {
      const a = saves[idxs[x]], b = saves[idxs[y]];
      if (a.userId === b.userId || Math.abs(a.savedAtMs - b.savedAtMs) > POD_WINDOW_MS) continue;
      const k = pairKey(a.userId, b.userId);
      const set = pairItems.get(k) ?? new Set<string>(); set.add(placeId); pairItems.set(k, set);
    }
  }
  const partners = new Map<string, Set<string>>();
  for (const [k, items] of pairItems) {
    if (items.size < POD_MIN_SHARED_ITEMS) continue;
    const [a, b] = k.split("\u0000");
    (partners.get(a) ?? partners.set(a, new Set()).get(a)!).add(b);
    (partners.get(b) ?? partners.set(b, new Set()).get(b)!).add(a);
  }
  for (const [placeId, idxs] of byPlace) {
    for (const i of idxs) {
      const mine = partners.get(saves[i].userId);
      if (!mine || mine.size < POD_MIN_PARTNERS) continue;
      const coSaved = idxs.some((j) => j !== i && mine.has(saves[j].userId)
        && Math.abs(saves[j].savedAtMs - saves[i].savedAtMs) <= POD_WINDOW_MS
        && (pairItems.get(pairKey(saves[i].userId, saves[j].userId))?.has(placeId) ?? false));
      if (coSaved) cut(i, 0, "pod");
    }
  }

  // reciprocal and self-network
  const savedSubmitters = new Map<string, Set<string>>();   // saver → submitters whose places they saved
  saves.forEach((s) => {
    const sub = inp.submitterByPlace.get(s.placeId);
    if (sub && sub !== s.userId) (savedSubmitters.get(s.userId) ?? savedSubmitters.set(s.userId, new Set()).get(s.userId)!).add(sub);
  });
  const edges = new Set(inp.follows.map(([a, b]) => `${a}\u0000${b}`));
  saves.forEach((s, i) => {
    const sub = inp.submitterByPlace.get(s.placeId);
    if (!sub) return;
    if (sub === s.userId) { cut(i, 0, "self_network"); return; }
    if (savedSubmitters.get(sub)?.has(s.userId)) cut(i, 0, "reciprocal");
    if (edges.has(`${s.userId}\u0000${sub}`) && edges.has(`${sub}\u0000${s.userId}`)) cut(i, 0.5, "self_network");
  });

  // new account
  saves.forEach((s, i) => {
    const created = inp.accountCreatedAtMs.get(s.userId);
    if (created !== undefined && Number.isFinite(created) && s.savedAtMs - created < NEW_ACCOUNT_DAYS * DAY) cut(i, 0.5, "new_account");
  });

  const out = new Map<string, PlaceIntegrity>();
  saves.forEach((s, i) => {
    const cur = out.get(s.placeId) ?? { raw: 0, effective: 0, integrity: 1, patterns: {} };
    cur.raw += 1;
    cur.effective += weight[i];
    for (const p of hit[i]) cur.patterns[p] = (cur.patterns[p] ?? 0) + 1;
    out.set(s.placeId, cur);
  });
  for (const v of out.values()) v.integrity = v.raw > 0 ? v.effective / v.raw : 1;
  return out;
}

/** The fields the integrity design sets on one candidate. */
export interface IntegrityDecoration {
  likeCount: number;
  engagementIntegrity: number;
  authorTrustScore?: number;
  authored?: boolean;
}

/**
 * Decorations for the candidate set, from a detector result. A place with NO
 * save rows was still measured — nothing abusive was found in what was read —
 * so its integrity is 1 and its count is unchanged.
 */
export function integrityDecorations(
  places: ReadonlyArray<{ id: string; savedCount?: number | null }>,
  result: ReadonlyMap<string, PlaceIntegrity>,
  submitterByPlace: ReadonlyMap<string, string>,
  trustBySubmitter: ReadonlyMap<string, number>,
): Map<string, IntegrityDecoration> {
  const out = new Map<string, IntegrityDecoration>();
  for (const p of places) {
    const r = result.get(p.id);
    const saved = typeof p.savedCount === "number" && Number.isFinite(p.savedCount) ? p.savedCount : 0;
    const discounted = r ? r.raw - r.effective : 0;
    const d: IntegrityDecoration = {
      likeCount: Math.max(0, saved - discounted),
      engagementIntegrity: r ? r.integrity : 1,
    };
    const sub = submitterByPlace.get(p.id);
    if (sub) {
      d.authored = true;
      const t = trustBySubmitter.get(sub);
      if (t !== undefined) d.authorTrustScore = t;
    }
    out.set(p.id, d);
  }
  return out;
}

export interface IntegrityRead {
  /** Null ⇒ unmeasured (today's numbers). */
  decorations: Map<string, IntegrityDecoration> | null;
  degraded: boolean;
  /** Per-pattern save counts across the set — observability, never per person. */
  patterns: Partial<Record<AbusePattern, number>>;
}

const DB_PREFIX = "db/";

function ok<T>(r: { data: T | null; error: unknown }): T | null {
  return r && !r.error && r.data != null ? r.data : null;
}

/**
 * Read everything the detector needs for one candidate set. Six reads, all
 * batched by `in`; any failure leaves the set unmeasured.
 */
export async function loadEngagementIntegrity(
  sc: any, places: ReadonlyArray<{ id: string; savedCount?: number | null }>,
): Promise<IntegrityRead> {
  const none: IntegrityRead = { decorations: null, degraded: false, patterns: {} };
  if (places.length === 0) return none;
  if (!sc) return { ...none, degraded: true };
  try {
    const dbIds = places.filter((p) => p.id.startsWith(DB_PREFIX)).map((p) => p.id.slice(DB_PREFIX.length));
    const osmIds = places.filter((p) => !p.id.startsWith(DB_PREFIX)).map((p) => p.id);

    const uuidToCandidate = new Map<string, string>();
    const submitterByPlace = new Map<string, string>();
    if (dbIds.length > 0) {
      const rows = ok<any[]>(await sc.from("discovery_places").select("id, submitted_by").in("id", dbIds));
      if (!rows) return { ...none, degraded: true };
      for (const r of rows) {
        uuidToCandidate.set(r.id, `${DB_PREFIX}${r.id}`);
        if (r.submitted_by) submitterByPlace.set(`${DB_PREFIX}${r.id}`, r.submitted_by);
      }
    }
    if (osmIds.length > 0) {
      const rows = ok<any[]>(await sc.from("discovery_places").select("id, osm_id, submitted_by").in("osm_id", osmIds));
      if (!rows) return { ...none, degraded: true };
      for (const r of rows) {
        uuidToCandidate.set(r.id, r.osm_id);
        if (r.submitted_by) submitterByPlace.set(r.osm_id, r.submitted_by);
      }
    }

    const uuids = [...uuidToCandidate.keys()];
    const saveRows = uuids.length === 0 ? [] : ok<any[]>(
      await sc.from("saved_places").select("user_id, place_id, saved_at").in("place_id", uuids).limit(MAX_SAVE_ROWS + 1),
    );
    if (!saveRows) return { ...none, degraded: true };
    if (saveRows.length > MAX_SAVE_ROWS) return { ...none, degraded: true };
    const saves: SaveEvent[] = saveRows.map((r) => ({
      userId: r.user_id, placeId: uuidToCandidate.get(r.place_id) ?? "", savedAtMs: Date.parse(r.saved_at),
    }));

    const savers = [...new Set(saves.map((s) => s.userId).filter(Boolean))];
    const submitters = [...new Set(submitterByPlace.values())];
    const people = [...new Set([...savers, ...submitters])];

    const flaggedAccounts = new Set<string>();
    const accountCreatedAtMs = new Map<string, number>();
    const follows: Array<[string, string]> = [];
    if (savers.length > 0) {
      const flagged = ok<any[]>(await sc.from("trust_reviews").select("user_id")
        .eq("review_type", "gaming_suspected").in("status", ["open", "in_progress"]).in("user_id", savers));
      if (!flagged) return { ...none, degraded: true };
      for (const r of flagged) flaggedAccounts.add(r.user_id);

      const profiles = ok<any[]>(await sc.from("profiles").select("id, created_at").in("id", savers));
      if (!profiles) return { ...none, degraded: true };
      for (const r of profiles) { const t = Date.parse(r.created_at); if (Number.isFinite(t)) accountCreatedAtMs.set(r.id, t); }
    }
    if (savers.length > 0 && submitters.length > 0) {
      const edges = ok<any[]>(await sc.from("user_follows").select("follower_id, following_id")
        .in("follower_id", people).in("following_id", people));
      if (!edges) return { ...none, degraded: true };
      for (const r of edges) follows.push([r.follower_id, r.following_id]);
    }

    const trustBySubmitter = new Map<string, number>();
    if (submitters.length > 0) {
      const t = await getDisplayTrustScores(sc, submitters);
      if (t.state !== "ok") return { ...none, degraded: true };
      for (const [id, score] of t.scores) trustBySubmitter.set(id, score);
    }

    const result = detectEngagementAbuse({ saves, flaggedAccounts, accountCreatedAtMs, follows, submitterByPlace });
    const patterns: Partial<Record<AbusePattern, number>> = {};
    for (const r of result.values()) for (const [p, n] of Object.entries(r.patterns) as Array<[AbusePattern, number]>) patterns[p] = (patterns[p] ?? 0) + n;
    return {
      decorations: integrityDecorations(places, result, submitterByPlace, trustBySubmitter),
      degraded: false,
      patterns,
    };
  } catch {
    return { ...none, degraded: true };
  }
}
