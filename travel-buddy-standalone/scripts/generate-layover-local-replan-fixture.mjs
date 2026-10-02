/**
 * Generate the SHARED §16 L156 local-replan fixture.
 *
 * ── WHY A GENERATOR AND NOT A HAND-WRITTEN TABLE ─────────────────────────────
 * §16 permits an offline client to replan "only if deterministic inputs
 * sufficient; otherwise show unavailable/stale". The server owns that rule
 * (`localReplan`, artifacts/api-server/src/services/airport/LayoverDegradedService.ts)
 * and correctly refuses to publish it on an endpoint: the decision is about
 * whether a CACHED bundle may be replanned while OFFLINE, so an endpoint is
 * unreachable exactly when it is needed, and a second feasibility answer
 * reachable while online is what §L1/§L2 forbid.
 *
 * That leaves the client needing the same rule with no way to call it. The
 * honest route is the one taken here: the client implements it, and the
 * implementation is PINNED to the server's by a fixture whose expectations are
 * PRODUCED BY THE SERVER'S OWN FUNCTION rather than transcribed by hand. A
 * hand-written table would pin the client to whoever wrote the table — which is
 * the divergence it is supposed to prevent.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * It does not run in CI and it is not a test. It writes
 * `src/components/layover/__fixtures__/layoverLocalReplan.fixture.json`, which
 * IS committed; the suites read that file. Regenerating it is how a deliberate
 * change to the server's rule is brought across, and a regenerated file that
 * turns the client suite red is the fixture doing its job.
 *
 * ── THE SERVER SIDE OF THE PIN IS NOT YET IN PLACE ───────────────────────────
 * This fixture only pins the client while the SERVER also asserts against it.
 * `artifacts/api-server/**` belongs to the server lanes; the coordination ask is
 * in this lane's report. Until that assertion exists, the fixture records what
 * the server's function returned AT `generatedFrom.headCommit` — which is a
 * real pin against drift on this side, and an unpinned snapshot on the other.
 *
 * USAGE (from travel-buddy-standalone/):
 *   node --import tsx scripts/generate-layover-local-replan-fixture.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(CLIENT_ROOT, '..');
const SERVER_MODULE = resolve(
  REPO_ROOT,
  'artifacts/api-server/src/services/airport/LayoverDegradedService.js',
);
const OUT = resolve(CLIENT_ROOT, 'src/components/layover/__fixtures__/layoverLocalReplan.fixture.json');

const { localReplan, OFFLINE_BUNDLE_TTL_MIN } = await import(SERVER_MODULE);

const CERTIFIED_AT = '2026-09-08T10:00:00.000Z';
const CERTIFIED_MS = Date.parse(CERTIFIED_AT);
const STALE_AFTER = new Date(CERTIFIED_MS + OFFLINE_BUNDLE_TTL_MIN * 60_000).toISOString();
const HARD_RETURN = '2026-09-08T13:40:00.000Z';
const HARD_RETURN_MS = Date.parse(HARD_RETURN);
const DEPARTURE = '2026-09-08T16:00:00.000Z';
const BOARDING = '2026-09-08T15:20:00.000Z';

/** Only the fields `localReplan` reads. Shared verbatim with the client suite. */
const BUNDLE = {
  certifiedAt: CERTIFIED_AT,
  staleAfter: STALE_AFTER,
  returnDeadline: {
    hardReturnTime: HARD_RETURN,
    hardReturnLocal: '20:40',
    returnState: 'RETURN_SOON',
    bufferMinutes: 95,
    returnReminderAt: null,
  },
};

const base = {
  certifiedUsableMinutes: 120,
  currentDepartureTime: DEPARTURE,
  currentBoardingTime: BOARDING,
  certifiedDepartureTime: DEPARTURE,
  certifiedBoardingTime: BOARDING,
};

/**
 * The cases, and each one is a property rather than a sample.
 *
 * The three refusals are covered alone AND together, because `refusals` is a
 * LIST and a client that returned only the first one it found would pass every
 * single-refusal case. The two boundaries are covered from both sides, because
 * an off-by-one in either direction is the failure this rule actually has: at
 * exactly `staleAfter` the bundle IS stale, and at exactly `hardReturnTime` the
 * deadline HAS passed.
 */
