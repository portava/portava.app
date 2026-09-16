/**
 * clock-offset-preload.mjs — run the suite as if it were another day.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * On 2026-09-15 three suites went red between 22:00 and 00:00 UTC because a
 * fixture was pinned to a constant while the assertion was judged against the
 * REAL clock. The obvious response is to grep for the dates in the fixtures.
 * That was tried, and the verification sweep of 2026-09-16 established that it
 * answers the wrong question in BOTH directions:
 *
 *   * All 163 files carrying a `2026-09-1x` literal are SAFE. Their dates are
 *     inert data, or the horizon they are judged against is injected or is
 *     another constant in the same fixture.
 *   * FOUR armed files contain no `2026-09-1x` date at all, so no grep over
 *     that pattern could ever have found them. The nearest was nineteen days
 *     from detonating.
 *
 * A date bomb is not a pattern in the source. It is a PROPERTY OF THE RUN, and
 * the only way to observe it is to move the clock and run.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 * Replaces the global `Date` with one whose notion of NOW is shifted by
 * CLOCK_OFFSET_DAYS. Everything else about Date is untouched: parsing, the
 * argument constructors, `UTC`, `parse`, and every instance method are
 * inherited, so a fixture that names an explicit instant still means exactly
 * what it says. Only "what time is it" moves — which is precisely the input a
 * date bomb depends on and a correct test does not.
 *
 * `performance.now()` is deliberately NOT shifted: it measures elapsed time,
 * not wall-clock position, and timers and rate limiters anchored to it are
 * supposed to keep working.
 *
 * ── USE ─────────────────────────────────────────────────────────────────────
 *   CLOCK_OFFSET_DAYS=400 node --import ./scripts/clock-offset-preload.mjs \
 *     --import tsx/esm --test src/test/<file>.test.ts
 *
 * `node --test` passes `--import` down to the per-file child processes, so one
 * flag covers the whole run.
 *
 * ── IT REFUSES TO BE A SILENT NO-OP ─────────────────────────────────────────
 * A harness that quietly does nothing produces a green run that means nothing,
 * which is worse than no harness. So: an unset offset is an explicit pass-through
 * that says so, a malformed one is a hard exit rather than a default of zero,
 * and a real offset announces itself on stderr with both instants, so the run's
 * own log carries the proof that the shift reached the process.
 */
const raw = process.env.CLOCK_OFFSET_DAYS;

if (raw === undefined || raw === '') {
  // Explicit and quiet: the preload is loadable unconditionally, so a caller
  // can put it in a shared flag set without forcing every run to be shifted.
  process.env.CLOCK_OFFSET_ACTIVE = '0';
} else {
  const days = Number(raw);
  if (!Number.isFinite(days)) {
    process.stderr.write(
      `clock-offset-preload: CLOCK_OFFSET_DAYS=${JSON.stringify(raw)} is not a number.\n` +
        'Refusing to run rather than defaulting to zero, which would produce a green\n' +
        'result that looks like a passed offset run and is not one.\n',
    );
    process.exit(2);
  }

  const offsetMs = days * 86_400_000;
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);

  class OffsetDate extends RealDate {
    constructor(...args) {
      // Only the NO-ARGUMENT form means "now". Every other form names an
      // instant and must be left alone, or the fixtures themselves would move
      // and the run would prove nothing.
      if (args.length === 0) super(realNow() + offsetMs);
      else super(...args);
    }
    static now() {
      return realNow() + offsetMs;
    }
  }
  Object.defineProperty(OffsetDate, 'name', { value: 'Date' });

  globalThis.Date = OffsetDate;
  process.env.CLOCK_OFFSET_ACTIVE = '1';

  if (process.env.CLOCK_OFFSET_QUIET !== '1') {
    process.stderr.write(
      `clock-offset-preload: now is ${new OffsetDate().toISOString()} ` +
        `(real ${new RealDate(realNow()).toISOString()}, offset ${days}d)\n`,
    );
  }
}
