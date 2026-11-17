import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CompassReasoningBudget, CompassReasoningTimeout } from "../compass/CompassReasoningBudget.js";
import { compassAiFailureFallbackWithRetrieval } from "../compass/compassMemoryFallback.js";

describe("Compass shared reasoning deadline", () => {
  it("counts context and prior rounds, reserves time for a final answer, and refuses expired work", async () => {
    let now = 10_000;
    const budget = new CompassReasoningBudget(now, undefined, () => now);
    now += 10_000; // context assembly
    assert.equal(budget.remainingMs(), 55_000);
    assert.equal(budget.shouldFinish(), false);
    await budget.run(async (_signal, timeout) => {
      assert.equal(timeout, 25_000);
      now += 25_000;
    });
    assert.equal(budget.shouldFinish(), true);
    now += 20_000;
    await budget.run(async (_signal, timeout) => assert.equal(timeout, 10_000));
    now += 10_000;
    let called = false;
    await assert.rejects(budget.run(async () => { called = true; }), CompassReasoningTimeout);
    assert.equal(called, false);
  });

  it("aborts an ignored transport deadline and discards a late completion", async () => {
    const budget = new CompassReasoningBudget(Date.now(), undefined, Date.now, 20);
    let signal: AbortSignal | undefined;
    let resolve!: (value: string) => void;
    const request = budget.run(async (s) => {
      signal = s;
      return new Promise<string>(done => { resolve = done; });
    });
    await assert.rejects(request, CompassReasoningTimeout);
    assert.equal(signal?.aborted, true);
    resolve("late answer");
  });

  it("propagates disconnects without misclassifying them as timeouts", async () => {
    const client = new AbortController();
    const budget = new CompassReasoningBudget(Date.now(), client.signal);
    const disconnected = new Error("client_disconnected");
    const request = budget.run(async signal => {
      client.abort(disconnected);
      assert.equal(signal.aborted, true);
      return new Promise<never>(() => {});
    });
    await assert.rejects(request, error => error === disconnected);
    await assert.rejects(budget.run(async () => assert.fail("must not call after disconnect")), error => error === disconnected);
  });

  it("does not let memory fallback retrieval turn an outage into an endless wait", async () => {
    const answer = await compassAiFailureFallbackWithRetrieval([], () => new Promise(() => {}), "Please retry.", 20);
    assert.deepEqual(answer, { message: "Please retry." });
  });
});
