/**
 * Rent a Buddy — API route tests
 *
 * Covers: feature-flag gating, policy text in responses, banned keyword creates
 * policy flag (not auto-ban), severe flags limit access, new-Buddy restrictions,
 * private first meetup blocked, route-change safety event, emergency phrase
 * (traveler-only), cash balance disagreement → dispute, confirmed cash emits
 * positive Trust Score event, no-show/cancel emits negative Trust Score event,
 * admin confirm/dismiss policy flag, admin apply full-in-app-payment-required
 * limit, user with cash_balance_disabled cannot choose deposit_plus_cash,
 * user with rent_buddy_disabled cannot create bookings, double-blind review
 * logic, comfort check distress → safety event.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddy.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter, { POLICY_TEXT, toPublicBuddyReview } from "../routes/rentABuddy.js";
import { toLedgerEntryView } from "../routes/rentABuddyMarketplace.js";
import { specAliasRewrite } from "../lib/specAliasRewrite.js";

// ── Test server ───────────────────────────────────────────────────────────────

// TZ HYGIENE — pin this test process to UTC (CI's reference timezone). The age-
// enforcement booking cases below build DOBs at the ±1-day 18/21 boundary, which
// the server's calculateUserAge reads with LOCAL date components; on a developer
// machine in a non-UTC zone those boundaries flip and the tests flake. Pinning
// makes them deterministic everywhere; prod code is unchanged.
process.env.TZ = "UTC";

let server: http.Server;
let base: string;

const FAKE_TOKEN  = "rb-test-token";
const BUDDY_TOKEN = "rb-buddy-token";
const ADMIN_TOKEN = "rb-admin-token";
const USER_ID     = "user-traveler-1";
const BUDDY_USER  = "user-buddy-1";
const ADMIN_USER  = "user-admin-1";
const BUDDY_PROF  = "profile-buddy-1";
const BOOKING_ID  = "booking-uuid-1";
const PACKAGE_ID  = "package-uuid-1";
const FLAG_ID     = "flag-uuid-1";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = FAKE_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    };
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, headers },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client state ─────────────────────────────────────────────────────────

interface FakeState {
  featureFlags?:       Record<string, { flag: string; enabled: boolean }>;
  profiles?:           Record<string, any>;
  buddyProfiles?:      Record<string, any>;
  applications?:       Record<string, any>;
  bookings?:           Record<string, any>;
  reviews?:            Record<string, any>[];
  policyFlags?:        Record<string, any>[];
  safetyEvents?:       any[];
  safetyCheckins?:     any[];
  disputes?:           any[];
  userLimits?:         Record<string, any>;
  adminActions?:       any[];
  trustEvents?:        any[];
  packages?:           Record<string, any>[];
  addons?:             Record<string, any>[];
  availability?:       Record<string, any>[];
  launchControls?:     any[];
  globalControls?:     any;
  cityRollouts?:       any[];
  /** Map of table name → error object. When set the fake client returns this
   *  error (and no data) for the next insert on that table, then clears it. */
  insertErrorOverrides?: Record<string, any>;
  /** Map of table name → error object. When set the fake client returns this
   *  error (and no data) for the next update on that table, then clears it. */
  updateErrorOverrides?: Record<string, any>;
  /** Map of table name → { matchEq?, error }. When set the fake client returns
   *  this error (and no data) for the next select on that table whose filters
   *  include the given eq match (or unconditionally if matchEq is omitted),
   *  then clears the override. */
  selectErrorOverrides?: Record<string, { matchEq?: { col: string; val: any }; error: any }>;
}

let state: FakeState = {};

// Tables whose inserts are fire-and-forget in rentABuddy.ts — i.e. the entire
// chain is `void serviceClient.from(table).insert(data)` with no await, so
// _resolve() is never called and the rows are invisible to test assertions
// unless captured eagerly inside insert() itself.
//
// Audit (grep "void serviceClient" in rentABuddy.ts, 2026-07-16):
//   • buddy_booking_events — 15 direct void sites; the only table that requires
//     eager capture.
//
// Other void-prefixed calls in rentABuddy.ts use async helper functions
// (emitBookingMilestone → messages, emitBookingCard → messages,
//  recordTrustEvent → trust_events, notifyBookingParty → notifications).
// Those helpers internally await their DB writes so _resolve() IS reached for
// those tables and no eager-capture is needed for them.
const FIRE_AND_FORGET_TABLES = new Set([
  "buddy_booking_events",
]);

function makeClient(userId: string, role = "user") {
  const inserted: any[] = [];

  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insertData: null as any,
      _updateData: null as any,
      _upsertData: null as any,
      _limit: 1000,
      _range: [0, 999] as [number, number],
      _order: null as any,
      _count: false,
      _maybeSingle: false,
      _eagerCaptured: false,

      select(cols?: string, opts?: any) { if (opts?.count) this._count = true; return this; },
      insert(data: any) {
        this._insertData = data;
        // For every table in FIRE_AND_FORGET_TABLES, the production code issues
        // `void serviceClient.from(table).insert(...)` — _resolve() is never
        // reached, so rows must be captured right here in insert().
        if (FIRE_AND_FORGET_TABLES.has(table)) {
          const rows = Array.isArray(data) ? data : [data];
          for (const row of rows) {
            const r = { id: `gen-${Math.random().toString(36).slice(2)}`, ...row };
            if (table === "buddy_booking_events") {
              if (!(state as any).bookingEvents) (state as any).bookingEvents = [];
              (state as any).bookingEvents.push(r);
            }
          }
          this._eagerCaptured = true;
        }
        return this;
      },
      update(data: any) { this._updateData = data; return this; },
      upsert(data: any, opts?: any) { this._upsertData = data; return this; },
      delete() { this._updateData = "__delete__"; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      neq(col: string, val: any) { this._filters.push(["neq", col, val]); return this; },
      in(col: string, vals: any[]) { this._filters.push(["in", col, vals]); return this; },
      gt(col: string, val: any) { this._filters.push(["gt", col, val]); return this; },
      lt(col: string, val: any) { this._filters.push(["lt", col, val]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      like(col: string, val: any) { this._filters.push(["like", col, val]); return this; },
      ilike(col: string, val: any) { this._filters.push(["ilike", col, val]); return this; },
      contains(col: string, val: any) { this._filters.push(["contains", col, val]); return this; },
      neq(col: string, val: any) { this._filters.push(["neq", col, val]); return this; },
      or(expr: string) { return this; },
      is(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      limit(n: number) { this._limit = n; return this; },
      range(from: number, to: number) { this._range = [from, to]; return this; },
      order(col: string, opts?: any) { this._order = { col, ...opts }; return this; },
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // Handle inserts
        if (this._insertData !== null) {
          // If a per-table error override is armed, return the error and disarm it.
          if (state.insertErrorOverrides?.[t]) {
            const err = state.insertErrorOverrides[t];
            delete state.insertErrorOverrides[t];
            return { data: null, error: err };
          }

          const data = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
          const generatedRows: any[] = [];
          for (const row of data) {
            const r = { id: `gen-${Math.random().toString(36).slice(2)}`, ...row };
            generatedRows.push(r);
            inserted.push({ table: t, row: r });
            if (t === "trust_events") {
              if (!state.trustEvents) state.trustEvents = [];
              state.trustEvents.push(r);
            }
            if (t === "rent_buddy_policy_flags") {
              if (!state.policyFlags) state.policyFlags = [];
              state.policyFlags.push(r);
            }
            if (t === "rent_buddy_safety_events") {
              if (!state.safetyEvents) state.safetyEvents = [];
              state.safetyEvents.push(r);
            }
            if (t === "rent_buddy_safety_checkins") {
              if (!state.safetyCheckins) state.safetyCheckins = [];
              state.safetyCheckins.push(r);
            }
            if (t === "rent_buddy_disputes") {
              if (!state.disputes) state.disputes = [];
              state.disputes.push(r);
            }
            if (t === "rent_buddy_admin_actions") {
              if (!state.adminActions) state.adminActions = [];
              state.adminActions.push(r);
            }
            if (t === "rent_buddy_reviews") {
              if (!state.reviews) state.reviews = [];
              state.reviews.push(r);
            }
            if (t === "buddy_booking_events" && !this._eagerCaptured) {
              if (!(state as any).bookingEvents) (state as any).bookingEvents = [];
              (state as any).bookingEvents.push(r);
            }
            if (t === "rent_buddy_route_change_requests") {
              if (!(state as any).routeChangeRequests) (state as any).routeChangeRequests = [];
              (state as any).routeChangeRequests.push(r);
            }
            if (t === "buddy_booking_change_requests") {
              if (!(state as any).bookingChangeRequests) (state as any).bookingChangeRequests = [];
              if (r.id === undefined) r.id = `bcr-${Math.random().toString(36).slice(2)}`;
              if (r.status === undefined) r.status = "pending";
              (state as any).bookingChangeRequests.push(r);
            }
            if (t === "rent_buddy_tag_consents") {
              if (!(state as any).tagConsents) (state as any).tagConsents = [];
              (state as any).tagConsents.push(r);
            }
            if (t === "rent_buddy_support_reports") {
              if (!(state as any).supportReports) (state as any).supportReports = [];
              (state as any).supportReports.push(r);
            }
            if (t === "buddy_availability_exceptions") {
              if (!(state as any).availabilityExceptions) (state as any).availabilityExceptions = [];
              (state as any).availabilityExceptions.push(r);
            }
            if (t === "rent_buddy_training_checklist") {
              if (!(state as any).trainingChecklist) (state as any).trainingChecklist = [];
              (state as any).trainingChecklist.push(r);
            }
            if (t === "messages") {
              if (!(state as any).messages) (state as any).messages = [];
              (state as any).messages.push(r);
            }
            if (t === "notifications") {
              if (!(state as any).notifications) (state as any).notifications = [];
              (state as any).notifications.push(r);
            }
          }
          if (this._maybeSingle) return { data: generatedRows.length === 1 ? generatedRows[0] : null, error: null };
          return { data: null, error: null };
        }

        // Handle upserts
        if (this._upsertData !== null) {
          const row = this._upsertData;
          if (t === "rent_buddy_user_limits" && row.user_id) {
            if (!state.userLimits) state.userLimits = {};
            state.userLimits[row.user_id] = row;
          }
          if (t === "rent_buddy_bookings") {
            if (!state.bookings) state.bookings = {};
            const id = row.id ?? `gen-${Math.random().toString(36).slice(2)}`;
            state.bookings[id] = { id, ...row };
          }
          if (this._maybeSingle) return { data: { id: `gen-${Math.random().toString(36).slice(2)}`, ...row }, error: null };
          return { data: null, error: null };
        }

        // Handle updates / deletes
        if (this._updateData !== null) {
          // If a per-table error override is armed for updates, return the error and disarm it.
          if (state.updateErrorOverrides?.[t]) {
            const err = state.updateErrorOverrides[t];
            delete state.updateErrorOverrides[t];
            return { data: null, error: err };
          }
          if (t === "buddy_availability_exceptions" && this._updateData === "__delete__") {
            let rows = (state as any).availabilityExceptions ?? [];
            for (const [op, col, val] of this._filters) {
              if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            }
            (state as any).availabilityExceptions =
              ((state as any).availabilityExceptions ?? []).filter((r: any) => !rows.includes(r));
            return { data: null, error: null };
          }
          if (t === "rent_buddy_bookings") {
            for (const [op, col, val] of this._filters) {
              if (op === "eq" && col === "id" && state.bookings?.[val]) {
                if (this._updateData === "__delete__") {
                  delete state.bookings[val];
                } else {
                  state.bookings[val] = { ...state.bookings[val], ...this._updateData };
                }
              }
              if (op === "in" && col === "id") {
                for (const id of val as string[]) {
                  if (state.bookings?.[id]) {
                    if (this._updateData === "__delete__") {
                      delete state.bookings[id];
                    } else {
                      state.bookings[id] = { ...state.bookings[id], ...this._updateData };
                    }
                  }
                }
              }
            }
          }
          if (t === "rent_buddy_policy_flags") {
            for (const [, col, val] of this._filters) {
              if (col === "id") {
                const flag = (state.policyFlags ?? []).find((f: any) => f.id === val);
                if (flag && this._updateData !== "__delete__") Object.assign(flag, this._updateData);
              }
            }
          }
          if (t === "rent_buddy_profiles") {
            for (const [, col, val] of this._filters) {
              if (col === "user_id") {
                for (const p of Object.values(state.buddyProfiles ?? {})) {
                  if ((p as any).user_id === val) Object.assign(p as any, this._updateData);
                }
              }
              if (col === "id" && state.buddyProfiles?.[val]) {
                Object.assign(state.buddyProfiles[val], this._updateData);
              }
            }
          }
          return { data: null, error: null };
        }

        // Handle select error overrides — fire when there is no pending write and
        // the table has an armed select error that either has no matchEq filter or
        // whose matchEq filter matches one of the applied eq filters.
        if (
          this._insertData === null &&
          this._updateData === null &&
          this._upsertData === null &&
          state.selectErrorOverrides?.[t]
        ) {
          const override = state.selectErrorOverrides[t];
          const matches =
            !override.matchEq ||
            this._filters.some(
              ([op, col, val]) => op === "eq" && col === override.matchEq!.col && val === override.matchEq!.val,
            );
          if (matches) {
            delete state.selectErrorOverrides[t];
            return { data: null, error: override.error };
          }
        }

        // Handle selects
        if (t === "feature_flags") {
          const flagMap = state.featureFlags ?? {};
          const flagEqFilter = this._filters.find(([op, col]) => op === "eq" && col === "flag");
          if (flagEqFilter && this._maybeSingle) {
            const flagVal = flagMap[flagEqFilter[2] as string];
            return { data: flagVal ?? null, error: null };
          }
          return { data: Object.values(flagMap), error: null, count: Object.values(flagMap).length };
        }

        if (t === "profiles") {
          const profiles = state.profiles ?? {};
          const eqFilter = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqFilter && this._maybeSingle) return { data: profiles[eqFilter[2]] ?? null, error: null };
          return { data: Object.values(profiles), error: null, count: Object.values(profiles).length };
        }

        if (t === "rent_buddy_profiles") {
          const bps = state.buddyProfiles ?? {};
          const eqId   = this._filters.find(([op, col]) => op === "eq" && col === "id");
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");

          if (eqId && this._maybeSingle) return { data: bps[eqId[2]] ?? null, error: null };
          if (eqUser && this._maybeSingle) {
            const match = Object.values(bps).find((p: any) => p.user_id === eqUser[2]);
            return { data: match ?? null, error: null };
          }
          let rows = Object.values(bps);
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          return { data: rows, error: null, count: rows.length };
        }

        if (t === "rent_buddy_applications") {
          const apps = state.applications ?? {};
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          const eqId   = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqUser && this._maybeSingle) return { data: apps[eqUser[2]] ?? null, error: null };
          if (eqId && this._maybeSingle) return { data: Object.values(apps).find((a: any) => a.id === eqId[2]) ?? null, error: null };
          return { data: Object.values(apps), error: null, count: Object.values(apps).length };
        }

        if (t === "rent_buddy_bookings") {
          const bks = state.bookings ?? {};
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle) return { data: bks[eqId[2]] ?? null, error: null };

          let rows = Object.values(bks);
          for (const [op, col, val] of this._filters) {
            if (op === "eq")  rows = rows.filter((r: any) => r[col] === val);
            if (op === "neq") rows = rows.filter((r: any) => r[col] !== val);
            if (op === "in")  rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
            if (op === "lt")  rows = rows.filter((r: any) => r[col] < val);
            if (op === "gt")  rows = rows.filter((r: any) => r[col] > val);
            if (op === "lte") rows = rows.filter((r: any) => r[col] <= val);
            if (op === "gte") rows = rows.filter((r: any) => r[col] >= val);
          }
          const cnt = rows.length;
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          if (this._count && rows.length === 0) {
            return { data: null, count: 0, error: null };
          }
          return { data: rows, count: cnt, error: null };
        }

        if (t === "rent_buddy_reviews") {
          const reviews = state.reviews ?? [];
          let rows = [...reviews];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_disputes") {
          const disputes = state.disputes ?? [];
          let rows = [...disputes];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_policy_flags") {
          const flags = state.policyFlags ?? [];
          let rows = [...flags];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_safety_events") {
          const events = state.safetyEvents ?? [];
          if (this._updateData !== null) {
            // handle resolve update
            return { data: null, error: null };
          }
          return { data: events, count: events.length, error: null };
        }

        if (t === "rent_buddy_route_change_requests") {
          const rcReqs = (state as any).routeChangeRequests ?? [];
          const eqId = this._filters.find(([op, col]: [string,string,any]) => op === "eq" && col === "id");
          if (this._insertData !== null) {
            const newReq = { id: `rcr-${Math.random().toString(36).slice(2)}`, ...this._insertData };
            if (!(state as any).routeChangeRequests) (state as any).routeChangeRequests = [];
            (state as any).routeChangeRequests.push(newReq);
            if (this._maybeSingle) return { data: newReq, error: null };
            return { data: null, error: null };
          }
          if (this._updateData !== null) {
            if (eqId) {
              const idx = rcReqs.findIndex((r: any) => r.id === eqId[2]);
              if (idx >= 0) Object.assign(rcReqs[idx], this._updateData);
            }
            return { data: null, error: null };
          }
          if (eqId && this._maybeSingle) return { data: rcReqs.find((r: any) => r.id === eqId[2]) ?? null, error: null };
          return { data: rcReqs, error: null };
        }

        if (t === "buddy_booking_change_requests") {
          if (!(state as any).bookingChangeRequests) (state as any).bookingChangeRequests = [];
          const bcReqs = (state as any).bookingChangeRequests;
          if (this._insertData !== null) {
            const newReq = { id: `bcr-${Math.random().toString(36).slice(2)}`, status: "pending", ...this._insertData };
            bcReqs.push(newReq);
            if (this._maybeSingle) return { data: newReq, error: null };
            return { data: null, error: null };
          }
          if (this._updateData !== null) {
            let rows = [...bcReqs];
            for (const [op, col, val] of this._filters) {
              if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            }
            for (const r of rows) Object.assign(r, this._updateData);
            return { data: null, error: null };
          }
          let rows = [...bcReqs];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_user_limits") {
          const limits = state.userLimits ?? {};
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          if (eqUser && this._maybeSingle) return { data: limits[eqUser[2]] ?? null, error: null };
          return { data: Object.values(limits), error: null };
        }

        if (t === "trust_events") {
          return { data: state.trustEvents ?? [], error: null };
        }

        if (t === "rent_buddy_tag_consents") {
          const consents = (state as any).tagConsents ?? [];
          let rows = [...consents];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (t === "rent_buddy_support_reports") {
          const reports = (state as any).supportReports ?? [];
          let rows = [...reports];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_training_checklist") {
          const items = (state as any).trainingChecklist ?? [];
          const eqUser = this._filters.find(([op, col]) => op === "eq" && col === "user_id");
          let rows = eqUser ? items.filter((r: any) => r.user_id === eqUser[2]) : [...items];
          const eqItem = this._filters.find(([op, col]) => op === "eq" && col === "item_key");
          if (eqItem) rows = rows.filter((r: any) => r.item_key === eqItem[2]);
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (t === "rent_buddy_admin_response_templates") {
          const templates = (state as any).adminResponseTemplates ?? [];
          let rows = [...templates];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (t === "rent_buddy_launch_controls") {
          const controls: any[] = state.launchControls ?? [];
          // Mirror the cascading lookup getLaunchControl uses: match on each filter applied
          let rows = [...controls];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          // Return count so the deny-by-default check (count > 0) works correctly
          return { data: rows, count: controls.length, error: null };
        }

        if (t === "rent_buddy_global_controls") {
          const gc = state.globalControls ?? {
            id: 1,
            all_bookings_paused: false,
            applications_paused: false,
            cash_balance_paused: false,
            nightlife_paused: false,
            force_full_in_app: false,
            force_public_meetup: false,
            force_delayed_posting: false,
          };
          if (this._maybeSingle) return { data: gc, error: null };
          return { data: [gc], count: 1, error: null };
        }

        if (t === "rent_buddy_city_rollouts") {
          const rollouts: any[] = state.cityRollouts ?? [];
          let rows = [...rollouts];
          for (const [op, col, val] of this._filters) {
            if (op === "eq")    rows = rows.filter((r: any) => r[col] === val);
            if (op === "ilike") rows = rows.filter((r: any) => typeof r[col] === "string" && r[col].toLowerCase() === String(val).toLowerCase());
          }
          // Fall back to a permissive "live" row when no explicit rollout matches,
          // so business-logic tests don't need to seed every city they touch.
          const fallback = { id: "default-rollout", city: "default", status: "public_mvp" };
          if (this._maybeSingle) return { data: rows[0] ?? fallback, error: null };
          return { data: rows.length ? rows : [fallback], count: rows.length || 1, error: null };
        }

        if (t === "rent_buddy_availability") {
          const avRows = (state as any).availability ?? [];
          let rows = [...avRows];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (t === "buddy_availability_exceptions") {
          const exRows = (state as any).availabilityExceptions ?? [];
          let rows = [...exRows];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "lte") rows = rows.filter((r: any) => r[col] <= val);
            if (op === "gte") rows = rows.filter((r: any) => r[col] >= val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "buddy_booking_events") {
          if (this._updateData !== null) return { data: null, error: null };
          const events = (state as any).bookingEvents ?? [];
          let rows = [...events];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "in") rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (this._maybeSingle) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) => {
        if (token === FAKE_TOKEN)  return { data: { user: { id: USER_ID } }, error: null };
        if (token === BUDDY_TOKEN) return { data: { user: { id: BUDDY_USER } }, error: null };
        if (token === ADMIN_TOKEN) return { data: { user: { id: ADMIN_USER } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  // Same alias rewrite as production (app.ts) so tests exercise the exact URLs
  // the mobile client calls, e.g. /api/buddy-bookings/:id/rebook.
  app.use(specAliasRewrite);
  app.use("/api", rentABuddyRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

function setupState(extra: Partial<FakeState> = {}) {
  const { featureFlags: extraFlags, ...restExtra } = extra;
  state = {
    featureFlags: {
      rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
      RENT_BUDDY_NIGHTLIFE_ENABLED: { flag: "RENT_BUDDY_NIGHTLIFE_ENABLED", enabled: true },
      ...(extraFlags ?? {}),
    },
    profiles: {
      [USER_ID]:   { id: USER_ID,   role: "user" },
      [BUDDY_USER]:{ id: BUDDY_USER, role: "user" },
      [ADMIN_USER]:{ id: ADMIN_USER, role: "admin" },
    },
    buddyProfiles: {
      [BUDDY_PROF]: {
        id: BUDDY_PROF, user_id: BUDDY_USER, city: "Tokyo", status: "active",
        admin_status: "active", buddy_level: "new", new_buddy_public_only: true,
        new_buddy_daytime_only: true, new_buddy_max_hours: 2,
        categories: ["city", "language"], category_approvals: {},
        languages: ["English", "Japanese"],
        hourly_rate_usd: 25, max_group_size: 4,
        verified: false, review_count: 0, completed_bookings: 0,
        vibe_tags: [], safety_badges: [], gallery_urls: [],
        risk_hold: false, updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    },
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
        booking_date: new Date().toISOString().slice(0, 10),
        duration_h: 2, group_size: 1, city: "Tokyo", category: "city",
        status: "pending", payment_mode: "full_in_app",
        total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
        safety_status: "normal", route_plan: [],
        updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      },
    },
    policyFlags: [],
    safetyEvents: [],
    safetyCheckins: [],
    disputes: [],
    adminActions: [],
    trustEvents: [],
    reviews: [],
    globalControls: {
      id: 1,
      all_bookings_paused: false,
      applications_paused: false,
      cash_balance_paused: false,
      nightlife_paused: false,
      force_full_in_app: false,
      force_public_meetup: false,
      force_delayed_posting: false,
    },
    cityRollouts: [
      { id: "rollout-tokyo", city: "Tokyo", country: "Japan", status: "public_mvp" },
    ],
    ...restExtra,
  };

  const client = makeClient(USER_ID);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

// ── Feature flag tests ────────────────────────────────────────────────────────

describe("feature flag", () => {
  it("returns 403 when rent_buddy_enabled is false", async () => {
    setupState({
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: false } },
    });
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("allows requests when flag is enabled", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo" });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.buddies));
  });
});

// ── Search proximity ──────────────────────────────────────────────────────────

describe("search proximity", () => {
  it("includes distanceKm for each buddy when lat/lng are provided", async () => {
    setupState();
    // Coordinates in central Tokyo — buddy city "Tokyo" resolves via seed cities (no network).
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo", lat: 35.68, lng: 139.7 });
    assert.equal(r.status, 200);
    assert.ok(r.body.buddies.length > 0, "expected at least one buddy");
    for (const b of r.body.buddies) {
      assert.equal(typeof b.distanceKm, "number", "distanceKm should be a number");
      assert.ok(b.distanceKm < 50, "Tokyo buddy should be near central Tokyo coords");
    }
  });

  it("returns null distanceKm when no coordinates are sent", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo" });
    assert.equal(r.status, 200);
    for (const b of r.body.buddies) {
      assert.equal(b.distanceKm, null);
    }
  });

  it("uses the buddy's meetup-base pin instead of the city centre when set", async () => {
    setupState();
    // Second Tokyo buddy pinned in Shibuya (~ the queried origin), while the
    // default buddy falls back to Tokyo's city-centre seed coordinates.
    state.buddyProfiles["buddy-prof-pinned"] = {
      ...state.buddyProfiles[BUDDY_PROF],
      id: "buddy-prof-pinned", user_id: "buddy-user-pinned",
      meetup_base_lat: 35.6595, meetup_base_lng: 139.7005,
    };
    const r = await req("POST", "/api/rent-a-buddy/search", { city: "Tokyo", lat: 35.6595, lng: 139.7005 });
    assert.equal(r.status, 200);
    const pinned = r.body.buddies.find((b: any) => b.id === "buddy-prof-pinned");
    const unpinned = r.body.buddies.find((b: any) => b.id === BUDDY_PROF);
    assert.ok(pinned && unpinned, "expected both buddies in results");
    assert.equal(pinned.distanceKm, 0, "pinned buddy is measured from their meetup base");
    assert.ok(unpinned.distanceKm > pinned.distanceKm, "unpinned buddy falls back to city centre");
    // Nearest buddy sorts first.
    assert.equal(r.body.buddies[0].id, "buddy-prof-pinned");
  });
});

// ── Meetup-base pin on own profile ────────────────────────────────────────────

describe("meetup base pin", () => {
  it("saves a valid pin via PATCH /me/profile", async () => {
    setupState();
    const r = await req("PATCH", "/api/rent-a-buddy/me/profile",
      { meetupBaseLat: 35.66, meetupBaseLng: 139.7 }, BUDDY_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(state.buddyProfiles[BUDDY_PROF].meetup_base_lat, 35.66);
    assert.equal(state.buddyProfiles[BUDDY_PROF].meetup_base_lng, 139.7);
  });

  it("clears the pin when both coordinates are null", async () => {
    setupState();
    state.buddyProfiles[BUDDY_PROF].meetup_base_lat = 35.66;
    state.buddyProfiles[BUDDY_PROF].meetup_base_lng = 139.7;
    const r = await req("PATCH", "/api/rent-a-buddy/me/profile",
      { meetupBaseLat: null, meetupBaseLng: null }, BUDDY_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(state.buddyProfiles[BUDDY_PROF].meetup_base_lat, null);
    assert.equal(state.buddyProfiles[BUDDY_PROF].meetup_base_lng, null);
  });

  it("rejects out-of-range or partial coordinates", async () => {
    setupState();
    for (const body of [
      { meetupBaseLat: 135.0, meetupBaseLng: 139.7 },   // lat out of range
      { meetupBaseLat: 35.66, meetupBaseLng: 200 },     // lng out of range
      { meetupBaseLat: 35.66 },                          // partial
      { meetupBaseLat: "35.66", meetupBaseLng: 139.7 }, // wrong type
    ]) {
      const r = await req("PATCH", "/api/rent-a-buddy/me/profile", body, BUDDY_TOKEN);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(r.body.error, "invalid_meetup_base");
    }
    assert.equal(state.buddyProfiles[BUDDY_PROF].meetup_base_lat ?? null, null);
  });
});

// ── Policy text ───────────────────────────────────────────────────────────────

describe("policy text", () => {
  it("appears in booking creation response", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.policyText, POLICY_TEXT);
  });

  it("appears in application response", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/apply", {
      city: "Tokyo", categories: ["city"], languages: ["English"],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.policyText, POLICY_TEXT);
  });
});

// ── Policy scanner ────────────────────────────────────────────────────────────

describe("policy scanner", () => {
  it("creates a policy flag for banned keyword in booking notes (not auto-ban)", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      notes: "I need a massage session",
    });
    // massage is medium severity — not blocked, but flag created
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const flags = state.policyFlags ?? [];
    assert.ok(flags.length > 0, "Expected a policy flag to be created");
    assert.equal(flags[0].category, "massage_service");
  });

  it("blocks booking creation for high-severity keyword and creates flag", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      notes: "This is for a hookup",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "policy_violation");
    assert.ok((state.policyFlags ?? []).length > 0, "Flag should still be created");
  });

  it("does NOT auto-ban user — account is not immediately disabled for medium severity", async () => {
    setupState();
    await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      notes: "I need a massage",
    });
    const profile = state.buddyProfiles?.[BUDDY_PROF];
    // admin_status should NOT be changed to 'disabled' for medium
    assert.ok(!profile || profile.admin_status !== "disabled");
  });
});

