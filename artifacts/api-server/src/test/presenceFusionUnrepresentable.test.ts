/**
 * census-sensing S3's actual bar: "proven by a test that a second presence
 * write path is UNREPRESENTABLE, not by the store's existence."
 *
 * So this file does not test that the store works. `presenceFusionStore.test.ts`
 * does that. This file tests that the four locks in
 * `src/presence/fusion/store.ts` hold, at BOTH levels a second write path could
 * be attempted from:
 *
 *   COMPILE TIME  Six fixture modules are type-checked against the real store
 *                 with a real `ts.Program`. Each one is a different way of
 *                 phrasing "make a presence estimate without the store", and
 *                 each must produce a diagnostic. A seventh — the SANCTIONED
 *                 path — must produce NONE, which is what stops this test from
 *                 passing vacuously if the module stopped resolving.
 *   RUN TIME      The same attempts with `as any` in front of them, because a
 *                 compile-time-only lock is a lock with a cast-shaped key.
 *
 * WHAT A FAILURE LOOKS LIKE. Drop `private` from the `FusedPresenceEstimate`
 * constructor and the `direct-construction` fixture compiles clean:
 *
 *   AssertionError: a second presence write path is REPRESENTABLE:
 *     fixture "direct-construction" compiled with no error.
 *     new FusedPresenceEstimate(...) — private constructor
 *     expected 'direct-construction' to be one of [ ... ]
 *
 * The fixtures are virtual: they are served to the compiler host from memory at
 * a path inside src/presence/fusion/, so `./store.js` resolves against the real
 * directory and nothing is written to disk.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  PRESENCE_WRITE_CAPABILITIES,
  PresenceFusionStore,
  PresenceFusionViolation,
  PresenceWriteCapability,
  FusedPresenceEstimate,
  assertFused,
  isFused,
  type PresenceClaim,
} from "../presence/fusion/store.js";

const FUSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "presence",
  "fusion",
);

// ── Compile-time harness ──────────────────────────────────────────────────────

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strictNullChecks: true,
  noImplicitAny: true,
  noImplicitReturns: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/**
 * Type-check one virtual module that sits inside src/presence/fusion/.
 * Returns every diagnostic, so a fixture's assertion can be about the COUNT
 * rather than about a particular message (messages move between TS releases;
 * "did it compile" does not).
 */
function checkFixture(name: string, source: string): readonly ts.Diagnostic[] {
  const virtualPath = path.join(FUSION_DIR, `__presence_fusion_fixture_${name}__.ts`);
  const host = ts.createCompilerHost(OPTIONS, true);

  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    path.resolve(fileName) === virtualPath
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
      : realGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  host.fileExists = (fileName) =>
    path.resolve(fileName) === virtualPath ? true : realFileExists(fileName);
  host.readFile = (fileName) =>
    path.resolve(fileName) === virtualPath ? source : realReadFile(fileName);

  const program = ts.createProgram([virtualPath], OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && path.resolve(d.file.fileName) === virtualPath);
}

function render(diags: readonly ts.Diagnostic[]): string {
  return diags
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)
    .join("\n");
}

/**
 * A sanctioned write, in full. Every negative fixture below is a MUTATION of
 * this one, so a negative result cannot be an artefact of a broken import or a
 * missing field — the positive control uses the same imports and the same claim.
 */
const SANCTIONED = `
import {
  PRESENCE_WRITE_CAPABILITIES,
  PresenceFusionStore,
  type PresenceClaim,
} from "./store.js";

const claim: PresenceClaim = {
  subjectKey: "user-1",
  linkage: "account_scoped",
  scope: { kind: "locate_session", id: "session-1" },
  requestedPrecision: "precise",
  observedAtMs: 1_000,
  state: "precise",
  confidence: 1,
  evidence: ["gps"],
  point: { lat: 1, lng: 2 },
};

const store = new PresenceFusionStore();
export const admitted = store.admit(
  PRESENCE_WRITE_CAPABILITIES.locate_friends_session,
  claim,
  1_000,
);
export const precision = admitted.ok ? admitted.estimate.precision : null;
`;

/**
 * Every way a second write path could be phrased. `why` is what the fixture is
 * trying to do; the assertion message quotes it so a regression names the lock
 * that broke rather than a line number.
 */
