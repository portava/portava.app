/**
 * PresenceFusionStore — the ONE place a `PresenceEstimate` comes into existence.
 *
 * ── THE ROW THIS FILE EXISTS TO CLOSE ────────────────────────────────────────
 * census-sensing S3: four presence models coexist and `presence/domain` has
 * "no store, no fusion layer". The bar the census sets is deliberately NOT "a
 * store exists" — it is that "a second presence write path is UNREPRESENTABLE".
 * A store you can go around is a fifth model, not a fusion layer.
 *
 * ── HOW THAT IS MADE STRUCTURAL, NOT A CONVENTION ────────────────────────────
 * Four locks, each of which fails at COMPILE time; the last two also fail at
 * runtime so that `as any` buys nothing either.
 *
 *  1. `FusedPresenceEstimate` is a CLASS with a `private constructor` and a
 *     `#fused` private field. An object literal cannot be assigned to it (the
 *     `#fused` member is missing and unnameable), and `new` is a compile error
 *     outside the class body. The only expression in the entire program that
 *     evaluates to one is inside this file's static block.
 *  2. The same for `PresenceWriteCapability`, and `admit` takes one. So there
 *     is no way to phrase a call to the store without holding a capability.
 *  3. The capabilities are MINTED ONCE at module load, one per member of the
 *     closed `PresenceSourceId` union, into a frozen record. There is no
 *     factory, no `register()`, no `grant()`. A fifth presence model cannot be
 *     given a capability without editing `sources.ts`, which is a reviewed
 *     diff inside a census scope.
 *  4. Runtime: every minted estimate and capability goes into a module-private
 *     WeakSet. `admit` THROWS `PresenceFusionViolation` on a capability it did
 *     not mint (a forgery is a bug or an attack, never a data condition), and
 *     `assertFused` throws on an estimate it did not mint. `Object.create` on
 *     the prototype, a structural cast, a JSON round-trip and a subclass all
 *     fail this check.
 *
 * What is NOT claimed: this does not stop a module from inventing a private
 * presence-shaped object of its OWN type and serving it. Nothing in a language
 * can. What it stops is that object ever being, or being mistaken for, a
 * `PresenceEstimate` — every consumer's parameter type is the sealed class, so
 * a parallel model cannot join the pipeline without declaring itself a fifth
 * source in `sources.ts`.
 *
 * ── WHY THERE IS NO TABLE, STATED RATHER THAN OMITTED ────────────────────────
 * This store is process-local, TTL-bounded and deliberately UNPERSISTED, and
 * that is a design decision with a spec line behind it, not an unfinished
 * migration. Sensing §1: "Do not introduce a second lifecycle, a second place
 * identity, a SECOND SOCIAL PRESENCE MODEL, or a second intelligence truth
 * store merely because the new feature needs richer signals." A fifth presence
 * TABLE holding a copy of the other four would be exactly that — a new row
 * lifecycle, a new retention decision, a new RLS surface and a new deletion
 * disposition for data that already has all four elsewhere. The fusion layer's
 * job is to be the single DERIVATION, not a fifth record. Each source keeps its
 * own table, its own consent record and its own TTL; what is unified is the
 * estimate, which is derived and short-lived by construction (§18.2's
 * observed_at / expires_at / freshness are the whole retention policy here).
 *
 * ── PURITY AND CLOCKS ────────────────────────────────────────────────────────
 * No `Date.now()` anywhere in this file. `nowMs` is always injected and may be
 * `null`, which means "the caller has no clock", NOT "now". An untimed claim
 * can never be live and can never carry freshness — see `admit`.
 */
import {
  ESTIMATE_STATES,
  isLiveState,
  narrowestPrecision,
  precisionRank,
  type GeoPoint,
  type LocationPrecision,
  type PresenceEstimate,
  type PresenceEstimateState,
  type PresenceEvidenceType,
} from "../domain/types.js";
import {
  PRESENCE_CLASSES,
  PRESENCE_SOURCES,
  PRESENCE_SOURCE_CONTRACTS,
  type PresenceSourceId,
} from "./sources.js";

