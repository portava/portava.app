/**
 * Fixture rows for a PRESENCE stamp that carries its occurrence evidence —
 * census-highlights-memories H4, the reader half (wave 5, lane 5).
 *
 * Since `services/passport/stampPresenceView.ts`, every reader that names,
 * counts, pins or keys a feed by a stamp's place asks for the evidence the
 * stamp's own SOURCE names: a check-in on its trip (`source_type: "trips"`), or a
 * GPS stamp-eligible, unrevoked postcard for its post (`source_type: "posts"`).
 * A fixture that stages a presence stamp as "really earned" therefore stages
 * that evidence too; one that does not is staging exactly the historical row
 * (a completion stamp for a trip nobody checked in on) the readers now refuse.
 *
 * Every helper here only ADDS columns and rows a reader before this change did
 * not read, so a suite moved onto them asserts the same thing at HEAD.
 */

type Row = Record<string, unknown>;

/** The source fields of a completion-style presence stamp, sourced from a trip. */
export function tripSourced(userId: string, tripId: string): Row {
  return { user_id: userId, source_type: "trips", source_id: tripId };
}

/** The source fields of a postcard presence stamp, sourced from a post. */
export function postSourced(userId: string, postId: string): Row {
  return { user_id: userId, source_type: "posts", source_id: postId };
}

/** A `plan_checkins` arrival on the trip by the person (the evidence `tripCompletionPresence.ts` reads). */
export function tripArrival(userId: string, tripId: string): Row {
  return { user_id: userId, trip_id: tripId, status: "arrived", checked_in_at: "2026-01-01T10:00:00Z" };
}

/** A GPS stamp-eligible, unrevoked `passport_postcards` row for the post by the person. */
export function eligiblePostcard(userId: string, postId: string, place: { city?: string | null; country?: string | null } = {}): Row {
  return {
    user_id: userId, post_id: postId, stamp_eligible: true, stamp_revoked: false,
    location_city: place.city ?? null, location_country: place.country ?? null,
  };
}

/**
 * The evidence tables for a set of stamp rows: an arrival for every trip-sourced
 * row and an eligible postcard for every post-sourced row. Pass the rows a test
 * means as REALLY earned; leave out the ones it means as unevidenced.
 */
export function evidenceFor(rows: ReadonlyArray<Row>): { plan_checkins: Row[]; passport_stamps: Row[]; passport_postcards: Row[] } {
  const plan_checkins: Row[] = [];
  const passport_postcards: Row[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const userId = String(r.user_id ?? "");
    const sourceId = String(r.source_id ?? "");
    const key = `${userId}|${r.source_type}|${sourceId}`;
    if (!userId || !sourceId || seen.has(key)) continue;
    seen.add(key);
    if (r.source_type === "trips") plan_checkins.push(tripArrival(userId, sourceId));
    if (r.source_type === "posts") passport_postcards.push(eligiblePostcard(userId, sourceId, { city: r.city as string, country: r.country as string }));
  }
  return { plan_checkins, passport_stamps: [], passport_postcards };
}

const POSTCARD_SLUGS = new Set(["city_explorer", "world_citizen", "globe_trotter_5", "globe_trotter_10"]);

/**
 * For a suite whose `user_stamps` fixtures stage presence stamps (embedded
 * `evidences_presence: true`) as GENUINELY EARNED but predate the evidence rule:
 * give each such row that has no source a source of the kind its slug is
 * minted from (a post for the postcard slugs, a trip otherwise) and stage that
 * source's evidence. Rows that already name a source are left exactly as they
 * are, and get no evidence unless the suite stages it — so a suite can still
 * stage an UNEVIDENCED presence stamp by giving it a source and no evidence.
 * Non-presence rows are untouched. Returns new tables; nothing is mutated.
 */
export function withEarnedPresenceEvidence<T extends Record<string, Row[]>>(tables: T): T {
  const stamps = (tables.user_stamps ?? []) as Row[];
  const earned: Row[] = [];
  const out = stamps.map((r, i) => {
    const def = Array.isArray(r.stamp_definitions) ? (r.stamp_definitions as Row[])[0] : (r.stamp_definitions as Row | undefined);
    if (!def || def.evidences_presence !== true || r.source_type !== undefined) return r;
    const userId = String(r.user_id ?? "");
    const slug = String(def.slug ?? "");
    const tag = `${userId}-${String(r.city ?? r.country ?? "x")}-${i}`;
    const sourced = { ...r, ...(POSTCARD_SLUGS.has(slug) ? postSourced(userId, `post-${tag}`) : tripSourced(userId, `trip-${tag}`)) };
    earned.push(sourced);
    return sourced;
  });
  const ev = evidenceFor(earned);
  return {
    ...tables,
    user_stamps: out,
    plan_checkins: [...((tables.plan_checkins as Row[] | undefined) ?? []), ...ev.plan_checkins],
    passport_stamps: [...((tables.passport_stamps as Row[] | undefined) ?? []), ...ev.passport_stamps],
    passport_postcards: [...((tables.passport_postcards as Row[] | undefined) ?? []), ...ev.passport_postcards],
  } as T;
}

const STAGED = Symbol.for("portava.test.stampPresenceStaged");

/**
 * The in-place form of `withEarnedPresenceEvidence`, for a fake whose store a
 * suite mutates after the client exists (`fake.store.user_stamps = [...]`).
 * Call it from the fake's table accessor: each presence row with no source is
 * given a trip source once and its arrival is appended to `plan_checkins`.
 * Idempotent per row. Rows that already name a source are left alone, so a
 * suite can still stage an UNEVIDENCED presence stamp.
 */
export function stageEarnedPresenceInPlace(store: Record<string, Row[] | undefined>): void {
  const stamps = store.user_stamps ?? [];
  for (const r of stamps) {
    if ((r as any)[STAGED]) continue;
    let presence = false;
    try {
      const def = Array.isArray(r.stamp_definitions) ? (r.stamp_definitions as Row[])[0] : (r.stamp_definitions as Row | undefined);
      presence = !!def && def.evidences_presence === true;
    } catch { continue; } // a row a suite poisons on purpose is the code under test's to choke on, not this helper's
    if (!presence || r.source_type !== undefined) continue;
    Object.defineProperty(r, STAGED, { value: true, enumerable: false });
    const userId = String(r.user_id ?? "");
    const tripId = `trip-earned-${userId}-${String(r.city ?? r.country ?? "x")}-${stamps.indexOf(r)}`;
    r.source_type = "trips";
    r.source_id = tripId;
    (store.plan_checkins ??= []).push(tripArrival(userId, tripId));
  }
}