// ── New Buddy restrictions ────────────────────────────────────────────────────

describe("new-buddy restrictions", () => {
  it("blocks private hotel room as first meetup location", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Private hotel room", category: "city",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_location");
  });

  it("blocks nightlife booking for new Buddy without approval", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Roppongi Station", category: "nightlife",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "category_not_approved");
  });

  it("blocks booking exceeding new-buddy max hours (2h)", async () => {
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 5, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "duration_exceeded");
  });

  it("allows approved nightlife booking for new Buddy with approval", async () => {
    setupState({
      buddyProfiles: {
        [BUDDY_PROF]: {
          ...state.buddyProfiles![BUDDY_PROF],
          category_approvals: { nightlife: true },
          new_buddy_max_hours: 6,
        } as any,
      },
    });
    setupState({
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, city: "Tokyo", status: "active",
          admin_status: "active", buddy_level: "new", new_buddy_public_only: true,
          new_buddy_daytime_only: true, new_buddy_max_hours: 6,
          categories: ["city", "nightlife"], category_approvals: { nightlife: true },
          nightlife_admin_approved: true, id_verified: true, phone_verified: true, verification_status: "verified",
          languages: ["English"], hourly_rate_usd: 25, max_group_size: 4,
          verified: false, review_count: 0, completed_bookings: 0,
          vibe_tags: [], safety_badges: [], gallery_urls: [],
          risk_hold: false, updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
        "bp-traveler": {
          id: "bp-traveler", user_id: USER_ID,
          verification_status: "verified",
          id_verified: true,
          phone_verified: true,
          date_of_birth: "1995-01-01",
        },
      },
    } as any);
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 2, city: "Roppongi Hills", category: "nightlife",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});

// ── User limits ───────────────────────────────────────────────────────────────

describe("user limits", () => {
  it("blocks booking creation when rent_buddy_disabled", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, rent_buddy_disabled: true, buddy_disabled: false, traveler_booking_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
    assert.ok(r.body.message.includes("under review"));
  });

  it("blocks deposit_plus_cash when cash_balance_disabled", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, cash_balance_disabled: true, rent_buddy_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      paymentMode: "deposit_plus_cash",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
    assert.ok(r.body.message.includes("Cash balance"));
  });

  it("blocks nightlife when nightlife_disabled", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, nightlife_disabled: true, rent_buddy_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Roppongi Station", category: "nightlife",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
  });

  it("enforces max_booking_duration_minutes", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, max_booking_duration_minutes: 60, rent_buddy_disabled: false } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 2, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /60 minutes/);
  });
});

// ── Cash balance ──────────────────────────────────────────────────────────────

describe("cash balance", () => {
  it("confirms cash balance successfully when both sides agree", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          status: "in_progress", payment_mode: "deposit_plus_cash",
          total_usd: 50, deposit_usd: 15, cash_balance_usd: 35,
          cash_balance_confirmed_by_buddy: true,
          cash_balance_confirmed_by_traveler: null,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/confirm-cash`, { confirmed: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.disputed, false);
  });

  it("creates dispute when traveler declines cash balance", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          cash_balance_confirmed_by_buddy: true,
          cash_balance_confirmed_by_traveler: null,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 1, city: "Tokyo", category: "city",
          payment_mode: "deposit_plus_cash", total_usd: 30, deposit_usd: 9, cash_balance_usd: 21,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/confirm-cash`, { confirmed: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.disputed, true);
    const disputes = state.disputes ?? [];
    assert.ok(disputes.some((d: any) => d.reason === "cash_balance_disagreement"));
  });
});

// ── Emergency phrase ──────────────────────────────────────────────────────────

describe("emergency phrase", () => {
  it("returns traveler-only prompt and creates safety event", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/emergency-phrase`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.travelerOnly, true);
    assert.ok(Array.isArray(r.body.options), "Expected options array");
    assert.ok(r.body.options.length >= 5);
    const eventTypes = (state.safetyEvents ?? []).map((e: any) => e.event_type);
    assert.ok(eventTypes.includes("emergency_phrase_triggered"), "Expected safety event");
  });

  it("returns 403 when non-traveler calls emergency-phrase", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: "someone-else",
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/emergency-phrase`, {});
    assert.equal(r.status, 403);
  });
});

// ── Safety checkin ────────────────────────────────────────────────────────────

describe("safety checkin", () => {
  it("creates a safety event on distress response", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/checkin`, {
      checkinType: "comfort_30min",
      response: "uncomfortable",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const eventTypes = (state.safetyEvents ?? []).map((e: any) => e.event_type);
    assert.ok(eventTypes.includes("comfort_check_distress"), "Expected distress safety event");
  });

  it("does NOT create safety event for normal checkin response", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress", safety_status: "normal",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          route_plan: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/safety/checkin`, {
      checkinType: "comfort_30min",
      response: "all_good",
    });
    const eventTypes = (state.safetyEvents ?? []).map((e: any) => e.event_type);
    assert.ok(!eventTypes.includes("comfort_check_distress"), "Should NOT create distress event for normal response");
  });
});

// ── Double-blind reviews ──────────────────────────────────────────────────────

describe("double-blind reviews", () => {
  it("review is not immediately public after first submission", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "completed", payment_mode: "full_in_app",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/review`, {
      rating: 5, body: "Great Buddy!",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.unblinded, false, "Should not unblind after only first review");
  });

  it("reveals both reviews after second side submits", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "completed", payment_mode: "full_in_app",
          booking_date: new Date().toISOString().slice(0, 10),
          duration_h: 2, city: "Tokyo", category: "city",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
      reviews: [
        { id: "rev-1", booking_id: BOOKING_ID, reviewer_id: BUDDY_USER, reviewee_id: USER_ID, role: "buddy", rating: 4, is_public: false },
      ],
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/review`, {
      rating: 5, body: "Wonderful experience",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.unblinded, true, "Should unblind after both sides submit");
  });
});

