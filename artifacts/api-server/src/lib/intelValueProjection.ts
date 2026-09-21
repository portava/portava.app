/**
 * intelValueProjection — the key allow-list for `intel_observations.value`.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
 * `value` arrives from the client as `z.record(z.string(), z.unknown())`
 * (routes/intel.ts) — an arbitrary JSON object. It is then validated by
 * lib/quickSignal.VALUE_VALIDATORS / lib/trailFollowup.TRAIL_VALUE_VALIDATORS,
 * every one of which checks that the keys it NAMES are present and well-shaped:
 *
 *   "crowd.level": (v) => isObj(v) && typeof v.level === "string" && …
 *
 * None of them rejects an EXTRA key. Measured against the shipped validators:
 *
 *   validateClaimValue("crowd.level",  { level: "busy", note: "met Alice at 9pm" })  => true
 *   validateClaimValue("queue.wait",   { minMinutes: 5, maxMinutes: 10, lat: 51.5, lng: -0.1 }) => true
 *   validateClaimValue("access.walk_in", { accepted: true, freeText: "ask for Dave" }) => true
 *
 * IntelCaptureService then stored `value: input.value` verbatim. And `value` does
 * not stay in the observation:
 *
 *   intel_observations.value  --(2174 promote, DISTINCT ON: `o.value` verbatim,
 *                                and proposeClaim: `value: observation.value`)-->
 *   intel_claims.value        --(lib/intelProjectionAggregator plurality)-->
 *   intel_state_snapshots.value  --(lib/intelApiProjection.projectSnapshotForApi)-->
 *   the redistributable API product.
 *
 * lib/dataRights classifies intel_observations.value `contributor_licensed,
 * personal: false` and both downstream copies `derived_aggregate, personal:
 * false` — REDISTRIBUTABLE. So free text and raw coordinates could ride a
 * client-chosen key all the way to a field whose stated classification is "not
 * personal data". lib/canonicalEvents does exactly this job for the event spine
 * (FORBIDDEN_PAYLOAD_KEYS + ALLOWED_PAYLOAD_KEYS); the intel value path had no
 * equivalent.
 *
 * ── WHAT THIS DOES ───────────────────────────────────────────────────────────
 * Projects a value to the keys its claim type's value space actually names, and
 * strips the raw-GPS key set at EVERY depth (belt and braces: no allow-listed
 * key is object-valued today, so the deep strip is for the value space that
 * eventually is). Fail-closed twice over:
 *
 *   * an unknown claim type projects to `null` — the caller must refuse. The
 *     capture path already refused it (SURFACE_CLAIMS + the validators), so this
 *     is the second lock, not the first.
 *   * the caller RE-VALIDATES the projected value. A projection that dropped a
 *     required key (i.e. this map drifting from the validators) then refuses the
 *     write instead of storing a shape nothing downstream can read.
 *
 * A canonical value round-trips byte-identically; only keys nobody named are
 * dropped. PURE — no I/O, no clock.
 */

/**
 * Raw-GPS keys, removed absolutely at every depth regardless of the per-type
 * allow-list. Same set and same absoluteness as lib/canonicalEvents
 * FORBIDDEN_PAYLOAD_KEYS — a coordinate is never part of a claim's value space,
 * in any claim type, present or future.
 */
export const FORBIDDEN_VALUE_KEYS = [
  "lat",
  "lng",
  "latitude",
  "longitude",
  "coords",
  "accuracy",
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_VALUE_KEYS.map((k) => k.toLowerCase()));

/**
 * claim_type -> the keys its value space names.
 *
 * MIRRORS lib/quickSignal.VALUE_VALIDATORS and lib/trailFollowup
 * .TRAIL_VALUE_VALIDATORS exactly, key for key. Those modules own the SHAPES;
 * this owns the KEY SET, and `intelValueProjection.test.ts` pins them against
 * each other in both directions — a claim type with a validator and no entry
 * here, or an entry naming a key the validator never reads, both fail.
 */
export const CLAIM_VALUE_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // §6 composer contexts + the §22 map sheet.
  "crowd.level": ["level"],
  "crowd.trajectory": ["trajectory"],
  "queue.wait": ["minMinutes", "maxMinutes"],
  "access.walk_in": ["accepted"],
  "vibe.state": ["state"],
  "event.status": ["status"],
  "closure.state": ["state"],
  "crowd.direction": ["direction"],
  "music.current": ["genre", "confidence"],
  // §4 Table-6 registry types that validate but are on no capture surface yet.
  "access.reservation": ["reservation"],
  "access.dress": ["policy", "enforced", "qualifiers"],
  "price.cover": ["amount", "currency", "accessType"],
  "crowd.mix": ["mix"],
  "inventory.status": ["item", "status"],
  "service.wait": ["serviceType", "minMinutes", "maxMinutes"],
  "transit.condition": ["routeOrMode", "condition"],
  // Trail surface (aggregate-only at claim level — mustAggregate).
  "experience.next_move": ["destinationArea", "timeWindow", "strength"],
  // Vocabulary-stable but deliberately not storable (no §4 row, no TTL). Listed
  // so this map stays total over TRAIL_VALUE_VALIDATORS.
  "experience.exit_reason": ["reason"],
});

/** Remove every forbidden key at every depth. Arrays walked; scalars pass through. */
function deepStripForbidden(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined; // fail-closed on pathological nesting
  if (Array.isArray(value)) return value.map((v) => deepStripForbidden(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(k.toLowerCase())) continue;
      const cleaned = deepStripForbidden(v, depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/** True iff this claim type has a declared value-key set. */
export function hasClaimValueKeys(claimType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLAIM_VALUE_KEYS, claimType);
}

/**
 * Project a client-supplied value to its claim type's named keys.
 *
 * Returns null for an unknown claim type or a non-object value — both of which
 * the caller must treat as a refusal, never as an empty value.
 */
export function projectClaimValue(
  claimType: string,
  value: unknown,
): Record<string, unknown> | null {
  const keys = CLAIM_VALUE_KEYS[claimType];
  if (!keys) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (FORBIDDEN.has(k.toLowerCase())) continue; // a named key may never be a coordinate
    const v = src[k];
    out[k] = v && typeof v === "object" ? deepStripForbidden(v) : v;
  }
  return out;
}
