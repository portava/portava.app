/**
 * census-layover L156 (client half) — ONE RULE, PINNED, NOT A SECOND ONE.
 *
 * §16: replanning offline is permitted "only if deterministic inputs
 * sufficient; otherwise show unavailable/stale". The SERVER owns that rule
 * (`localReplan`, artifacts/api-server/src/services/airport/LayoverDegradedService.ts)
 * and the server lane correctly refused to put it on an endpoint: the decision
 * is about whether a CACHED bundle may be replanned WHILE OFFLINE, so an
 * endpoint is unreachable exactly when it is needed, and one reachable while
 * online would be a second feasibility answer about the same layover — which
 * §L1/§L2 forbid.
 *
 * That leaves the client needing the rule with no way to call it, and exactly
 * two honest routes: one rule used by both sides, or a client implementation
 * PINNED to the server's by a SHARED FIXTURE. This is the second.
 *
 * ── WHY THE FIXTURE IS GENERATED AND NOT WRITTEN ─────────────────────────────
 * Every `expected` in `__fixtures__/layoverLocalReplan.fixture.json` was
 * PRODUCED BY EXECUTING THE SERVER'S OWN FUNCTION
 * (scripts/generate-layover-local-replan-fixture.mjs). A hand-written table
 * would pin this client to whoever wrote the table, which is the divergence a
 * shared fixture exists to prevent. Nothing in this file states an expected
 * value; it states only that the client's answer EQUALS the server's.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * Any drift at all, in either direction, because the comparison is a deep
 * equality over the WHOLE decision — `allowed`, every member of `refusals` in
 * order, the carried deadline and return state, the freshness triple and
 * `conservativeUsableMinutes`. In particular:
 *   - a client returning only the FIRST refusal fails the three-at-once case;
 *   - an off-by-one at `staleAfter` or at `hardReturnTime` fails one side of
 *     the boundary pair while passing the other;
 *   - a `conservativeUsableMinutes` that did not shrink with age, or that went
 *     negative, fails the two cases built for it;
 *   - a refusal that dropped the deadline fails every refusing case, because
 *     `lastCertifiedDeadline` is asserted on ALL of them.
 *
 * ── THE HALF THIS FILE CANNOT DO ─────────────────────────────────────────────
 * A shared fixture only pins BOTH sides while both sides assert against it.
 * `artifacts/api-server/**` is not this lane's to edit, so the server-side
 * assertion is a coordination ask in this lane's report. Until it exists, the
 * fixture pins the client to a SNAPSHOT of the server taken at
 * `generatedFrom.headCommit`, and a later server change would move without
 * turning anything red. Stated here rather than left implied.
 *
 * ── NO FIXED-DATE BOMB ───────────────────────────────────────────────────────
 * Every instant in the fixture is compared against the fixture's own `nowMs`.
 * Nothing here reads the real clock, so nothing here expires or slackens as
 * time passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localReplan, type LocalReplanInput } from '../layoverLocalReplan.ts';
import type { LayoverOfflineBundle } from '../../../services/layover.ts';

interface FixtureCase {
  name: string;
  nowMs: number;
  input: Omit<LocalReplanInput, 'nowMs'>;
  expected: unknown;
}

interface Fixture {
  generatedFrom: { headCommit: string; offlineBundleTtlMin: number };
  bundle: Pick<LayoverOfflineBundle, 'certifiedAt' | 'staleAfter' | 'returnDeadline'>;
  cases: FixtureCase[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE: Fixture = JSON.parse(
  readFileSync(resolve(HERE, '../__fixtures__/layoverLocalReplan.fixture.json'), 'utf8'),
) as Fixture;

test('the shared fixture is the one the server generated, and it is not empty', () => {
  // A fixture that silently became empty would make every case below vacuous.
  assert.ok(FIXTURE.cases.length >= 14, `expected >= 14 cases, got ${FIXTURE.cases.length}`);
  // The TTL the server derived (RETURN_SOON_LEAD_MIN / 2). Asserted so that a
  // server-side change to it cannot pass unnoticed through a regenerated file.
  assert.equal(FIXTURE.generatedFrom.offlineBundleTtlMin, 15);
});

/**
 * THE ONE FIELD THE CLIENT HAS AND THE SERVER DOES NOT, STRIPPED HERE AND
 * PINNED BELOW.
 *
 * `freshness.known` is a CLIENT addition, not rule drift. The server builds
 * every bundle itself, so its instants always parse and it has no case to
 * report; this client receives bundles over a wire and must distinguish "15
 * minutes old" from "age unestablished" — `bundleFreshness` answers
 * `known: false` there and refuses to call such a bundle fresh.
 *
 * It is stripped for the comparison so the fixture pins the RULE, and it is
 * asserted separately — both that it is true for every (parseable) fixture
 * case, and that an unparseable bundle is refused. Silently tolerating an extra
 * field would let a real divergence hide behind this one.
 */
