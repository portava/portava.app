/**
 * Every self-rescheduling scheduler: a stop() and start() while a pass is still
 * in flight leaves exactly ONE loop — and a stop() alone leaves none.
 *
 * THE LEAK (found by lane H on memoryDeletionRedriveScheduler, PR #645). Each
 * scheduler is a `setTimeout` whose tick runs a pass and, in `.finally`, arms the
 * next timer. #627 made that re-arm conditional on `_timer !== null`, which a
 * stop() makes false — enough for a stop alone. But stop() then start() while
 * the pass is still running sets `_timer` to the NEW loop's handle, so the old
 * pass's `.finally` sees a non-null timer and re-arms the OLD loop beside it:
 * two loops, and `_timer` now points at the old one, so the next stop() can
 * clear only one of them. Four schedulers under server/ did not have even the
 * #627 guard. The fix, in every one: a generation counter that start() takes
 * and stop() bumps; a pass re-arms only if its own generation is still current.
 *
 * HOW THIS PROVES IT FOR ALL OF THEM, WITHOUT KNOWING ANY OF THEIR PASSES.
 *   - The scheduler's own timers are intercepted: a `setTimeout` whose callback
 *     is the scheduler's `tick` is recorded instead of armed (every other timer
 *     — the logger's transport poll included — passes through to the real one).
 *     The test fires a recorded tick by hand.
 *   - The service client is a universal stand-in whose every query and rpc
 *     stays pending until the test releases it, then answers an error, so every
 *     pass blocks mid-flight and then ends quickly on its own fail-closed path.
 *   - Two in-flight windows. The universal one: every pass is async, so its
 *     `.finally` cannot run in the same turn as the tick — a stop()/start() made
 *     synchronously after firing the tick is always mid-pass. The realistic one:
 *     the pass has reached the database and is waiting on it (every scheduler
 *     but one, whose pass refuses before it reads anything — `heldByClient`).
 *   - For each scheduler: (premise) the pass is in flight and, released,
 *     re-arms exactly once; (stop) stop() mid-pass leaves no live tick;
 *     (restart, both windows) stop() + start() mid-pass leaves exactly one live
 *     tick, and a final stop() leaves none.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/schedulerRestartDuringPass.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { _setTestServiceClient } from "../lib/supabase.js";

type Pair = {
  file: string;
  load: () => Promise<{ start: () => void; stop: () => void }>;
  /** False only where the pass refuses before it reads anything (so no client can hold it); see the header. */
  heldByClient?: false;
};
const m = <T extends Record<string, unknown>>(p: Promise<T>, start: keyof T, stop: keyof T) =>
  p.then((x) => ({ start: () => (x[start] as () => void)(), stop: () => (x[stop] as () => void)() }));

