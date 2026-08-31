/**
 * loadingStrategy — §33's loading ladder and §34's performance targets, as data.
 *
 * §33 is a sequence, and the sentence under it is the actual requirement:
 *
 *     cached geography → current position → canonical places/events →
 *     live state → social state → Compass personalization
 *
 *     "The map should progressively improve; it should not blank while live
 *      intelligence is loading."
 *
 * The way a map blanks is not a bug anyone writes on purpose — it is what you
 * get when the render path asks "do I have live data yet?" instead of "what am
 * I already allowed to draw?". So this module answers the second question:
 * `renderableAt(stage)` is the contract that says what the screen may ALREADY
 * paint at every rung, starting with rung one, where cached geography and
 * cached objects are enough to fill the viewport.
 *
 * PURE. No I/O, no clock, no React. Every function here is a total function of
 * its arguments so the ladder can be reasoned about — and tested — in one file.
 */

// ── The ladder (§33) ──────────────────────────────────────────────────────────

export const LOADING_STAGES = [
  'cached_geography',
  'current_position',
  'canonical',
  'live_state',
  'social_state',
  'compass',
] as const;

export type LoadingStage = (typeof LOADING_STAGES)[number];

/** The stage the map starts at — never "nothing". */
export const INITIAL_STAGE: LoadingStage = 'cached_geography';
/** The stage at which the map is fully personalized. */
export const TERMINAL_STAGE: LoadingStage = 'compass';

export function stageRank(stage: LoadingStage): number {
  const at = LOADING_STAGES.indexOf(stage);
  return at < 0 ? 0 : at;
}

export function isStage(value: string): value is LoadingStage {
  return (LOADING_STAGES as readonly string[]).includes(value);
}

/** The next rung, or null at the top. */
export function nextStage(stage: LoadingStage): LoadingStage | null {
  const at = stageRank(stage);
  return at >= LOADING_STAGES.length - 1 ? null : LOADING_STAGES[at + 1];
}

/**
 * Fold a newly-reached stage into the current one.
 *
 * MONOTONE BY CONSTRUCTION: the result is never lower than `current`. A late
 * response, a retry, or an out-of-order resolve can therefore never walk the
 * map backwards to a rung that renders less — which is precisely how a loaded
 * map blanks itself halfway through loading.
 */
export function advanceStage(current: LoadingStage, reached: LoadingStage): LoadingStage {
  return stageRank(reached) > stageRank(current) ? reached : current;
}

/** Has the ladder reached at least `required`? */
export function hasReached(current: LoadingStage, required: LoadingStage): boolean {
  return stageRank(current) >= stageRank(required);
}

// ── What may be drawn (the anti-blank contract) ───────────────────────────────

/**
 * Render layers, named for the §29 component list. `renderableAt` returns the
 * CUMULATIVE set: every layer unlocked at this rung and every rung below it.
 */
export const MAP_LAYERS = [
  'base_map',
  'cached_objects',
  'user_marker',
  'places',
  'events',
  'activity_zones',
  'freshness_badges',
  'crew',
  'social_zones',
  'compass_recommendations',
] as const;

export type MapLayer = (typeof MAP_LAYERS)[number];

/** Layers UNLOCKED at each rung (not cumulative — see `renderableAt`). */
const STAGE_UNLOCKS: Record<LoadingStage, readonly MapLayer[]> = {
  // Rung one already fills the screen. This is the whole point of §33.
  cached_geography: ['base_map', 'cached_objects'],
  current_position: ['user_marker'],
  canonical: ['places', 'events'],
  live_state: ['activity_zones', 'freshness_badges'],
  social_state: ['crew', 'social_zones'],
  compass: ['compass_recommendations'],
};

const STAGE_LABELS: Record<LoadingStage, string> = {
  cached_geography: 'Cached geography',
  current_position: 'Current position',
  canonical: 'Places and events',
  live_state: 'Live state',
  social_state: 'Social state',
  compass: 'Compass personalization',
};