const CASES = [
  {
    name: 'fresh bundle, unchanged schedule, before the deadline — allowed',
    nowMs: CERTIFIED_MS + 5 * 60_000,
    input: { ...base },
  },
  {
    name: 'conservative minutes shrink with the bundle’s age, never grow',
    nowMs: CERTIFIED_MS + 12 * 60_000,
    input: { ...base },
  },
  {
    name: 'a device clock behind the server does not buy extra minutes',
    nowMs: CERTIFIED_MS - 30 * 60_000,
    input: { ...base },
  },
  {
    name: 'one tick before staleAfter the bundle is still fresh',
    nowMs: Date.parse(STALE_AFTER) - 1,
    input: { ...base },
  },
  {
    name: 'at exactly staleAfter the bundle is stale — refused',
    nowMs: Date.parse(STALE_AFTER),
    input: { ...base },
  },
  {
    name: 'past staleAfter — refused, and the deadline is still carried',
    nowMs: CERTIFIED_MS + 40 * 60_000,
    input: { ...base },
  },
  {
    name: 'departure moved since certification — refused',
    nowMs: CERTIFIED_MS + 5 * 60_000,
    input: { ...base, currentDepartureTime: '2026-09-08T16:35:00.000Z' },
  },
  {
    name: 'boarding moved since certification — refused',
    nowMs: CERTIFIED_MS + 5 * 60_000,
    input: { ...base, currentBoardingTime: '2026-09-08T15:05:00.000Z' },
  },
  {
    name: 'boarding that was known and is now absent — refused',
    nowMs: CERTIFIED_MS + 5 * 60_000,
    input: { ...base, currentBoardingTime: null },
  },
  {
    name: 'boarding absent on BOTH sides is not a change — allowed',
    nowMs: CERTIFIED_MS + 5 * 60_000,
    input: { ...base, currentBoardingTime: null, certifiedBoardingTime: null },
  },
  {
    name: 'one tick before the hard return time — stale, but NOT yet past the deadline',
    nowMs: HARD_RETURN_MS - 1,
    input: { ...base, certifiedUsableMinutes: 600 },
  },
  {
    name: 'at exactly the hard return time — already_past_hard_return joins bundle_stale',
    nowMs: HARD_RETURN_MS,
    input: { ...base, certifiedUsableMinutes: 600 },
  },
  {
    name: 'all three refusals at once — every one is named, not just the first',
    nowMs: HARD_RETURN_MS + 60_000,
    input: { ...base, currentDepartureTime: '2026-09-08T16:35:00.000Z' },
  },
  {
    name: 'age exceeds the certified window — conservative minutes floor at 0, never negative',
    nowMs: CERTIFIED_MS + 10 * 60_000,
    input: { ...base, certifiedUsableMinutes: 4 },
  },
];

let headCommit = 'unknown';
try {
  headCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
    .toString()
    .trim();
} catch { /* a tree without git still produces a usable fixture */ }

const fixture = {
  $comment:
    'GENERATED — do not hand-edit. Produced by ' +
    'travel-buddy-standalone/scripts/generate-layover-local-replan-fixture.mjs by ' +
    'EXECUTING the server\'s own localReplan (LayoverDegradedService.ts). It is the ' +
    'shared pin between that function and the client mirror in ' +
    'src/components/layover/layoverLocalReplan.ts. Both sides must assert against it; ' +
    'see this lane\'s report for the server-side ask.',
  generatedFrom: {
    module: 'artifacts/api-server/src/services/airport/LayoverDegradedService.ts',
    export: 'localReplan',
    headCommit,
    offlineBundleTtlMin: OFFLINE_BUNDLE_TTL_MIN,
  },
  bundle: BUNDLE,
  cases: CASES.map((c) => ({
    name: c.name,
    nowMs: c.nowMs,
    input: c.input,
    expected: localReplan(BUNDLE, { nowMs: c.nowMs, ...c.input }),
  })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${OUT} — ${fixture.cases.length} cases from ${headCommit.slice(0, 9)}`);