// ── Temporal constants (§18.2, §20) ───────────────────────────────────────────

/**
 * How long an estimate can be served at all. 60 minutes, and the number is not
 * a new invention: it is `lib/locateFriendsSession.POSITION_TTL_MS`, the sum of
 * §23's decay stages (5 precise + 25 approximate + 30 last-known). A test
 * asserts the two are equal rather than leaving two constants to drift.
 */
export const PRESENCE_ESTIMATE_TTL_MS = 60 * 60_000;

/**
 * The only window in which an estimate may carry a LIVE state. 5 minutes,
 * equal to `DECAY_BOUNDARIES_MS.precise`. §20: "Expired/stale state ≠ current."
 * Past this the store DOWNGRADES a live state to `recent` — it does not refuse,
 * because a twenty-minute-old fix is still true, it just is not live.
 */
export const PRESENCE_LIVE_WINDOW_MS = 5 * 60_000;

// ── Subject linkage (§20 "Anonymous intelligence may not be reverse-linked") ──

/**
 * Whether a subject key means the same person across sources.
 *
 * `account_scoped`  The key is a Portava account id; the same key in two
 *                   sources is the same person, so `resolve` may fuse them.
 * `source_scoped`   The key means something only inside its own source. Two
 *                   sources holding the same string are NOT asserted to be the
 *                   same subject and are never fused.
 *
 * The map's presence objects are `source_scoped` ON PURPOSE. Their ids are
 * render handles (`traveler:…`, `buddy:…`, `friend:…`), and §20 forbids
 * reverse-linking anonymous world intelligence to an account. Making the
 * default fusion behaviour "do not link" means the leak takes a deliberate
 * declaration rather than an oversight.
 */
export const SUBJECT_LINKAGES = ["account_scoped", "source_scoped"] as const;
export type SubjectLinkage = (typeof SUBJECT_LINKAGES)[number];

// ── The claim (what a source may say) ─────────────────────────────────────────

/**
 * A source's RAW assertion. Note what is absent: there is no `precision` field
 * a source can set, only a `requestedPrecision` and a list of `ceilings`. The
 * store folds them with `narrowestPrecision`, whose only direction is down, so
 * a source cannot widen its own exposure by asking — §52, enforced at the one
 * place an estimate is made rather than at four call sites.
 */
export interface PresenceClaim {
  /** Source-scoped or account-scoped subject id. Must be non-empty. */
  subjectKey: string;
  linkage: SubjectLinkage;
  /** What the source would like. The store may only narrow it. */
  requestedPrecision: LocationPrecision;
  /**
   * Every other bound the source computed: the session ceiling, the signal
   * rung's ceiling, the §23 decay stage, the §24 protected-zone floor. An
   * unrecognised entry is treated as `none` — a bound we cannot read is not a
   * bound we get to ignore.
   */
  ceilings?: readonly (LocationPrecision | string | null | undefined)[];
  /** Device/observation clock in ms, or null when the source has no observation time. */
  observedAtMs: number | null;
  /** §10 state the source believes. The store may downgrade it, never upgrade. */
  state: PresenceEstimateState;
  /** 0..1. Non-finite becomes 0 — an unreadable confidence is not a high one. */
  confidence: number;
  evidence: readonly PresenceEvidenceType[];
  point?: GeoPoint | null;
  zoneId?: string | null;
  floor?: number | null;
  distanceRange?: { minMeters: number; maxMeters: number } | null;
}

export type PresenceRefusal =
  /** The capability names a source the register does not contain. */
  | "unknown_source"
  /** Empty or non-string subject key. */
  | "no_subject"
  /** A non-finite observedAt or nowMs. We do not guess a clock. */
  | "bad_clock"
  /** Older than PRESENCE_ESTIMATE_TTL_MS. Not an estimate any more. */
  | "expired"
  /** The fold landed on `none` — policy says show nothing. */
  | "suppressed"
  /** A state string outside ESTIMATE_STATES. */
  | "unknown_state";

export type PresenceAdmission =
  | { readonly ok: true; readonly estimate: FusedPresenceEstimate }
  | { readonly ok: false; readonly refusal: PresenceRefusal };

