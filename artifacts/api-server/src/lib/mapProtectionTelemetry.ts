/**
 * mapProtectionTelemetry — where the §24 protection pass's per-reason counts go
 * now that they are not on the wire.
 *
 * ── WHY THEY LEFT THE RESPONSE (2026-10-06, Telegraph re-check) ──────────────
 * `GET /api/map/projection` used to answer `protection: { evaluated, allowed,
 * coarsened, suppressed, safetyExempt }`. Circle members go through that pass.
 * With one circle member on the map, `suppressed: 1` next to an empty object
 * list told the viewer that their friend is INSIDE A PROTECTED ZONE — a clinic,
 * a shelter, a home — which is precisely the fact the zone exists to hide, and
 * a worse disclosure than the coarse position it withheld. The same class as
 * the Nearby leak fixed before it: a count attributable to a zone reached the
 * wire for another person's position.
 *
 * So the counts are SERVER TELEMETRY only: logged with the request (counts and
 * the route name, never the viewer, an object id or a zone), and handed to an
 * optional in-process sink that tests use to assert the gate actually ran. The
 * response carries nothing that differs between "hidden by a zone" and "not
 * shown for another reason".
 */
import type { ProtectionReport } from "./protectedLocations.js";

export interface ProtectionTelemetryEvent {
  route: "map_projection" | "map_projection_world_intelligence";
  report: ProtectionReport;
}

type Sink = (event: ProtectionTelemetryEvent) => void;
let sink: Sink | null = null;

/** TEST SEAM: observe every protection pass. Pass null to stop. */
export function _setProtectionTelemetrySink(next: Sink | null): void {
  sink = next;
}

interface LogLike { info?: (obj: unknown, msg?: string) => void }

/** Record one pass. Never throws: telemetry must not be the thing that fails a map request. */
export function recordProtectionPass(
  log: LogLike | null | undefined,
  route: ProtectionTelemetryEvent["route"],
  report: ProtectionReport,
): void {
  const event: ProtectionTelemetryEvent = { route, report: { ...report } };
  try {
    log?.info?.({ mapProtection: event }, "map §24 protection pass");
  } catch {
    /* logging is best-effort */
  }
  try {
    sink?.(event);
  } catch {
    /* a test sink that throws is the test's problem, not the request's */
  }
}
