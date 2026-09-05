/**
 * Admin — Intel Calibration dashboard (§24 / Table 32).
 *
 * Table 32 'Calibration': accuracy by confidence band, claim family, city, zone,
 * hour and source class — plus the §26 density-gate verdict.
 *
 * A thin screen over the shared renderer: all four intel dashboards read the one
 * admin endpoint (GET /api/v1/internal/intel/observability) and differ only in
 * which section they show, so the "not instrumented is never zero" rule lives in
 * exactly one place. Requires admin role (enforced server-side by requireAdmin).
 */
import React from 'react';
import IntelObservabilityDashboard from '../../src/components/IntelObservabilityDashboard';

export default function IntelCalibrationScreen() {
  return <IntelObservabilityDashboard section="calibration" title="Intel Calibration" />;
}