/** Thrown for a forged capability or a forged estimate. Never for data. */
export class PresenceFusionViolation extends Error {
  readonly kind: "forged_capability" | "forged_estimate";
  constructor(kind: "forged_capability" | "forged_estimate", detail?: string) {
    super(
      kind === "forged_capability"
        ? `presence fusion: admit() was called with a capability this store did not mint${detail ? ` (${detail})` : ""}. There is exactly one write path into presence and this is not it.`
        : `presence fusion: a value was presented as a PresenceEstimate that this store did not mint${detail ? ` (${detail})` : ""}.`,
    );
    this.name = "PresenceFusionViolation";
    this.kind = kind;
  }
}

// ── Lock 2 + 3: the write capability ──────────────────────────────────────────

const MINTED_CAPABILITIES = new WeakSet<object>();
let mintCapability!: (source: PresenceSourceId) => PresenceWriteCapability;

/**
 * Proof that the holder is one of the registered presence sources.
 *
 * `private constructor` + `#capability` means this type is uninhabitable from
 * outside this module: `new` is a compile error, and an object literal is
 * missing a member it cannot name. The static block below is the only place in
 * the program where one is made.
 */
export class PresenceWriteCapability {
  readonly #capability = true;
  readonly source: PresenceSourceId;

  private constructor(source: PresenceSourceId) {
    this.source = source;
    Object.freeze(this);
  }

  /** True only for a capability minted by this module. */
  static holds(v: unknown): v is PresenceWriteCapability {
    if (typeof v !== "object" || v === null) return false;
    if (!MINTED_CAPABILITIES.has(v)) return false;
    return #capability in v;
  }

  static {
    mintCapability = (source: PresenceSourceId): PresenceWriteCapability => {
      const c = new PresenceWriteCapability(source);
      MINTED_CAPABILITIES.add(c);
      return c;
    };
  }
}

/**
 * One capability per registered source, minted once, frozen.
 *
 * This record IS the complete set of write paths into presence. It is exported
 * so the four sources can use theirs; it cannot be extended (frozen), and the
 * key type is the closed union, so `PRESENCE_WRITE_CAPABILITIES["anything_else"]`
 * does not compile.
 */
export const PRESENCE_WRITE_CAPABILITIES: Readonly<
  Record<PresenceSourceId, PresenceWriteCapability>
> = Object.freeze(
  Object.fromEntries(
    PRESENCE_SOURCES.map((s) => [s, mintCapability(s)]),
  ) as Record<PresenceSourceId, PresenceWriteCapability>,
);

// ── Lock 1 + 4: the sealed estimate ───────────────────────────────────────────

interface FusedInit {
  source: PresenceSourceId;
  subjectKey: string;
  linkage: SubjectLinkage;
  observedAtMs: number | null;
  expiresAtMs: number | null;
  position: GeoPoint | null;
  zoneId: string | null;
  floor: number | null;
  distanceRange: { minMeters: number; maxMeters: number } | null;
  confidence: number;
  freshness: number;
  evidenceTypes: readonly PresenceEvidenceType[];
  state: PresenceEstimateState;
  precision: LocationPrecision;
  ceiling: LocationPrecision;
}

const MINTED_ESTIMATES = new WeakSet<object>();
let mintEstimate!: (init: FusedInit) => FusedPresenceEstimate;

/**
 * `PresenceEstimate` (presence/domain/types.ts) with the source, the ceiling
 * that produced it and a seal.
 *
 * ONE FIELD IS WIDENED AND THE REASON MATTERS. `PresenceEstimate.observedAt` is
 * `Date`, which assumes every estimate came from a TIMED observation. Two of
 * the map's three presence kinds have no observation time at all — a buddy's
 * meetup base and a circle roster pin are standing assertions, not sightings,
 * and `lib/mapProjection` says so in as many words ("Manufacturing 'live' from
 * either would make a listing read as a confirmed sighting"). Stamping `now` on
 * them to satisfy a type would manufacture exactly that. So `observedAt` is
 * `Date | null` here, and a null one is pinned to `state: "unknown"` and
 * `freshness: 0` — strictly more honest than the type it widens, never less.
 * `toPresenceEstimate()` returns the domain type for the timed case and `null`
 * for the untimed one, rather than inventing a Date to satisfy a signature.
 */
