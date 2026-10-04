/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B46): the Live Pulse rail's collapsed
 * header never states a partial read as the whole.
 *
 * `collapsedSummaryText` (LivePulseRail.machine.ts) is the one function that decides the collapsed line. Pure: no React,
 * no React Native. (LivePulseRail.test.ts imports the livePulse service and cannot run under node; this file imports the
 * machine alone.)
 *
 *   CS1  cards beside an unread read → the summary AND "some couldn't be loaded", never the summary alone
 *   CS2  no cards and an unread read → "Couldn't load live plans"
 *   CS3  the latest read failed, cards kept → "Couldn't load live plans", never a summary (§122, B39)
 *   CS4  the latest read failed, cards kept, a read unread → "Couldn't load live plans"
 *   CS0  CONTROL: cards and nothing unread → the summary alone
 *   CS0b CONTROL: no cards and nothing unread → no line
 *
 * Run: node --import tsx/esm --test src/components/__tests__/LivePulseRail.collapsed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { collapsedSummaryText, buildSummaryText, LIVE_RAIL_COLLAPSED_FAILED, LIVE_RAIL_COLLAPSED_PARTIAL_SUFFIX } from "../LivePulseRail.machine.ts";
import type { LivePulseItem } from "../../services/livePulse.ts";

const item = (id: string, status_label: string): LivePulseItem => ({
  id: `event:${id}`, item_type: "event", item_id: id, status_label, title: id, subtitle: null, city: null,
  starts_at: null, ends_at: null, people_count: null, user_relationship: "host", primary_action: null, secondary_action: null,
  reason_labels: [], expires_at: null, is_joinable: false,
} as unknown as LivePulseItem);
const TWO = [item("a", "Tonight"), item("b", "Tonight")];

describe("census-discovery §123 (B46): the collapsed Live Pulse header", () => {
  it("CS1 cards beside an unread read → the summary and that some could not be loaded", () => {
    const line = collapsedSummaryText(TWO, 1, false);
    assert.equal(line, "2 tonight · some couldn't be loaded");
    assert.notEqual(line, buildSummaryText(TWO));
    assert.ok(line!.includes(LIVE_RAIL_COLLAPSED_PARTIAL_SUFFIX));
  });
  it("CS2 no cards and an unread read → the failure", () => {
    assert.equal(collapsedSummaryText([], 2, false), LIVE_RAIL_COLLAPSED_FAILED);
  });
  it("CS3 the latest read failed, cards kept → the failure, never a summary", () => {
    assert.equal(collapsedSummaryText(TWO, 0, true), "Couldn't load live plans");
  });
  it("CS4 the latest read failed, cards kept, a read unread → the failure", () => {
    assert.equal(collapsedSummaryText(TWO, 3, true), LIVE_RAIL_COLLAPSED_FAILED);
  });
  it("CS0 CONTROL: cards and nothing unread → the summary alone", () => {
    assert.equal(collapsedSummaryText(TWO, 0, false), "2 tonight");
    assert.equal(collapsedSummaryText(TWO, 0, false), buildSummaryText(TWO));
  });
  it("CS0b CONTROL: no cards and nothing unread → no line", () => {
    assert.equal(collapsedSummaryText([], 0, false), null);
  });
});
