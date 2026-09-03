/**
 * usePassportPlans — data hook for the Plans surface (spec §16).
 *
 * Reads the ONE Passport projection (GET /api/passport/:userId/projection). The
 * server has ALREADY applied per-plan visibility (§16 / TABLE 24: "Plans:
 * private/followers by default") and returns only the plans this viewer may see
 * plus the server-projected action flags (§30). This hook never re-derives that
 * policy — it renders what the projection returns.
 *
 * When viewing ANOTHER passport it also loads the VIEWER's own plans (self
 * projection) so it can compute Trip overlap ("You'll both be in Bangkok Sep
 * 14–17", §16). Overlap is computed on the CLIENT from the two permitted plan
 * lists — nothing extra is fetched or exposed. The "Connect for {city}" action
 * is gated on the server flag `capabilities.actions.can_make_plan`.
 *
 * `computeTripOverlap` and `formatTripDateRange` are pure and exported for
 * direct unit/component testing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getPassportProjection,
  type PassportProjectionView,
  type PassportProjectionIdentity,
  type PlanProjection,
} from '../../services/passportProjection.ts';
import { updateTrip } from '../../services/trips.ts';
import type { TripVisibility } from '../../types/models.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** Parse the `YYYY-MM-DD` prefix of an ISO date, or null. */
function parseYmd(s: string | null): Ymd | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** `YYYY-MM-DD` day key (lexicographically comparable), or null. */
function dayKey(s: string | null): string | null {
  const m = parseYmd(s);
  return m ? `${m.y.toString().padStart(4, '0')}-${m.m.toString().padStart(2, '0')}-${m.d.toString().padStart(2, '0')}` : null;
}

/** Human date range: "Sep 14–17" / "Sep 28 – Oct 2" / single day. */
export function formatTripDateRange(startISO: string | null, endISO: string | null): string {
  const a = parseYmd(startISO);
  const b = parseYmd(endISO);
  if (!a) return '';
  if (!b || (a.y === b.y && a.m === b.m && a.d === b.d)) return `${MONTHS[a.m - 1]} ${a.d}`;
  if (a.y === b.y && a.m === b.m) return `${MONTHS[a.m - 1]} ${a.d}–${b.d}`;
  if (a.y === b.y) return `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}`;
  return `${MONTHS[a.m - 1]} ${a.d}, ${a.y} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}

function normCity(s: string | null): string {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

/** A computed overlap between the viewer's plans and the owner's plans. */
export interface TripOverlap {
  city: string;
  country: string | null;
  /** Intersection window (null when either side hid exact dates). */
  startDate: string | null;
  endDate: string | null;
  /** e.g. "You'll both be in Bangkok Sep 14–17". */
  label: string;
  /** The owner's trip id for this overlap. */
  tripId: string;
}

/**
 * Compute Trip overlap between the viewer's own plans and the owner's plans.
 * Matches by (coarse) city; when both sides expose dates, reports the
 * intersecting window. Pure — no I/O.
 */
export function computeTripOverlap(myPlans: PlanProjection[], theirPlans: PlanProjection[]): TripOverlap[] {
  const out: TripOverlap[] = [];
  const seen = new Set<string>();

  for (const tp of theirPlans) {
    const key = normCity(tp.destinationCity);
    if (!key || seen.has(key)) continue;
    const mine = myPlans.filter((mp) => normCity(mp.destinationCity) === key);
    if (mine.length === 0) continue;
    seen.add(key);

    let start: string | null = null;
    let end: string | null = null;
    for (const mp of mine) {
      const sa = dayKey(tp.startDate);
      const ea = dayKey(tp.endDate);
      const sb = dayKey(mp.startDate);
      const eb = dayKey(mp.endDate);
      if (sa && ea && sb && eb) {
        const s = sa > sb ? sa : sb;
        const e = ea < eb ? ea : eb;
        if (s <= e) {
          start = s;
          end = e;
          break;
        }
      }
    }

    const dateStr = start ? formatTripDateRange(start, end) : '';
    out.push({
      city: tp.destinationCity as string,
      country: tp.destinationCountry,
      startDate: start,
      endDate: end,
      label: `You'll both be in ${tp.destinationCity}${dateStr ? ` ${dateStr}` : ''}`,
      tripId: tp.tripId,
    });
  }
  return out;
}