export class FusedPresenceEstimate {
  readonly #fused = true;

  readonly source: PresenceSourceId;
  readonly subjectKey: string;
  readonly linkage: SubjectLinkage;
  readonly observedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly position: GeoPoint | null;
  readonly zoneId: string | null;
  readonly floor: number | null;
  readonly distanceRange: { minMeters: number; maxMeters: number } | null;
  readonly confidence: number;
  readonly freshness: number;
  readonly evidenceTypes: readonly PresenceEvidenceType[];
  readonly state: PresenceEstimateState;
  readonly precision: LocationPrecision;
  /** The bound the fold landed on. `precision` can never exceed it. */
  readonly ceiling: LocationPrecision;

  readonly #observedAtMs: number | null;
  readonly #expiresAtMs: number | null;

  private constructor(init: FusedInit) {
    this.source = init.source;
    this.subjectKey = init.subjectKey;
    this.linkage = init.linkage;
    this.observedAt = init.observedAtMs === null ? null : new Date(init.observedAtMs);
    this.expiresAt = init.expiresAtMs === null ? null : new Date(init.expiresAtMs);
    this.position = init.position;
    this.zoneId = init.zoneId;
    this.floor = init.floor;
    this.distanceRange = init.distanceRange;
    this.confidence = init.confidence;
    this.freshness = init.freshness;
    this.evidenceTypes = Object.freeze([...init.evidenceTypes]);
    this.state = init.state;
    this.precision = init.precision;
    this.ceiling = init.ceiling;
    this.#observedAtMs = init.observedAtMs;
    this.#expiresAtMs = init.expiresAtMs;
    Object.freeze(this);
  }

  /** Null when the source had no observation time. */
  get observedAtMs(): number | null {
    return this.#observedAtMs;
  }

