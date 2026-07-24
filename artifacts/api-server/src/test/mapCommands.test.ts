/**
 * mapCommands — command validation + intent→command building.
 * Run: node --import tsx/esm --test src/test/mapCommands.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateMapCommand, validateMapCommands, buildCommandsFromIntent,
} from "../lib/mapCommands.js";

describe("validateMapCommand", () => {
  it("accepts a valid set-viewport and clamps radius", () => {
    const c = validateMapCommand({ type: "set-viewport", lat: 10, lng: 123, radiusKm: 9999 });
    assert.ok(c && c.type === "set-viewport");
    assert.equal((c as any).radiusKm, 200, "radius clamped to 200");
  });

  it("rejects out-of-range coordinates", () => {
    assert.equal(validateMapCommand({ type: "set-viewport", lat: 200, lng: 0 }), null);
    assert.equal(validateMapCommand({ type: "set-viewport", lat: 0, lng: 999 }), null);
  });

  it("rejects unknown filter keys, accepts allowed ones", () => {
    assert.equal(validateMapCommand({ type: "add-filter", key: "evil", value: "x" }), null);
    const ok = validateMapCommand({ type: "add-filter", key: "verified", value: true });
    assert.deepEqual(ok, { type: "add-filter", key: "verified", value: true });
  });

  it("select-entity needs a non-empty id; search-area whitelists types", () => {
    assert.equal(validateMapCommand({ type: "select-entity", entityId: "  " }), null);
    const sa = validateMapCommand({ type: "search-area", lat: 1, lng: 2, types: ["gem", "hacker", "event"] });
    assert.deepEqual((sa as any).types, ["gem", "event"], "unknown types dropped");
  });

  it("rejects unknown command types", () => {
    assert.equal(validateMapCommand({ type: "nuke-everything" }), null);
    assert.equal(validateMapCommand(null), null);
  });

  it("validateMapCommands drops the invalid ones only", () => {
    const out = validateMapCommands([
      { type: "clear-filters" },
      { type: "set-viewport", lat: 500, lng: 0 }, // invalid
      { type: "select-entity", entityId: "e1" },
    ]);
    assert.deepEqual(out.map((c) => c.type), ["clear-filters", "select-entity"]);
  });
});

describe("buildCommandsFromIntent", () => {
  const geocoder = async (q: string) =>
    q.toLowerCase().includes("cebu") ? { lat: 10.3157, lng: 123.8854, label: "Cebu City" } : null;

  it("go_to with explicit coords → set-viewport (no geocode needed)", async () => {
    const { commands, explanation } = await buildCommandsFromIntent(
      { kind: "go_to", lat: 1, lng: 2, radiusKm: 10 }, geocoder);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "set-viewport");
    assert.ok(explanation.length > 0);
  });

  it("go_to with a query is server-geocoded into a set-viewport", async () => {
    const { commands } = await buildCommandsFromIntent({ kind: "go_to", query: "Cebu" }, geocoder);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "set-viewport");
    assert.equal((commands[0] as any).label, "Cebu City");
    assert.ok(Math.abs((commands[0] as any).lat - 10.3157) < 0.01);
  });

  it("go_to with an unresolvable query moves nothing (no guessing)", async () => {
    const { commands, explanation } = await buildCommandsFromIntent({ kind: "go_to", query: "Xyzzy" }, geocoder);
    assert.equal(commands.length, 0);
    assert.match(explanation, /couldn't resolve/i);
  });

  it("search → set-viewport + search-area", async () => {
    const { commands } = await buildCommandsFromIntent(
      { kind: "search", query: "Cebu", types: ["gem"] }, geocoder);
    assert.deepEqual(commands.map((c) => c.type), ["set-viewport", "search-area"]);
    assert.deepEqual((commands[1] as any).types, ["gem"]);
  });

  it("filter → only valid filters survive", async () => {
    const { commands } = await buildCommandsFromIntent(
      { kind: "filter", filters: [{ key: "verified", value: true }, { key: "evil", value: "x" }] }, geocoder);
    assert.equal(commands.length, 1);
    assert.equal((commands[0] as any).key, "verified");
  });

  it("clear → clear-filters", async () => {
    const { commands } = await buildCommandsFromIntent({ kind: "clear" }, geocoder);
    assert.deepEqual(commands.map((c) => c.type), ["clear-filters"]);
  });
});
