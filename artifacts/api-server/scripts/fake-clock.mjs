/**
 * fake-clock — pin the process wall clock, so a suite can be run at any hour.
 *
 * WHY THIS EXISTS. `layoverAirportIntelligence.test.ts` asserted a property that
 * holds only when two timezones land in the same traffic band, and derived its
 * fixtures from `Date.now()`. It therefore passed at ONE UTC hour in 24 and
 * failed at 23 — and it was integrated and reported green because it happened to
 * be run inside that hour. A test whose result depends on when it runs is not a
 * flaky test; it is an unmeasured one, and nothing in this repository could see
 * it.
 *
 * USE:
 *   FAKE_NOW_MS=$(date -u -d '2026-09-15 15:00' +%s)000 \
 *     node --import scripts/fake-clock.mjs --import tsx --test <file>
 *
 * Sweep a suite across the day and it either holds at all 24 hours or it does
 * not. That sweep is how the defect above was measured, and how the fix was
 * shown to hold: 126 cases across five layover suites, green at every hour
 * sampled, with the pre-fix file as the negative control failing at 23 of 24.
 *
 * WHAT IT DOES NOT DO. It pins `Date` only. Timers, `performance.now()`,
 * `process.hrtime` and anything reading the clock in native code are untouched,
 * so a suite that sleeps still sleeps in real time. It is a measurement tool for
 * clock-derived FIXTURES, not a general time machine.
 */
// Pin the wall clock to FAKE_NOW_MS for the whole process, so a suite that
// derives fixtures from Date.now() can be run at any hour of the day.
const fixed = Number(process.env.FAKE_NOW_MS);
if (Number.isFinite(fixed)) {
  const RealDate = Date;
  const D = function (...args) {
    if (!(this instanceof D)) return new RealDate(fixed).toString();
    return args.length === 0 ? new RealDate(fixed) : new RealDate(...args);
  };
  D.prototype = RealDate.prototype;
  D.now = () => fixed;
  D.parse = RealDate.parse;
  D.UTC = RealDate.UTC;
  Object.setPrototypeOf(D, RealDate);
  globalThis.Date = D;
}