// ── Cancel — Trust Score events ───────────────────────────────────────────────

describe("cancellation Trust Score events", () => {
  it("cancels booking and returns ok (trust event is emitted async)", async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: futureDate.toISOString().slice(0, 10),
          start_time: "14:00",
          duration_h: 2, city: "Tokyo", category: "city",
          status: "confirmed", payment_mode: "full_in_app",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    // Booking should be marked cancelled in state
    assert.equal(state.bookings?.[BOOKING_ID]?.status, "cancelled_by_traveler");
  });
});

// ── Admin — Policy flag management ───────────────────────────────────────────

describe("admin policy flag management", () => {
  it("admin can dismiss a policy flag", async () => {
    setupState({
      policyFlags: [{ id: FLAG_ID, status: "open", severity: "medium", flagged_user_id: USER_ID, category: "massage_service" }],
    });
    const r = await req("POST", `/api/rent-a-buddy/admin/safety/flags/${FLAG_ID}/dismiss`, { notes: "false positive" }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const flag = (state.policyFlags ?? []).find((f: any) => f.id === FLAG_ID);
    assert.equal(flag?.status, "dismissed");
  });

  it("admin can confirm a policy flag — status becomes resolved", async () => {
    setupState({
      policyFlags: [{ id: FLAG_ID, status: "open", severity: "medium", flagged_user_id: USER_ID, category: "massage_service" }],
    });
    const r = await req("POST", `/api/rent-a-buddy/admin/safety/flags/${FLAG_ID}/confirm`, { notes: "confirmed" }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    // Flag must be resolved in state
    const flag = (state.policyFlags ?? []).find((f: any) => f.id === FLAG_ID);
    assert.equal(flag?.status, "resolved", "Expected flag status to be 'resolved'");
    // Admin action should be recorded
    const actions = state.adminActions ?? [];
    assert.ok(actions.some((a: any) => a.action === "confirmed"), "Expected admin action 'confirmed'");
  });

  it("non-admin cannot access safety flags", async () => {
    setupState();
    const r = await req("GET", `/api/rent-a-buddy/admin/safety/flags`);
    assert.equal(r.status, 403);
  });
});

// ── Admin — User limits ───────────────────────────────────────────────────────

describe("admin user limits", () => {
  it("admin can apply full_in_app_payment_required limit", async () => {
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/admin/users/${USER_ID}/limits`, {
      fullInAppPaymentRequired: true,
      reason: "policy violation",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(state.userLimits?.[USER_ID]);
    assert.equal(state.userLimits[USER_ID].full_in_app_payment_required, true);
  });

  it("enforces full_in_app_payment_required on subsequent booking", async () => {
    setupState({ userLimits: { [USER_ID]: { user_id: USER_ID, full_in_app_payment_required: true } } });
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
      paymentMode: "deposit_plus_cash",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "access_limited");
  });
});

// ── Application flow ──────────────────────────────────────────────────────────

describe("application", () => {
  it("submits application and returns policy text", async () => {
    setupState({ applications: {} });
    const r = await req("POST", "/api/rent-a-buddy/apply", {
      city: "Tokyo", categories: ["city", "language"], languages: ["English", "Japanese"],
      motivation: "I love helping tourists discover the real Tokyo!",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.policyText, POLICY_TEXT);
    assert.equal(r.body.message.includes("submitted"), true);
  });

  it("retrieves existing application", async () => {
    setupState({
      applications: {
        [USER_ID]: { id: "app-1", user_id: USER_ID, status: "pending", city: "Tokyo", categories: [], languages: [], social_links: {}, policy_accepted: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      },
    });
    const r = await req("GET", "/api/rent-a-buddy/apply");
    assert.equal(r.status, 200);
    assert.ok(r.body.application);
    assert.equal(r.body.application.status, "pending");
  });
});

// ── Review display fix — reviewee_id uses user_id not profile_id ─────────────

describe("review display (ID domain regression)", () => {
  it("review is stored with buddy user_id as reviewee_id, not profile_id", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: new Date().toISOString().slice(0, 10),
          status: "completed", payment_mode: "full_in_app",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          cash_balance_confirmed_by_traveler: null,
          cash_balance_confirmed_by_buddy: null,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/review`, {
      rating: 5, body: "Great experience!",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // reviewee_id must be the buddy's user_id (BUDDY_USER), not the profile id (BUDDY_PROF)
    const savedReview = (state.reviews ?? [])[0];
    assert.ok(savedReview, "Review should be saved in state");
    assert.equal(savedReview.reviewee_id, BUDDY_USER,
      `reviewee_id should be buddy user_id (${BUDDY_USER}), got ${savedReview.reviewee_id}`);
    assert.notEqual(savedReview.reviewee_id, BUDDY_PROF,
      "reviewee_id must NOT be the rent_buddy_profiles.id (profile id)");
  });

  it("buddy profile reviews endpoint looks up by user_id, not profile_id", async () => {
    // Seed reviews stored with reviewee_id = BUDDY_USER (user_id) — not BUDDY_PROF (profile id)
    setupState({
      reviews: [
        { id: "rev-1", booking_id: BOOKING_ID, reviewer_id: USER_ID, reviewee_id: BUDDY_USER,
          role: "traveler", rating: 5, body: "Excellent!", is_public: true,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ],
    });
    const r = await req("GET", `/api/rent-a-buddy/buddies/${BUDDY_PROF}/reviews`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Should find the review because BUDDY_PROF.user_id = BUDDY_USER
    assert.equal(r.body.total, 1,
      "Review should be returned when filtering by buddy user_id via profile lookup");
    assert.equal(r.body.reviews[0].reviewee_id, BUDDY_USER);
  });
});

// ── Route-change approval / decline ──────────────────────────────────────────

describe("route-change approval workflow", () => {
  it("buddy can propose a route change and it creates a safety event", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: new Date().toISOString().slice(0, 10),
          status: "in_progress", payment_mode: "full_in_app",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/route-change`, {
      newStops: [{ name: "Shinjuku Park", lat: 35.689, lng: 139.692 }],
      reason: "More scenic option",
    }, BUDDY_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const safetyEvents = state.safetyEvents ?? [];
    const routeEvent = safetyEvents.find((e: any) => e.event_type === "route_change_unapproved");
    assert.ok(routeEvent, "Should create a route_change_unapproved safety event for buddy-initiated changes");
  });

  it("traveler can approve a route change request", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: new Date().toISOString().slice(0, 10),
          status: "in_progress", payment_mode: "full_in_app",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    // First create a route change request
    const proposeRes = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/route-change`, {
      newStops: [{ name: "Ueno Park" }], reason: "nice spot",
    }, BUDDY_TOKEN);
    assert.equal(proposeRes.status, 201);
    const changeId = proposeRes.body.routeChangeRequest?.id;
    assert.ok(changeId, "Should return route change request id");

    // Traveler approves it
    const approveRes = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/route-change/${changeId}/approve`);
    assert.equal(approveRes.status, 200, JSON.stringify(approveRes.body));
    assert.ok(approveRes.body.ok);
  });

  it("only the traveler can approve a route change — buddy gets 403", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          booking_date: new Date().toISOString().slice(0, 10),
          status: "in_progress", payment_mode: "full_in_app",
          total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          safety_status: "normal", route_plan: [],
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const proposeRes = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/route-change`, {
      newStops: [{ name: "Shibuya" }], reason: "faster",
    }, BUDDY_TOKEN);
    assert.equal(proposeRes.status, 201);
    const changeId = proposeRes.body.routeChangeRequest?.id;

    // Buddy tries to self-approve — should be 403
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/route-change/${changeId}/approve`, undefined, BUDDY_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
});

// ── Compliance & launch hardening tests ───────────────────────────────────────

describe("Rent a Buddy — compliance: eligibility & launch controls", () => {
  function setupCompliance(overrides: Partial<FakeState & { buddyProfiles?: Record<string, any>; launchControls?: any[] }> = {}) {
    state = {
      featureFlags: {
        rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
      },
      profiles: {
        [USER_ID]: { id: USER_ID, full_name: "Traveler", trust_score: 80 },
        [BUDDY_USER]: { id: BUDDY_USER, full_name: "Buddy", trust_score: 80 },
        [ADMIN_USER]: { id: ADMIN_USER, full_name: "Admin", trust_score: 80, role: "admin" },
      },
      buddyProfiles: {
        "bp-user-1": {
          id: "bp-user-1", user_id: USER_ID, display_name: "Traveler",
          phone_verified: true, id_verified: true, age_verified: true,
          date_of_birth: "1995-01-01",
          risk_review_status: "normal", training_completed: true,
        },
      },
      ...overrides,
    } as any;
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("GET /api/rent-a-buddy/me/eligibility — returns eligibility shape", async () => {
    setupCompliance();
    const r = await req("GET", "/api/rent-a-buddy/me/eligibility");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.eligible === "boolean");
    assert.ok(Array.isArray(r.body.reasons));
    assert.ok(r.body.disclaimers?.main?.length > 10);
    assert.ok(r.body.disclaimers?.adultService?.length > 10);
    assert.ok(r.body.disclaimers?.emergency?.length > 10);
  });

  it("GET /api/rent-a-buddy/availability/location — returns availability shape", async () => {
    setupCompliance({
      launchControls: [
        { id: "lc-1", country_code: null, city: null, category: "city", enabled: true, waitlist_only: false, min_age: 18, nightlife_min_age: 21 },
      ] as any,
    });
    const r = await req("GET", "/api/rent-a-buddy/availability/location?category=city");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.available === "boolean");
    assert.ok(typeof r.body.waitlistOnly === "boolean");
  });

  it("GET /api/rent-a-buddy/launch-status — returns category map", async () => {
    setupCompliance({
      launchControls: [
        { id: "lc-1", country_code: null, city: null, category: "city", enabled: true, waitlist_only: false, min_age: 18, nightlife_min_age: 21 },
        { id: "lc-2", country_code: null, city: null, category: "nightlife", enabled: false, waitlist_only: true, min_age: 18, nightlife_min_age: 21 },
      ] as any,
    });
    const r = await req("GET", "/api/rent-a-buddy/launch-status");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.enabled === "boolean");
    assert.ok(typeof r.body.categories === "object");
  });

  it("admin can create a launch control", async () => {
    setupCompliance();
    const r = await req("POST", "/api/rent-a-buddy/admin/launch-controls", {
      countryCode: null, city: null, category: "food",
      enabled: true, waitlistOnly: false, minAge: 18, nightlifeMinAge: 21,
    }, ADMIN_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.ok);
  });
});

describe("Rent a Buddy — compliance: tag consent", () => {
  function setupTagState() {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [USER_ID]:   { id: USER_ID,   trust_score: 80 },
        [BUDDY_USER]:{ id: BUDDY_USER, trust_score: 80 },
        [ADMIN_USER]:{ id: ADMIN_USER, trust_score: 80, role: "admin" },
      },
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
          status: "completed", safety_status: "normal",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          booking_date: new Date().toISOString().slice(0, 10),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
      buddyProfiles: {
        [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER },
      },
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("traveler can request tag consent from buddy", async () => {
    setupTagState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/tag-consent`, {
      targetUserId: BUDDY_USER,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.ok || r.body.alreadyExists);
  });

  it("tag consent blocked on disputed bookings", async () => {
    state.bookings = {
      [BOOKING_ID]: {
        id: BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
        status: "disputed", safety_status: "normal",
        payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
        booking_date: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    };
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/tag-consent`, {
      targetUserId: BUDDY_USER,
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "consent_blocked");
  });

  it("missing targetUserId returns 400", async () => {
    setupTagState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/tag-consent`, {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

describe("Rent a Buddy — compliance: support reports", () => {
  function setupSupportState(completedAt?: string) {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [USER_ID]:   { id: USER_ID,   trust_score: 80 },
        [BUDDY_USER]:{ id: BUDDY_USER, trust_score: 80 },
        [ADMIN_USER]:{ id: ADMIN_USER, trust_score: 80, role: "admin" },
      },
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
          status: "completed", safety_status: "normal",
          payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
          booking_date: new Date().toISOString().slice(0, 10),
          completed_at: completedAt ?? null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
      buddyProfiles: { [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER } },
      adminResponseTemplates: [
        { id: "tpl-1", category: "adult_service_violation", title: "Zero-tolerance policy applied", body: "This is a serious violation.", is_active: true },
        { id: "tpl-2", category: "harassment",              title: "Harassment report received", body: "We are reviewing your report.", is_active: true },
      ],
    } as any;
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("traveler can file a harassment report", async () => {
    setupSupportState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/support/report`, {
      category: "harassment",
      details: "Buddy made me uncomfortable at the venue.",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.ok);
    assert.equal(r.body.report.category, "harassment");
  });

  it("emergency report always accepted regardless of window", async () => {
    setupSupportState(new Date(Date.now() - 100 * 3_600_000).toISOString());
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/support/report`, {
      category: "emergency",
      details: "I felt unsafe.",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.ok);
  });

  it("cash_dispute outside 72h window is rejected", async () => {
    const oldDate = new Date(Date.now() - 80 * 3_600_000).toISOString();
    setupSupportState(oldDate);
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/support/report`, {
      category: "cash_dispute",
      details: "Money issue.",
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "report_window_expired");
  });

  it("invalid category returns 400", async () => {
    setupSupportState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/support/report`, {
      category: "made_up_category",
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
  });

  it("adult_service_violation report always accepted", async () => {
    setupSupportState(new Date(Date.now() - 200 * 3_600_000).toISOString());
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/support/report`, {
      category: "adult_service_violation",
      details: "Explicit request was made.",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.ok);
    assert.ok(r.body.templateResponse?.title?.length > 0);
  });

  it("admin can list open support reports", async () => {
    setupSupportState();
    const r = await req("GET", "/api/rent-a-buddy/admin/support/reports?status=open", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.reports));
  });

  it("admin can list support templates", async () => {
    setupSupportState();
    const r = await req("GET", "/api/rent-a-buddy/admin/support/templates", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.templates));
  });
});

describe("Rent a Buddy — compliance: training checklist", () => {
  const APP_ID = "app-test-1";

  function setupTrainState() {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [USER_ID]:   { id: USER_ID, trust_score: 80 },
        [ADMIN_USER]:{ id: ADMIN_USER, trust_score: 80, role: "admin" },
      },
      applications: { [USER_ID]: { id: APP_ID, user_id: USER_ID, status: "pending" } },
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("GET training checklist returns all items with completed=false when no rows exist", async () => {
    setupTrainState();
    const r = await req("GET", "/api/rent-a-buddy/me/training-checklist");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.checklist));
    assert.equal(r.body.checklist.length, 10);
    assert.equal(r.body.allComplete, false);
  });

  it("POST training item marks it complete", async () => {
    setupTrainState();
    const r = await req("POST", "/api/rent-a-buddy/me/training-checklist/safety_policy");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.ok);
    assert.ok(typeof r.body.completedCount === "number");
  });

  it("invalid checklist item key returns 400", async () => {
    setupTrainState();
    const r = await req("POST", "/api/rent-a-buddy/me/training-checklist/not_a_real_item");
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_item");
  });

  it("POST training item with no application returns 404", async () => {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: { [USER_ID]: { id: USER_ID, trust_score: 80 } },
      applications: {},
    };
    const r = await req("POST", "/api/rent-a-buddy/me/training-checklist/safety_policy");
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.error, "no_application");
  });
});

describe("Rent a Buddy — compliance: risk review", () => {
  function setupRiskState() {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [USER_ID]:   { id: USER_ID, trust_score: 80 },
        [BUDDY_USER]:{ id: BUDDY_USER, trust_score: 80 },
        [ADMIN_USER]:{ id: ADMIN_USER, trust_score: 80, role: "admin" },
      },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, display_name: "Buddy",
          risk_review_status: "watch", risk_review_note: "Multiple complaints",
        },
      },
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("admin can list buddies under risk review", async () => {
    setupRiskState();
    const r = await req("GET", "/api/rent-a-buddy/admin/risk-review?status=watch", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.profiles));
  });

  it("admin can update a user's risk status", async () => {
    setupRiskState();
    const r = await req("POST", `/api/rent-a-buddy/admin/users/${BUDDY_USER}/risk-status`, {
      status: "limited",
      note: "Repeated no-show complaints",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.ok);
  });

  it("invalid risk status returns 400", async () => {
    setupRiskState();
    const r = await req("POST", `/api/rent-a-buddy/admin/users/${BUDDY_USER}/risk-status`, {
      status: "made_up_status",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
  });

  it("admin can approve nightlife for a buddy", async () => {
    setupRiskState();
    const r = await req("POST", `/api/rent-a-buddy/admin/buddies/${BUDDY_PROF}/nightlife-approve`, {
      approved: true, note: "ID verified, 24 years old",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.ok);
    assert.equal(r.body.approved, true);
  });

  it("admin can update user verification fields", async () => {
    setupRiskState();
    const r = await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER}/verification`, {
      idVerified: true, phoneVerified: true, ageVerified: true, dateOfBirth: "1998-05-12",
    }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.ok);
  });

  it("admin verification PATCH with empty body returns 400", async () => {
    setupRiskState();
    const r = await req("PATCH", `/api/rent-a-buddy/admin/users/${BUDDY_USER}/verification`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
  });
});

describe("Rent a Buddy — compliance: posting defaults & earnings summary", () => {
  function setupPostingState(hasActive = false) {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: { [USER_ID]: { id: USER_ID, trust_score: 80 } },
      bookings: hasActive
        ? {
            [BOOKING_ID]: {
              id: BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
              status: "in_progress", city: "Tokyo",
              payment_mode: "full_in_app", total_usd: 50, deposit_usd: 50, cash_balance_usd: 0,
              booking_date: new Date().toISOString().slice(0, 10),
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            },
          }
        : {},
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("posting defaults returns safe granularity when no active booking", async () => {
    setupPostingState(false);
    const r = await req("GET", "/api/rent-a-buddy/me/posting-defaults");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.defaultDelayPost, false);
    assert.equal(r.body.hasActiveRentABuddyBooking, false);
    assert.equal(r.body.defaultLocationGranularity, "exact");
  });

  it("posting defaults signals delay when active booking exists", async () => {
    setupPostingState(true);
    const r = await req("GET", "/api/rent-a-buddy/me/posting-defaults");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hasActiveRentABuddyBooking, true);
    assert.equal(r.body.defaultDelayPost, true);
    assert.equal(r.body.defaultLocationGranularity, "neighborhood");
    assert.ok(r.body.safetyNote !== null);
  });

  it("earnings breakdown summary returns tax note", async () => {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: { [USER_ID]: { id: USER_ID, trust_score: 80 } },
      buddyProfiles: {
        "bp-u1": { id: "bp-u1", user_id: USER_ID },
      },
      bookings: {},
    };
    const r = await req("GET", "/api/rent-a-buddy/dashboard/earnings/summary");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.taxNote?.length > 10);
    assert.ok(typeof r.body.totalNetUsd === "number");
    assert.ok(Array.isArray(r.body.monthlyBreakdown));
  });
});

// ── Launch control + age enforcement at booking creation ──────────────────────

describe("Rent a Buddy — booking: launch control and age enforcement", () => {
  const BASE_BOOKING_BODY = {
    buddyId: BUDDY_PROF,
    bookingDate: new Date().toISOString().slice(0, 10),
    durationH: 1,
    city: "Tokyo",
    countryCode: "JP",
    category: "city",
  };

  function setupBookingEnforcement(launchControl: any, travelerBuddyProfile?: any) {
    state = {
      featureFlags: {
        rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
        RENT_BUDDY_NIGHTLIFE_ENABLED: { flag: "RENT_BUDDY_NIGHTLIFE_ENABLED", enabled: true },
      },
      profiles: {
        // The traveller's identity now lives on `profiles`, not on the buddy
        // table. These tests express the traveller's state through the
        // `travelerBuddyProfile` argument, so it is mirrored across here: the
        // intent of each test is unchanged, only the column's home is corrected.
        // (`profiles` has no id_verified/phone_verified booleans — ID is
        // verification_level, phone is the phone_verified_at timestamp.)
        [USER_ID]: {
          id: USER_ID,
          trust_score: 80,
          date_of_birth: travelerBuddyProfile?.date_of_birth ?? null,
          verification_level: travelerBuddyProfile?.id_verified ? "id" : "none",
          phone_verified_at: travelerBuddyProfile?.phone_verified ? "2026-01-01T00:00:00Z" : null,
        },
        [BUDDY_USER]:{ id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
          // `country` is the server-side source of the service country now that
          // the gate derives it from the buddy rather than the request body.
          country: "JP",
          hourly_rate_usd: 25, categories: ["city", "nightlife"], category_approvals: {},
          new_buddy_public_only: false, new_buddy_max_hours: 8,
        },
        ...(travelerBuddyProfile ? { "bp-traveler": travelerBuddyProfile } : {}),
      },
      launchControls: [launchControl],
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("booking blocked when global launch control has enabled=false", async () => {
    setupBookingEnforcement({
      id: "lc-global", country_code: null, city: null, category: null,
      enabled: false, waitlist_only: false,
      min_age: 18, nightlife_min_age: 21,
      require_id_verification: false, require_phone_verification: false, full_payment_required: false,
    });
    const r = await req("POST", "/api/rent-a-buddy/bookings", BASE_BOOKING_BODY);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "location_unavailable");
  });

  it("booking blocked with waitlist_only error when waitlist_only=true", async () => {
    setupBookingEnforcement({
      id: "lc-waitlist", country_code: null, city: null, category: null,
      enabled: false, waitlist_only: true,
      min_age: 18, nightlife_min_age: 21,
      require_id_verification: false, require_phone_verification: false, full_payment_required: false,
    });
    const r = await req("POST", "/api/rent-a-buddy/bookings", BASE_BOOKING_BODY);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "waitlist_only");
  });

  it("booking blocked when ID verification required but traveler not verified", async () => {
    setupBookingEnforcement(
      {
        id: "lc-id", country_code: null, city: null, category: null,
        enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: true, require_phone_verification: false, full_payment_required: false,
      },
      { id: "bp-traveler", user_id: USER_ID, date_of_birth: "1995-01-01", id_verified: false, phone_verified: true },
    );
    const r = await req("POST", "/api/rent-a-buddy/bookings", BASE_BOOKING_BODY);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "verification_required");
  });

  it("booking blocked when traveler DOB makes them under 18 (boundary: 1 day short)", async () => {
    // DOB is tomorrow's date N years ago, so they turn 18 tomorrow — still 17 today
    const today = new Date();
    const dob = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate() + 1)
      .toISOString().slice(0, 10);
    setupBookingEnforcement(
      {
        id: "lc-age", country_code: null, city: null, category: null,
        enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      },
      { id: "bp-traveler", user_id: USER_ID, date_of_birth: dob, id_verified: true, phone_verified: true },
    );
    const r = await req("POST", "/api/rent-a-buddy/bookings", BASE_BOOKING_BODY);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "age_requirement");
  });

  it("booking blocked for under-21 nightlife booking (boundary: 1 day short of 21)", async () => {
    // DOB is tomorrow's date N years ago → user turns 21 tomorrow, still 20 today
    const today = new Date();
    const dob = new Date(today.getFullYear() - 21, today.getMonth(), today.getDate() + 1)
      .toISOString().slice(0, 10);
    setupBookingEnforcement(
      {
        id: "lc-nightlife", country_code: null, city: null, category: null,
        enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      },
      { id: "bp-traveler", user_id: USER_ID, date_of_birth: dob, id_verified: true, phone_verified: true },
    );
    const r = await req("POST", "/api/rent-a-buddy/bookings", { ...BASE_BOOKING_BODY, category: "nightlife" });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "age_requirement");
  });

  it("booking succeeds for 18-year-old traveler when launch control allows", async () => {
    // DOB is exactly 18 years ago today
    const today = new Date();
    const dob = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate())
      .toISOString().slice(0, 10);
    setupBookingEnforcement(
      {
        id: "lc-ok", country_code: null, city: null, category: null,
        enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      },
      { id: "bp-traveler", user_id: USER_ID, date_of_birth: dob, id_verified: true, phone_verified: true },
    );
    const r = await req("POST", "/api/rent-a-buddy/bookings", BASE_BOOKING_BODY);
    // Should reach booking creation (201) or a different business error — NOT age_requirement
    assert.notEqual(r.body.error, "age_requirement", JSON.stringify(r.body));
  });

  it("fresh booking returns total_usd of 0 — not NaN — when buddy has no hourly_rate_usd set", async () => {
    setupBookingEnforcement(
      {
        id: "lc-global-null-rate", country_code: null, city: null, category: null,
        enabled: true, waitlist_only: false,
        min_age: 18, nightlife_min_age: 21,
        require_id_verification: false, require_phone_verification: false, full_payment_required: false,
      },
      { id: "bp-traveler", user_id: USER_ID, date_of_birth: "1990-01-01", id_verified: true, phone_verified: true },
    );
    (state.buddyProfiles![BUDDY_PROF] as any).hourly_rate_usd = null;
    const r = await req("POST", "/api/rent-a-buddy/bookings", BASE_BOOKING_BODY);
    assert.equal(r.status, 201, `expected 201 but got ${r.status}: ${JSON.stringify(r.body)}`);
    const totalUsd = r.body.booking?.totalUsd ?? r.body.totalUsd;
    assert.ok(
      typeof totalUsd === "number" && Number.isFinite(totalUsd),
      `total_usd should be a finite number; got ${totalUsd}`,
    );
    assert.equal(totalUsd, 0, `total_usd should be 0 when hourly_rate_usd is null; got ${totalUsd}`);
  });
});