/** Every self-rescheduling setTimeout scheduler on this tree (setInterval ones cannot re-arm). */
const SCHEDULERS: Pair[] = [
  { file: "lib/intelCoverageScheduler.ts", load: () => m(import("../lib/intelCoverageScheduler.js"), "startIntelCoverageScheduler", "stopIntelCoverageScheduler") },
  { file: "lib/intelProjectionScheduler.ts", load: () => m(import("../lib/intelProjectionScheduler.js"), "startIntelProjectionScheduler", "stopIntelProjectionScheduler") },
  { file: "lib/intelRetentionScheduler.ts", load: () => m(import("../lib/intelRetentionScheduler.js"), "startIntelRetentionScheduler", "stopIntelRetentionScheduler") },
  { file: "lib/eventLifecycle.ts", load: () => m(import("../lib/eventLifecycle.js"), "startEventLifecycleScheduler", "stopEventLifecycleScheduler") },
  { file: "lib/intelRewardScheduler.ts", load: () => m(import("../lib/intelRewardScheduler.js"), "startIntelRewardScheduler", "stopIntelRewardScheduler") },
  { file: "lib/intelPromotionScheduler.ts", load: () => m(import("../lib/intelPromotionScheduler.js"), "startIntelPromotionScheduler", "stopIntelPromotionScheduler") },
  { file: "lib/intelAttributionScheduler.ts", load: () => m(import("../lib/intelAttributionScheduler.js"), "startIntelAttributionScheduler", "stopIntelAttributionScheduler") },
  { file: "lib/intelPatternScheduler.ts", load: () => m(import("../lib/intelPatternScheduler.js"), "startIntelPatternScheduler", "stopIntelPatternScheduler") },
  { file: "lib/memoryProjectionScheduler.ts", load: () => m(import("../lib/memoryProjectionScheduler.js"), "startMemoryProjectionScheduler", "stopMemoryProjectionScheduler") },
  { file: "lib/intelCalibrationScheduler.ts", load: () => m(import("../lib/intelCalibrationScheduler.js"), "startIntelCalibrationScheduler", "stopIntelCalibrationScheduler") },
  { file: "lib/rankingFatigueSweeper.ts", load: () => m(import("../lib/rankingFatigueSweeper.js"), "startRankingFatigueSweeper", "stopRankingFatigueSweeper") },
  { file: "lib/sensingRetentionScheduler.ts", load: () => m(import("../lib/sensingRetentionScheduler.js"), "startSensingRetentionScheduler", "stopSensingRetentionScheduler") },
  { file: "lib/locationSnapshotPurgeScheduler.ts", load: () => m(import("../lib/locationSnapshotPurgeScheduler.js"), "startLocationSnapshotPurgeScheduler", "stopLocationSnapshotPurgeScheduler") },
  { file: "lib/rentBuddyRequestSweeper.ts", load: () => m(import("../lib/rentBuddyRequestSweeper.js"), "startBuddyRequestSweeper", "stopBuddyRequestSweeper") },
  // Its pass refuses on the contribution policy before any client exists (an owner consent act; ungranted).
  { file: "lib/sensingPublicationScheduler.ts", load: () => m(import("../lib/sensingPublicationScheduler.js"), "startSensingPublicationScheduler", "stopSensingPublicationScheduler"), heldByClient: false },
  { file: "lib/layoverCrewExpiryScheduler.ts", load: () => m(import("../lib/layoverCrewExpiryScheduler.js"), "startLayoverCrewExpiryScheduler", "stopLayoverCrewExpiryScheduler") },
  { file: "lib/notificationMaintenanceScheduler.ts", load: () => m(import("../lib/notificationMaintenanceScheduler.js"), "startNotificationMaintenanceScheduler", "stopNotificationMaintenanceScheduler") },
  { file: "lib/eventWaitlistSweeper.ts", load: () => m(import("../lib/eventWaitlistSweeper.js"), "startEventWaitlistSweeper", "stopEventWaitlistSweeper") },
  { file: "lib/layoverExternalEventScheduler.ts", load: () => m(import("../lib/layoverExternalEventScheduler.js"), "startLayoverExternalEventScheduler", "stopLayoverExternalEventScheduler") },
  { file: "lib/callSweepScheduler.ts", load: () => m(import("../lib/callSweepScheduler.js"), "startCallSweepScheduler", "stopCallSweepScheduler") },
  { file: "lib/trustMaintenanceScheduler.ts", load: () => m(import("../lib/trustMaintenanceScheduler.js"), "startTrustMaintenanceScheduler", "stopTrustMaintenanceScheduler") },
  { file: "server/telegraph/lifecycleScheduler.ts", load: () => m(import("../server/telegraph/lifecycleScheduler.js"), "startTelegraphLifecycleScheduler", "stopTelegraphLifecycleScheduler") },
  { file: "server/trips/projectionWorkers/tripCrewLiveShareScheduler.ts", load: () => m(import("../server/trips/projectionWorkers/tripCrewLiveShareScheduler.js"), "startTripCrewLiveShareScheduler", "stopTripCrewLiveShareScheduler") },
  { file: "server/trips/projectionWorkers/tripRetentionScheduler.ts", load: () => m(import("../server/trips/projectionWorkers/tripRetentionScheduler.js"), "startTripRetentionScheduler", "stopTripRetentionScheduler") },
  { file: "server/trips/outboxWorker.ts", load: () => m(import("../server/trips/outboxWorker.js"), "startTripOutboxWorker", "stopTripOutboxWorker") },
  // Already generation-guarded before this file; held to the same rule.
  { file: "lib/media/mediaProcessingWorker.ts", load: () => m(import("../lib/media/mediaProcessingWorker.js"), "startMediaProcessingWorker", "stopMediaProcessingWorker") },
  { file: "lib/media/pendingUploadSweepScheduler.ts", load: () => m(import("../lib/media/pendingUploadSweepScheduler.js"), "startPendingUploadSweepScheduler", "stopPendingUploadSweepScheduler") },
  { file: "services/memoryProjections/outboxDrainRunner.ts", load: () => m(import("../services/memoryProjections/outboxDrainRunner.js"), "startMemoryOutboxScheduler", "stopMemoryOutboxScheduler") },
];

// ── The scheduler's own timers, recorded instead of armed ────────────────────

interface Recorded { id: number; fn: () => void; ms: number }
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let live = new Map<number, Recorded>();
let nextId = 1;

