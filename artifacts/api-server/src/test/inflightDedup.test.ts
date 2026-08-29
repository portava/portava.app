/**
 * createInflightDedup — one HTTP call where there were N.
 *
 * THE GAP THIS IS WRITTEN AGAINST (2026-08-28)
 * -------------------------------------------
 * routes/discovery.ts deduplicated Nominatim (`_geocodePending`) but NOT
 * Overpass, whose four call sites each issued their own request. GET
 * /discovery/counts fans out over seven categories, so two simultaneous counts
 * requests for one city meant fourteen Overpass calls where seven would do.
 *
 * The dependency is rate-limited and this deployment has already been throttled
 * by it, and `queryOverpass` returns [] on a non-ok response — so being
 * throttled does not raise, it silently empties the feed.
 *
 * The tests assert the two properties that separate a deduper from a cache:
 * work is shared only WHILE IN FLIGHT, and the key is released on both settle
 * paths.
 *
 * Pure and offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInflightDedup } from "../lib/inflightDedup.js";

/** A promise whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createInflightDedup", () => {
  it("invokes the work ONCE for concurrent callers on the same key", async () => {
    const d = createInflightDedup<string>();
    const gate = deferred<string>();
    let calls = 0;
    const fn = () => { calls += 1; return gate.promise; };

    const a = d.run("k", fn);
    const b = d.run("k", fn);
    const c = d.run("k", fn);
    assert.equal(calls, 1, "three concurrent callers, one invocation");
    assert.equal(d.size, 1);

    gate.resolve("value");
    assert.deepEqual(await Promise.all([a, b, c]), ["value", "value", "value"]);
  });

  it("keeps different keys independent", async () => {
    const d = createInflightDedup<string>();
    let calls = 0;
    const fn = (v: string) => () => { calls += 1; return Promise.resolve(v); };

    const [x, y] = await Promise.all([d.run("a", fn("A")), d.run("b", fn("B"))]);
    assert.equal(calls, 2);
    assert.deepEqual([x, y], ["A", "B"]);
  });

  it("is NOT a cache — a settled key runs the work again", async () => {
    // The most likely way for this to be mis-modified later is to retain
    // settled promises, which silently converts it into a cache with no expiry.
    const d = createInflightDedup<number>();
    let calls = 0;
    const fn = () => { calls += 1; return Promise.resolve(calls); };

    assert.equal(await d.run("k", fn), 1);
    assert.equal(await d.run("k", fn), 2, "second call after settle must re-run");
    assert.equal(d.size, 0, "nothing may be retained once settled");
  });

  it("releases the key on REJECTION, so a failure cannot strand it", async () => {
    const d = createInflightDedup<string>();
    const gate = deferred<string>();
    let calls = 0;

    const a = d.run("k", () => { calls += 1; return gate.promise; });
    const b = d.run("k", () => { calls += 1; return gate.promise; });
    assert.equal(calls, 1);

    gate.reject(new Error("boom"));
    await assert.rejects(a, /boom/);
    await assert.rejects(b, /boom/, "concurrent callers share the failure");
    assert.equal(d.size, 0, "a rejected key must not block later callers");

    // and the next caller gets a fresh attempt
    const c = await d.run("k", () => Promise.resolve("recovered"));
    assert.equal(c, "recovered");
  });

  it("a caller joining mid-flight gets the SAME promise instance", async () => {
    const d = createInflightDedup<string>();
    const gate = deferred<string>();
    const first = d.run("k", () => gate.promise);
    const second = d.run("k", () => Promise.resolve("should not be used"));
    assert.equal(first, second, "the joiner must receive the in-flight promise itself");
    gate.resolve("ok");
    assert.equal(await second, "ok");
  });

  it("reports size so exhaustion is observable", async () => {
    const d = createInflightDedup<string>();
    const gates = [deferred<string>(), deferred<string>()];
    const ps = gates.map((g, i) => d.run(`k${i}`, () => g.promise));
    assert.equal(d.size, 2);
    gates.forEach((g, i) => g.resolve(`v${i}`));
    await Promise.all(ps);
    assert.equal(d.size, 0);
  });
});