  /** True only inside PRESENCE_LIVE_WINDOW_MS AND for a live §10 state. */
  live(nowMs: number | null): boolean {
    if (!isLiveState(this.state)) return false;
    if (nowMs === null || this.#observedAtMs === null) return false;
    if (!Number.isFinite(nowMs)) return false;
    return nowMs - this.#observedAtMs < PRESENCE_LIVE_WINDOW_MS;
  }

  /**
   * §20 "Expired/stale state ≠ current". An UNTIMED estimate never expires by
   * clock (it has none) — it is bounded by the store's entry cap instead, and
   * it can never be live, so it cannot be mistaken for current.
   */
  expiredAt(nowMs: number | null): boolean {
    if (this.#expiresAtMs === null) return false;
    if (nowMs === null || !Number.isFinite(nowMs)) return false;
    return nowMs >= this.#expiresAtMs;
  }

  /** The domain type, for the timed case. Null rather than a fabricated Date. */
  toPresenceEstimate(): PresenceEstimate | null {
    if (this.observedAt === null) return null;
    return {
      subjectId: this.subjectKey,
      observedAt: this.observedAt,
      position: this.position,
      zoneId: this.zoneId,
      floor: this.floor,
      distanceRange: this.distanceRange,
      confidence: this.confidence,
      freshness: this.freshness,
      evidenceTypes: [...this.evidenceTypes],
      state: this.state,
      precision: this.precision,
    };
  }

  /** Structural seal check — true only for a real instance of this class. */
  static sealed(v: unknown): boolean {
    if (typeof v !== "object" || v === null) return false;
    return #fused in v;
  }

  static {
    mintEstimate = (init: FusedInit): FusedPresenceEstimate => {
      const e = new FusedPresenceEstimate(init);
      MINTED_ESTIMATES.add(e);
      return e;
    };
  }
}

/** True only for an estimate this module minted. */
export function isFused(v: unknown): v is FusedPresenceEstimate {
  if (typeof v !== "object" || v === null) return false;
  if (!MINTED_ESTIMATES.has(v)) return false;
  return FusedPresenceEstimate.sealed(v);
}

/**
 * The gate a consumer puts on anything handed to it as an estimate. Throws
 * rather than returning false: a forged estimate reaching a consumer is not a
 * data condition to branch on, it is a second write path being attempted.
 */
export function assertFused(v: unknown): asserts v is FusedPresenceEstimate {
  if (!isFused(v)) throw new PresenceFusionViolation("forged_estimate");
}

// ── The store ─────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function foldCeilings(
  requested: LocationPrecision,
  rest: readonly (LocationPrecision | string | null | undefined)[],
): LocationPrecision {
  const known = (v: LocationPrecision | string | null | undefined): LocationPrecision =>
    typeof v === "string" && precisionRank(v as LocationPrecision) >= 0
      ? (v as LocationPrecision)
      : "none";
  let acc = known(requested);
  for (const r of rest) acc = narrowestPrecision(acc, known(r));
  return acc;
}

/**
 * §17's CLASS BOUNDARY — "keep privacy classes distinct … reuse low-level
 * sensor/proximity infrastructure where possible, NOT consent/policy semantics".
 *
 * OWNER DECISION, 2026-09-26: distinct classes MAY NOT FUSE. The competing
 * reading — that classes merely may not MERGE identity, since the estimate
 * keeps its `source` — was put to the owner and refused. Recorded in
 * census-sensing §20; do not relitigate it from the code.
 *
 * Both sides are read from the TRUSTED REGISTER (`PRESENCE_SOURCE_CONTRACTS`)
 * rather than from the estimate, so a forged or stale object cannot nominate
 * its own class. A source the register does not contain, or one whose class is
 * not a member of the closed `PRESENCE_CLASSES` union, is REFUSED rather than
 * treated as compatible: an unreadable class is not a matching class, which is
 * the same fail-closed direction `foldCeilings` takes for an unreadable bound.
 *
 * Same-class fusion stays permitted, and that is the rule doing real work
 * rather than a blanket ban: `circle_presence` and `locate_friends_session` are
 * BOTH `social`, so they still fuse with each other. What can no longer happen
 * is a `trip_crew` position answering a `social` surface, or the reverse.
 */
function sameConsentClass(a: PresenceSourceId, b: PresenceSourceId): boolean {
  const ca = PRESENCE_SOURCE_CONTRACTS[a]?.presenceClass;
  const cb = PRESENCE_SOURCE_CONTRACTS[b]?.presenceClass;
  if (!ca || !cb) return false;
  if (!(PRESENCE_CLASSES as readonly string[]).includes(ca)) return false;
  if (!(PRESENCE_CLASSES as readonly string[]).includes(cb)) return false;
  return ca === cb;
}

function isEstimateState(v: unknown): v is PresenceEstimateState {
  return typeof v === "string" && (ESTIMATE_STATES as readonly string[]).includes(v);
}

const RETENTION_KEY_SEP = "\u0000";

export interface PresenceFusionStoreOptions {
  /**
   * Hard cap on retained entries. The store is a derivation cache in a
   * long-lived process, so it must have a bound that does not depend on a
   * sweeper having run. Oldest insertion is evicted first.
   */
  maxEntries?: number;
}

export const DEFAULT_MAX_ENTRIES = 50_000;

export class PresenceFusionStore {
  readonly #entries = new Map<string, FusedPresenceEstimate>();
  readonly #maxEntries: number;

  constructor(options?: PresenceFusionStoreOptions) {
    const m = options?.maxEntries;
    this.#maxEntries = typeof m === "number" && Number.isFinite(m) && m > 0 ? Math.floor(m) : DEFAULT_MAX_ENTRIES;
  }

