/**
 * The §44 event vocabulary exists in FOUR copies, and until this file nothing
 * compared the ones that can break a write:
 *
 *   1. the database — the `iate_event_name_known` CHECK on
 *      input_assistance_telemetry_events (2950, widened by 4121);
 *   2. the ingest — `INPUT_TELEMETRY_EVENT_NAMES` in lib/inputAssistance/telemetry.ts;
 *   3. the client's type — `InputTelemetryEventName` in
 *      travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts;
 *   4. the client's per-field lists — `STANDARD_TELEMETRY_EVENTS` and
 *      `METADATA_ONLY_TELEMETRY_EVENTS` in contexts/inputPolicies.ts.
 *
 * WHY THIS MATTERS (census G368). A name the ingest admits and the CHECK does
 * not list fails THE WHOLE INSERT BATCH at the database: the route answers 422
 * and every event queued with it is lost. Adding the fifteenth name
 * (`selection_reversed`) is exactly that change, so the pin is written with it
 * rather than after the first lost batch.
 *
 * "The newest migration that defines the CHECK" is found by scanning, not
 * hard-coded, so the next widening is checked without editing this file.
 *
 * Run: node --import tsx --test src/test/inputTelemetryVocabularyParity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INPUT_TELEMETRY_EVENT_NAMES } from "../lib/inputAssistance/telemetry.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, "..", "migrations");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const CLIENT_TYPES = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/types/fieldPolicy.ts",
);
const CLIENT_POLICIES = path.join(
  REPO_ROOT,
  "travel-buddy-standalone/src/platform/input-assistance/contexts/inputPolicies.ts",
);

const CHECK_RE = /CONSTRAINT\s+iate_event_name_known\s+CHECK\s*\(\s*event_name\s+IN\s*\(([\s\S]*?)\)\s*\)/;

function quoted(body: string): string[] {
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The newest migration (by numeric prefix) that defines the CHECK, and its names. */
export function newestEventNameCheck(dir = MIGRATIONS): { file: string; names: string[] } {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  let found: { file: string; names: string[] } | null = null;
  for (const f of files) {
    const m = fs.readFileSync(path.join(dir, f), "utf8").match(CHECK_RE);
    if (m) found = { file: f, names: quoted(m[1]!) };
  }
  assert.ok(found, "no migration defines iate_event_name_known — this test cannot check anything");
  return found;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function clientUnion(): string[] {
  const src = stripComments(fs.readFileSync(CLIENT_TYPES, "utf8"));
  const m = src.match(/export type InputTelemetryEventName\s*=([\s\S]*?);/);
  assert.ok(m, "InputTelemetryEventName not found in the client's fieldPolicy.ts");
  return quoted(m[1]!);
}

function clientList(name: string): string[] {
  const src = stripComments(fs.readFileSync(CLIENT_POLICIES, "utf8"));
  const m = src.match(new RegExp(`const ${name}: InputTelemetryEventName\\[\\] = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} not found in the client's inputPolicies.ts`);
  return quoted(m[1]!);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("§44 event vocabulary — database, ingest and client agree (census G368)", () => {
  it("the NEWEST iate_event_name_known CHECK admits exactly the ingest's vocabulary", () => {
    const { file, names } = newestEventNameCheck();
    assert.deepEqual(
      sorted(names),
      sorted(INPUT_TELEMETRY_EVENT_NAMES),
      `${file}'s CHECK and INPUT_TELEMETRY_EVENT_NAMES disagree — an admitted name the CHECK lacks fails the whole insert batch`,
    );
  });

  it("the newest CHECK is the one that admits selection_reversed (4121), not 2950", () => {
    const { file, names } = newestEventNameCheck();
    assert.ok(names.includes("selection_reversed"), `${file} does not admit selection_reversed`);
    assert.ok(parseInt(file, 10) > 2950, `the newest CHECK is still ${file}`);
  });

  it("the client's InputTelemetryEventName union is the same vocabulary", () => {
    assert.deepEqual(sorted(clientUnion()), sorted(INPUT_TELEMETRY_EVENT_NAMES));
  });

  it("the client's per-field event lists mirror the server's, member for member", () => {
    assert.deepEqual(
      sorted(clientList("STANDARD_TELEMETRY_EVENTS")),
      sorted(resolvePolicy("global_search")!.telemetryPolicy.events),
      "a standard field's events differ between the client derivation and the server registry",
    );
    assert.deepEqual(
      sorted(clientList("METADATA_ONLY_TELEMETRY_EVENTS")),
      sorted(resolvePolicy("telegraph_message")!.telemetryPolicy.events),
      "the private-message narrowing differs between client and server",
    );
  });

  it("the scan is not vacuous: it reads a CHECK with at least the fourteen names 2950 shipped", () => {
    const { names } = newestEventNameCheck();
    assert.ok(names.length >= 14, `parsed only ${names.length} names — the regex no longer matches the SQL`);
  });
});