const ATTEMPTS: readonly { name: string; why: string; source: string }[] = [
  {
    name: "direct-construction",
    why: "new FusedPresenceEstimate(...) — private constructor",
    source: `
import { FusedPresenceEstimate } from "./store.js";
export const forged = new FusedPresenceEstimate({
  source: "locate_friends_session",
  subjectKey: "user-1",
  linkage: "account_scoped",
  observedAtMs: 1_000,
  expiresAtMs: 2_000,
  position: null, zoneId: null, floor: null, distanceRange: null,
  confidence: 1, freshness: 1, evidenceTypes: ["gps"],
  state: "precise", precision: "precise", ceiling: "precise",
} as any);
`,
  },
  {
    name: "structural-estimate-literal",
    why: "an object literal with every public field, used as a FusedPresenceEstimate",
    source: `
import type { FusedPresenceEstimate } from "./store.js";
export const forged: FusedPresenceEstimate = {
  source: "locate_friends_session",
  subjectKey: "user-1",
  linkage: "account_scoped",
  observedAt: new Date(1_000),
  expiresAt: new Date(2_000),
  position: null, zoneId: null, floor: null, distanceRange: null,
  confidence: 1, freshness: 1, evidenceTypes: ["gps"],
  state: "precise", precision: "precise", ceiling: "precise",
  observedAtMs: 1_000,
  live: () => true,
  expiredAt: () => false,
  toPresenceEstimate: () => null,
};
`,
  },
  {
    name: "subclass-the-estimate",
    why: "class MyEstimate extends FusedPresenceEstimate — private constructor blocks extension",
    source: `
import { FusedPresenceEstimate } from "./store.js";
export class MyEstimate extends FusedPresenceEstimate {}
`,
  },
  {
    name: "forge-capability-by-new",
    why: "new PresenceWriteCapability('...') — private constructor",
    source: `
import { PresenceWriteCapability } from "./store.js";
export const cap = new PresenceWriteCapability("locate_friends_session" as any);
`,
  },
  {
    name: "forge-capability-by-literal",
    why: "an object literal passed to admit() where a capability is required",
    source: `
import { PresenceFusionStore, type PresenceClaim } from "./store.js";
const claim: PresenceClaim = {
  subjectKey: "user-1", linkage: "account_scoped", requestedPrecision: "precise",
  scope: { kind: "locate_session", id: "session-1" },
  observedAtMs: 1_000, state: "precise", confidence: 1, evidence: ["gps"],
};
export const r = new PresenceFusionStore().admit({ source: "locate_friends_session" }, claim, 1_000);
`,
  },
  {
    name: "fifth-presence-source",
    why: "a capability for a source the closed register does not contain",
    source: `
import { PRESENCE_WRITE_CAPABILITIES, PresenceFusionStore, type PresenceClaim } from "./store.js";
const claim: PresenceClaim = {
  subjectKey: "user-1", linkage: "account_scoped", requestedPrecision: "precise",
  scope: { kind: "locate_session", id: "session-1" },
  observedAtMs: 1_000, state: "precise", confidence: 1, evidence: ["gps"],
};
export const r = new PresenceFusionStore().admit(
  PRESENCE_WRITE_CAPABILITIES["shadow_presence_v2"],
  claim,
  1_000,
);
`,
  },
  {
    name: "widen-past-the-ceiling",
    why: "setting precision directly on a claim, bypassing the narrowing fold",
    source: `
import { type PresenceClaim } from "./store.js";
export const claim: PresenceClaim = {
  subjectKey: "user-1", linkage: "account_scoped", requestedPrecision: "zone",
  scope: { kind: "locate_session", id: "session-1" },
  precision: "precise",
  observedAtMs: 1_000, state: "precise", confidence: 1, evidence: ["gps"],
};
`,
  },
];

describe("presence fusion — a second write path is unrepresentable (compile time)", () => {
  test("the SANCTIONED path compiles with no error (the control)", () => {
    const diags = checkFixture("sanctioned", SANCTIONED);
    assert.equal(
      diags.length,
      0,
      "the sanctioned write path must compile — if it does not, every negative " +
        "result below is meaningless. Diagnostics:\n" + render(diags),
    );
  });

  for (const attempt of ATTEMPTS) {
    test(`REJECTED at compile time: ${attempt.name}`, () => {
      const diags = checkFixture(attempt.name, attempt.source);
      assert.ok(
        diags.length > 0,
        `a second presence write path is REPRESENTABLE:\n` +
          `  fixture "${attempt.name}" compiled with no error.\n` +
          `  ${attempt.why}`,
      );
    });
  }

  test("every attempt is a DIFFERENT lock, so one lock cannot cover the set", () => {
    // Each attempt must fail for a reason the others do not share. Without this
    // the suite could pass on a single blunt error (a broken import, say) seven
    // times over and prove nothing.
    const codes = new Set<number>();
    for (const attempt of ATTEMPTS) {
      for (const d of checkFixture(attempt.name, attempt.source)) codes.add(d.code);
    }
    assert.ok(
      codes.size >= 3,
      `expected the attempts to trip at least three distinct TypeScript errors; got ${[...codes].join(", ")}`,
    );
    // TS2673 = private constructor; TS2345/2739/2741 = structural mismatch;
    // TS2353/2561 = excess property. Any of these is a real lock; a set of size
    // one would mean they all failed for the same incidental reason.
  });
});