export interface StageCapability {
  stage: LoadingStage;
  label: string;
  /** Every layer drawable at this rung, in ladder order. */
  layers: readonly MapLayer[];
  /**
   * ALWAYS false. Encoded as a field rather than a comment because it is the
   * assertion the tests pin: there is no rung of this ladder at which the map
   * is permitted to be blank (§33).
   */
  mayBlank: false;
  /**
   * Whether anything on screen at this rung may wear a live/pulsing treatment.
   * False below `live_state`: before live state has landed, everything visible
   * came from cache, and §37 forbids stale claims looking live.
   */
  liveTreatmentAllowed: boolean;
  /**
   * Whether the screen must show the §28 "Last updated …" cache label. True
   * below `live_state` for the same reason.
   */
  requiresCacheLabel: boolean;
  /** True once the map is usable enough to stop showing a loading affordance. */
  usable: boolean;
}

/**
 * What the screen may already draw at `stage`.
 *
 * The renderer should call this instead of branching on "did the live fetch
 * resolve?" — the difference between the two is a blank map.
 */
export function renderableAt(stage: LoadingStage): StageCapability {
  const rank = stageRank(stage);
  const layers: MapLayer[] = [];
  for (let i = 0; i <= rank; i += 1) {
    for (const layer of STAGE_UNLOCKS[LOADING_STAGES[i]]) layers.push(layer);
  }
  const live = hasReached(stage, 'live_state');
  return {
    stage,
    label: STAGE_LABELS[stage],
    layers,
    mayBlank: false,
    liveTreatmentAllowed: live,
    requiresCacheLabel: !live,
    // §34's "initial usable map": geography plus the user's own position is
    // enough to orient on, so the loading affordance can go away here.
    usable: hasReached(stage, 'current_position'),
  };
}

/** The full ladder, for a progress readout or a test that walks every rung. */
export function loadingLadder(): StageCapability[] {
  return LOADING_STAGES.map(renderableAt);
}

// ── Performance targets (§34) ─────────────────────────────────────────────────

export const PERFORMANCE_TARGETS = {
  /** §34: "Initial usable map: target under 2 seconds on a normal connection." */
  initialUsableMapMs: 2_000,
  /** §34: "first meaningful results within ~500-800 ms when cached/server-ready". */
  viewportIntelligenceMinMs: 500,
  viewportIntelligenceMaxMs: 800,
  /** §34: "Debounce after camera settles". How long "settled" means. */
  cameraSettleMs: 250,
  /** §34: "Pan responsiveness: target 60 fps" — 16.7 ms per frame. */
  frameBudgetMs: 1000 / 60,
} as const;

/** Did the first usable frame land inside the §34 budget? */
export function meetsInitialMapTarget(elapsedMs: number): boolean {
  return elapsedMs <= PERFORMANCE_TARGETS.initialUsableMapMs;
}

/** Did viewport intelligence land inside the §34 window? */
export function meetsViewportIntelligenceTarget(elapsedMs: number): boolean {
  return elapsedMs <= PERFORMANCE_TARGETS.viewportIntelligenceMaxMs;
}

// ── Requery decision (§34 debounce) ───────────────────────────────────────────

export interface ViewportCenter {
  lat: number;
  lng: number;
}

export interface Viewport {
  center: ViewportCenter;
  /** Web-mercator zoom level. */
  zoom: number;
  /** Viewport width in device-independent pixels. Defaults to 390 (a phone). */
  widthPx?: number;
}

export const DEFAULT_VIEWPORT_WIDTH_PX = 390;

export interface RequeryOptions {
  /**
   * How long the camera has been at rest, in ms. REQUIRED: §34 says debounce
   * after the camera settles, and there is no defensible default for "has it
   * settled?" — the caller owns that clock.
   */
  settledForMs: number;
  /** Override the settle window. Defaults to PERFORMANCE_TARGETS.cameraSettleMs. */
  settleMs?: number;
  /**
   * Minimum centre movement, as a fraction of the viewport's own width. 0.25
   * means "the camera moved a quarter of a screen". Expressing it as a fraction
   * rather than a distance is what makes one rule work at both city zoom and
   * street zoom.
   */
  minShiftFraction?: number;
  /** Minimum zoom change that counts on its own. */
  minZoomDelta?: number;
  /** When the last query fired, epoch ms. Enables the refresh floor. */
  lastQueryAt?: number | null;
  /** Now, epoch ms. Only needed alongside `lastQueryAt`. */
  now?: number;
  /**
   * Age past which a settled, unmoved viewport is re-queried anyway, so a map
   * left open does not sit on hour-old intelligence. Set to null to disable.
   */
  refreshAfterMs?: number | null;
}