// ── Category risk enforcement ──────────────────────────────────────────────────

describe("Rent a Buddy — booking: category risk levels", () => {
  const BOOKING_DATE = new Date().toISOString().slice(0, 10);

  function setupRiskState(
    buddyVerified: boolean,
    travelerVerified: boolean,
    category = "arrival",
    city = "Manila",
  ) {
    state = {
      featureFlags: {
        rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
      },
      profiles: {
        [USER_ID]:    { id: USER_ID,    trust_score: 80 },
        [BUDDY_USER]: { id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
          hourly_rate_usd: 30, categories: [category], category_approvals: { arrival: true },
          new_buddy_public_only: false, new_buddy_max_hours: 8,
          verification_status: buddyVerified ? "verified" : "unverified",
          id_verified: buddyVerified, phone_verified: buddyVerified,
          nightlife_admin_approved: true,
        },
        "bp-traveler": {
          id: "bp-traveler", user_id: USER_ID,
          verification_status: travelerVerified ? "verified" : "unverified",
          id_verified: travelerVerified, phone_verified: travelerVerified,
          date_of_birth: "1990-01-01",
        },
      },
      launchControls: [],
      // checkRentBuddyAccess fail-closes on unknown status; seed city as public_mvp
      cityRollouts: [{ id: `cr-${city.toLowerCase()}`, city, country_code: "PH", status: "public_mvp", enabled: true }],
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("arrival booking blocked when buddy is not verified (side=buddy)", async () => {
    setupRiskState(false, true, "arrival");
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: BOOKING_DATE, durationH: 2,
      city: "Manila", countryCode: "PH", category: "arrival",
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "verification_required");
    assert.equal(r.body.side, "buddy");
  });

  it("arrival booking blocked when traveler is not verified (side=traveler)", async () => {
    setupRiskState(true, false, "arrival");
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: BOOKING_DATE, durationH: 2,
      city: "Manila", countryCode: "PH", category: "arrival",
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "verification_required");
    assert.equal(r.body.side, "traveler");
  });

  it("arrival booking blocked when both unverified (side=both)", async () => {
    setupRiskState(false, false, "arrival");
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: BOOKING_DATE, durationH: 2,
      city: "Manila", countryCode: "PH", category: "arrival",
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "verification_required");
    assert.equal(r.body.side, "both");
  });

  it("city booking (low risk) proceeds even when both unverified", async () => {
    setupRiskState(false, false, "city");
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: BOOKING_DATE, durationH: 2,
      city: "Manila", countryCode: "PH", category: "city",
    });
    // Should NOT be blocked for verification; may reach a business error or succeed
    assert.notEqual(r.body.error, "verification_required", JSON.stringify(r.body));
  });
});

// ── Review moderation: moderation_status + one-review-per-booking ─────────────