  /**
   * THE ONLY WRITE PATH INTO PRESENCE.
   *
   * Returns the estimate derived from THIS claim, always. Retention is a
   * separate decision made below: an older claim is minted and returned (the
   * caller asked about that observation and deserves an answer about it) but
   * does not displace a fresher retained one. Conflating the two would make
   * projection impure — the same row would project differently depending on
   * what some other request happened to do first.
   */
  admit(
    capability: PresenceWriteCapability,
    claim: PresenceClaim,
    nowMs: number | null,
  ): PresenceAdmission {
    if (!PresenceWriteCapability.holds(capability)) {
      throw new PresenceFusionViolation("forged_capability");
    }
    const contract = PRESENCE_SOURCE_CONTRACTS[capability.source];
    if (!contract) return { ok: false, refusal: "unknown_source" };

    const subjectKey = typeof claim?.subjectKey === "string" ? claim.subjectKey.trim() : "";
    if (subjectKey === "") return { ok: false, refusal: "no_subject" };

    const observedAtMs = claim.observedAtMs;
    if (observedAtMs !== null && !Number.isFinite(observedAtMs)) {
      return { ok: false, refusal: "bad_clock" };
    }
    if (nowMs !== null && !Number.isFinite(nowMs)) return { ok: false, refusal: "bad_clock" };

    if (!isEstimateState(claim.state)) return { ok: false, refusal: "unknown_state" };

    const timed = observedAtMs !== null && nowMs !== null;
    const ageMs = timed ? Math.max(0, (nowMs as number) - (observedAtMs as number)) : null;
    if (ageMs !== null && ageMs >= PRESENCE_ESTIMATE_TTL_MS) {
      return { ok: false, refusal: "expired" };
    }

    // §2.2 / §20: freshness is about the CLOCK and confidence is about the
    // EVIDENCE. They are separate fields because a very confident reading can
    // still be very old, and an untimed one has no freshness to report at all.
    const freshness = ageMs === null ? 0 : clamp01(1 - ageMs / PRESENCE_ESTIMATE_TTL_MS);

    // The state may only be DOWNGRADED here. An untimed claim can never assert
    // a current position; a timed one past the live window is `recent`.
    let state: PresenceEstimateState = claim.state;
    if (!timed && isLiveState(state)) state = "unknown";
    else if (timed && isLiveState(state) && (ageMs as number) >= PRESENCE_LIVE_WINDOW_MS) {
      state = "recent";
    }

    const ceiling = foldCeilings(contract.ceiling, claim.ceilings ?? []);
    const precision = narrowestPrecision(foldCeilings(claim.requestedPrecision, []), ceiling);
    if (precision === "none") return { ok: false, refusal: "suppressed" };

    // §52: the store never RETAINS a coordinate the rung does not permit. A
    // point kept "in case the ceiling is raised later" is how a derivation
    // cache becomes a location history.
    const point =
      precision === "precise" &&
      claim.point != null &&
      Number.isFinite(claim.point.lat) &&
      Number.isFinite(claim.point.lng)
        ? { lat: claim.point.lat, lng: claim.point.lng }
        : null;

    const expiresAtMs = observedAtMs === null ? null : observedAtMs + PRESENCE_ESTIMATE_TTL_MS;

    const estimate = mintEstimate({
      source: capability.source,
      subjectKey,
      linkage: claim.linkage === "account_scoped" ? "account_scoped" : "source_scoped",
      observedAtMs,
      expiresAtMs,
      position: point,
      zoneId: claim.zoneId ?? null,
      floor: typeof claim.floor === "number" && Number.isFinite(claim.floor) ? claim.floor : null,
      distanceRange: claim.distanceRange ?? null,
      confidence: clamp01(claim.confidence),
      freshness,
      evidenceTypes: Array.isArray(claim.evidence) ? claim.evidence : [],
      state,
      precision,
      ceiling,
    });

    this.#retain(estimate, nowMs);
    return { ok: true, estimate };
  }

