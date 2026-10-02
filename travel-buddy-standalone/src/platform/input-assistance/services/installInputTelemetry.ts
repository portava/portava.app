/**
 * installInputTelemetry — the ONE LINE the whole of §44 has been waiting for.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MISSING
 * ══════════════════════════════════════════════════════════════════════════════
 * `inputTelemetry.ts` has declared fourteen §44 event names since Phase 1, and
 * since Phase 11 twelve of them have had real call sites in `SmartInput` and
 * `useInputAssistance`. `telemetryBatcher.ts` buffers and bounds them,
 * `telemetryTransport.ts` posts them, and `POST /api/input-assistance/telemetry`
 * rebuilds and stores them. Every piece of that chain existed except its first
 * link: nothing ever called `setTelemetrySink`, so the default `() => {}` was
 * still the sink in every build of the app.
 *
 * `docs/architecture/census-input-intelligence.md` §3 fact 5 states it as the
 * deployment reality that decides whether the §44 column means anything:
 *
 *     "The telemetry sink is a no-op and is never attached. … Every §44 event
 *      the platform emits goes nowhere."
 *
 * This module is the attachment. It is deliberately a SEAM and not an
 * auto-install: importing it starts nothing. `app/_layout.tsx` calls it once,
 * exactly as it already does for `installPassportTelemetry`, and the platform
 * library keeps the property `telemetryTransport.ts`'s header argues for — a
 * library that quietly begins posting because it was imported is the kind of
 * thing nobody can find later.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY IT IS NOT GATED ON INTELLIGENCE-CONTRIBUTION CONSENT — the review, written
 * down rather than assumed
 * ══════════════════════════════════════════════════════════════════════════════
 * Wiring a user's typing into a network path deserves an explicit answer, not a
 * shrug. `wallAnalytics` gates its REAL-WORLD-OUTCOME signals on the D4
 * Intelligence-Contribution consent (`setRealWorldOutcomeConsent`), and the
 * question is whether this stream belongs on the same gate. It does not, and the
 * reason is that a D4 contribution is an account's data offered to shared
 * intelligence, whereas nothing on this path is attributable to an account or
 * carries anything the user typed. Four independent enforcement points, each
 * tested, each able to fail:
 *
 *   1. CLIENT SCRUB — `inputTelemetry.ts` drops `text`/`query`/`rawText`/
 *      `message` for any field whose policy does not set `captureRawText`, and
 *      no registered policy sets it (`policyRegistry.ts:40`).
 *   2. NO WIRE WIDENING — `telemetryBatcher.ts` copies SIX fields by name, never
 *      a spread, so a future caller cannot hang a label on an event and have it
 *      travel.
 *   3. SERVER REBUILD — the ingest route does not store what it is sent. It
 *      rebuilds each event from a per-name prop allow-list of ints, unit floats,
 *      bools and 64-char enum tokens (`lib/inputAssistance/telemetry.ts`), and
 *      refuses an event the field's own policy does not declare.
 *   4. NO ACTOR — migration 2950 stores no `user_id`/`viewer_id`/`actor_id` and
 *      RAISEs at apply time if such a column is ever added. The only correlator
 *      is the per-app-run `sessionId` minted below, which is not derived from
 *      and not resolvable to an account.
 *
 * A stream that carries counts, lengths and type tokens under a per-run token is
 * the same class of first-party product telemetry as `installPassportTelemetry`,
 * which this app attaches unconditionally. That is also exactly where
 * `wallAnalytics` draws its own line: D4 gates `trackRealWorldOutcome` and
 * NOTHING ELSE in that module, because a real-world outcome is a claim that a
 * person physically did something. No §44 event is such a claim. Gating this
 * stream on D4 would widen what D4 means rather than honour it.
 *
 * ONE FUTURE EVENT DOES BELONG BEHIND THAT GATE, and it is worth naming before
 * someone writes it: `downstream_task_completed` (§45/§57, census G320/G370) has
 * an exported emitter and no caller. On the day a feature screen calls it, it
 * will be asserting that a real task really completed — the same class of claim
 * D4 governs — and it should be routed through `hasValidConsent` the way the
 * Wall routes its outcome arm. The gate belongs HERE, as one predicate around
 * `setTelemetrySink` or a per-name filter in front of it, which is the reason
 * this seam is its own module rather than three lines inside `_layout.tsx`.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS STILL DOES NOT MAKE TRUE
 * ══════════════════════════════════════════════════════════════════════════════
 * Migration 2950 is unapplied to production AND to portava-ci
 * (`checkProductionDrift.ts:615` classifies the table `unapplied`). Until it is
 * applied the ingest answers 503 `retryable`, the batcher drops the batch and
 * COUNTS the drop. So on today's deployments these events are produced,
 * transported, refused and counted — which is a different and better state than
 * produced and silently discarded, but it is still not a measurement. Anything
 * claiming a §57 number from production has to wait on the migration.
 *
 * Pure module — no React, no fetch, no timers of its own. Everything impure is
 * injected, which is what lets `__tests__/installInputTelemetry.test.ts` drive
 * the whole install/flush/dispose lifecycle under node:test.
 */