describe("Rent a Buddy — reviews: moderation and duplicate guard", () => {
  const COMPLETED_BOOKING_ID = "completed-bk-1";

  function setupReviewState(extraReviews: any[] = []) {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [USER_ID]:    { id: USER_ID,    trust_score: 80 },
        [BUDDY_USER]: { id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active" },
      },
      bookings: {
        [COMPLETED_BOOKING_ID]: {
          id: COMPLETED_BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
          status: "completed", city: "Tokyo",
          booking_date: "2025-06-01",
          payment_mode: "full_in_app", total_usd: 50,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
      reviews: extraReviews,
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("review submission returns 201 and sets moderation_status=pending_moderation", async () => {
    setupReviewState([]);
    const r = await req("POST", `/api/rent-a-buddy/bookings/${COMPLETED_BOOKING_ID}/review`, {
      rating: 5, body: "Amazing experience!",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // The review should contain moderation_status from the insert
    const insertedReview = state.reviews?.find((rv: any) => rv.booking_id === COMPLETED_BOOKING_ID);
    assert.ok(insertedReview, "review should be inserted");
    assert.equal(insertedReview?.moderation_status, "pending_moderation");
  });

  it("second review submission returns 409 already_reviewed", async () => {
    // Pre-seed an existing review for this booking+reviewer
    setupReviewState([{
      id: "rv-existing", booking_id: COMPLETED_BOOKING_ID,
      reviewer_id: USER_ID, reviewee_id: BUDDY_USER,
      role: "traveler", rating: 4, is_public: false,
      moderation_status: "pending_moderation",
    }]);
    const r = await req("POST", `/api/rent-a-buddy/bookings/${COMPLETED_BOOKING_ID}/review`, {
      rating: 5, body: "Trying to review again",
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_reviewed");
  });

  it("review on non-completed booking returns 400", async () => {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: { [USER_ID]: { id: USER_ID, trust_score: 80 } },
      bookings: {
        "pending-bk": {
          id: "pending-bk", traveler_id: USER_ID, buddy_id: BUDDY_PROF,
          status: "pending", city: "Tokyo",
          booking_date: "2025-06-10",
          payment_mode: "full_in_app", total_usd: 50,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
      buddyProfiles: {
        [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER },
      },
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await req("POST", "/api/rent-a-buddy/bookings/pending-bk/review", { rating: 5 });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
  });
});

// ── Admin review moderation routes ────────────────────────────────────────────

describe("Rent a Buddy — admin: review approve and reject", () => {
  const REVIEW_ID = "review-uuid-mod-1";

  function setupAdminReviewState() {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [ADMIN_USER]: { id: ADMIN_USER, role: "admin", trust_score: 90 },
        [USER_ID]:    { id: USER_ID,    trust_score: 80 },
        [BUDDY_USER]: { id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
          average_rating: 0, review_count: 0 },
      },
      reviews: [{
        id: REVIEW_ID, booking_id: BOOKING_ID,
        reviewer_id: USER_ID, reviewee_id: BUDDY_USER,
        role: "traveler", rating: 4.5,
        is_public: false, moderation_status: "pending_moderation",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }],
      adminActions: [],
    };
    const client = makeClient(ADMIN_USER);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("admin approve sets is_public=true and moderation_status=approved", async () => {
    setupAdminReviewState();
    const r = await req("POST", `/api/rent-a-buddy/admin/reviews/${REVIEW_ID}/approve`, {}, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const action = state.adminActions?.find((a: any) => a.action === "review_approved");
    assert.ok(action, "admin action should be logged");
  });

  it("admin reject sets moderation_status=rejected", async () => {
    setupAdminReviewState();
    const r = await req("POST", `/api/rent-a-buddy/admin/reviews/${REVIEW_ID}/reject`, { reason: "spam" }, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const action = state.adminActions?.find((a: any) => a.action === "review_rejected");
    assert.ok(action, "admin action should be logged");
  });

  it("non-admin cannot approve a review", async () => {
    setupAdminReviewState();
    // Reset client to regular user
    const userClient = makeClient(USER_ID);
    _setTestClient(userClient as any, true);
    _setTestServiceClient(userClient as any);
    const r = await req("POST", `/api/rent-a-buddy/admin/reviews/${REVIEW_ID}/approve`, {}, FAKE_TOKEN);
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  it("admin moderation queue lists pending reviews", async () => {
    setupAdminReviewState();
    const r = await req("GET", "/api/rent-a-buddy/admin/reviews?moderationStatus=pending_moderation", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.reviews));
    assert.equal(r.body.reviews.length, 1);
  });
});

// ── Rebook ─────────────────────────────────────────────────────────────────────

describe("Rent a Buddy — rebook", () => {
  const ORIG_BOOKING_ID = "completed-for-rebook-1";
  const FUTURE_DATE = new Date(Date.now() + 86400000 * 10).toISOString().slice(0, 10);

  function setupRebookState(bookingStatus = "completed") {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: {
        [USER_ID]:    { id: USER_ID,    trust_score: 80 },
        [BUDDY_USER]: { id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
          hourly_rate_usd: 25, categories: ["city"], category_approvals: {},
          new_buddy_public_only: false, new_buddy_max_hours: 8,
        },
      },
      bookings: {
        [ORIG_BOOKING_ID]: {
          id: ORIG_BOOKING_ID, traveler_id: USER_ID, buddy_id: BUDDY_PROF,
          status: bookingStatus, city: "Seoul", country_code: "KR", category: "city",
          duration_h: 3, group_size: 2, notes: "Looking forward to it",
          payment_mode: "full_in_app", total_usd: 75,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("rebook creates a new pending booking (201)", async () => {
    setupRebookState("completed");
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.bookingId, "should return new bookingId");
  });

  it("rebook pre-fills city and category from original", async () => {
    setupRebookState("completed");
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.booking?.city, "Seoul");
    assert.equal(r.body.booking?.category, "city");
    assert.equal(r.body.booking?.status, "pending");
  });

  it("rebook without startTime succeeds and inherits original start_time (201)", async () => {
    setupRebookState("completed");
    // Seed a start_time on the original so we can verify it is carried forward.
    state.bookings![ORIG_BOOKING_ID].start_time = "09:00";
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      // startTime intentionally omitted — server must fall back to original
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.bookingId, "should return new bookingId");
    assert.equal(r.body.booking?.start_time, "09:00", "should inherit original start_time");
  });

  it("rebook blocked when buddy marked unavailable on the requested date", async () => {
    setupRebookState("completed");
    (state as any).availability = [
      { buddy_id: BUDDY_PROF, date: FUTURE_DATE, is_available: false },
    ];
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_not_available");
  });

  it("rebook proceeds when buddy availability is not set for the date (open availability)", async () => {
    setupRebookState("completed");
    (state as any).availability = [];
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "14:00",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });

  it("rebook from non-completed booking returns 400", async () => {
    setupRebookState("in_progress");
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
  });

  it("rebook without bookingDate returns 400", async () => {
    setupRebookState("completed");
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_payload");
  });

  it("rebook without startTime and original has no start_time yields null start_time (201)", async () => {
    setupRebookState("completed");
    // Original booking has no start_time — neither client nor original provides one.
    delete (state.bookings![ORIG_BOOKING_ID] as any).start_time;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      // startTime intentionally omitted
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.bookingId, "should return new bookingId");
    assert.equal(r.body.booking?.start_time ?? null, null, "start_time should be null when neither client nor original supplies one");
  });

  it("rebook with no duration_h or group_size on original yields null for both fields (201)", async () => {
    setupRebookState("completed");
    // Strip the optional numeric fields from the original booking so neither
    // the client nor the original supplies them — server must not substitute
    // arbitrary defaults (0, 1, 2, etc.).
    delete (state.bookings![ORIG_BOOKING_ID] as any).duration_h;
    delete (state.bookings![ORIG_BOOKING_ID] as any).group_size;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "11:00",
      // durationH and groupSize intentionally omitted
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.bookingId, "should return new bookingId");
    assert.equal(
      r.body.booking?.duration_h ?? null,
      null,
      "duration_h should be null when the original omits it and client sends none",
    );
    assert.equal(
      r.body.booking?.group_size ?? null,
      null,
      "group_size should be null when the original omits it and client sends none",
    );
  });

  it("rebook total_usd is 0 — not NaN or a crash — when duration is unknown (201)", async () => {
    setupRebookState("completed");
    // Remove duration_h and group_size from the original booking so neither
    // the original nor the client supplies them.
    delete (state.bookings![ORIG_BOOKING_ID] as any).duration_h;
    delete (state.bookings![ORIG_BOOKING_ID] as any).group_size;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "11:00",
      // durationH and groupSize intentionally omitted
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const totalUsd = r.body.booking?.total_usd;
    assert.ok(
      typeof totalUsd === "number" && !Number.isNaN(totalUsd),
      `total_usd must be a number, got ${JSON.stringify(totalUsd)}`,
    );
    assert.equal(totalUsd, 0, "total_usd should be 0 when duration is unknown");
  });

  it("rebook explicit durationH/groupSize override wins when original has no duration or group size (201)", async () => {
    setupRebookState("completed");
    // Strip the optional numeric fields from the original so it cannot
    // contribute values — only the client-supplied overrides should win.
    delete (state.bookings![ORIG_BOOKING_ID] as any).duration_h;
    delete (state.bookings![ORIG_BOOKING_ID] as any).group_size;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "11:00",
      durationH: 2,
      groupSize: 3,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.bookingId, "should return new bookingId");
    assert.equal(
      r.body.booking?.duration_h,
      2,
      "duration_h should be the client-supplied value, not null",
    );
    assert.equal(
      r.body.booking?.group_size,
      3,
      "group_size should be the client-supplied value, not null",
    );
  });

  it("rebook returns total_usd of 0 — not NaN — when buddy has no hourly_rate_usd set", async () => {
    setupRebookState("completed");
    // Simulate a newly approved buddy who hasn't filled in their rate yet.
    (state.buddyProfiles![BUDDY_PROF] as any).hourly_rate_usd = null;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const totalUsd = r.body.booking?.total_usd;
    assert.ok(
      typeof totalUsd === "number" && isFinite(totalUsd),
      `total_usd must be a finite number; got ${totalUsd}`,
    );
    assert.equal(totalUsd, 0, `total_usd should be 0 when hourly_rate_usd is null; got ${totalUsd}`);
  });

  it("rebook uses client groupSize when original has group_size of zero (201)", async () => {
    setupRebookState("completed");
    // Set group_size to 0 on the original — 0 is non-null, so a naive check
    // could accidentally use it instead of the client-supplied override.
    (state.bookings![ORIG_BOOKING_ID] as any).group_size = 0;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
      groupSize: 3,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(
      r.body.booking?.group_size,
      3,
      "client-supplied groupSize must win even when original.group_size is 0 (non-null)",
    );
  });

  it("rebook honours client-supplied groupSize of 0 — does not fall back to original (201)", async () => {
    setupRebookState("completed");
    // The original booking has group_size = 2.  The client explicitly sends
    // groupSize: 0, which is non-null and should win.  A naive falsy check
    // (`if (groupSize)`) would discard the 0 and fall back to the original's 2.
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
      groupSize: 0,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(
      r.body.booking?.group_size,
      0,
      "client-supplied groupSize of 0 must be used, not treated as falsy and replaced by original.group_size",
    );
  });

  it("rebook honours client-supplied durationH of 0 — does not fall back to original (201)", async () => {
    setupRebookState("completed");
    // The original booking has duration_h = 3.  The client explicitly sends
    // durationH: 0, which is non-null and should win.  A naive falsy check
    // (`if (durationH)`) would discard the 0 and fall back to the original's 3.
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
      durationH: 0,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(
      r.body.booking?.duration_h,
      0,
      "client-supplied durationH of 0 must be used, not treated as falsy and replaced by original.duration_h",
    );
  });

  it("rebook total_usd reflects buddy's current rate — not the original booking amount", async () => {
    setupRebookState("completed");
    // Original booking: duration_h=3, total_usd=75 (i.e. was priced at $25/h).
    // Buddy has since raised their rate to $40/h.
    // Rebooking the same duration should produce 40 * 3 = $120, not the original $75.
    state.buddyProfiles![BUDDY_PROF].hourly_rate_usd = 40;
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
      // durationH not sent — falls back to original's duration_h of 3
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(
      r.body.booking?.total_usd,
      120,
      `total_usd should be 40 * 3 = 120 (new rate), not 75 (original booking amount); got ${r.body.booking?.total_usd}`,
    );
  });

  it("rebook for someone else's booking returns 403", async () => {
    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      profiles: { [USER_ID]: { id: USER_ID, trust_score: 80 } },
      buddyProfiles: { [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER } },
      bookings: {
        [ORIG_BOOKING_ID]: {
          id: ORIG_BOOKING_ID, traveler_id: "someone-else",
          buddy_id: BUDDY_PROF, status: "completed",
          city: "Seoul", category: "city",
          payment_mode: "full_in_app", total_usd: 75,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        },
      },
    };
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await req("POST", `/api/buddy-bookings/${ORIG_BOOKING_ID}/rebook`, {
      bookingDate: FUTURE_DATE,
      startTime: "10:00",
    });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
  });
});

// ── Availability settings & vacation/blocked dates (dashboard) ─────────────────

describe("Rent a Buddy — dashboard availability settings & blocked dates", () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  const IN_5 = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const IN_10 = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  const IN_7 = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

  function setupBuddy(extra: Partial<FakeState> = {}) {
    state = {
      featureFlags: {
        rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true },
        RENT_BUDDY_NIGHTLIFE_ENABLED: { flag: "RENT_BUDDY_NIGHTLIFE_ENABLED", enabled: true },
      },
      profiles: {
        [USER_ID]:   { id: USER_ID, trust_score: 80 },
        [BUDDY_USER]:{ id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
          hourly_rate_usd: 25, categories: ["city"], category_approvals: {},
          available_now: false, min_notice_hours: null, buffer_minutes: null, max_bookings_per_day: null,
        },
      },
      ...extra,
    };
    const client = makeClient(BUDDY_USER);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
  }

  it("PATCH settings saves a blocked range as a vacation exception", async () => {
    setupBuddy();
    const r = await req("PATCH", "/api/rent-a-buddy/dashboard/availability/settings", {
      blockedFrom: IN_5, blockedTo: IN_10, maxBookingsPerDay: 4,
    }, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const exceptions = (state as any).availabilityExceptions ?? [];
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].exception_type, "vacation");
    assert.equal(exceptions[0].exception_date, IN_5);
    assert.equal(exceptions[0].end_date, IN_10);
    assert.equal(state.buddyProfiles?.[BUDDY_PROF].max_bookings_per_day, 4);
  });

  it("GET dashboard availability returns the saved blocked range in settings", async () => {
    setupBuddy();
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_10,
    }];
    const r = await req("GET", "/api/rent-a-buddy/dashboard/availability", undefined, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settings.blockedFrom, IN_5);
    assert.equal(r.body.settings.blockedTo, IN_10);
  });

  it("PATCH settings with empty blockedFrom clears the vacation exception", async () => {
    setupBuddy();
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_10,
    }];
    const r = await req("PATCH", "/api/rent-a-buddy/dashboard/availability/settings", {
      blockedFrom: "", blockedTo: "",
    }, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(((state as any).availabilityExceptions ?? []).length, 0);
  });

  it("PATCH settings rejects an inverted blocked range", async () => {
    setupBuddy();
    const r = await req("PATCH", "/api/rent-a-buddy/dashboard/availability/settings", {
      blockedFrom: IN_10, blockedTo: IN_5,
    }, BUDDY_TOKEN);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_blocked_range");
  });

  it("PATCH settings rejects malformed dates", async () => {
    setupBuddy();
    const r = await req("PATCH", "/api/rent-a-buddy/dashboard/availability/settings", {
      blockedFrom: "not-a-date",
    }, BUDDY_TOKEN);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error, "invalid_blocked_from");
  });

  it("booking on a blocked date is rejected with buddy_unavailable", async () => {
    setupBuddy();
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_10,
    }];
    // traveler books inside the blocked range
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: IN_7, durationH: 1,
      city: "Tokyo", countryCode: "JP", category: "city",
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
  });

  it("booking outside the blocked range is not rejected as buddy_unavailable", async () => {
    setupBuddy();
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_7,
    }];
    const client = makeClient(USER_ID);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: TODAY, durationH: 1,
      city: "Tokyo", countryCode: "JP", category: "city",
    });
    assert.notEqual(r.body.error, "buddy_unavailable", JSON.stringify(r.body));
  });

  function seedRequestedBooking() {
    (state as any).bookings = {
      "bk-suggest-1": {
        id: "bk-suggest-1", traveler_id: USER_ID, buddy_id: BUDDY_PROF,
        status: "requested", booking_date: TODAY, start_time: "10:00", duration_h: 2,
      },
    };
  }

  it("suggest-changes onto a blocked date is rejected with buddy_unavailable", async () => {
    setupBuddy();
    seedRequestedBooking();
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_10,
    }];
    const r = await req("POST", "/api/rent-a-buddy/bookings/bk-suggest-1/suggest", {
      proposedDate: IN_7, message: "How about later?",
    }, BUDDY_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
  });

  it("suggest-changes onto a free date succeeds", async () => {
    setupBuddy();
    seedRequestedBooking();
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_7,
    }];
    const r = await req("POST", "/api/rent-a-buddy/bookings/bk-suggest-1/suggest", {
      proposedDate: IN_10, proposedTime: "14:00",
    }, BUDDY_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const crs = (state as any).bookingChangeRequests ?? [];
    assert.ok(crs.some((c: any) => c.change_field === "date" && c.proposed_value?.date === IN_10));
  });

  it("date change-request onto a blocked date is rejected with buddy_unavailable", async () => {
    setupBuddy();
    seedRequestedBooking();
    (state as any).bookings["bk-suggest-1"].status = "scheduled";
    (state as any).availabilityExceptions = [{
      id: "ex-1", buddy_id: BUDDY_PROF, exception_type: "blocked",
      exception_date: IN_5, end_date: IN_10,
    }];
    const r = await req("POST", "/api/buddy-bookings/bk-suggest-1/change-request", {
      changeField: "date", proposedValue: { date: IN_7 },
    }, BUDDY_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
  });

  it("accepting a date change-request re-checks blocked dates at apply time", async () => {
    setupBuddy();
    seedRequestedBooking();
    (state as any).bookings["bk-suggest-1"].status = "scheduled";
    // Raise the change request while the date is still free
    const raise = await req("POST", "/api/buddy-bookings/bk-suggest-1/change-request", {
      changeField: "date", proposedValue: { date: IN_7 },
    }, BUDDY_TOKEN);
    assert.equal(raise.status, 201, JSON.stringify(raise.body));
    const crId = raise.body.changeRequest?.id;
    assert.ok(crId, JSON.stringify(raise.body));
    // Buddy then blocks the range; traveler tries to accept
    (state as any).availabilityExceptions = [{
      id: "ex-late", buddy_id: BUDDY_PROF, exception_type: "vacation",
      exception_date: IN_5, end_date: IN_10,
    }];
    const r = await req("POST", "/api/buddy-bookings/bk-suggest-1/respond-change-request", {
      changeRequestId: crId, decision: "accept",
    }, FAKE_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "buddy_unavailable");
    // Booking date must be unchanged
    assert.equal((state as any).bookings["bk-suggest-1"].booking_date, TODAY);
  });
});