export type RequeryReason =
  | 'initial'
  | 'camera_moving'
  | 'zoom_changed'
  | 'significant_pan'
  | 'refresh_interval'
  | 'below_threshold';

export interface RequeryDecision {
  requery: boolean;
  reason: RequeryReason;
  /** Distance the centre moved, km. */
  centerShiftKm: number;
  /** Approximate viewport width on the ground, km. */
  viewportSpanKm: number;
  /** centerShiftKm / viewportSpanKm. */
  shiftFraction: number;
  zoomDelta: number;
}

export const DEFAULT_MIN_SHIFT_FRACTION = 0.25;
export const DEFAULT_MIN_ZOOM_DELTA = 0.5;
export const DEFAULT_REFRESH_AFTER_MS = 60_000;

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km. */
export function haversineKm(a: ViewportCenter, b: ViewportCenter): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Approximate ground width of the viewport, in km, at a given zoom and
 * latitude. Standard web-mercator: 156543.03392 m/px at zoom 0 on the equator.
 */
export function viewportSpanKm(viewport: Viewport): number {
  const widthPx = viewport.widthPx ?? DEFAULT_VIEWPORT_WIDTH_PX;
  const zoom = Number.isFinite(viewport.zoom) ? viewport.zoom : 0;
  const metersPerPixel =
    (156_543.033_92 * Math.cos((viewport.center.lat * Math.PI) / 180)) / 2 ** zoom;
  return Math.max(1e-6, (Math.abs(metersPerPixel) * widthPx) / 1000);
}

/**
 * §34: "Debounce after camera settles; never re-query on every pixel movement."
 *
 * BOTH conditions are required, and that is the whole design:
 *
 *   1. the camera must have been at rest for `settleMs`, and
 *   2. the viewport must have changed by a MEANINGFUL amount — a quarter of a
 *      screen, or half a zoom level.
 *
 * A settle timer alone still fires on a one-pixel nudge that happens to end in
 * a pause; a distance threshold alone still fires mid-drag. Requiring both is
 * what turns a drag across a city into one query instead of two hundred.
 */
export function shouldRequery(
  prevViewport: Viewport | null | undefined,
  nextViewport: Viewport,
  opts: RequeryOptions,
): RequeryDecision {
  const settleMs = opts.settleMs ?? PERFORMANCE_TARGETS.cameraSettleMs;
  const minShiftFraction = opts.minShiftFraction ?? DEFAULT_MIN_SHIFT_FRACTION;
  const minZoomDelta = opts.minZoomDelta ?? DEFAULT_MIN_ZOOM_DELTA;
  const refreshAfterMs =
    opts.refreshAfterMs === undefined ? DEFAULT_REFRESH_AFTER_MS : opts.refreshAfterMs;

  const spanKm = viewportSpanKm(nextViewport);

  // Nothing has ever been queried — draw cache now, query immediately. The
  // settle gate does not apply to the first load (§34's 2-second budget).
  if (!prevViewport) {
    return {
      requery: true,
      reason: 'initial',
      centerShiftKm: 0,
      viewportSpanKm: spanKm,
      shiftFraction: 0,
      zoomDelta: 0,
    };
  }

  const centerShiftKm = haversineKm(prevViewport.center, nextViewport.center);
  const shiftFraction = centerShiftKm / spanKm;
  const zoomDelta = Math.abs((nextViewport.zoom ?? 0) - (prevViewport.zoom ?? 0));

  const base = { centerShiftKm, viewportSpanKm: spanKm, shiftFraction, zoomDelta };

  // Condition 1: the camera must be at rest. Checked FIRST so that no amount of
  // movement can trigger a query mid-gesture.
  if (!(opts.settledForMs >= settleMs)) {
    return { requery: false, reason: 'camera_moving', ...base };
  }

  // Condition 2: the change must be meaningful.
  if (zoomDelta >= minZoomDelta) {
    return { requery: true, reason: 'zoom_changed', ...base };
  }
  if (shiftFraction >= minShiftFraction) {
    return { requery: true, reason: 'significant_pan', ...base };
  }

  // Settled and effectively unmoved: only a stale-data floor may fire.
  if (
    refreshAfterMs != null &&
    opts.lastQueryAt != null &&
    opts.now != null &&
    opts.now - opts.lastQueryAt >= refreshAfterMs
  ) {
    return { requery: true, reason: 'refresh_interval', ...base };
  }

  return { requery: false, reason: 'below_threshold', ...base };
}
