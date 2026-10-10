/**
 * Wait until the logger's pino transport worker is READY — call it in a
 * `before()` of any test file that enables `mock.timers` for `setTimeout`.
 *
 * ── THE HANG THIS PREVENTS (root-caused 2026-10-06, lane L) ─────────────────
 * Outside production, lib/logger.ts logs through `pino-pretty` as a pino
 * TRANSPORT: a worker thread fed by `thread-stream`. Until the worker reports
 * READY, the stream is REF'd (it keeps the process alive), and pino unrefs it
 * only on the `ready` event. thread-stream emits `ready` from
 * `stream.flush(cb)`, and when the worker has not yet consumed everything
 * written so far, `flush` polls with the GLOBAL `setTimeout`
 * (thread-stream/lib/wait.js). If a test has enabled `mock.timers` for
 * `setTimeout` at that moment, the poll is a MOCKED timer: nothing ever ticks
 * it, `mock.timers.reset()` discards it, `ready` never fires, the worker is
 * never unref'd — and the test file's process stays alive for ever at 0% CPU
 * after every assertion has passed.
 *
 * It needs the worker to boot slowly (loading pino-pretty) while a test is
 * already logging with timers mocked, which is why it showed up only under
 * load: notificationMaintenanceSchedulerTiming.test.ts hung full-suite runs for
 * 24 and 35 minutes and passed alone in 0.2 s. Reproduced deterministically by
 * enabling the mock before the worker was ready and logging: `ready` stays
 * false and the process never exits.
 *
 * Waiting for READY first removes the window: after it, `flush` is reached only
 * when the 4 MiB ring buffer is full, which a unit-test file does not do. The
 * wait uses the REAL `setTimeout`, captured before any test can mock it, and
 * fails loudly after `capMs` rather than hanging.
 */
import { once } from "node:events";
import pino from "pino";
import { logger } from "../../lib/logger.js";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface MaybeThreadStream {
  ready?: unknown;
  destroyed?: unknown;
  once?: (event: string, fn: (...args: unknown[]) => void) => unknown;
}

/** The logger's destination; a transport is a ThreadStream with a `ready` getter. */
export function loggerDestination(): MaybeThreadStream | null {
  const sym = (pino as unknown as { symbols: { streamSym: symbol } }).symbols.streamSym;
  const dest = (logger as unknown as Record<symbol, unknown>)[sym];
  return dest && typeof dest === "object" ? (dest as MaybeThreadStream) : null;
}

/** Resolves once the transport is ready (immediately if the logger has no transport). */
export async function awaitLoggerTransportReady(capMs = 60_000): Promise<void> {
  const dest = loggerDestination();
  if (!dest || dest.ready === undefined || dest.ready === true || dest.destroyed === true) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(dest as unknown as NodeJS.EventEmitter, "ready"),
      new Promise((_, reject) => {
        timer = realSetTimeout(
          () => reject(new Error(`the logger's pino transport did not become ready within ${capMs} ms`)),
          capMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) realClearTimeout(timer);
  }
}