  /**
   * Latest retained estimate for one source's subject, NARROWED TO THE AUDIENCE
   * THAT IS ASKING — or null when expired, absent, or withheld from that
   * audience.
   *
   * `audienceCeiling` is REQUIRED, and it is the caller's own §52 rung for THIS
   * viewer and THIS subject — the live-share grant, the session ceiling, the
   * circle visibility mode. It is NOT the source's static contract ceiling,
   * which is a property of the model rather than of who is looking. `#forAudience`
   * states what a read without it would serve.
   */
  read(
    source: PresenceSourceId,
    subjectKey: string,
    audienceCeiling: LocationPrecision,
    nowMs: number | null,
  ): FusedPresenceEstimate | null {
    const hit = this.#entries.get(`${source}${RETENTION_KEY_SEP}${subjectKey}`);
    if (!hit) return null;
    if (hit.expiredAt(nowMs)) return null;
    return this.#forAudience(hit, source, audienceCeiling);
  }

  /**
   * FUSION ACROSS SOURCES — one subject, many models, one answer.
   *
   * Takes every live ACCOUNT-SCOPED estimate for `subjectKey`, picks the most
   * recent observation, and re-mints it under BOTH the asking source's ceiling
   * and `audienceCeiling` — the rung THIS viewer holds over THIS subject — so a
   * feature can never see more through the fusion layer than its own §52 rung
   * allows, and one viewer can never see another viewer's. The source ceiling
   * alone is not enough, and `#forAudience` states why in full.
   * `source_scoped` estimates are skipped entirely: §20 forbids
   * reverse-linking anonymous world intelligence to an account, and the way to
   * honour that is to have no code path that does it.
   */
  resolve(
    subjectKey: string,
    forSource: PresenceSourceId,
    audienceCeiling: LocationPrecision,
    nowMs: number | null,
  ): FusedPresenceEstimate | null {
    const asking = PRESENCE_SOURCE_CONTRACTS[forSource];
    if (!asking) return null;
    const key = typeof subjectKey === "string" ? subjectKey.trim() : "";
    if (key === "") return null;

    let best: FusedPresenceEstimate | null = null;
    for (const source of PRESENCE_SOURCES) {
      const hit = this.#entries.get(`${source}${RETENTION_KEY_SEP}${key}`);
      if (!hit) continue;
      if (hit.linkage !== "account_scoped") continue;
      // §17 CLASS BOUNDARY, applied during SELECTION and not only at egress.
      // If a cross-class estimate were allowed to win `best` here and were then
      // refused below, the answer would be `null` where an eligible same-class
      // estimate existed — the rule would silently destroy correct answers
      // instead of narrowing them. Filtering here means the newest estimate
      // WITHIN the asking class wins, which is what fusion means once classes
      // may not cross.
      if (!sameConsentClass(hit.source, forSource)) continue;
      if (hit.expiredAt(nowMs)) continue;
      if (hit.observedAtMs === null) continue;
      if (best === null || (hit.observedAtMs as number) > (best.observedAtMs as number)) best = hit;
    }
    if (best === null) return null;

    return this.#forAudience(best, forSource, audienceCeiling);
  }