// ── Grace-period sweep ────────────────────────────────────────────────────────
describe("Rent a Buddy — grace-period sweep: no_show_pending → disputed", () => {
  const INTERNAL_KEY = "test-sweep-secret-179";

  function reqSweep(): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL("/api/internal/buddy-requests/expire", base);
      const r = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-key": INTERNAL_KEY },
        },
        (inRes) => {
          let raw = "";
          inRes.on("data", (c) => (raw += c));
          inRes.on("end", () => {
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            resolve({ status: inRes.statusCode ?? 0, body: parsed });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
  }

  before(() => {
    process.env.INTERNAL_API_SECRET = INTERNAL_KEY;
  });

  after(() => {
    delete process.env.INTERNAL_API_SECRET;
  });

  it("escalates a no_show_pending booking past its grace expiry to disputed", async () => {
    // Grace window expired 3 hours ago — sweep must promote to disputed.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-expired": {
          id: "bk-ns-expired",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
    };
    // Seed the no_show_reported event with BUDDY_USER as the reporter — intentionally
    // different from traveler_id (USER_ID) so the assertion can distinguish
    // "read reporter from event row" from "fell back to traveler_id".
    (state as any).bookingEvents = [
      { id: "ev-ns-1", booking_id: "bk-ns-expired", actor_user_id: BUDDY_USER, event: "no_show_reported" },
    ];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.noShowEscalated, 1, JSON.stringify(r.body));
    assert.equal(
      state.bookings!["bk-ns-expired"].status,
      "disputed",
      "booking past grace expiry must be promoted to disputed",
    );
    assert.ok(
      (state.disputes ?? []).some((d: any) => d.booking_id === "bk-ns-expired" && d.reason === "no_show"),
      "a no_show dispute row must be created",
    );
    // Happy-path assertion: when a no_show_reported event row IS present the
    // escalation event must record that reporter (BUDDY_USER) as actor_user_id —
    // not the traveler_id (USER_ID) fallback, which differs from the reporter here.
    const escalationEvent = ((state as any).bookingEvents ?? []).find(
      (e: any) => e.booking_id === "bk-ns-expired" && e.event === "no_show_escalated",
    );
    assert.ok(escalationEvent, "a no_show_escalated event row must be written for the happy path");
    assert.equal(
      escalationEvent.actor_user_id,
      BUDDY_USER,
      "escalation event actor_user_id must equal the seeded reporter (BUDDY_USER), not the traveler_id fallback (USER_ID)",
    );
  });

  it("falls back to traveler_id when no no_show_reported event row exists", async () => {
    // Grace window expired 2 hours ago, but NO no_show_reported event was seeded.
    // The sweeper must still promote the booking to disputed and set raised_by = traveler_id.
    const PAST = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const TRAVELER = "traveler-fallback-uid";
    const client = makeClient(TRAVELER);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-no-event": {
          id: "bk-ns-no-event",
          traveler_id: TRAVELER,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
    };
    // Deliberately omit any no_show_reported event rows.
    (state as any).bookingEvents = [];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.noShowEscalated, 1, JSON.stringify(r.body));
    assert.equal(
      state.bookings!["bk-ns-no-event"].status,
      "disputed",
      "booking past grace expiry must be promoted to disputed even with no event row",
    );
    const dispute = (state.disputes ?? []).find(
      (d: any) => d.booking_id === "bk-ns-no-event" && d.reason === "no_show",
    );
    assert.ok(dispute, "a no_show dispute row must be created");
    assert.equal(
      dispute.raised_by,
      TRAVELER,
      "dispute raised_by must fall back to traveler_id when no_show_reported event is absent",
    );
    const escalationEvent = ((state as any).bookingEvents ?? []).find(
      (e: any) => e.booking_id === "bk-ns-no-event" && e.event === "no_show_escalated",
    );
    assert.ok(escalationEvent, "a no_show_escalated event row must be written");
    assert.equal(
      escalationEvent.actor_user_id,
      TRAVELER,
      "escalation event actor_user_id must fall back to traveler_id when no_show_reported event is absent",
    );
  });

  it("leaves a no_show_pending booking whose grace window has not yet expired untouched", async () => {
    // Grace window expires 1 hour from now — sweep must not touch this booking.
    const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-live": {
          id: "bk-ns-live",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: FUTURE,
        },
      },
    };
    (state as any).bookingEvents = [];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.noShowEscalated, 0, JSON.stringify(r.body));
    assert.equal(
      state.bookings!["bk-ns-live"].status,
      "no_show_pending",
      "booking within grace window must remain no_show_pending",
    );
  });

  it("does not escalate a no_show_pending booking whose grace expiry equals the sweep's now (boundary — .lt() is strict)", async () => {
    // The sweep uses .lt("no_show_grace_expires_at", now) — strict less-than.
    // A booking expiring at exactly the sweep's "now" must NOT be escalated
    // (equality is not strictly less-than).
    //
    // To test this deterministically we pin global Date so the sweep handler
    // always sees FIXED_NOW as its current time.  We then assert:
    //   • expiry === FIXED_NOW  → noShowEscalated 0  (equality excluded by .lt)
    //   • expiry === FIXED_NOW - 1 ms → noShowEscalated 1  (strictly past, included)
    // This pair definitively documents the operator semantics and will catch
    // any future change from .lt() to .lte().
    const FIXED_NOW = "2025-06-01T12:00:00.000Z";
    const FIXED_NOW_MS = new Date(FIXED_NOW).getTime();
    const ONE_MS_BEFORE = new Date(FIXED_NOW_MS - 1).toISOString();

    const OriginalDate = global.Date as any;
    // Replace global Date so new Date() inside the sweep handler returns FIXED_NOW.
    function FakeDate(this: any, ...args: any[]) {
      if (args.length === 0) {
        return new OriginalDate(FIXED_NOW);
      }
      return new OriginalDate(...args);
    }
    FakeDate.now = () => FIXED_NOW_MS;
    FakeDate.parse = OriginalDate.parse.bind(OriginalDate);
    FakeDate.UTC = OriginalDate.UTC.bind(OriginalDate);
    FakeDate.prototype = OriginalDate.prototype;
    (global as any).Date = FakeDate;

    try {
      // --- Case A: expiry === FIXED_NOW → must NOT be escalated ---
      {
        const client = makeClient(USER_ID);
        _setTestClient(client as any, false);
        _setTestServiceClient(client as any);

        state = {
          bookings: {
            "bk-ns-eq-boundary": {
              id: "bk-ns-eq-boundary",
              traveler_id: USER_ID,
              buddy_id: BUDDY_PROF,
              status: "no_show_pending",
              no_show_grace_expires_at: FIXED_NOW,
            },
          },
        };
        (state as any).bookingEvents = [];

        const r = await reqSweep();
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(
          r.body.noShowEscalated,
          0,
          "booking expiring at exactly now must NOT be escalated — .lt() is strict less-than, equality is excluded",
        );
        assert.equal(
          state.bookings!["bk-ns-eq-boundary"].status,
          "no_show_pending",
          "booking at the exact expiry boundary must remain no_show_pending",
        );
      }

      // --- Case B: expiry === FIXED_NOW - 1 ms → must be escalated ---
      {
        const client = makeClient(USER_ID);
        _setTestClient(client as any, false);
        _setTestServiceClient(client as any);

        state = {
          bookings: {
            "bk-ns-1ms-past": {
              id: "bk-ns-1ms-past",
              traveler_id: USER_ID,
              buddy_id: BUDDY_PROF,
              status: "no_show_pending",
              no_show_grace_expires_at: ONE_MS_BEFORE,
            },
          },
        };
        (state as any).bookingEvents = [
          { id: "ev-1ms", booking_id: "bk-ns-1ms-past", actor_user_id: USER_ID, event: "no_show_reported" },
        ];

        const r = await reqSweep();
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(
          r.body.noShowEscalated,
          1,
          "booking expiring 1 ms before now MUST be escalated — strictly less-than now",
        );
        assert.equal(
          state.bookings!["bk-ns-1ms-past"].status,
          "disputed",
          "booking 1 ms past expiry must be promoted to disputed",
        );
      }
    } finally {
      (global as any).Date = OriginalDate;
    }
  });

  it("does not touch bookings with statuses other than no_show_pending", async () => {
    // Put a past-expired timestamp on several non-no_show_pending bookings;
    // the sweep must leave all of them unchanged.
    const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-sched": { id: "bk-sched", traveler_id: USER_ID, buddy_id: BUDDY_PROF, status: "scheduled",  no_show_grace_expires_at: PAST },
        "bk-disp":  { id: "bk-disp",  traveler_id: USER_ID, buddy_id: BUDDY_PROF, status: "disputed",   no_show_grace_expires_at: PAST },
        "bk-comp":  { id: "bk-comp",  traveler_id: USER_ID, buddy_id: BUDDY_PROF, status: "completed",  no_show_grace_expires_at: PAST },
      },
    };
    (state as any).bookingEvents = [];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.noShowEscalated, 0, JSON.stringify(r.body));
    assert.equal(state.bookings!["bk-sched"].status, "scheduled",  "scheduled booking must not be touched");
    assert.equal(state.bookings!["bk-disp"].status,  "disputed",   "disputed booking must not be touched");
    assert.equal(state.bookings!["bk-comp"].status,  "completed",  "completed booking must not be touched");
  });

  it("reuses an existing no_show dispute row — does not create a duplicate", async () => {
    // Simulate a concurrent sweep run that already created the dispute row.
    // The sweep must reuse it (exactly one dispute row) and still promote the booking.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-dup": {
          id: "bk-ns-dup",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
      // Pre-seed an existing no_show dispute row, as if a concurrent sweep already inserted it.
      disputes: [
        { id: "disp-existing-1", booking_id: "bk-ns-dup", raised_by: USER_ID, reason: "no_show", status: "open" },
      ],
    };
    (state as any).bookingEvents = [
      { id: "ev-ns-dup-1", booking_id: "bk-ns-dup", actor_user_id: USER_ID, event: "no_show_reported" },
    ];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.noShowEscalated, 1, JSON.stringify(r.body));

    // Booking must be promoted to disputed.
    assert.equal(
      state.bookings!["bk-ns-dup"].status,
      "disputed",
      "booking must be promoted to disputed even when a dispute row already exists",
    );

    // Exactly one dispute row must exist — no duplicate was inserted.
    const noShowDisputes = (state.disputes ?? []).filter(
      (d: any) => d.booking_id === "bk-ns-dup" && d.reason === "no_show",
    );
    assert.equal(
      noShowDisputes.length,
      1,
      `expected exactly 1 no_show dispute row but found ${noShowDisputes.length}`,
    );
  });

  it("skips the booking promotion and escalation count when the dispute-row insert errors", async () => {
    // Grace window expired 3 hours ago — the booking is eligible for escalation.
    // But the rent_buddy_disputes insert returns a DB error, so the sweep must
    // abandon this booking: noShowEscalated stays 0, booking stays no_show_pending,
    // and no buddy_booking_events row is written.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-dispute-err": {
          id: "bk-ns-dispute-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
      // Arm the error override so the rent_buddy_disputes insert returns a DB error.
      insertErrorOverrides: {
        rent_buddy_disputes: { message: "simulated DB error on disputes insert", code: "23505" },
      },
    };
    (state as any).bookingEvents = [
      { id: "ev-ns-err-1", booking_id: "bk-ns-dispute-err", actor_user_id: USER_ID, event: "no_show_reported" },
    ];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The sweep must NOT count a failed dispute insert as a successful escalation.
    assert.equal(
      r.body.noShowEscalated,
      0,
      "noShowEscalated must be 0 when the dispute-row insert errors",
    );

    // The booking must remain no_show_pending — the dispute insert failing
    // must prevent the booking-status update from running at all.
    assert.equal(
      state.bookings!["bk-ns-dispute-err"].status,
      "no_show_pending",
      "booking must remain no_show_pending when the dispute-row insert errors",
    );

    // No no_show_escalated event must be written when the escalation was aborted.
    const escalationEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) => e.booking_id === "bk-ns-dispute-err" && e.event === "no_show_escalated",
    );
    assert.equal(
      escalationEvents.length,
      0,
      "no no_show_escalated event must be written when the dispute-row insert errors",
    );
  });

  it("does NOT count the escalation when the booking status update itself errors — booking remains no_show_pending", async () => {
    // The sweep must only increment noShowEscalatedCount when the
    // .update({ status: 'disputed' }) DB call succeeds.  If the call errors
    // the booking is left in no_show_pending and the count must stay at 0.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-update-err": {
          id: "bk-ns-update-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
      // Arm the update error override so the rent_buddy_bookings status update
      // returns a DB error — leaving the booking un-promoted.
      updateErrorOverrides: {
        rent_buddy_bookings: { message: "simulated DB error on bookings update", code: "23514" },
      },
    };
    (state as any).bookingEvents = [
      { id: "ev-ns-upd-err-1", booking_id: "bk-ns-update-err", actor_user_id: USER_ID, event: "no_show_reported" },
    ];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The sweep must NOT count a failed update as a successful escalation.
    assert.equal(
      r.body.noShowEscalated,
      0,
      "noShowEscalated must be 0 when the booking status update DB call errors",
    );

    // The booking must remain no_show_pending because the DB update failed.
    assert.equal(
      state.bookings!["bk-ns-update-err"].status,
      "no_show_pending",
      "booking status must remain no_show_pending when the status update DB call errors",
    );

    // The no_show_escalated event row must NOT be written when the booking was
    // never actually promoted to disputed — the `continue` after updateError
    // must skip the buddy_booking_events insert.
    const escalationEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) =>
        e.booking_id === "bk-ns-update-err" && e.event === "no_show_escalated",
    );
    assert.equal(
      escalationEvents.length,
      0,
      "no no_show_escalated event must be written when the booking status update DB call errors",
    );

    // ORDERING NOTE — the dispute row is now inserted BEFORE the booking-status
    // update.  When the update errors, the dispute row has already been committed
    // (it is an orphan in the sense that the booking remains no_show_pending).
    // That is an acceptable trade-off: the alternative (inserting the dispute
    // only after a successful booking update) would allow a failed dispute insert
    // to silently leave a booking promoted to disputed without any dispute record.
    const orphanedDisputes = (state.disputes ?? []).filter(
      (d: any) => d.booking_id === "bk-ns-update-err" && d.reason === "no_show",
    );
    assert.equal(
      orphanedDisputes.length,
      1,
      "a dispute row is written before the booking update; if the update errors " +
        "the dispute row remains (acceptable orphan — the booking stays no_show_pending)",
    );
  });

  it("still counts the escalation and marks booking disputed when the event-row insert fails", async () => {
    // A DB error on the buddy_booking_events insert must NOT cause the sweep to
    // throw or un-do the already-committed status update.  noShowEscalated must
    // still be 1 and the booking must reach 'disputed'.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-event-insert-err": {
          id: "bk-ns-event-insert-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
      // Arm the error override so the buddy_booking_events insert returns a DB error.
      insertErrorOverrides: {
        buddy_booking_events: { message: "simulated DB error on event insert", code: "23505" },
      },
    };
    (state as any).bookingEvents = [
      { id: "ev-event-err-1", booking_id: "bk-ns-event-insert-err", actor_user_id: USER_ID, event: "no_show_reported" },
    ];

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The sweep must still count the escalation — the booking was promoted before the event insert.
    assert.equal(
      r.body.noShowEscalated,
      1,
      "noShowEscalated must be 1 even when the event-row insert errors",
    );

    // The booking must have been promoted to 'disputed' before the failing event insert.
    assert.equal(
      state.bookings!["bk-ns-event-insert-err"].status,
      "disputed",
      "booking must be promoted to 'disputed' even when the event-row insert errors",
    );
  });

  it("logs the booking ID to console.error when the event-row insert fails", async () => {
    // When the buddy_booking_events insert returns a DB error the sweep must call
    // console.error with the affected booking ID so operators can identify which
    // bookings lost their audit trail.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ns-event-log-err": {
          id: "bk-ns-event-log-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "no_show_pending",
          no_show_grace_expires_at: PAST,
        },
      },
      // Arm the error override so the buddy_booking_events insert returns a DB error.
      insertErrorOverrides: {
        buddy_booking_events: { message: "simulated DB error on event insert", code: "23505" },
      },
    };
    (state as any).bookingEvents = [
      { id: "ev-event-log-err-1", booking_id: "bk-ns-event-log-err", actor_user_id: USER_ID, event: "no_show_reported" },
    ];

    // Spy on console.error to capture calls made during the sweep.
    const errorCalls: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    try {
      const r = await reqSweep();
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } finally {
      console.error = originalConsoleError;
    }

    // At least one console.error call must include the booking ID so operators
    // know which booking lost its audit trail.
    const mentionsBookingId = errorCalls.some((args) =>
      args.some((a) => typeof a === "string" && a.includes("bk-ns-event-log-err")),
    );
    assert.ok(
      mentionsBookingId,
      `expected console.error to be called with booking ID 'bk-ns-event-log-err' when the event-row insert fails, got: ${JSON.stringify(errorCalls)}`,
    );
  });

  it("expired-request count stays at zero when the status update DB call fails", async () => {
    // A stale requested booking whose .update({ status: 'expired' }) errors must
    // leave expired = 0 and the booking in its original status.
    const PAST = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      bookings: {
        "bk-expire-err": {
          id: "bk-expire-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "requested",
          expires_at: PAST,
        },
      },
      // Arm the update error override so the expired-requests status update errors.
      updateErrorOverrides: {
        rent_buddy_bookings: { message: "simulated DB error on expiry update", code: "23514" },
      },
    };

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // expired count must be 0 — the DB update failed.
    assert.equal(
      r.body.expired,
      0,
      "expired must be 0 when the status update DB call errors",
    );

    // The booking must retain its original status because the update failed.
    assert.equal(
      state.bookings!["bk-expire-err"].status,
      "requested",
      "booking status must remain 'requested' when the expiry update DB call errors",
    );

    // No buddy_booking_events rows must have been inserted — side-effects are
    // suppressed when the status update fails.
    const expiredEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) => e.event === "request_expired",
    );
    assert.equal(
      expiredEvents.length,
      0,
      "no request_expired booking events must be inserted when the status update DB call errors",
    );

    // No notifications must have been queued — notifyBookingParty is inside the
    // same if (!expireErr) guard and must not fire when the update fails.
    const notifications = (state as any).notifications ?? [];
    assert.equal(
      notifications.length,
      0,
      "no notifications must be queued when the expired-request status update DB call errors",
    );
  });

  it("returns 200 with expired: 0 when the stale-requests DB fetch itself errors — not just the update", async () => {
    // The sweep's step-1 query (.in("status",["pending","requested"]).lt("expires_at", now))
    // may itself return a DB error. The route must not crash and must report
    // expired: 0 without touching any booking, distinguishing a fetch-error
    // from an update-error (already covered by the sibling test above).
    const PAST = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      bookings: {
        "bk-fetch-err": {
          id: "bk-fetch-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "requested",
          expires_at: PAST,
        },
      },
      // Arm a select error override that fires on the stale-requests fetch (the
      // sweep's very first query against this table, using .in() rather than
      // .eq() — matchEq is omitted so it fires unconditionally on the next select).
      selectErrorOverrides: {
        rent_buddy_bookings: {
          error: { message: "simulated DB error fetching stale requests", code: "PGRST301" },
        },
      },
    };

    const r = await reqSweep();

    // Sweep must not crash — it must respond with HTTP 200.
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // expired count must be 0 — the initial fetch errored, so the update/loop
    // must never run.
    assert.equal(
      r.body.expired,
      0,
      "expired must be 0 when the stale-requests DB fetch itself errors",
    );

    // The booking must retain its original status — the fetch failure must
    // prevent any state transition, not just report a wrong count.
    assert.equal(
      state.bookings!["bk-fetch-err"].status,
      "requested",
      "booking status must remain 'requested' when the stale-requests DB fetch errors",
    );

    // No buddy_booking_events rows must have been inserted.
    const expiredEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) => e.event === "request_expired",
    );
    assert.equal(
      expiredEvents.length,
      0,
      "no request_expired booking events must be inserted when the stale-requests DB fetch errors",
    );
  });

  it("both stale bookings retain status 'requested' when the batch expiry update errors — confirms .in() atomicity", async () => {
    // Two stale requested bookings; the single .update().in("id", ids) call is
    // armed to error.  Neither booking should be transitioned to 'expired' —
    // expired count must be 0.  This confirms the implementation uses a single
    // batch update (not a per-booking loop that could partially succeed).
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      featureFlags: { rent_buddy_enabled: { flag: "rent_buddy_enabled", enabled: true } },
      bookings: {
        "bk-batch-err-1": {
          id: "bk-batch-err-1",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "requested",
          expires_at: PAST,
        },
        "bk-batch-err-2": {
          id: "bk-batch-err-2",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "requested",
          expires_at: PAST,
        },
      },
      // Arm the update error override — the single .update().in("id", ids) call
      // will fail, so neither booking may be transitioned.
      updateErrorOverrides: {
        rent_buddy_bookings: { message: "simulated DB error on batch expiry update", code: "23514" },
      },
    };

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // expired count must be 0 — the batch update failed atomically.
    assert.equal(
      r.body.expired,
      0,
      "expired must be 0 when the batch .in() update errors",
    );

    // Both bookings must retain their original status — no partial commit.
    assert.equal(
      state.bookings!["bk-batch-err-1"].status,
      "requested",
      "first booking must remain 'requested' after a failed batch update",
    );
    assert.equal(
      state.bookings!["bk-batch-err-2"].status,
      "requested",
      "second booking must remain 'requested' after a failed batch update — partial commit would indicate a per-booking loop",
    );
  });

  it("auto-complete count stays at zero when the batch status update errors — bookings remain in completed_pending_traveler_confirmation", async () => {
    // The sweep must only increment autoCompletedCount when the
    // .update({ status: 'completed' }) DB call succeeds.  If the call errors
    // the bookings are left in completed_pending_traveler_confirmation and the
    // count must stay at 0.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ac-update-err": {
          id: "bk-ac-update-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "completed_pending_traveler_confirmation",
          dispute_window_expires_at: PAST,
        },
      },
      // Arm the update error override so the rent_buddy_bookings status update
      // returns a DB error — leaving the booking un-promoted.
      updateErrorOverrides: {
        rent_buddy_bookings: { message: "simulated DB error on auto-complete update", code: "23514" },
      },
    };

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The sweep must NOT count a failed update as a successful auto-completion.
    assert.equal(
      r.body.autoCompleted,
      0,
      "autoCompleted must be 0 when the batch status update DB call errors",
    );

    // The booking must remain in completed_pending_traveler_confirmation because the update failed.
    assert.equal(
      state.bookings!["bk-ac-update-err"].status,
      "completed_pending_traveler_confirmation",
      "booking status must remain 'completed_pending_traveler_confirmation' when the batch update DB call errors",
    );
  });

  it("auto_completed booking events and completion notifications are NOT written when the batch update errors", async () => {
    // The event loop and notifyBookingParty calls are inside the same
    // if (!autoCompleteErr) guard.  If a future refactor moves them outside,
    // this test will catch it by asserting that neither side-effect fires when
    // the status update DB call errors.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ac-side-effect-err": {
          id: "bk-ac-side-effect-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "completed_pending_traveler_confirmation",
          dispute_window_expires_at: PAST,
        },
      },
      // Arm the update error so the rent_buddy_bookings status update fails.
      updateErrorOverrides: {
        rent_buddy_bookings: { message: "simulated DB error on auto-complete update", code: "23514" },
      },
    };

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // No auto_completed booking events must have been inserted — the event loop
    // is inside the guard and must not run when the status update fails.
    const autoCompletedEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) => e.event === "auto_completed",
    );
    assert.equal(
      autoCompletedEvents.length,
      0,
      "no auto_completed booking events must be inserted when the batch status update DB call errors",
    );

    // No completion notifications must have been queued — notifyBookingParty
    // is inside the same guard and must not fire when the update fails.
    const notifications = (state as any).notifications ?? [];
    assert.equal(
      notifications.length,
      0,
      "no completion notifications must be queued when the batch status update DB call errors",
    );
  });

  it("auto-complete leg promotes all eligible bookings together — not just the first", async () => {
    // Seed two completed_pending_traveler_confirmation bookings whose
    // dispute windows have both expired.  The .in("id", ids2) batch update
    // must advance every one of them to completed in a single sweep run.
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {
        "bk-ac-multi-1": {
          id: "bk-ac-multi-1",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "completed_pending_traveler_confirmation",
          dispute_window_expires_at: PAST,
        },
        "bk-ac-multi-2": {
          id: "bk-ac-multi-2",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "completed_pending_traveler_confirmation",
          dispute_window_expires_at: PAST,
        },
      },
    };

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The sweep must report both bookings as auto-completed.
    assert.equal(
      r.body.autoCompleted,
      2,
      "autoCompleted must equal the number of seeded eligible bookings (2)",
    );

    // Every eligible booking must have been promoted — not just the first one.
    assert.equal(
      state.bookings!["bk-ac-multi-1"].status,
      "completed",
      "first booking must be promoted to completed",
    );
    assert.equal(
      state.bookings!["bk-ac-multi-2"].status,
      "completed",
      "second booking must also be promoted to completed — the .in() call must cover all ids",
    );
  });

  it("returns 200 with noShowEscalated: 0 when the stale-no-shows DB query itself errors — no crash", async () => {
    // The sweep's step-3 query (.eq("status","no_show_pending").lt(…)) may itself
    // return a DB error.  The code destructures only { data: staleNoShows } so
    // data will be null; the guard `if (staleNoShows && staleNoShows.length > 0)`
    // must skip the loop and the sweep must still return 200 with noShowEscalated: 0.
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);

    state = {
      bookings: {},
      // Arm a select error override that fires only when the eq("status","no_show_pending")
      // filter is present — i.e. the stale-no-shows fetch in step 3 of the sweep.
      selectErrorOverrides: {
        rent_buddy_bookings: {
          matchEq: { col: "status", val: "no_show_pending" },
          error: { message: "simulated DB error fetching stale no-shows", code: "PGRST301" },
        },
      },
    };

    const r = await reqSweep();

    // Sweep must not crash — it must respond with HTTP 200.
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // noShowEscalated must be 0 — the stale-no-shows query returned an error so
    // the loop body must never execute.
    assert.equal(
      r.body.noShowEscalated,
      0,
      "noShowEscalated must be 0 when the stale-no-shows DB query errors",
    );

    // ok flag must still be true — a single step erroring must not fail the whole sweep.
    assert.equal(
      r.body.ok,
      true,
      "sweep must return ok:true even when the stale-no-shows DB query errors",
    );

    // No dispute rows must have been inserted — the guard short-circuits before
    // reaching the per-booking escalation loop.
    const noShowDisputes = (state.disputes ?? []).filter(
      (d: any) => d.reason === "no_show",
    );
    assert.equal(
      noShowDisputes.length,
      0,
      "no dispute rows must be inserted when the stale-no-shows DB query errors",
    );

    // No no_show_escalated events must have been written.
    const escalationEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) => e.event === "no_show_escalated",
    );
    assert.equal(
      escalationEvents.length,
      0,
      "no no_show_escalated events must be written when the stale-no-shows DB query errors",
    );
  });

  it("still sends the TRAVELER's auto-completion notification when the buddy-profile lookup errors", async () => {
    // The auto-complete step resolves buddy_id -> user_id via a batch lookup
    // against rent_buddy_profiles purely to notify the BUDDY side. If that
    // lookup itself returns a DB error, the traveler's own notification must
    // still fire — a buddy-ID resolution failure must never silence the
    // traveler side.
    const client = makeClient(USER_ID);
    _setTestClient(client as any, false);
    _setTestServiceClient(client as any);
    const PAST = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    state = {
      bookings: {
        "bk-buddy-lookup-err": {
          id: "bk-buddy-lookup-err",
          traveler_id: USER_ID,
          buddy_id: BUDDY_PROF,
          status: "completed_pending_traveler_confirmation",
          dispute_window_expires_at: PAST,
        },
      },
      selectErrorOverrides: {
        rent_buddy_profiles: {
          error: { message: "simulated DB error resolving buddy profile", code: "PGRST301" },
        },
      },
    };

    const r = await reqSweep();
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // The booking must still be auto-completed — the buddy-profile lookup
    // failure is unrelated to the status update itself.
    assert.equal(
      r.body.autoCompleted,
      1,
      "autoCompleted must still count the booking even when the buddy-profile lookup errors",
    );
    assert.equal(
      state.bookings!["bk-buddy-lookup-err"].status,
      "completed",
      "booking must still be promoted to completed when the buddy-profile lookup errors",
    );

    // The traveler's notification must still have fired. notifyBookingParty
    // is fire-and-forget (a void async IIFE that starts with dynamic imports),
    // so poll with a bounded deadline instead of a single setImmediate flush —
    // under full-suite CPU load the dynamic import can straddle one tick.
    const deadline = Date.now() + 5000;
    let travelerNotified = false;
    while (!travelerNotified && Date.now() < deadline) {
      const notifications = (state as any).notifications ?? [];
      travelerNotified = notifications.some(
        (n: any) => n.user_id === USER_ID && n.event_type === "rent_buddy.booking_completed",
      );
      if (!travelerNotified) await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(
      travelerNotified,
      true,
      "traveler auto-completion notification must fire even when the buddy-profile lookup errors",
    );
  });
});