function serverComparable(decision: ReturnType<typeof localReplan>) {
  const { known: _known, ...freshness } = decision.freshness;
  return { ...decision, freshness };
}

for (const c of FIXTURE.cases) {
  test(`localReplan matches the server: ${c.name}`, () => {
    const actual = localReplan(FIXTURE.bundle, { nowMs: c.nowMs, ...c.input });
    assert.deepEqual(serverComparable(actual), c.expected);
    // Every fixture bundle parses, so every one of them must be KNOWN. A
    // client that answered `known: false` here would be refusing replans for a
    // reason that is not true, and the stripped comparison above would not see
    // it.
    assert.equal(actual.freshness.known, true, c.name);
  });
}

test('a bundle whose instants do not parse is refused — an unestablished age is not a small one', () => {
  // The client-only case, and the reason `known` exists. The server cannot
  // produce this bundle; a wire, a cache or a partial write can.
  const corrupt = { ...FIXTURE.bundle, certifiedAt: 'not-an-instant', staleAfter: 'nor-this' };
  const first = FIXTURE.cases[0];
  const d = localReplan(corrupt, { nowMs: first.nowMs, ...first.input });

  assert.equal(d.freshness.known, false);
  assert.equal(d.allowed, false);
  assert.deepEqual(d.refusals, ['bundle_stale']);
  assert.equal(d.conservativeUsableMinutes, null);
  // And the deadline is STILL carried: the one number that must survive.
  assert.equal(d.lastCertifiedDeadline, FIXTURE.bundle.returnDeadline.hardReturnTime);
});

// ── The two properties the fixture cannot state, asserted over all of it ─────

test('a refusal NEVER drops the certified deadline — it is carried in every case', () => {
  for (const c of FIXTURE.cases) {
    const d = localReplan(FIXTURE.bundle, { nowMs: c.nowMs, ...c.input });
    assert.equal(
      d.lastCertifiedDeadline,
      FIXTURE.bundle.returnDeadline.hardReturnTime,
      `${c.name}: the deadline must survive everything else going dark`,
    );
    assert.equal(d.lastCertifiedReturnState, FIXTURE.bundle.returnDeadline.returnState);
  }
});

test('a permitted local replan can only ever be MORE cautious than the certified figure', () => {
  for (const c of FIXTURE.cases) {
    const d = localReplan(FIXTURE.bundle, { nowMs: c.nowMs, ...c.input });
    if (!d.allowed) {
      // A refused replan has no figure at all, rather than a figure to ignore.
      assert.equal(d.conservativeUsableMinutes, null, c.name);
      continue;
    }
    assert.ok(d.conservativeUsableMinutes != null, c.name);
    assert.ok(
      d.conservativeUsableMinutes <= c.input.certifiedUsableMinutes,
      `${c.name}: a local fallback must never widen the certified window`,
    );
    assert.ok(d.conservativeUsableMinutes >= 0, `${c.name}: never negative`);
  }
});