  /**
   * ── WHY EVERY READ PATH TAKES AN AUDIENCE CEILING ────────────────────────
   *
   * Retention is keyed `(source, subject)` and deliberately carries no viewer:
   * `locateFriendsSession.ts` says so in as many words — "the latest observation
   * of a person is the latest observation of that person, whichever session
   * carried it". That is right about the OBSERVATION and wrong about the
   * DISCLOSURE, because the estimate object carries both. `precision`, `ceiling`
   * and `position` are folded from bounds that are properties of the VIEWER, not
   * of the subject: the live-share grant (`allowed_member_ids` — per viewer),
   * the Locate-My-Friends session ceiling (per session), the circle visibility
   * mode (per circle). One slot, many viewers, last writer's entitlement.
   *
   * `#retain` replaces only on a STRICTLY newer observation, so the common case
   * is the bad one: two viewers of the same sighting tie on `observedAtMs`, the
   * narrower admission does not displace the wider, and the wider survives.
   * Measured on this tree before the fix: a viewer holding a `precise` grant and
   * a viewer holding none admit the same observation; the retained entry keeps
   * the precise position, and a `resolve` on behalf of the ungranted viewer
   * returned it in full, because the asking ceiling was read from the SOURCE
   * CONTRACT (statically `precise` for that model) instead of from the viewer.
   *
   * So the fix is not a viewer in the key — that would store the same sighting
   * once per viewer and make "the latest observation" false. It is that policy
   * is applied at EGRESS: the store retains the fact, and every read states the
   * rung the asker is entitled to. Both ladders still apply, and both only
   * tighten — the source contract bounds the model, the audience bounds the
   * viewer, and `foldCeilings` turns a bound it cannot read into `none` rather
   * than ignoring it. A `none` audience withholds the row entirely, so a viewer
   * who may not know the subject is present learns nothing from asking.
   *
   * This is required rather than optional on purpose: a reader that forgets it
   * is a compile error, not a leak.
   */
  #forAudience(
    best: FusedPresenceEstimate,
    forSource: PresenceSourceId,
    audienceCeiling: LocationPrecision,
  ): FusedPresenceEstimate | null {
    const asking = PRESENCE_SOURCE_CONTRACTS[forSource];
    if (!asking) return null;
    // §17 CLASS BOUNDARY — owner decision 2026-09-26, central backstop.
    //
    // HONEST ABOUT ITS REACH: this line is UNREACHABLE on every path that
    // exists today, and mutation testing is what established that rather than
    // inspection. Deleting it turns no test red. `read` looks the entry up BY
    // `source` and passes that same `source` as `forSource`, so `hit.source ===
    // forSource` holds by construction and the classes always match; an
    // unknown source is already refused by the `asking` guard above. The load-
    // bearing enforcement is the selection-time filter in `resolve`, which IS
    // covered (deleting it reds "an eligible same-class estimate still answers
    // even when a NEWER cross-class one exists").
    //
    // It stays because the owner asked for the rule to be mandatory for every
    // caller, and the invariant that makes it redundant is `read`'s, not the
    // store's: the day a caller asks on behalf of a source other than the one
    // it addressed — a fused read with an explicit asking class, which is
    // exactly what §16.5's step builds — this is the line that refuses it.
    // Redundant today, load-bearing the moment that invariant is relaxed.
    if (!sameConsentClass(best.source, forSource)) return null;
    const ceiling = foldCeilings(best.ceiling, [asking.ceiling, audienceCeiling]);
    const precision = narrowestPrecision(best.precision, ceiling);
    if (precision === "none") return null;
    if (precision === best.precision && ceiling === best.ceiling && best.source === forSource) {
      return best;
    }
    return mintEstimate({
      source: best.source,
      subjectKey: best.subjectKey,
      linkage: best.linkage,
      observedAtMs: best.observedAtMs,
      expiresAtMs: best.expiresAt === null ? null : best.expiresAt.getTime(),
      position: precision === "precise" ? best.position : null,
      zoneId: best.zoneId,
      floor: best.floor,
      distanceRange: best.distanceRange,
      confidence: best.confidence,
      freshness: best.freshness,
      evidenceTypes: best.evidenceTypes,
      state: best.state,
      precision,
      ceiling,
    });
  }

  /** Drop everything expired at `nowMs`. Returns how many went. */
  sweep(nowMs: number | null): number {
    let dropped = 0;
    for (const [k, v] of this.#entries) {
      if (v.expiredAt(nowMs)) {
        this.#entries.delete(k);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #retain(estimate: FusedPresenceEstimate, nowMs: number | null): void {
    const key = `${estimate.source}${RETENTION_KEY_SEP}${estimate.subjectKey}`;
    const existing = this.#entries.get(key);
    const replace =
      !existing ||
      existing.expiredAt(nowMs) ||
      existing.observedAtMs === null ||
      (estimate.observedAtMs !== null && estimate.observedAtMs > existing.observedAtMs);
    if (replace) {
      // Delete first so Map insertion order tracks recency for the eviction below.
      this.#entries.delete(key);
      this.#entries.set(key, estimate);
    }
    if (nowMs !== null) this.sweep(nowMs);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

/**
 * The process-wide store. One, because "one PresenceEstimate store" is the
 * whole point; a second instance is constructible for tests and for callers
 * that want an isolated derivation, and neither can mint an estimate by any
 * route this one cannot.
 */
export const presenceFusion = new PresenceFusionStore();