function interceptTicks(): void {
  live = new Map();
  (globalThis as any).setTimeout = function (fn: unknown, ms?: number, ...rest: unknown[]) {
    if (typeof fn === "function" && fn.name === "tick") {
      const rec: Recorded = { id: nextId++, fn: fn as () => void, ms: Number(ms ?? 0) };
      live.set(rec.id, rec);
      return { __tick: rec.id, unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
    }
    return (realSetTimeout as any)(fn, ms, ...rest);
  };
  (globalThis as any).clearTimeout = function (h: any) {
    if (h && typeof h === "object" && "__tick" in h) { live.delete(h.__tick); return; }
    return (realClearTimeout as any)(h);
  };
}
function restoreTimers(): void {
  (globalThis as any).setTimeout = realSetTimeout;
  (globalThis as any).clearTimeout = realClearTimeout;
}
/** Fire the one live tick (removing it, as a fired timer is gone). */
function fireTick(): void {
  const [only] = [...live.values()];
  assert.ok(only, "no live tick to fire");
  assert.equal(live.size, 1, `expected one live tick before firing, found ${live.size}`);
  live.delete(only.id);
  only.fn();
}

// ── A client every query of which waits until released ───────────────────────

function blockingClient() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reached = 0;
  const answer = { data: null, error: { message: "released by the test", code: "XX000" }, count: null };
  const node = (): any => new Proxy(function () { /* callable */ }, {
    get(_t, prop) {
      if (prop === "then") return (ok: any, bad: any) => { reached++; return gate.then(() => answer).then(ok, bad); };
      if (prop === "catch" || prop === "finally") return undefined;
      return () => node();
    },
    apply() { return node(); },
  });
  return { client: node(), release, reached: () => reached };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

let current: { stop: () => void } | null = null;
afterEach(() => {
  try { current?.stop(); } catch { /* best effort */ }
  current = null;
  restoreTimers();
  _setTestServiceClient(null as any);
});

describe("every self-rescheduling scheduler: one loop after stop()/start() mid-pass, none after stop()", () => {
  for (const s of SCHEDULERS) {
    describe(s.file, () => {
      it("premise: the pass is in flight after its tick fires, and once released it re-arms its own loop exactly once", async () => {
        const sch = await s.load(); current = sch;
        const c = blockingClient(); _setTestServiceClient(c.client);
        interceptTicks();
        sch.start();
        fireTick();
        assert.equal(live.size, 0, "the tick re-armed in the same turn — the pass was not in flight");
        await drain();
        if (s.heldByClient === false) {
          assert.equal(c.reached(), 0, "this pass now reads the database — drop heldByClient:false so the realistic window is tested");
        } else {
          assert.ok(c.reached() > 0, "the pass never reached the client — mark heldByClient:false only if it refuses before any read");
          assert.equal(live.size, 0, "the pass finished before it was released — it was not held in flight");
        }
        c.release();
        await drain();
        assert.equal(live.size, 1, "a released pass must re-arm its loop exactly once");
      });

      it("stop() while the pass is in flight: nothing re-arms", async () => {
        const sch = await s.load(); current = sch;
        const c = blockingClient(); _setTestServiceClient(c.client);
        interceptTicks();
        sch.start();
        fireTick();
        sch.stop();
        c.release();
        await drain();
        assert.equal(live.size, 0, "a stopped scheduler re-armed when its in-flight pass settled");
      });

      it("stop() + start() in the same turn as the tick: exactly ONE loop, and a final stop() leaves none", async () => {
        const sch = await s.load(); current = sch;
        const c = blockingClient(); _setTestServiceClient(c.client);
        interceptTicks();
        sch.start();
        fireTick();
        sch.stop();
        sch.start();
        assert.equal(live.size, 1, "start() after stop() arms the new loop");
        c.release();
        await drain();
        assert.equal(live.size, 1, "the old pass re-armed its loop beside the new one: two loops");
        sch.stop();
        assert.equal(live.size, 0, "stop() could not clear every loop — one was orphaned");
      });

      if (s.heldByClient !== false) {
        it("stop() + start() while the pass waits on the database: exactly ONE loop, and a final stop() leaves none", async () => {
          const sch = await s.load(); current = sch;
          const c = blockingClient(); _setTestServiceClient(c.client);
          interceptTicks();
          sch.start();
          fireTick();
          await drain();
          assert.ok(c.reached() > 0);
          sch.stop();
          sch.start();
          assert.equal(live.size, 1, "start() after stop() arms the new loop");
          c.release();
          await drain();
          assert.equal(live.size, 1, "the old pass re-armed its loop beside the new one: two loops");
          sch.stop();
          assert.equal(live.size, 0, "stop() could not clear every loop — one was orphaned");
        });
      }
    });
  }
});
