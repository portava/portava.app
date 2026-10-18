/**
 * The two-event moderation fixture (wave 5, independent verification pass 6:
 * mutants MB, MB2, MB3).
 *
 * WHY. lib/eventModerationClaim.ts reads an event's moderation record in three
 * places, and each one is scoped to ONE event by a single
 * `.eq("event_id", eventId)`:
 *   - readRecordedEventVisibility: the visibility a restore puts back;
 *   - readEventModerationHold: what holds the host off;
 *   - readRecordedEventModeration: the state a restore reverses.
 * Every suite seeded the moderation rows of one event only, so a mutant that
 * dropped that `.eq` survived all of them (pass 6: MB 151/151, MB2 65/65, MB3
 * 97/97), while it put event B back to PUBLIC on event A's hide and let a
 * restore of A release B's hold.
 *
 * THE FIXTURE. Two events with the same host, A and B. Each has its own host
 * visibility change, hide, restore, cancel, restore and remove rows in ONE
 * event_activity_log, interleaved in time:
 *   - B ends REMOVED (archived, invite_only). Its newest row is its own
 *     recorded remove, from open and friends_only.
 *   - A ends RESTORED (open, public) by the NEWEST row on the table.
 * So a reader that reads past its own event answers A's restore for B: no
 * visibility to put back, no hold, and a state record that does not match.
 *
 * A suite appends its own rows after the story (twoEventRow, n > the story's
 * length), or acts on A through the real routes. Rows the routes insert sort
 * above every seeded row (adminModerationDouble gives them increasing
 * `f0000000-…` ids). The double's `.order()` keeps only the last key (id), so
 * the seeded ids sort as their times do.
 *
 * Used by eventModerationVisibilityRestore (section D), eventHostModerationHold
 * (section G) and eventModerationStateAuthority (section E).
 */
import type { Row, Seed } from "./schemaStrictSupabase.js";

export interface TwoEventIds { a: string; b: string; admin: string; host: string }
export type TwoEventWhich = "a" | "b";
type Step = readonly [TwoEventWhich, string, Record<string, unknown>];

const vis = (from: string, to: string) => ({ from_visibility: from, to_visibility: to });
const st = (from: string, to: string) => ({ from_state: from, to_state: to });

/** The interleaved story, oldest first: row n of the log is TWO_EVENT_STORY[n - 1]. */
export const TWO_EVENT_STORY: readonly Step[] = Object.freeze([
  ["b", "visibility_changed", { ...vis("public", "friends_only"), via: "edit" }],                // 1  B's host chose friends-only
  ["a", "visibility_changed", { ...vis("friends_only", "public"), via: "edit" }],                // 2  A's host chose public
  ["b", "admin_hide", vis("friends_only", "invite_only")],                                        // 3
  ["a", "admin_hide", vis("public", "invite_only")],                                              // 4
  ["b", "admin_restore", vis("invite_only", "friends_only")],                                     // 5
  ["a", "admin_restore", vis("invite_only", "public")],                                           // 6
  ["b", "admin_cancel", st("open", "cancelled")],                                                 // 7
  ["a", "admin_cancel", st("open", "cancelled")],                                                 // 8
  ["b", "admin_restore", st("cancelled", "open")],                                                // 9
  ["a", "admin_restore", st("cancelled", "open")],                                                // 10
  ["a", "admin_remove", { ...st("open", "archived"), ...vis("public", "invite_only") }],          // 11
  ["b", "admin_remove", { ...st("open", "archived"), ...vis("friends_only", "invite_only") }],    // 12 B's own newest row: it decides B
  ["a", "admin_restore", { ...st("archived", "open"), ...vis("invite_only", "public") }],         // 13 the NEWEST row on the table: A's
] as Step[]);

/** Where the story leaves each event. */
export const TWO_EVENT_END: Readonly<Record<TwoEventWhich, { state: string; visibility: string }>> = Object.freeze({
  a: { state: "open", visibility: "public" },
  b: { state: "archived", visibility: "invite_only" },
});

const at = (n: number) => new Date(Date.UTC(2026, 9, 6, 0, 0, 100 + n)).toISOString();
/** Seeded ids sort below the double's inserted `f0000000-…` ids, and in time order. */
export const twoEventRowId = (n: number) => `e1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Row n of the log: a step of the story, or a suite's own row appended after
 * it (n > TWO_EVENT_STORY.length). The host writes `visibility_changed`
 * (recordHostVisibilityChange's metadata: no reason); the admin writes the rest.
 */
export function twoEventRow(ids: TwoEventIds, n: number, which: TwoEventWhich, action: string, metadata: Record<string, unknown>): Row {
  const byHost = action === "visibility_changed";
  return {
    id: twoEventRowId(n), event_id: ids[which], actor_id: byHost ? ids.host : ids.admin, action,
    metadata: byHost ? { ...metadata } : { reason: null, ...metadata }, created_at: at(n),
  };
}

/**
 * Install the fixture in a suite's seed. B is the suite's own event row, with
 * its state and visibility set to where the story leaves it. A is a copy of B
 * under A's id (so it has the suite's columns), with A's end state. The log is
 * the story.
 */
export function seedTwoEventModeration(s: Seed, ids: TwoEventIds): Seed {
  const b = s.events?.find((e) => e.id === ids.b);
  if (!b) throw new Error(`seedTwoEventModeration: the seed has no event ${ids.b}`);
  Object.assign(b, TWO_EVENT_END.b);
  s.events = [...s.events!.filter((e) => e.id !== ids.a), { ...b, id: ids.a, title: "Other event", ...TWO_EVENT_END.a }];
  s.event_activity_log = TWO_EVENT_STORY.map(([which, action, metadata], i) => twoEventRow(ids, i + 1, which, action, metadata));
  return s;
}