// ── No-show duplicate-report guard (canonical /no-show handler) ───────────────

describe("Rent a Buddy — no-show: duplicate-report guard", () => {
  it("returns 409 already_reported when booking is already no_show_pending", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "no_show_pending",
          no_show_grace_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/no-show`, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_reported", JSON.stringify(r.body));
    assert.equal(r.body.status, "no_show_pending", JSON.stringify(r.body));
  });

  it("returns 409 already_reported when booking is already disputed", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "disputed",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/no-show`, {});
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_reported", JSON.stringify(r.body));
    assert.equal(r.body.status, "disputed", JSON.stringify(r.body));
  });

  it("returns 409 already_reported when buddy party calls after booking is already no_show_pending", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "no_show_pending",
          no_show_grace_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/no-show`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_reported", JSON.stringify(r.body));
    assert.equal(r.body.status, "no_show_pending", JSON.stringify(r.body));
  });

  it("returns 409 already_reported when buddy party calls after booking is already disputed", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "disputed",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/no-show`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_reported", JSON.stringify(r.body));
    assert.equal(r.body.status, "disputed", JSON.stringify(r.body));
  });
});

// ── Dispute duplicate-report guard (canonical /dispute handler) ───────────────

describe("Rent a Buddy — dispute: duplicate-report guard", () => {
  it("returns 409 already_disputed when traveler calls /dispute on an already-disputed booking", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "disputed",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_disputed", JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "disputed", JSON.stringify(r.body));
  });

  it("returns 409 already_disputed when buddy party calls /dispute on an already-disputed booking", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "disputed",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" }, BUDDY_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "already_disputed", JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "disputed", JSON.stringify(r.body));
  });
});

// ── Dispute no-show-pending guard ─────────────────────────────────────────────
// A no_show_pending booking has a no-show report already in progress that will
// escalate to a dispute automatically — the handler must return the dedicated
// no_show_in_progress code, not the generic invalid_transition.

describe("Rent a Buddy — dispute: no_show_pending guard", () => {
  it("returns 409 no_show_in_progress when traveler calls /dispute on a no_show_pending booking", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "no_show_pending",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "no_show_in_progress", JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "no_show_pending", JSON.stringify(r.body));
  });

  it("returns 409 no_show_in_progress when buddy calls /dispute on a no_show_pending booking", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "no_show_pending",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" }, BUDDY_TOKEN);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "no_show_in_progress", JSON.stringify(r.body));
    assert.equal(r.body.currentStatus, "no_show_pending", JSON.stringify(r.body));
  });
});

// ── Dispute terminal-status guard ─────────────────────────────────────────────
// cancelled and completed are terminal — the disputableStatuses list excludes
// them, so the handler must return 409 invalid_transition with currentStatus.

describe("Rent a Buddy — dispute: terminal-status guard", () => {
  for (const terminalStatus of ["cancelled", "completed"] as const) {
    it(`returns 409 invalid_transition when traveler calls /dispute on a ${terminalStatus} booking`, async () => {
      setupState({
        bookings: {
          [BOOKING_ID]: {
            id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
            status: terminalStatus,
            updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
          },
        },
      });
      const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error, "invalid_transition", JSON.stringify(r.body));
      assert.equal(r.body.currentStatus, terminalStatus, JSON.stringify(r.body));
    });

    it(`returns 409 invalid_transition when buddy calls /dispute on a ${terminalStatus} booking`, async () => {
      setupState({
        bookings: {
          [BOOKING_ID]: {
            id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
            status: terminalStatus,
            updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
          },
        },
      });
      const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" }, BUDDY_TOKEN);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error, "invalid_transition", JSON.stringify(r.body));
      assert.equal(r.body.currentStatus, terminalStatus, JSON.stringify(r.body));
    });
  }
});

// ── Message payload correctness: booking_id / sender_id ───────────────────────
// Asserts that milestone and card messages inserted into state.messages carry
// the correct sender_id (the acting user) and booking_id (in the card body
// JSON) for each major booking transition.  A swapped or blank value would
// silently corrupt thread history.

describe("Rent a Buddy — message payload: booking_id and sender_id correctness", () => {
  const THREAD_ID = "thread-msg-payload-1";

  function baseBooking(status: string, extra: Record<string, any> = {}) {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    return {
      id: BOOKING_ID,
      buddy_id: BUDDY_PROF,
      traveler_id: USER_ID,
      booking_date: futureDate.toISOString().slice(0, 10),
      start_time: "14:00",
      duration_h: 2,
      city: "Tokyo",
      category: "city",
      total_usd: 50,
      deposit_usd: 50,
      cash_balance_usd: 0,
      safety_status: "normal",
      route_plan: [],
      payment_mode: "full_in_app",
      telegraph_thread_id: THREAD_ID,
      status,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      ...extra,
    };
  }

  it("cancel: milestone and card carry traveler sender_id and correct booking_id", async () => {
    setupState({ bookings: { [BOOKING_ID]: baseBooking("confirmed") } });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    const milestone = msgs.find((m: any) => m.subtype === "rent_buddy_cancelled");
    assert.ok(milestone, "expected rent_buddy_cancelled milestone in state.messages");
    assert.equal(milestone.sender_id, USER_ID, "cancel milestone sender_id must be the traveler (actor), not blank or swapped");
    assert.equal(milestone.msg_type, "system");
    assert.equal(milestone.body, "Booking cancelled.");

    const card = msgs.find((m: any) => m.subtype === "booking_status_cancelled");
    assert.ok(card, "expected booking_status_cancelled card in state.messages");
    assert.equal(card.sender_id, USER_ID, "cancel card sender_id must be the traveler (actor)");
    assert.equal(card.msg_type, "booking_card");
    const cardBody = JSON.parse(card.body);
    assert.equal(cardBody.booking_id, BOOKING_ID, "card body booking_id must match the booking, not blank or swapped");
    assert.equal(cardBody.status, "cancelled");
  });

  it("accept: milestones and card carry buddy sender_id and correct booking_id", async () => {
    setupState({ bookings: { [BOOKING_ID]: baseBooking("pending") } });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/accept`, undefined, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    const accepted = msgs.find((m: any) => m.subtype === "rent_buddy_accepted");
    assert.ok(accepted, "expected rent_buddy_accepted milestone in state.messages");
    assert.equal(accepted.sender_id, BUDDY_USER, "accepted milestone sender_id must be the buddy user, not blank or swapped");

    const confirmed = msgs.find((m: any) => m.subtype === "rent_buddy_confirmed");
    assert.ok(confirmed, "expected rent_buddy_confirmed milestone in state.messages");
    assert.equal(confirmed.sender_id, BUDDY_USER, "confirmed milestone sender_id must be the buddy user");

    const card = msgs.find((m: any) => m.subtype === "booking_status_scheduled");
    assert.ok(card, "expected booking_status_scheduled card in state.messages");
    assert.equal(card.sender_id, BUDDY_USER, "accept card sender_id must be the buddy user");
    assert.equal(card.msg_type, "booking_card");
    const cardBody = JSON.parse(card.body);
    assert.equal(cardBody.booking_id, BOOKING_ID, "card body booking_id must match the booking");
    assert.equal(cardBody.status, "scheduled");
  });

  it("start: milestone and card carry buddy sender_id and correct booking_id", async () => {
    setupState({ bookings: { [BOOKING_ID]: baseBooking("scheduled") } });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/start`, undefined, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    const milestone = msgs.find((m: any) => m.subtype === "rent_buddy_started");
    assert.ok(milestone, "expected rent_buddy_started milestone in state.messages");
    assert.equal(milestone.sender_id, BUDDY_USER, "start milestone sender_id must be the buddy user, not blank or swapped");
    assert.equal(milestone.msg_type, "system");
    assert.equal(milestone.body, "Meetup started — enjoy your time together!");

    const card = msgs.find((m: any) => m.subtype === "booking_status_in_progress");
    assert.ok(card, "expected booking_status_in_progress card in state.messages");
    assert.equal(card.sender_id, BUDDY_USER, "start card sender_id must be the buddy user");
    assert.equal(card.msg_type, "booking_card");
    const cardBody = JSON.parse(card.body);
    assert.equal(cardBody.booking_id, BOOKING_ID, "card body booking_id must match the booking");
    assert.equal(cardBody.status, "in_progress");
  });

  it("complete (traveler path): milestone and card carry traveler sender_id and correct booking_id", async () => {
    setupState({ bookings: { [BOOKING_ID]: baseBooking("in_progress") } });
    // Traveler completes (no buddy profile for USER_ID) → isBuddyCompleting = false
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/complete`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    const milestone = msgs.find((m: any) => m.subtype === "rent_buddy_completed");
    assert.ok(milestone, "expected rent_buddy_completed milestone in state.messages");
    assert.equal(milestone.sender_id, USER_ID, "complete milestone sender_id must be the traveler (actor), not blank or swapped");
    assert.equal(milestone.msg_type, "system");
    assert.equal(milestone.body, "Booking completed — hope you had a great time!");

    const card = msgs.find((m: any) => m.subtype === "booking_status_completed");
    assert.ok(card, "expected booking_status_completed card in state.messages");
    assert.equal(card.sender_id, USER_ID, "complete card sender_id must be the traveler (actor)");
    assert.equal(card.msg_type, "booking_card");
    const cardBody = JSON.parse(card.body);
    assert.equal(cardBody.booking_id, BOOKING_ID, "card body booking_id must match the booking");
    assert.equal(cardBody.status, "completed");
  });

  it("complete (buddy path): milestone and card carry buddy sender_id and pending-confirmation subtypes", async () => {
    setupState({ bookings: { [BOOKING_ID]: baseBooking("in_progress") } });
    // Buddy (BUDDY_USER) completes — buddy_id on the booking matches their profile → isBuddyCompleting = true
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/complete`, undefined, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    const milestone = msgs.find((m: any) => m.subtype === "rent_buddy_pending_confirmation");
    assert.ok(milestone, "expected rent_buddy_pending_confirmation milestone in state.messages — not rent_buddy_completed");
    assert.equal(milestone.sender_id, BUDDY_USER, "pending-confirmation milestone sender_id must be the buddy (actor), not blank or swapped");
    assert.equal(milestone.msg_type, "system");

    const card = msgs.find((m: any) => m.subtype === "booking_status_completed_pending_traveler_confirmation");
    assert.ok(card, "expected booking_status_completed_pending_traveler_confirmation card in state.messages — not booking_status_completed");
    assert.equal(card.sender_id, BUDDY_USER, "pending-confirmation card sender_id must be the buddy (actor)");
    assert.equal(card.msg_type, "booking_card");
    const cardBody = JSON.parse(card.body);
    assert.equal(cardBody.booking_id, BOOKING_ID, "card body booking_id must match the booking");
    assert.equal(cardBody.status, "completed_pending_traveler_confirmation", "card body status must be completed_pending_traveler_confirmation — not completed");
  });

  it("dispute: milestone and card carry traveler sender_id and correct booking_id", async () => {
    setupState({ bookings: { [BOOKING_ID]: baseBooking("in_progress") } });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    const milestone = msgs.find((m: any) => m.subtype === "rent_buddy_disputed");
    assert.ok(milestone, "expected rent_buddy_disputed milestone in state.messages");
    assert.equal(milestone.sender_id, USER_ID, "dispute milestone sender_id must be the traveler (actor), not blank or swapped");
    assert.equal(milestone.msg_type, "system");
    assert.equal(milestone.body, "A dispute has been opened. Our team will review and reach out within 24 hours.");

    const card = msgs.find((m: any) => m.subtype === "booking_status_disputed");
    assert.ok(card, "expected booking_status_disputed card in state.messages");
    assert.equal(card.sender_id, USER_ID, "dispute card sender_id must be the traveler (actor)");
    assert.equal(card.msg_type, "booking_card");
    const cardBody = JSON.parse(card.body);
    assert.equal(cardBody.booking_id, BOOKING_ID, "card body booking_id must match the booking");
    assert.equal(cardBody.status, "disputed");
  });
});

