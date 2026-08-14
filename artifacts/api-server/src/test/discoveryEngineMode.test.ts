/**
 * DISCOVERY_ENGINE_MODE resolution
 *
 * Stage 1's exit criterion is that the dispatch is a genuine no-op: every state
 * the flag can be in resolves to `legacy`, which is current production
 * behaviour. These tests are that criterion, written so it can be re-checked
 * rather than asserted once.
 *
 * The rulings under test:
 *   D1=B  read through lib/featureFlags.ts (exact match, reads metadata) and
 *         NOT through compass/flags.ts, whose LIKE 'COMPASS_%' loader would
 *         return false for this flag with no error and no log line
 *   D2=A  one row; enabled is the master switch, metadata.mode selects the path
 *   D3=B  every failure state -> legacy, AND pde additionally requires that
 *         disable_discovery_pde is not engaged
 *
 * Tests:
 *  A. No row                      -> legacy / flag_absent
 *  B. enabled = false             -> legacy / flag_disabled     (even with mode: pde)
 *  C. metadata absent or no mode  -> legacy / mode_missing
 *  D. metadata.mode invalid       -> legacy / mode_invalid
 *  E. mode = legacy               -> legacy / resolved
 *  F. mode = shadow               -> shadow / resolved
 *  G. mode = pde, no stop         -> pde    / resolved
 *  H. mode = pde, stop engaged    -> legacy / kill_switch_engaged
 *  I. mode = pde, stop UNREADABLE -> legacy / kill_switch_engaged  (inverted polarity)
 *  J. mode = shadow, stop errors  -> shadow / resolved  (stop is read ONLY for pde)
 *  K. null client                 -> legacy / no_client
 *  L. a throwing client           -> legacy, never propagates
 *  M. the resolution is cached inside the TTL
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryEngineMode.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDiscoveryEngineMode,
  invalidateDiscoveryEngineModeCache,
  DISCOVERY_ENGINE_MODE_FLAG,
  DISCOVERY_PDE_KILL_SWITCH,
} from "../lib/discoveryEngineMode.js";

/**
 * Stub answering the two feature_flags reads the resolver makes: getFlagRow for
 * the mode, isKillSwitchEngaged for the stop. Both go through
 * .from().select().eq().maybeSingle(), so the stub dispatches on the flag name.
 */
function makeClient(opts: {
  modeRow?:   { enabled: boolean; metadata: unknown } | null;
  modeError?: unknown;
  stopRow?:   { enabled: boolean } | null;
  stopError?: unknown;
  throws?:    boolean;
}) {
  let stopReads = 0;
  const client = {
    from(_table: string) {
      const q: any = {
        _flag: "",
        select() { return q; },
        eq(_col: string, val: string) { q._flag = val; return q; },
        maybeSingle() {
          if (opts.throws) throw new Error("client exploded");
          if (q._flag === DISCOVERY_PDE_KILL_SWITCH) {
            stopReads += 1;
            return Promise.resolve({ data: opts.stopRow ?? null, error: opts.stopError ?? null });
          }
          return Promise.resolve({ data: opts.modeRow ?? null, error: opts.modeError ?? null });
        },
      };
      return q;
    },
  };
  return { client, stopReads: () => stopReads };
}

const meta = (mode: unknown) => ({ enabled: true, metadata: { mode } });

describe("DISCOVERY_ENGINE_MODE — every failure state resolves to legacy", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("A. a missing row resolves to legacy", async () => {
    const { client } = makeClient({ modeRow: null });
    assert.deepEqual(await resolveDiscoveryEngineMode(client), {
      mode: "legacy", reason: "flag_absent",
    });
  });

  it("B. enabled=false resolves to legacy even when metadata says pde", async () => {
    const { client } = makeClient({ modeRow: { enabled: false, metadata: { mode: "pde" } } });
    assert.deepEqual(await resolveDiscoveryEngineMode(client), {
      mode: "legacy", reason: "flag_disabled",
    });
  });

  it("C. an enabled row with no mode resolves to legacy", async () => {
    for (const metadata of [null, {}, { other: "x" }]) {
      invalidateDiscoveryEngineModeCache();
      const { client } = makeClient({ modeRow: { enabled: true, metadata } });
      const r = await resolveDiscoveryEngineMode(client);
      assert.deepEqual(r, { mode: "legacy", reason: "mode_missing" });
    }
  });

  it("D. an unrecognised mode resolves to legacy", async () => {
    for (const bad of ["PDE", "shadow ", "new", "", 3, true, null]) {
      invalidateDiscoveryEngineModeCache();
      const { client } = makeClient({ modeRow: meta(bad) });
      const r = await resolveDiscoveryEngineMode(client);
      assert.equal(r.mode, "legacy", `${JSON.stringify(bad)} must not resolve to a live mode`);
    }
  });

  it("K. a null client resolves to legacy", async () => {
    assert.deepEqual(await resolveDiscoveryEngineMode(null), {
      mode: "legacy", reason: "no_client",
    });
  });

  it("L. a throwing client resolves to legacy and never propagates", async () => {
    const { client } = makeClient({ throws: true });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "legacy");
  });
});

