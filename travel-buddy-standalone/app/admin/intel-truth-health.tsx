/**
 * Admin — Intel Truth Health dashboard (§24 / Table 32).
 *
 * Table 32 'Truth health': fresh claim coverage, conflict rate, expiry latency,
 * source diversity and correction propagation.
 *
 * A thin screen over the shared renderer: all four intel dashboards read the one
 * admin endpoint (GET /api/v1/internal/intel/observability) and differ only in
 * which section they show, so the "not instrumented is never zero" rule lives in
 * exactly one place. Requires admin role (enforced server-side by requireAdmin).
 */
import React from 'react';
import IntelObservabilityDashboard from '../../src/components/IntelObservabilityDashboard';

export default function IntelTruthHealthScreen() {
  return <IntelObservabilityDashboard section="truth_health" title="Intel Truth Health" />;
}
