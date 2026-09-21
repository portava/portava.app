/**
 * fake-clock — move the process wall clock, so a suite can be run at any hour.
 *
 * WHY THIS EXISTS. `layoverAirportIntelligence.test.ts` asserted a property that
 * holds only when two timezones land in the same traffic band, and derived its
 * fixtures from `Date.now()`. It therefore passed at ONE UTC hour in 24 and
 * failed at 23 — and it was integrated and reported green because it happened to
 * be run inside that hour. A test whose result depends on when it runs is not a
 * flaky test; it is an unmeasured one, and nothing in this repository could see
 * it.
 *
 * TWO MODES, AND THE DIFFERENCE MATTERS.
 *
 *   FAKE_NOW_MODE=freeze   (default) `Date.now()` returns FAKE_NOW_MS forever.
 *   FAKE_NOW_MODE=offset             `Date.now()` starts at FAKE_NOW_MS and then
 *                                    ADVANCES at the real rate.
 *
 * Both put the wall clock at the hour you asked for. Only `offset` lets logical
 * time pass, and that is the whole distinction:
 *
 *   `compass-home.test.ts` → "rebuilds after the cache entry expires" sets a
 *   10ms cache TTL, sleeps 30ms on a real timer, and expects the entry to be
 *   gone. The TTL is measured with `Date.now()`; the sleep is not. Under
 *   `freeze` the sleep elapses and the TTL does not, so the entry never expires
 *   and the suite fails. That failure is THIS TOOL, not the suite — the suite
 *   holds at every hour of the day, as `offset` shows.
 *
 * So: `freeze` to interrogate ONE instant (what does this code compute if the
 * clock reads 03:00Z?); `offset` to ask whether a suite depends on the hour of
 * day at all. A corpus sweep wants `offset`. Sweeping under `freeze` reports
 * every elapsed-time suite in the repository as a clock defect, which is a
 * false positive per suite, not a finding.
 *
 * USE:
 *   FAKE_NOW_MS=$(date -u -d '2026-09-15 15:00' +%s)000 \
 *     node --import scripts/fake-clock.mjs --import tsx --test <file>
 *
 *   FAKE_NOW_MS=... FAKE_NOW_MODE=offset \
 *     node --import scripts/fake-clock.mjs --import tsx --test <file...>
 *
 * Sweep a suite across the day and it either holds at all 24 hours or it does
 * not. That sweep is how the defect above was measured, and how the fix was
 * shown to hold: 126 cases across five layover suites, green at every hour
 * sampled, with the pre-fix file as the negative control failing at 23 of 24.
 *
 * WHAT IT DOES NOT DO. It moves `Date` only. Timers, `performance.now()`,
 * `process.hrtime` and anything reading the clock in native code are untouched,
 * so a suite that sleeps still sleeps in real time. It is a measurement tool for
 * clock-derived FIXTURES, not a general time machine. In `offset` mode the two
 * clocks advance together and agree on durations; in `freeze` mode they do not,
 * which is the trap documented above.
 */
// `Number("")` is 0, and 0 is a finite instant — so an unset-but-present
// FAKE_NOW_MS would silently pin the clock to 1970 and the sweep would report
// "green at 02:00Z" having measured the epoch. Blank means absent.
const raw = process.env.FAKE_NOW_MS;
const fixed = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
if (Number.isFinite(fixed)) {
  const RealDate = Date;
  const offset = process.env.FAKE_NOW_MODE === "offset";
  const origin = RealDate.now();
  const now = offset ? () => fixed + (RealDate.now() - origin) : () => fixed;
  const D = function (...args) {
    if (!(this instanceof D)) return new RealDate(now()).toString();
    return args.length === 0 ? new RealDate(now()) : new RealDate(...args);
  };
  D.prototype = RealDate.prototype;
  D.now = now;
  D.parse = RealDate.parse;
  D.UTC = RealDate.UTC;
  Object.setPrototypeOf(D, RealDate);
  globalThis.Date = D;
}