// ── Thread-id isolation: messages go to the correct booking's thread ──────────
// emitBookingMilestone and emitBookingCard look up telegraph_thread_id by
// booking id.  If the filter were broken they could pick up the wrong booking's
// thread.  These tests put two bookings in state with *different* thread ids
// and assert that every inserted message carries the thread of the booking
// that was acted on — and that no message carries the other booking's thread.

describe("Rent a Buddy — message thread isolation: messages land in the correct booking's thread", () => {
  const CORRECT_THREAD  = "thread-correct-booking";
  const DECOY_THREAD    = "thread-decoy-booking";
  const DECOY_BOOKING   = "booking-uuid-decoy";

  function futureDate() {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    return d.toISOString().slice(0, 10);
  }

  function targetBooking(status: string) {
    return {
      id: BOOKING_ID,
      buddy_id: BUDDY_PROF,
      traveler_id: USER_ID,
      booking_date: futureDate(),
      start_time: "14:00",
      duration_h: 2,
      city: "Tokyo",
      category: "city",
      total_usd: 50,
      deposit_usd: 50,
      cash_balance_usd: 0,
      safety_status: "normal",
      route_plan: [],
      payment_mode: "full_in_app",
      telegraph_thread_id: CORRECT_THREAD,
      status,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
  }

  function decoyBooking() {
    return {
      id: DECOY_BOOKING,
      buddy_id: BUDDY_PROF,
      traveler_id: USER_ID,
      booking_date: futureDate(),
      start_time: "10:00",
      duration_h: 3,
      city: "Osaka",
      category: "city",
      total_usd: 75,
      deposit_usd: 75,
      cash_balance_usd: 0,
      safety_status: "normal",
      route_plan: [],
      payment_mode: "full_in_app",
      telegraph_thread_id: DECOY_THREAD,
      status: "confirmed",
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
  }

  it("cancel: milestone and card carry CORRECT_THREAD — not DECOY_THREAD — when two bookings coexist", async () => {
    setupState({
      bookings: {
        [BOOKING_ID]: targetBooking("confirmed"),
        [DECOY_BOOKING]: decoyBooking(),
      },
    });

    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const msgs: any[] = (state as any).messages ?? [];

    // ── milestone thread ─────────────────────────────────────────────────────
    const milestone = msgs.find((m: any) => m.subtype === "rent_buddy_cancelled");
    assert.ok(milestone, "expected rent_buddy_cancelled milestone in state.messages");
    assert.equal(
      milestone.thread_id, CORRECT_THREAD,
      `cancel milestone must land in the cancelled booking's thread (${CORRECT_THREAD}), got: ${milestone.thread_id}`,
    );
    assert.notEqual(
      milestone.thread_id, DECOY_THREAD,
      "cancel milestone must NOT land in the other booking's thread",
    );

    // ── card thread ──────────────────────────────────────────────────────────
    const card = msgs.find((m: any) => m.subtype === "booking_status_cancelled");
    assert.ok(card, "expected booking_status_cancelled card in state.messages");
    assert.equal(
      card.thread_id, CORRECT_THREAD,
      `cancel card must land in the cancelled booking's thread (${CORRECT_THREAD}), got: ${card.thread_id}`,
    );
    assert.notEqual(
      card.thread_id, DECOY_THREAD,
      "cancel card must NOT land in the other booking's thread",
    );

    // ── no message must carry the decoy thread ───────────────────────────────
    const leaked = msgs.filter((m: any) => m.thread_id === DECOY_THREAD);
    assert.equal(
      leaked.length, 0,
      `no message should reference the decoy thread — found ${leaked.length}: ${JSON.stringify(leaked.map((m: any) => m.subtype))}`,
    );
  });
});

// ── Notification recipient correctness ────────────────────────────────────────
// Asserts that notifyBookingParty targets the OTHER party — not the actor —
// for each booking status transition.

describe("Rent a Buddy — notifications: recipient is the other party", () => {
  // notifyBookingParty runs inside a fire-and-forget void IIFE so the HTTP
  // response arrives before the notification insert completes.  A short drain
  // gives the microtask queue time to flush the in-memory fake-client write.
  const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

  it("accept: traveler (not the buddy actor) receives booking_accepted notification", async () => {
    // Buddy (BUDDY_USER) accepts → traveler (USER_ID) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/accept`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.booking_accepted");
    assert.ok(note, "expected a booking_accepted notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who performed the action");
  });

  it("cancel by traveler: buddy (not the traveler actor) receives booking_cancelled_by_traveler notification", async () => {
    // Traveler (USER_ID) cancels → buddy (BUDDY_USER) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.booking_cancelled_by_traveler");
    assert.ok(note, "expected a booking_cancelled_by_traveler notification row");
    assert.equal(note.user_id, BUDDY_USER,
      `notification recipient must be the buddy (${BUDDY_USER}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, USER_ID,
      "notification must not target the traveler who performed the action");
  });

  it("cancel by buddy: traveler (not the buddy actor) receives booking_cancelled_by_buddy notification", async () => {
    // Buddy (BUDDY_USER) cancels → traveler (USER_ID) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/cancel`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.booking_cancelled_by_buddy");
    assert.ok(note, "expected a booking_cancelled_by_buddy notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who performed the action");
  });

  it("decline: traveler (not the buddy actor) receives booking_declined notification", async () => {
    // Buddy (BUDDY_USER) declines → traveler (USER_ID) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/decline`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.booking_declined");
    assert.ok(note, "expected a booking_declined notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who performed the action");
  });

  it("dispute by traveler: buddy (not the traveler actor) receives dispute_opened notification", async () => {
    // Traveler (USER_ID) opens dispute → buddy (BUDDY_USER) must be notified
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.dispute_opened");
    assert.ok(note, "expected a dispute_opened notification row");
    assert.equal(note.user_id, BUDDY_USER,
      `notification recipient must be the buddy (${BUDDY_USER}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, USER_ID,
      "notification must not target the traveler who raised the dispute");
  });

  it("dispute by buddy: traveler (not the buddy actor) receives dispute_opened notification", async () => {
    // Buddy (BUDDY_USER) opens dispute → traveler (USER_ID) must be notified
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/dispute`, { reason: "other" }, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.dispute_opened");
    assert.ok(note, "expected a dispute_opened notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who raised the dispute");
  });

  it("no-show by traveler: buddy (not the traveler actor) receives no_show_reported notification", async () => {
    // Traveler (USER_ID) reports no-show → buddy (BUDDY_USER) must be notified
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/no-show`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.no_show_reported");
    assert.ok(note, "expected a no_show_reported notification row");
    assert.equal(note.user_id, BUDDY_USER,
      `notification recipient must be the buddy (${BUDDY_USER}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, USER_ID,
      "notification must not target the traveler who reported the no-show");
  });

  it("no-show by buddy: traveler (not the buddy actor) receives no_show_reported notification", async () => {
    // Buddy (BUDDY_USER) reports no-show → traveler (USER_ID) must be notified
    setupState({
      bookings: {
        [BOOKING_ID]: {
          id: BOOKING_ID, buddy_id: BUDDY_PROF, traveler_id: USER_ID,
          status: "in_progress",
          updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        },
      },
    });
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/no-show`, {}, BUDDY_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.no_show_reported");
    assert.ok(note, "expected a no_show_reported notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who reported the no-show");
  });

  it("booking_requested: buddy (not the traveler actor) receives booking_requested notification", async () => {
    // Traveler (USER_ID) creates booking → buddy (BUDDY_USER) must be notified
    setupState();
    const r = await req("POST", "/api/rent-a-buddy/bookings", {
      buddyId: BUDDY_PROF, bookingDate: new Date().toISOString().slice(0, 10),
      durationH: 1, city: "Shinjuku Station", category: "city",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.booking_requested");
    assert.ok(note, "expected a booking_requested notification row");
    assert.equal(note.user_id, BUDDY_USER,
      `notification recipient must be the buddy (${BUDDY_USER}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, USER_ID,
      "notification must not target the traveler who placed the request");
  });

  // ── change_request_raised via /suggest ──────────────────────────────────────

  it("suggest by traveler: buddy (not the traveler actor) receives change_request_raised notification", async () => {
    // Traveler (USER_ID) suggests a change → buddy (BUDDY_USER) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/suggest`, {
      proposedDate: "2026-09-01",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.change_request_raised");
    assert.ok(note, "expected a change_request_raised notification row");
    assert.equal(note.user_id, BUDDY_USER,
      `notification recipient must be the buddy (${BUDDY_USER}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, USER_ID,
      "notification must not target the traveler who raised the change request");
  });

  it("suggest by buddy: traveler (not the buddy actor) receives change_request_raised notification", async () => {
    // Buddy (BUDDY_USER) suggests a change → traveler (USER_ID) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/suggest`, {
      proposedDate: "2026-09-01",
    }, BUDDY_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.change_request_raised");
    assert.ok(note, "expected a change_request_raised notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who raised the change request");
  });

  // ── change_request_raised via /change-request ───────────────────────────────

  it("change-request by traveler: buddy (not the traveler actor) receives change_request_raised notification", async () => {
    // Traveler (USER_ID) raises a change request → buddy (BUDDY_USER) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/change-request`, {
      changeField: "duration_h",
      proposedValue: { duration_h: 3 },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.change_request_raised");
    assert.ok(note, "expected a change_request_raised notification row");
    assert.equal(note.user_id, BUDDY_USER,
      `notification recipient must be the buddy (${BUDDY_USER}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, USER_ID,
      "notification must not target the traveler who raised the change request");
  });

  it("change-request by buddy: traveler (not the buddy actor) receives change_request_raised notification", async () => {
    // Buddy (BUDDY_USER) raises a change request → traveler (USER_ID) must be notified
    setupState();
    const r = await req("POST", `/api/rent-a-buddy/bookings/${BOOKING_ID}/change-request`, {
      changeField: "duration_h",
      proposedValue: { duration_h: 3 },
    }, BUDDY_TOKEN);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await drain();
    const notes: any[] = (state as any).notifications ?? [];
    const note = notes.find((n: any) => n.event_type === "rent_buddy.change_request_raised");
    assert.ok(note, "expected a change_request_raised notification row");
    assert.equal(note.user_id, USER_ID,
      `notification recipient must be the traveler (${USER_ID}), got: ${note.user_id}`);
    assert.notEqual(note.user_id, BUDDY_USER,
      "notification must not target the buddy who raised the change request");
  });
});

// ── Row → view mappings ───────────────────────────────────────────────────────
//
// Both of these endpoints used to return raw snake_case rows while the app's
// types declared camelCase. Nothing failed to compile on either side, because a
// route's response is `any` on the way out and the app's type is an assertion on
// the way in — so the mismatch could only ever show up at runtime, and it did:
// the earnings ledger THREW on its first row, and every buddy review rendered
// its date as "Invalid Date".

describe("toLedgerEntryView", () => {
  const ROW = {
    id: "led-1",
    booking_id: "bk-1",
    pricing_type: "hourly",
    total_booking_usd: 120,
    addons_usd: 20,
    tip_usd: 10,
    platform_fee_percent: 22,
    platform_fee_amount: 26.4,
    traveler_service_fee_amount: 8,
    buddy_gross_amount: 120,
    buddy_net_estimated_amount: 93.6,
    deposit_amount: 30,
    in_app_amount_collected: 30,
    cash_balance_due: 90,
    cash_balance_confirmed: false,
    is_estimated: true,
    created_at: "2026-09-01T10:00:00.000Z",
    // Present on the row, deliberately not part of the view.
    buddy_user_id: "u-1",
    traveler_id: "u-2",
    note: "internal",
  };

  it("maps every numeric field the ledger screen calls .toFixed() on", () => {
    const v = toLedgerEntryView(ROW);
    // These four are the reads that threw: `undefined.toFixed(2)`.
    assert.equal(v.buddyNetEstimatedAmount, ROW.buddy_net_estimated_amount);
    assert.equal(v.totalBookingUsd, ROW.total_booking_usd);
    assert.equal(v.platformFeeAmount, ROW.platform_fee_amount);
    assert.equal(v.tipUsd, ROW.tip_usd);
    for (const k of ["buddyNetEstimatedAmount", "totalBookingUsd", "platformFeeAmount", "tipUsd"]) {
      assert.equal(typeof (v as any)[k], "number", `${k} must be a number, not undefined`);
    }
  });

  it("maps the remaining declared fields", () => {
    const v = toLedgerEntryView(ROW);
    assert.equal(v.id, ROW.id);
    assert.equal(v.bookingId, ROW.booking_id);
    assert.equal(v.pricingType, ROW.pricing_type);
    assert.equal(v.addonsUsd, ROW.addons_usd);
    assert.equal(v.platformFeePercent, ROW.platform_fee_percent);
    assert.equal(v.travelerServiceFeeAmount, ROW.traveler_service_fee_amount);
    assert.equal(v.buddyGrossAmount, ROW.buddy_gross_amount);
    assert.equal(v.depositAmount, ROW.deposit_amount);
    assert.equal(v.inAppAmountCollected, ROW.in_app_amount_collected);
    assert.equal(v.cashBalanceDue, ROW.cash_balance_due);
    assert.equal(v.cashBalanceConfirmed, ROW.cash_balance_confirmed);
    assert.equal(v.isEstimated, ROW.is_estimated);
    assert.equal(v.createdAt, ROW.created_at);
  });

  it("emits NO snake_case key — the raw row must not leak through", () => {
    // The bug was a `{ ...row }` spread. This is the assertion that catches a
    // re-introduced spread even if every camelCase field is also present.
    const v = toLedgerEntryView(ROW) as Record<string, unknown>;
    const snake = Object.keys(v).filter((k) => k.includes("_"));
    assert.deepEqual(snake, [], `raw columns leaked: ${snake.join(", ")}`);
  });

  it("warns only while the payout is an estimate", () => {
    assert.ok(toLedgerEntryView(ROW).warning);
    assert.equal(toLedgerEntryView({ ...ROW, is_estimated: false }).warning, undefined);
  });
});

describe("toPublicBuddyReview", () => {
  const ROW = {
    id: "rv-1",
    booking_id: "bk-1",
    reviewer_id: "u-2",
    reviewee_id: "u-1",
    rating: 5,
    body: "Great day out",
    photos: ["https://cdn.example/1.jpg"],
    is_public: true,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z",
    // Columns select("*") used to hand out with the rest.
    private_admin_note: "flagged by moderator",
    moderation_status: "approved",
    punctuality_score: 4,
    communication_score: 5,
    safety_score: 5,
    blind_until: null,
    role: "traveler",
  };

  it("maps createdAt — the read that rendered every review as Invalid Date", () => {
    const v = toPublicBuddyReview(ROW);
    assert.equal(v.createdAt, ROW.created_at);
    assert.equal(Number.isNaN(new Date(v.createdAt).getTime()), false);
  });

  it("maps the reviewee onto buddyId, and the rest of the declared shape", () => {
    const v = toPublicBuddyReview(ROW);
    assert.equal(v.buddyId, ROW.reviewee_id);
    assert.equal(v.reviewerId, ROW.reviewer_id);
    assert.equal(v.bookingId, ROW.booking_id);
    assert.equal(v.rating, ROW.rating);
    assert.equal(v.body, ROW.body);
    assert.deepEqual(v.photos, ROW.photos);
    assert.equal(v.isPublic, ROW.is_public);
    assert.equal(v.updatedAt, ROW.updated_at);
  });

  it("never forwards the private moderation columns", () => {
    // An allowlist, not a redaction: a column added to rent_buddy_reviews
    // cannot start leaking just because nobody remembered to exclude it.
    const v = toPublicBuddyReview(ROW) as Record<string, unknown>;
    assert.deepEqual(Object.keys(v).sort(), [
      "bookingId", "body", "buddyId", "createdAt", "id",
      "isPublic", "photos", "rating", "reviewerId", "updatedAt",
    ]);
  });

  it("a null photos column becomes an empty array, never null", () => {
    assert.deepEqual(toPublicBuddyReview({ ...ROW, photos: null }).photos, []);
  });
});
