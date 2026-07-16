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
import rentABuddyRouter, { POLICY_TEXT } from "../routes/rentABuddy.js";
import { specAliasRewrite } from "../lib/specAliasRewrite.js";

// ── Test server ───────────────────────────────────────────────────────────────

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
}

let state: FakeState = {};

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
        // buddy_booking_events inserts are often void'd (fire-and-forget) so
        // _resolve() is never called for them.  Capture eagerly here so tests
        // can observe the rows even without an await chain.
        if (table === "buddy_booking_events") {
          const rows = Array.isArray(data) ? data : [data];
          for (const row of rows) {
            const r = { id: `gen-${Math.random().toString(36).slice(2)}`, ...row };
            if (!(state as any).bookingEvents) (state as any).bookingEvents = [];
            (state as any).bookingEvents.push(r);
          }
          this._eagerCaptured = true;
        }
        return this;
      },
      update(data: any) { this._updateData = data; return this; },
      upsert(data: any, opts?: any) { this._upsertData = data; return this; },
      delete() { this._updateData = "__delete__"; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      in(col: string, vals: any[]) { this._filters.push(["in", col, vals]); return this; },
      gt(col: string, val: any) { this._filters.push(["gt", col, val]); return this; },
      lt(col: string, val: any) { this._filters.push(["lt", col, val]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      like(col: string, val: any) { this._filters.push(["like", col, val]); return this; },
      ilike(col: string, val: any) { this._filters.push(["ilike", col, val]); return this; },
      contains(col: string, val: any) { this._filters.push(["contains", col, val]); return this; },
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
            for (const [, col, val] of this._filters) {
              if (col === "id" && state.bookings?.[val]) {
                if (this._updateData === "__delete__") {
                  delete state.bookings[val];
                } else {
                  state.bookings[val] = { ...state.bookings[val], ...this._updateData };
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
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "in") rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
            if (op === "lt") rows = rows.filter((r: any) => r[col] < val);
            if (op === "gt") rows = rows.filter((r: any) => r[col] > val);
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
  app.use(rentABuddyRouter);

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
        [USER_ID]:   { id: USER_ID,   trust_score: 80 },
        [BUDDY_USER]:{ id: BUDDY_USER, trust_score: 80 },
      },
      buddyProfiles: {
        [BUDDY_PROF]: {
          id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active",
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
    process.env.SESSION_SECRET = INTERNAL_KEY;
  });

  after(() => {
    delete process.env.SESSION_SECRET;
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
    // Seed the no_show_reported event so the sweeper can identify the original reporter.
    (state as any).bookingEvents = [
      { id: "ev-ns-1", booking_id: "bk-ns-expired", actor_user_id: USER_ID, event: "no_show_reported" },
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

  it("still promotes booking to disputed and writes the event with dispute_id: null when the dispute insert fails", async () => {
    // Grace window expired 3 hours ago.
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
    assert.equal(r.body.noShowEscalated, 1, JSON.stringify(r.body));

    // Booking must still be promoted to disputed even though the dispute insert failed.
    assert.equal(
      state.bookings!["bk-ns-dispute-err"].status,
      "disputed",
      "booking must be promoted to disputed even when the dispute-row insert fails",
    );

    // No dispute row must have been persisted (the insert errored out).
    const storedDisputes = (state.disputes ?? []).filter(
      (d: any) => d.booking_id === "bk-ns-dispute-err",
    );
    assert.equal(
      storedDisputes.length,
      0,
      "no dispute row should be stored when the insert returns an error",
    );

    // The buddy_booking_events row must still be written, with dispute_id: null.
    const escalationEvents = ((state as any).bookingEvents ?? []).filter(
      (e: any) => e.booking_id === "bk-ns-dispute-err" && e.event === "no_show_escalated",
    );
    assert.equal(
      escalationEvents.length,
      1,
      "a no_show_escalated event must be recorded even when dispute insert fails",
    );
    assert.equal(
      escalationEvents[0].metadata?.dispute_id,
      null,
      "event metadata.dispute_id must be null when the dispute-row insert failed",
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
});