export interface PlansViewModel {
  loading: boolean;
  error: string | null;
  /** True when the projection resolved to the owner's own (self) context. */
  isSelf: boolean;
  identity: PassportProjectionIdentity | null;
  plans: PlanProjection[];
  overlaps: TripOverlap[];
  /** Server-projected (§30): whether this viewer may start a plan with the owner. */
  canMakePlan: boolean;
  restricted: boolean;
}

export interface UsePassportPlansResult extends PlansViewModel {
  reload: () => void;
  /** Owner-only: change one plan's visibility (optimistic; reverts on failure). */
  updatePlanVisibility: (tripId: string, visibility: TripVisibility) => Promise<void>;
  /** Non-null after a failed visibility write. */
  mutationError: string | null;
}

const EMPTY: PlansViewModel = {
  loading: true,
  error: null,
  isSelf: false,
  identity: null,
  plans: [],
  overlaps: [],
  canMakePlan: false,
  restricted: false,
};

export interface UsePassportPlansArgs {
  /** The passport being viewed (UUID/@handle). null ⇒ the viewer's own plans. */
  targetUserId: string | null;
  /** The signed-in viewer's id (for self detection + overlap). */
  viewerUserId: string | null;
}

export function usePassportPlans({ targetUserId, viewerUserId }: UsePassportPlansArgs): UsePassportPlansResult {
  const [vm, setVm] = useState<PlansViewModel>(EMPTY);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const plansRef = useRef<PlanProjection[]>([]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    const ownerId = targetUserId ?? viewerUserId;
    setVm((s) => ({ ...s, loading: true, error: null }));

    if (!ownerId) {
      setVm({ ...EMPTY, loading: false, error: 'Not signed in' });
      return () => {
        alive = false;
      };
    }

    (async () => {
      const res = await getPassportProjection(ownerId);
      if (!alive) return;
      if (!res.ok) {
        setVm({ ...EMPTY, loading: false, error: res.message });
        return;
      }
      const proj: PassportProjectionView = res.data;
      const isSelf = proj.viewerContext === 'self';

      let overlaps: TripOverlap[] = [];
      if (!isSelf && viewerUserId) {
        const mine = await getPassportProjection(viewerUserId);
        if (!alive) return;
        if (mine.ok) overlaps = computeTripOverlap(mine.data.upcomingPlans, proj.upcomingPlans);
      }

      plansRef.current = proj.upcomingPlans;
      setVm({
        loading: false,
        error: null,
        isSelf,
        identity: proj.identity,
        plans: proj.upcomingPlans,
        overlaps,
        canMakePlan: proj.actions.can_make_plan,
        restricted: proj.restricted,
      });
    })().catch(() => {
      if (alive) setVm({ ...EMPTY, loading: false, error: 'Failed to load plans' });
    });

    return () => {
      alive = false;
    };
  }, [targetUserId, viewerUserId, tick]);

  const updatePlanVisibility = useCallback(async (tripId: string, visibility: TripVisibility) => {
    setMutationError(null);
    const prev = plansRef.current;
    const next = prev.map((p) => (p.tripId === tripId ? { ...p, visibility } : p));
    plansRef.current = next;
    setVm((s) => ({ ...s, plans: next }));

    const result = await updateTrip(tripId, { visibility });
    if (result === null) {
      // Revert on failure.
      plansRef.current = prev;
      setVm((s) => ({ ...s, plans: prev }));
      setMutationError('Could not update visibility');
    }
  }, []);

  return { ...vm, reload, updatePlanVisibility, mutationError };
}
