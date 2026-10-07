/**
 * Test helper: read the §24 protection pass's counts from SERVER TELEMETRY.
 *
 * `GET /api/map/projection` no longer puts `protection: {evaluated, allowed,
 * coarsened, suppressed, safetyExempt}` on the wire — with one circle member,
 * `suppressed: 1` disclosed that the member was inside a protected zone
 * (lib/mapProtectionTelemetry.ts). Suites that used those counts as evidence
 * that the gate ran read them here instead.
 */
import { _setProtectionTelemetrySink, type ProtectionTelemetryEvent } from "../../lib/mapProtectionTelemetry.js";
import type { ProtectionReport } from "../../lib/protectedLocations.js";

export interface ProtectionCapture {
  /** The most recent main-path (`map_projection`) report, or null when no pass ran. */
  last(): ProtectionReport | null;
  /** Every event since the capture started or was last cleared. */
  events(): ProtectionTelemetryEvent[];
  clear(): void;
  stop(): void;
}

export function captureProtection(): ProtectionCapture {
  let seen: ProtectionTelemetryEvent[] = [];
  _setProtectionTelemetrySink((e) => { seen.push(e); });
  return {
    last() {
      for (let i = seen.length - 1; i >= 0; i--) if (seen[i]!.route === "map_projection") return seen[i]!.report;
      return null;
    },
    events: () => [...seen],
    clear() { seen = []; },
    stop() { _setProtectionTelemetrySink(null); },
  };
}