// ── Run time: the same attempts with a cast in front of them ─────────────────

const CLAIM: PresenceClaim = {
  subjectKey: "user-1",
  linkage: "account_scoped",
  scope: { kind: "locate_session", id: "session-1" },
  requestedPrecision: "precise",
  observedAtMs: 1_000,
  state: "precise",
  confidence: 1,
  evidence: ["gps"],
  point: { lat: 1, lng: 2 },
};

describe("presence fusion — a second write path is unrepresentable (run time)", () => {
  test("a capability-shaped object literal is refused by admit()", () => {
    const store = new PresenceFusionStore();
    assert.throws(
      () => store.admit({ source: "locate_friends_session" } as any, CLAIM, 1_000),
      (err: unknown) =>
        err instanceof PresenceFusionViolation && err.kind === "forged_capability",
      "an object that merely LOOKS like a capability must not open the write path",
    );
  });

  test("Object.create on the capability prototype is refused", () => {
    const fake = Object.create(PresenceWriteCapability.prototype) as PresenceWriteCapability;
    const store = new PresenceFusionStore();
    assert.throws(
      () => store.admit(fake, CLAIM, 1_000),
      (err: unknown) =>
        err instanceof PresenceFusionViolation && err.kind === "forged_capability",
    );
    assert.equal(PresenceWriteCapability.holds(fake), false);
  });

  test("a structurally-complete estimate the store did not mint fails assertFused", () => {
    const store = new PresenceFusionStore();
    const real = store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, CLAIM, 1_000);
    assert.ok(real.ok);
    // Every public field, copied off a genuine estimate.
    const forged = {
      source: real.estimate.source,
      subjectKey: real.estimate.subjectKey,
      linkage: real.estimate.linkage,
      observedAt: real.estimate.observedAt,
      expiresAt: real.estimate.expiresAt,
      position: real.estimate.position,
      zoneId: real.estimate.zoneId,
      floor: real.estimate.floor,
      distanceRange: real.estimate.distanceRange,
      confidence: real.estimate.confidence,
      freshness: real.estimate.freshness,
      evidenceTypes: real.estimate.evidenceTypes,
      state: real.estimate.state,
      precision: real.estimate.precision,
      ceiling: real.estimate.ceiling,
    };
    assert.equal(isFused(forged), false);
    assert.throws(() => assertFused(forged), PresenceFusionViolation);
    assert.equal(isFused(real.estimate), true);
  });

  test("Object.create on the estimate prototype fails assertFused", () => {
    const fake = Object.create(FusedPresenceEstimate.prototype);
    assert.equal(isFused(fake), false);
    assert.throws(() => assertFused(fake), PresenceFusionViolation);
  });

  test("a JSON round-trip of a real estimate is no longer fused", () => {
    const store = new PresenceFusionStore();
    const real = store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, CLAIM, 1_000);
    assert.ok(real.ok);
    const copy = JSON.parse(JSON.stringify(real.estimate));
    assert.equal(isFused(copy), false);
  });

  test("the capability record is frozen — no fifth source can be added at runtime", () => {
    assert.equal(Object.isFrozen(PRESENCE_WRITE_CAPABILITIES), true);
    assert.throws(() => {
      "use strict";
      (PRESENCE_WRITE_CAPABILITIES as any).shadow_presence_v2 = { source: "shadow_presence_v2" };
    });
    assert.equal((PRESENCE_WRITE_CAPABILITIES as any).shadow_presence_v2, undefined);
  });

  test("a capability cannot be re-pointed at another source", () => {
    const cap = PRESENCE_WRITE_CAPABILITIES.map_social_presence;
    assert.equal(Object.isFrozen(cap), true);
    assert.throws(() => {
      "use strict";
      (cap as any).source = "locate_friends_session";
    });
    assert.equal(cap.source, "map_social_presence");
  });

  test("the sanctioned path still works — the locks are not a wall around nothing", () => {
    const store = new PresenceFusionStore();
    const r = store.admit(PRESENCE_WRITE_CAPABILITIES.locate_friends_session, CLAIM, 1_000);
    assert.ok(r.ok);
    assert.equal(isFused(r.estimate), true);
    assert.equal(r.estimate.source, "locate_friends_session");
  });
});
