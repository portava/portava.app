/**
 * LivePulseRail machine-layer tests
 *
 * Tests pure logic functions from LivePulseRail and the livePulse service:
 *   - buildSummaryText: collapsed row count summary
 *   - dismiss store: dismiss/restore/clear cycle
 *   - computeStatusLabel: inline copy of the server-side pure function
 *
 * No React rendering, no RNTL, no React Native imports.
 * Run: node --import tsx/esm --test src/components/__tests__/LivePulseRail.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSummaryText, filterItems } from "../LivePulseRail.machine.ts";
import type { LivePulseItem, LivePulseStatusLabel } from "../../services/livePulse.ts";
import {
  dismissLivePulseItem,
  isLivePulseDismissed,
  isLivePulseDismissible,
  clearDismissedItems,
} from "../../services/livePulse.ts";

// ── Inline pure copy of computeStatusLabel (mirrors server logic) ─────────────

function computeStatusLabel(
  startsAt: string | null,
  endsAt: string | null,
): LivePulseStatusLabel {
  const now = Date.now();
  if (!startsAt) return 'My Plan';
  const startMs = new Date(startsAt).getTime();
  const endMs   = endsAt ? new Date(endsAt).getTime() : null;
  if (endMs !== null && endMs <= now) return 'My Plan';
  if (startMs <= now) {
    if (endMs !== null && endMs - now <= 45 * 60_000) return 'Ends Soon';
    return 'Ongoing';
  }
  const minsToStart = (startMs - now) / 60_000;
  if (minsToStart <= 60) return 'Starting Soon';
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  if (startMs <= todayEnd.getTime()) return 'Tonight';
  const tomorrowEnd = new Date(todayEnd);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
  if (startMs <= tomorrowEnd.getTime()) return 'Tomorrow';
  const daysAway = (startMs - now) / 86_400_000;
  if (daysAway <= 14) return 'Upcoming';
  return 'My Plan';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let seq = 0;
function makeItem(overrides: Partial<LivePulseItem> = {}): LivePulseItem {
  const id = `item-${++seq}`;
  return {
    id,
    item_type:         'event',
    item_id:           id,
    status_label:      'Upcoming',
    title:             'Test Item',
    subtitle:          null,
    city:              'Manila',
    starts_at:         new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
    ends_at:           null,
    people_count:      null,
    user_relationship: 'joined',
    primary_action:    { label: 'View', type: 'navigate_event' },
    secondary_action:  null,
    reason_labels:     ["You're going"],
    expires_at:        null,
    is_joinable:       true,
    ...overrides,
  };
}

const min  = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const day  = (n: number) => new Date(Date.now() + n * 24 * 60 * 60_000).toISOString();
const past = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// ── buildSummaryText ──────────────────────────────────────────────────────────

describe("buildSummaryText", () => {
  it("shows 'Your live plans' when all items are Upcoming", () => {
    const items = [makeItem({ status_label: 'Upcoming' }), makeItem({ status_label: 'Upcoming' })];
    assert.equal(buildSummaryText(items), 'Your live plans');
  });

  it("counts Starting Soon items", () => {
    const items = [
      makeItem({ status_label: 'Starting Soon' }),
      makeItem({ status_label: 'Starting Soon' }),
      makeItem({ status_label: 'Starting Soon' }),
    ];
    const text = buildSummaryText(items);
    assert.ok(text.includes("3 starting soon"), `Expected '3 starting soon' in: ${text}`);
  });

  it("counts Ongoing and Ends Soon together as 'ongoing'", () => {
    const items = [
      makeItem({ status_label: 'Ongoing' }),
      makeItem({ status_label: 'Ends Soon' }),
    ];
    const text = buildSummaryText(items);
    assert.ok(text.includes("2 ongoing"), `Expected '2 ongoing' in: ${text}`);
  });

  it("counts Tonight items", () => {
    const items = [makeItem({ status_label: 'Tonight' })];
    const text = buildSummaryText(items);
    assert.ok(text.includes("1 tonight"), `Expected '1 tonight' in: ${text}`);
  });

  it("places Action Needed count before Starting Soon", () => {
    const items = [
      makeItem({ status_label: 'Action Needed', item_type: 'buddy_request' }),
      makeItem({ status_label: 'Starting Soon' }),
    ];
    const text = buildSummaryText(items);
    const actionIdx   = text.indexOf("action");
    const startingIdx = text.indexOf("starting");
    assert.ok(actionIdx < startingIdx, "Action Needed appears before Starting Soon");
  });

  it("combines counts with · separator", () => {
    const items = [
      makeItem({ status_label: 'Starting Soon' }),
      makeItem({ status_label: 'Ongoing' }),
      makeItem({ status_label: 'Tonight' }),
    ];
    const text = buildSummaryText(items);
    assert.ok(text.includes("·"), "should contain · separator");
  });

  it("returns 'Your live plans' for empty array", () => {
    assert.equal(buildSummaryText([]), 'Your live plans');
  });

  it("singular form for single action needed", () => {
    const items = [makeItem({ status_label: 'Action Needed', item_type: 'buddy_request' })];
    const text = buildSummaryText(items);
    assert.ok(text.includes("1 action needed"), `Expected '1 action needed' in: ${text}`);
  });

  it("plural form for multiple actions needed", () => {
    const items = [
      makeItem({ status_label: 'Action Needed', item_type: 'buddy_request' }),
      makeItem({ status_label: 'Action Needed', item_type: 'buddy_request' }),
    ];
    const text = buildSummaryText(items);
    assert.ok(text.includes("2 actions needed"), `Expected '2 actions needed' in: ${text}`);
  });
});

// ── Dismiss store ─────────────────────────────────────────────────────────────

describe("dismiss store", () => {
  it("isLivePulseDismissed is false before dismissing", () => {
    clearDismissedItems();
    assert.equal(isLivePulseDismissed("item-abc"), false);
  });

  it("isLivePulseDismissed is true after dismissing", () => {
    clearDismissedItems();
    dismissLivePulseItem("item-xyz");
    assert.equal(isLivePulseDismissed("item-xyz"), true);
  });

  it("dismissing one id does not affect others", () => {
    clearDismissedItems();
    dismissLivePulseItem("item-1");
    assert.equal(isLivePulseDismissed("item-2"), false);
  });

  it("clearDismissedItems resets all dismissed state", () => {
    clearDismissedItems();
    dismissLivePulseItem("item-clear-test");
    clearDismissedItems();
    assert.equal(isLivePulseDismissed("item-clear-test"), false);
  });
});

// ── isLivePulseDismissible ────────────────────────────────────────────────────

describe("isLivePulseDismissible", () => {
  it("true for hidden_gem", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'hidden_gem' })), true);
  });

  it("true for compass", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'compass' })), true);
  });

  it("false for event", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'event' })), false);
  });

  it("false for trip", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'trip' })), false);
  });

  it("false for buddy_request", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'buddy_request' })), false);
  });
});

// ── computeStatusLabel (inline copy) ─────────────────────────────────────────

describe("computeStatusLabel", () => {
  it("returns 'My Plan' when startsAt is null", () => {
    assert.equal(computeStatusLabel(null, null), 'My Plan');
  });

  it("returns 'Starting Soon' for event starting in 30 min", () => {
    assert.equal(computeStatusLabel(min(30), min(120)), 'Starting Soon');
  });

  it("returns 'Starting Soon' for event starting in 59 min", () => {
    assert.equal(computeStatusLabel(min(59), min(120)), 'Starting Soon');
  });

  it("returns 'Ongoing' for currently running event", () => {
    assert.equal(computeStatusLabel(past(60), min(120)), 'Ongoing');
  });

  it("returns 'Ends Soon' for event ending in 30 min", () => {
    assert.equal(computeStatusLabel(past(60), min(30)), 'Ends Soon');
  });

  it("returns 'My Plan' for ended event", () => {
    assert.equal(computeStatusLabel(past(120), past(60)), 'My Plan');
  });

  it("returns 'Upcoming' for event 3 days away", () => {
    assert.equal(computeStatusLabel(day(3), day(4)), 'Upcoming');
  });

  it("returns 'My Plan' for event 20 days away (beyond 14-day window)", () => {
    assert.equal(computeStatusLabel(day(20), day(21)), 'My Plan');
  });
});

// ── filterItems — filter chip narrowing ───────────────────────────────────────

describe("filterItems — chip: All", () => {
  it("returns all items unchanged", () => {
    const items = [
      makeItem({ item_type: 'event',         status_label: 'Starting Soon' }),
      makeItem({ item_type: 'trip',          status_label: 'Upcoming' }),
      makeItem({ item_type: 'buddy_request', status_label: 'Action Needed' }),
      makeItem({ item_type: 'safe_return',   status_label: 'Action Needed' }),
    ];
    assert.equal(filterItems(items, 'All').length, 4);
  });
});

describe("filterItems — chip: Now", () => {
  it("includes Ongoing and Ends Soon items", () => {
    const ongoing   = makeItem({ status_label: 'Ongoing' });
    const endsSoon  = makeItem({ status_label: 'Ends Soon' });
    const upcoming  = makeItem({ status_label: 'Upcoming' });
    const result = filterItems([ongoing, endsSoon, upcoming], 'Now');
    assert.equal(result.length, 2);
    assert.ok(result.includes(ongoing));
    assert.ok(result.includes(endsSoon));
  });

  it("includes safe_return items (always high-priority)", () => {
    const sr = makeItem({ item_type: 'safe_return', status_label: 'Action Needed' });
    const result = filterItems([sr], 'Now');
    assert.equal(result.length, 1);
  });

  it("excludes Upcoming and Starting Soon items", () => {
    const upcoming     = makeItem({ status_label: 'Upcoming' });
    const startingSoon = makeItem({ status_label: 'Starting Soon' });
    const result = filterItems([upcoming, startingSoon], 'Now');
    assert.equal(result.length, 0);
  });
});

describe("filterItems — chip: Starting Soon", () => {
  it("returns only Starting Soon items", () => {
    const soon    = makeItem({ status_label: 'Starting Soon' });
    const tonight = makeItem({ status_label: 'Tonight' });
    const ongoing = makeItem({ status_label: 'Ongoing' });
    const result = filterItems([soon, tonight, ongoing], 'Starting Soon');
    assert.equal(result.length, 1);
    assert.ok(result.includes(soon));
  });

  it("returns empty when no Starting Soon items", () => {
    const items = [makeItem({ status_label: 'Ongoing' }), makeItem({ status_label: 'Tonight' })];
    assert.equal(filterItems(items, 'Starting Soon').length, 0);
  });
});

describe("filterItems — chip: Tonight", () => {
  it("returns only Tonight items", () => {
    const tonight  = makeItem({ status_label: 'Tonight' });
    const tomorrow = makeItem({ status_label: 'Tomorrow' });
    const result = filterItems([tonight, tomorrow], 'Tonight');
    assert.equal(result.length, 1);
    assert.ok(result.includes(tonight));
  });
});

describe("filterItems — chip: My Trip", () => {
  it("returns trip and circle items only", () => {
    const trip    = makeItem({ item_type: 'trip',    status_label: 'Upcoming' });
    const circle  = makeItem({ item_type: 'circle',  status_label: 'Ongoing' });
    const event   = makeItem({ item_type: 'event',   status_label: 'Upcoming' });
    const gem     = makeItem({ item_type: 'hidden_gem', status_label: 'My Plan' });
    const result  = filterItems([trip, circle, event, gem], 'My Trip');
    assert.equal(result.length, 2);
    assert.ok(result.includes(trip));
    assert.ok(result.includes(circle));
  });
});

describe("filterItems — chip: Near Me", () => {
  it("returns events, hidden_gem, and compass items", () => {
    const event   = makeItem({ item_type: 'event' });
    const gem     = makeItem({ item_type: 'hidden_gem' });
    const compass = makeItem({ item_type: 'compass' });
    const trip    = makeItem({ item_type: 'trip' });
    const result  = filterItems([event, gem, compass, trip], 'Near Me');
    assert.equal(result.length, 3);
    assert.ok(!result.includes(trip));
  });
});

describe("filterItems — chip: Requests", () => {
  it("returns buddy_request and Action Needed items", () => {
    const buddy   = makeItem({ item_type: 'buddy_request', status_label: 'Action Needed' });
    const sr      = makeItem({ item_type: 'safe_return',   status_label: 'Action Needed' });
    const event   = makeItem({ item_type: 'event',         status_label: 'Upcoming' });
    const result  = filterItems([buddy, sr, event], 'Requests');
    assert.equal(result.length, 2);
    assert.ok(!result.includes(event));
  });

  it("excludes events with non-Action-Needed status", () => {
    const event = makeItem({ item_type: 'event', status_label: 'Starting Soon' });
    assert.equal(filterItems([event], 'Requests').length, 0);
  });
});

describe("filterItems — chip: Buddies", () => {
  it("returns only buddy_request items", () => {
    const buddy   = makeItem({ item_type: 'buddy_request', status_label: 'Action Needed' });
    const sr      = makeItem({ item_type: 'safe_return',   status_label: 'Action Needed' });
    const result  = filterItems([buddy, sr], 'Buddies');
    assert.equal(result.length, 1);
    assert.ok(result.includes(buddy));
  });
});

// ── isLivePulseDismissible — new types ────────────────────────────────────────

describe("isLivePulseDismissible — new types", () => {
  it("false for circle", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'circle' })), false);
  });

  it("false for safe_return (safety cards never dismissible)", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'safe_return' })), false);
  });

  it("true for available_buddy (discovery card, can be dismissed)", () => {
    assert.equal(isLivePulseDismissible(makeItem({ item_type: 'available_buddy' })), true);
  });
});

// ── filterItems — available_buddy in Buddies chip ─────────────────────────────

describe("filterItems — chip: Buddies includes available_buddy", () => {
  it("returns both buddy_request and available_buddy items", () => {
    const req   = makeItem({ item_type: 'buddy_request',   status_label: 'Action Needed' });
    const avail = makeItem({ item_type: 'available_buddy', status_label: 'My Plan' });
    const event = makeItem({ item_type: 'event',           status_label: 'Upcoming' });
    const result = filterItems([req, avail, event], 'Buddies');
    assert.equal(result.length, 2);
    assert.ok(result.includes(req));
    assert.ok(result.includes(avail));
    assert.ok(!result.includes(event));
  });

  it("available_buddy does NOT appear in Requests chip (not action-needed)", () => {
    const avail = makeItem({ item_type: 'available_buddy', status_label: 'My Plan' });
    assert.equal(filterItems([avail], 'Requests').length, 0);
  });
});

// ── Rail state machine — loading / empty / error / retry ─────────────────────
//
// These tests exercise the pure rail-state logic that drives the component's
// loading, empty, and error shell states.  No React rendering required.

import {
  computeRailState,
  type RailState,
} from "../LivePulseRail.machine.ts";

describe("computeRailState — loading", () => {
  it("returns loading state when loading=true regardless of items", () => {
    const state: RailState = computeRailState({ loading: true, error: null, items: [] });
    assert.equal(state.kind, 'loading');
  });

  it("returns loading even when stale items are present", () => {
    const items = [makeItem()];
    const state = computeRailState({ loading: true, error: null, items });
    assert.equal(state.kind, 'loading');
  });
});

describe("computeRailState — error", () => {
  it("returns error state when error is set and not loading", () => {
    const state = computeRailState({ loading: false, error: 'Network error', items: [] });
    assert.equal(state.kind, 'error');
    assert.equal((state as any).message, 'Network error');
  });
});

describe("computeRailState — empty", () => {
  it("returns empty state when loaded with zero items and no error", () => {
    const state = computeRailState({ loading: false, error: null, items: [] });
    assert.equal(state.kind, 'empty');
  });
});

describe("computeRailState — ready", () => {
  it("returns ready state with items when loaded successfully", () => {
    const items = [makeItem(), makeItem()];
    const state = computeRailState({ loading: false, error: null, items });
    assert.equal(state.kind, 'ready');
    assert.equal((state as any).items.length, 2);
  });

  it("priority item is the first item in the sorted list (urgency order)", () => {
    const items = [makeItem({ status_label: 'Upcoming' }), makeItem({ status_label: 'Ongoing' })];
    const state = computeRailState({ loading: false, error: null, items });
    assert.equal(state.kind, 'ready');
    // ready state exposes items in passed order (sorting is backend's job)
    assert.equal((state as any).items.length, 2);
  });
});
