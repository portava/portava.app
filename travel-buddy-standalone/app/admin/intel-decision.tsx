/**
 * Admin — Intel Decision dashboard (§24 / Table 32).
 *
 * Table 32 'Decision': arrival success, entry success, outcome, reroute recovery
 * and regret feedback.
 *
 * A thin screen over the shared renderer: all four intel dashboards read the one
 * admin endpoint (GET /api/v1/internal/intel/observability) and differ only in
 * which section they show, so the "not instrumented is never zero" rule lives in
 * exactly one place. Requires admin role (enforced server-side by requireAdmin).
 */
import React from 'react';
import IntelObservabilityDashboard from '../../src/components/IntelObservabilityDashboard';

export default function IntelDecisionScreen() {
  return <IntelObservabilityDashboard section="decision" title="Intel Decision" />;
}