import { setTelemetrySink, resetTelemetrySink } from './inputTelemetry.ts';
import type { TelemetryBatcher } from './telemetryBatcher.ts';

/** The subset of React Native's `AppState` this module needs (injectable). */
export interface AppStateLike {
  addEventListener: (
    type: 'change',
    handler: (state: string) => void,
  ) => { remove: () => void };
}

export interface InstallInputTelemetryOptions {
  /**
   * Builds the transport. A FACTORY rather than an instance, so a second
   * (idempotent) install does not construct a batcher it then throws away —
   * `installInputTelemetryTransport()` mints a session id, and minting two per
   * app run would split one user's funnel across two correlators.
   */
  createBatcher: () => TelemetryBatcher;
  /** React Native `AppState`, or a test double. Optional — web has no lifecycle here. */
  appState?: AppStateLike | null;
}

export interface InputTelemetryHandle {
  batcher: TelemetryBatcher;
  /** Flush what is buffered, unsubscribe AppState and restore the no-op sink. */
  dispose: () => void;
}

let current: InputTelemetryHandle | null = null;

/**
 * Attach the §44 sink. Idempotent: a second call while one is live returns the
 * live handle rather than replacing the sink, so a re-mounting root layout
 * cannot orphan a buffer full of events or double-subscribe to AppState.
 */
export function installInputTelemetry(opts: InstallInputTelemetryOptions): InputTelemetryHandle {
  if (current) return current;

  const batcher = opts.createBatcher();
  setTelemetrySink(batcher.sink);

  // THE BUFFER IS IN MEMORY AND THE FLUSH IS ON A 5s IDLE TIMER, so a user who
  // types, taps a suggestion and immediately backgrounds the app would lose the
  // selection — which is the single most load-bearing event in §57's funnel.
  // Backgrounding is the flush trigger for exactly that reason.
  let sub: { remove: () => void } | null = null;
  try {
    sub =
      opts.appState?.addEventListener('change', (state) => {
        if (state !== 'active') void batcher.flush();
      }) ?? null;
  } catch {
    // A missing or broken AppState must not stop telemetry from being attached.
    sub = null;
  }

  const handle: InputTelemetryHandle = {
    batcher,
    dispose: () => {
      // Only the LIVE handle may tear down. A stale handle calling dispose after
      // a re-install would otherwise reset a sink it does not own.
      if (current !== handle) return;
      current = null;
      try {
        sub?.remove();
      } catch {
        /* never throw out of teardown */
      }
      // Last chance to send what is buffered, then stop accepting.
      void batcher.flush();
      resetTelemetrySink();
    },
  };
  current = handle;
  return handle;
}

/** The live handle, or null when nothing is installed (tests / diagnostics). */
export function currentInputTelemetry(): InputTelemetryHandle | null {
  return current;
}
