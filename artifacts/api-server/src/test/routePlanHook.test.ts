/**
 * Mobile useRoutePlan — checkpoint-progress logic tests.
 *
 * These tests validate the derived-state computations that the hook exposes:
 *  - completedCount  (arrived stops)
 *  - progressFraction (0.0 – 1.0)
 *  - nextStop         (first pending stop)
 *
 * Because the logic is pure functional composition over the stops array, it is
 * tested here as unit tests without a React renderer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ── Pure helpers (mirror of useRoutePlan derived state) ───────────────────────

type StopStatus = "pending" | "arrived" | "skipped" | "cancelled";

interface MockStop {
  id: string;
  orderIndex: number;
  checkpointStatus: StopStatus;
}

function deriveProgress(stops: MockStop[]) {
  const completedCount   = stops.filter((s) => s.checkpointStatus === "arrived").length;
  const totalCount       = stops.length;
  const progressFraction = totalCount > 0 ? completedCount / totalCount : 0;
  const nextStop         = stops.find((s) => s.checkpointStatus === "pending") ?? null;
  return { completedCount, totalCount, progressFraction, nextStop };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("useRoutePlan: completedCount is 0 for empty list", () => {
  const { completedCount, totalCount, progressFraction } = deriveProgress([]);
  assert.equal(completedCount, 0);
  assert.equal(totalCount, 0);
  assert.equal(progressFraction, 0);
});

test("useRoutePlan: completedCount counts only arrived stops", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "pending" },
    { id: "c", orderIndex: 2, checkpointStatus: "arrived" },
    { id: "d", orderIndex: 3, checkpointStatus: "skipped" },
  ];
  const { completedCount } = deriveProgress(stops);
  assert.equal(completedCount, 2);
});

test("useRoutePlan: skipped stops do not count toward completedCount", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "skipped" },
    { id: "b", orderIndex: 1, checkpointStatus: "skipped" },
  ];
  const { completedCount } = deriveProgress(stops);
  assert.equal(completedCount, 0);
});

test("useRoutePlan: progressFraction is completedCount / totalCount", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "arrived" },
    { id: "c", orderIndex: 2, checkpointStatus: "pending" },
    { id: "d", orderIndex: 3, checkpointStatus: "pending" },
  ];
  const { progressFraction } = deriveProgress(stops);
  assert.equal(progressFraction, 0.5);
});

test("useRoutePlan: progressFraction is 1.0 when all stops arrived", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "arrived" },
  ];
  const { progressFraction } = deriveProgress(stops);
  assert.equal(progressFraction, 1);
});

test("useRoutePlan: nextStop is first pending stop in order", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "pending" },
    { id: "c", orderIndex: 2, checkpointStatus: "pending" },
  ];
  const { nextStop } = deriveProgress(stops);
  assert.equal(nextStop?.id, "b");
});

test("useRoutePlan: nextStop is null when all stops are arrived", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "arrived" },
    { id: "b", orderIndex: 1, checkpointStatus: "arrived" },
  ];
  const { nextStop } = deriveProgress(stops);
  assert.equal(nextStop, null);
});

test("useRoutePlan: nextStop is null for empty list", () => {
  const { nextStop } = deriveProgress([]);
  assert.equal(nextStop, null);
});

test("useRoutePlan: cancelled stops do not count as completed and do not surface as nextStop", () => {
  const stops: MockStop[] = [
    { id: "a", orderIndex: 0, checkpointStatus: "cancelled" },
    { id: "b", orderIndex: 1, checkpointStatus: "pending" },
  ];
  const { completedCount, nextStop } = deriveProgress(stops);
  assert.equal(completedCount, 0);
  assert.equal(nextStop?.id, "b");
});