describe("DISCOVERY_ENGINE_MODE — configured modes", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("E/F. legacy and shadow resolve as configured", async () => {
    for (const mode of ["legacy", "shadow"] as const) {
      invalidateDiscoveryEngineModeCache();
      const { client } = makeClient({ modeRow: meta(mode) });
      assert.deepEqual(await resolveDiscoveryEngineMode(client), { mode, reason: "resolved" });
    }
  });

  it("G. pde resolves when no stop is configured", async () => {
    // A MISSING stop row means "no stop has been configured" and is NOT
    // engaged — isKillSwitchEngaged inverts the FAILURE, not the flag.
    const { client } = makeClient({ modeRow: meta("pde"), stopRow: null });
    assert.deepEqual(await resolveDiscoveryEngineMode(client), {
      mode: "pde", reason: "resolved",
    });
  });
});

describe("DISCOVERY_ENGINE_MODE — the PDE stop (D3=B)", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("H. an engaged stop forces legacy", async () => {
    const { client } = makeClient({ modeRow: meta("pde"), stopRow: { enabled: true } });
    assert.deepEqual(await resolveDiscoveryEngineMode(client), {
      mode: "legacy", reason: "kill_switch_engaged",
    });
  });

  it("I. an UNREADABLE stop forces legacy — the whole point of the polarity", async () => {
    // This is the case a plain capability flag gets wrong: false-on-error would
    // disengage the stop exactly when the database is unhealthy, which is when
    // it is most likely to be needed.
    const { client } = makeClient({ modeRow: meta("pde"), stopError: { message: "db down" } });
    assert.deepEqual(await resolveDiscoveryEngineMode(client), {
      mode: "legacy", reason: "kill_switch_engaged",
    });
  });

  it("J. the stop is read ONLY for pde", async () => {
    for (const mode of ["legacy", "shadow"] as const) {
      invalidateDiscoveryEngineModeCache();
      const { client, stopReads } = makeClient({
        modeRow: meta(mode), stopError: { message: "db down" },
      });
      const r = await resolveDiscoveryEngineMode(client);
      assert.deepEqual(r, { mode, reason: "resolved" },
        "a stop error must not drag a non-pde mode to legacy");
      assert.equal(stopReads(), 0, `${mode} must not read the stop at all`);
    }
  });
});

describe("DISCOVERY_ENGINE_MODE — caching (mechanic M5)", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("M. resolves once inside the TTL", async () => {
    let reads = 0;
    const client = {
      from() {
        const q: any = {
          select() { return q; },
          eq() { return q; },
          maybeSingle() {
            reads += 1;
            return Promise.resolve({ data: { enabled: true, metadata: { mode: "shadow" } }, error: null });
          },
        };
        return q;
      },
    };
    for (let i = 0; i < 5; i++) {
      assert.equal((await resolveDiscoveryEngineMode(client)).mode, "shadow");
    }
    assert.equal(reads, 1, "the mode is read once per TTL window, not per request");
  });

  it("M2. the flag names are the ones the migration and docs use", () => {
    assert.equal(DISCOVERY_ENGINE_MODE_FLAG, "DISCOVERY_ENGINE_MODE");
    assert.equal(DISCOVERY_PDE_KILL_SWITCH, "disable_discovery_pde");
    // D1=B: the name carries no COMPASS_ prefix, so it MUST NOT be read through
    // compass/flags.ts, whose loader filters .like("flag", "COMPASS_%").
    assert.ok(!DISCOVERY_ENGINE_MODE_FLAG.startsWith("COMPASS_"));
  });
});
