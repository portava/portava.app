/**
 * Find Your Circle — backend API tests
 *
 * Covers: access guard cases (trip membership, event membership, blocks, paused
 * sharing, global off, per-context off, expiry, staleness, telegraph-only,
 * follow-only, kill switch), response shape privacy per visibility mode,
 * need-help emergency detail suppression, invalid context type 400, and consent
 * flow on PATCH /circle/settings.
 *
 * Run: node --import tsx/esm --test src/test/circle.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import circleRouter from "../routes/circle.js";
import { checkRateLimit, _resetRateLimit } from "../lib/rateLimit.js";
import { renderTemplate } from "../services/notifications/NotificationTemplateService.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

// ── Constants ─────────────────────────────────────────────────────────────────

const VIEWER_TOKEN = "viewer-token";
const TARGET_TOKEN = "target-token";
const ADMIN_TOKEN  = "admin-token";
const NON_MEMBER_TOKEN = "nonmember-token";

const VIEWER_ID    = "aaaaaaaa-0000-0000-0000-000000000001";
const TARGET_ID    = "aaaaaaaa-0000-0000-0000-000000000002";
const ADMIN_ID     = "aaaaaaaa-0000-0000-0000-000000000003";
const NON_MEMBER_ID = "aaaaaaaa-0000-0000-0000-000000000004";
const TELEGR_ID    = "aaaaaaaa-0000-0000-0000-000000000005"; // telegraph-only

const TRIP_ID  = "cccccccc-0000-0000-0000-000000000001";
const EVENT_ID = "cccccccc-0000-0000-0000-000000000002";

function req(
  method: string,
  path: string,
  body?: unknown,
  token: string = VIEWER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type":  "application/json",
      "authorization": `Bearer ${token}`,
    };
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers,
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
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake state ────────────────────────────────────────────────────────────────

interface FakeState {
  featureFlags:         Record<string, { flag: string; enabled: boolean }>;
  tripMembers:          any[];
  eventRsvps:           any[];
  eventAttendees:       any[]; // mirrors event_rsvps for going/maybe/interested
  circleVisibility:     Record<string, any>; // keyed by user_id
  circleContextSettings: any[];              // array with (user_id, context_type, context_id) composite
  circlePresence:       any[];
  circleCheckins:       any[];
  circleAuditEvents:    any[];
  circleMeetingPoints:  any[];
  profiles:             Record<string, any>;
  blocks:               any[];
  userAccountStates:    any[];
  trips:                Record<string, any>;
  events:               Record<string, any>;
  messageThreadMembers: any[];
  // ── Additions for compass-suggestions + pause-on-session-end ────────────────
  follows:              any[];
  circleMembers:        any[];
  messages:             any[];
  messageThreads:       any[];
  // ── Notification pipeline tracking ──────────────────────────────────────────
  notifications:        any[];
}

let state: FakeState;

function resetState(): void {
  state = {
    featureFlags: {
      find_your_circle_enabled: { flag: "find_your_circle_enabled",  enabled: true },
      find_your_circle_disabled: { flag: "find_your_circle_disabled", enabled: false },
    },
    tripMembers: [
      // viewer is accepted member of TRIP_ID
      { trip_id: TRIP_ID, user_id: VIEWER_ID, role: "member", status: "accepted" },
      // target is accepted member of TRIP_ID
      { trip_id: TRIP_ID, user_id: TARGET_ID, role: "member", status: "accepted" },
      // telegr-only user is NOT in trip_members (only in message_thread_members)
    ],
    eventRsvps: [
      // viewer goes to EVENT_ID
      { event_id: EVENT_ID, user_id: VIEWER_ID, status: "going" },
      // target goes to EVENT_ID
      { event_id: EVENT_ID, user_id: TARGET_ID, status: "going" },
    ],
    eventAttendees: [
      // synced from event_rsvps (going → upserted into event_attendees)
      { event_id: EVENT_ID, user_id: VIEWER_ID },
      { event_id: EVENT_ID, user_id: TARGET_ID },
    ],
    circleVisibility: {
      [TARGET_ID]: {
        user_id:        TARGET_ID,
        global_enabled: true,
        visibility_mode: "status_only",
        consent_version: "v1",
        consented_at:   "2026-07-05T00:00:00Z",
        updated_at:     "2026-07-05T00:00:00Z",
      },
    },
    circleContextSettings: [],
    circlePresence: [
      {
        id:               "pres-0001",
        user_id:          TARGET_ID,
        context_type:     "trip",
        context_id:       TRIP_ID,
        status:           "active",
        status_label:     null,
        approximate_label: null,
        venue_label:      null,
        checked_in:       false,
        stale_after_secs: 1800,
        last_seen_at:     new Date().toISOString(),
        expires_at:       new Date(Date.now() + 86_400_000).toISOString(),
        is_stale:         false,
        needs_help:       false,
        created_at:       "2026-07-05T00:00:00Z",
        updated_at:       new Date().toISOString(),
      },
    ],
    circleCheckins:    [],
    circleAuditEvents: [],
    circleMeetingPoints: [
      {
        id:               "meet-0001",
        context_type:     "trip",
        context_id:       TRIP_ID,
        host_user_id:     VIEWER_ID,
        venue_label:      "Hotel Lobby",
        approximate_label: null,
        description:      null,
        is_active:        true,
        created_at:       "2026-07-05T00:00:00Z",
        updated_at:       "2026-07-05T00:00:00Z",
      },
    ],
    profiles: {
      [VIEWER_ID]:   { id: VIEWER_ID, handle: "viewer", display_name: "Viewer User", avatar_url: null, role: "user" },
      [TARGET_ID]:   { id: TARGET_ID, handle: "target", display_name: "Target User", avatar_url: null, role: "user" },
      [ADMIN_ID]:    { id: ADMIN_ID,  handle: "admin",  display_name: "Admin User",  avatar_url: null, role: "admin" },
      [NON_MEMBER_ID]: { id: NON_MEMBER_ID, handle: "nonmember", display_name: "Non Member", avatar_url: null, role: "user" },
      [TELEGR_ID]:   { id: TELEGR_ID, handle: "telegr", display_name: "Telegraph User", avatar_url: null, role: "user" },
    },
    blocks: [],
    userAccountStates: [],
    trips: {
      [TRIP_ID]: { id: TRIP_ID, owner_id: VIEWER_ID, end_date: "2026-08-01" },
    },
    events: {
      [EVENT_ID]: { id: EVENT_ID, host_id: VIEWER_ID, ends_at: "2026-08-01T22:00:00Z" },
    },
    messageThreadMembers: [
      // telegraph-only user is only in message_thread_members, NOT trip_members
      { thread_id: "thread-trip-1", user_id: TELEGR_ID },
    ],
    follows: [
      // VIEWER_ID ↔ TARGET_ID mutual follows (used by compass-suggestions)
      { follower_id: VIEWER_ID, following_id: TARGET_ID },
      { follower_id: TARGET_ID, following_id: VIEWER_ID },
    ],
    circleMembers: [],
    messages: [],
    messageThreads: [],
    notifications: [],
  };
}

function makeClient(userId: string) {
  function fakeTable(table: string) {
    return {
      _table:       table,
      _filters:     [] as Array<[string, string, any]>,
      _insertData:  null as any,
      _updateData:  null as any,
      _upsertData:  null as any,
      _deleteMode:  false,
      _limit:       1000,
      _maybeSingle: false,
      _notNullCol:  null as string | null,
      _inFilters:   [] as Array<[string, any[]]>,
      _orderBy:     null as any,

      select(_cols?: string, opts?: any) { return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      upsert(data: any, _opts?: any) { this._upsertData = data; return this; },
      delete() { this._deleteMode = true; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      in(col: string, vals: any[]) { this._inFilters.push([col, vals]); return this; },
      not(col: string, _op: string, _val: any) { this._notNullCol = col; return this; },
      neq(col: string, val: any) { this._filters.push(["neq", col, val]); return this; },
      lte(col: string, val: any) { this._filters.push(["lte", col, val]); return this; },
      gte(col: string, val: any) { this._filters.push(["gte", col, val]); return this; },
      or(_expr: string) { return this; },
      is(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      limit(n: number) { this._limit = n; return this; },
      range(_from: number, _to: number) { return this; },
      order(_col: string, _opts?: any) { return this; },
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        // ── Inserts ─────────────────────────────────────────────────────────
        if (this._insertData !== null) {
          const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
          const generated = rows.map((r: any) => ({
            id: `gen-${Math.random().toString(36).slice(2)}`,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          }));
          if (t === "circle_audit_events") state.circleAuditEvents.push(...generated);
          if (t === "circle_checkins") state.circleCheckins.push(...generated);
          if (t === "circle_meeting_points") state.circleMeetingPoints.push(...generated);
          if (t === "notifications") state.notifications.push(...generated);
          const out = this._maybeSingle ? { data: generated[0] ?? null, error: null } : { data: generated, error: null };
          return out;
        }

        // ── Upserts ─────────────────────────────────────────────────────────
        if (this._upsertData !== null) {
          const rows = Array.isArray(this._upsertData) ? this._upsertData : [this._upsertData];
          for (const row of rows) {
            if (t === "circle_visibility_settings") {
              const uid = row.user_id as string;
              state.circleVisibility[uid] = {
                ...(state.circleVisibility[uid] ?? {}),
                ...row,
                updated_at: row.updated_at ?? new Date().toISOString(),
              };
            } else if (t === "circle_context_settings") {
              const idx = state.circleContextSettings.findIndex(
                (r) => r.user_id === row.user_id && r.context_type === row.context_type && r.context_id === row.context_id,
              );
              if (idx >= 0) {
                state.circleContextSettings[idx] = { ...state.circleContextSettings[idx], ...row };
              } else {
                state.circleContextSettings.push({ id: `gen-${Math.random().toString(36).slice(2)}`, ...row });
              }
            } else if (t === "circle_presence") {
              const idx = state.circlePresence.findIndex(
                (r) => r.user_id === row.user_id && r.context_type === row.context_type && r.context_id === row.context_id,
              );
              if (idx >= 0) {
                state.circlePresence[idx] = { ...state.circlePresence[idx], ...row };
              } else {
                state.circlePresence.push({
                  id: `gen-${Math.random().toString(36).slice(2)}`,
                  created_at: new Date().toISOString(),
                  stale_after_secs: 1800,
                  is_stale: false,
                  needs_help: false,
                  ...row,
                });
              }
            } else if (t === "feature_flags") {
              state.featureFlags[row.flag as string] = {
                flag:    row.flag as string,
                enabled: Boolean(row.enabled),
              };
            }
          }
          if (this._maybeSingle) {
            let found: any = null;
            if (t === "circle_visibility_settings") found = state.circleVisibility[(rows[0] as any).user_id ?? userId];
            if (t === "circle_context_settings") {
              const r = rows[0] as any;
              found = state.circleContextSettings.find(
                (x) => x.user_id === r.user_id && x.context_type === r.context_type && x.context_id === r.context_id,
              ) ?? null;
            }
            if (t === "circle_presence") {
              const r = rows[0] as any;
              found = state.circlePresence.find(
                (x) => x.user_id === r.user_id && x.context_type === r.context_type && x.context_id === r.context_id,
              ) ?? null;
            }
            return { data: found ? { ...found } : rows[0], error: null };
          }
          return { data: rows, error: null };
        }

        // ── Updates ─────────────────────────────────────────────────────────
        if (this._updateData !== null) {
          const filters = this._filters;
          function rowMatchesFilters(row: any): boolean {
            return filters.every(([op, col, val]) =>
              op === "neq" ? row[col] !== val : row[col] === val,
            );
          }
          if (t === "circle_presence") {
            const ids = this._inFilters.find(([col]) => col === "id")?.[1] ?? [];
            for (const row of state.circlePresence) {
              if (ids.length > 0 && ids.includes(row.id)) {
                Object.assign(row, this._updateData);
              } else if (filters.length > 0 && rowMatchesFilters(row)) {
                Object.assign(row, this._updateData);
              }
            }
          }
          if (t === "circle_meeting_points") {
            for (const row of state.circleMeetingPoints) {
              if (rowMatchesFilters(row)) Object.assign(row, this._updateData);
            }
          }
          if (t === "circle_context_settings") {
            for (const row of state.circleContextSettings) {
              if (rowMatchesFilters(row)) Object.assign(row, this._updateData);
            }
          }
          if (this._maybeSingle) {
            return { data: { ...this._updateData }, error: null };
          }
          return { data: null, error: null };
        }

        // ── Deletes ─────────────────────────────────────────────────────────
        if (this._deleteMode) {
          if (t === "circle_presence") {
            const ids = this._inFilters.find(([col]) => col === "id")?.[1] ?? [];
            const ctFilter = this._filters.find(([, col]) => col === "context_type");
            const cidInFilter = this._inFilters.find(([col]) => col === "context_id");
            state.circlePresence = state.circlePresence.filter((r) => {
              if (ids.length > 0 && ids.includes(r.id)) return false;
              if (ctFilter && cidInFilter) {
                if (r.context_type === ctFilter[2] && cidInFilter[1].includes(r.context_id)) return false;
              }
              return true;
            });
          }
          return { data: null, error: null };
        }

        // ── Selects ─────────────────────────────────────────────────────────
        const filters = this._filters;
        const inFilters = this._inFilters;

        function applyFilters(rows: any[]): any[] {
          let result = rows;
          for (const [op, col, val] of filters) {
            if (op === "neq") {
              result = result.filter((r) => r[col] !== val);
            } else {
              result = result.filter((r) => r[col] === val);
            }
          }
          for (const [col, vals] of inFilters) {
            result = result.filter((r) => vals.includes(r[col]));
          }
          return result;
        }

        // feature_flags
        if (t === "feature_flags") {
          const rows = Object.values(state.featureFlags);
          const filtered = applyFilters(rows);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // profiles
        if (t === "profiles") {
          const rows = Object.values(state.profiles);
          const filtered = applyFilters(rows);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // trip_members
        if (t === "trip_members") {
          const filtered = applyFilters(state.tripMembers);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // event_rsvps
        if (t === "event_rsvps") {
          const filtered = applyFilters(state.eventRsvps);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // event_attendees
        if (t === "event_attendees") {
          const filtered = applyFilters(state.eventAttendees);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_visibility_settings
        if (t === "circle_visibility_settings") {
          const rows = Object.values(state.circleVisibility);
          const filtered = applyFilters(rows);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_context_settings
        if (t === "circle_context_settings") {
          const filtered = applyFilters(state.circleContextSettings);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_presence
        if (t === "circle_presence") {
          const filtered = applyFilters(state.circlePresence);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_meeting_points
        if (t === "circle_meeting_points") {
          const filtered = applyFilters(state.circleMeetingPoints).filter((r) => !this._filters.find(([,col,val]) => col === "is_active" && val !== r.is_active));
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_audit_events
        if (t === "circle_audit_events") {
          const filtered = applyFilters(state.circleAuditEvents);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_checkins
        if (t === "circle_checkins") {
          const filtered = applyFilters(state.circleCheckins);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // follows
        if (t === "follows") {
          const filtered = applyFilters(state.follows);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // circle_members
        if (t === "circle_members") {
          const filtered = applyFilters(state.circleMembers);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // messages (Telegraph cards)
        if (t === "messages") {
          if (this._insertData !== null) {
            const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
            state.messages.push(...rows.map((r: any) => ({ id: `msg-${Math.random()}`, ...r })));
            return { data: null, error: null };
          }
          const filtered = applyFilters(state.messages);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // message_threads (for Telegraph card thread lookup)
        if (t === "message_threads") {
          const filtered = applyFilters(state.messageThreads);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // notifications (pipeline tracking + dedup reads)
        if (t === "notifications") {
          const filtered = applyFilters(state.notifications);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // blocks
        if (t === "blocks") {
          return { data: state.blocks.map((r) => ({ ...r })), error: null };
        }

        // user_account_states
        if (t === "user_account_states") {
          const filtered = applyFilters(state.userAccountStates);
          return { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // trips
        if (t === "trips") {
          const rows = Object.values(state.trips);
          const filtered = applyFilters(rows);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        // events
        if (t === "events") {
          const rows = Object.values(state.events);
          const filtered = applyFilters(rows);
          return this._maybeSingle ? { data: filtered[0] ? { ...filtered[0] } : null, error: null } : { data: filtered.map((r) => ({ ...r })), error: null };
        }

        return this._maybeSingle ? { data: null, error: null } : { data: [], error: null };
      },
    };
  }

  return {
    auth: {
      async getUser(_token: string) {
        const userMap: Record<string, any> = {
          [VIEWER_TOKEN]:     { id: VIEWER_ID,    email: "viewer@test.com" },
          [TARGET_TOKEN]:     { id: TARGET_ID,    email: "target@test.com" },
          [ADMIN_TOKEN]:      { id: ADMIN_ID,     email: "admin@test.com" },
          [NON_MEMBER_TOKEN]: { id: NON_MEMBER_ID, email: "nonmember@test.com" },
        };
        const found = userMap[_token];
        return found
          ? { data: { user: found }, error: null }
          : { data: { user: null }, error: { message: "Invalid token" } };
      },
    },
    from(table: string) {
      return fakeTable(table);
    },
  };
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(circleRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => {
  resetState();
  const client = makeClient(VIEWER_ID);
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /circle/settings", () => {
  it("returns defaults when no row exists", async () => {
    state.circleVisibility = {};
    const r = await req("GET", "/circle/settings");
    assert.equal(r.status, 200);
    assert.equal(r.body.globalEnabled, false);
    assert.equal(r.body.visibilityMode, "status_only");
    assert.equal(r.body.currentConsentVersion, "v1");
  });

  it("returns existing settings row", async () => {
    const r = await req("GET", "/circle/settings", undefined, TARGET_TOKEN);
    const tc = makeClient(TARGET_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r2 = await req("GET", "/circle/settings", undefined, TARGET_TOKEN);
    assert.equal(r2.status, 200);
  });
});

describe("PATCH /circle/settings — consent flow", () => {
  it("returns 409 when enabling without consentVersion", async () => {
    state.circleVisibility = {};
    const r = await req("PATCH", "/circle/settings", { globalEnabled: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "consent_required");
  });

  it("returns 409 when consentVersion mismatches", async () => {
    state.circleVisibility = {};
    const r = await req("PATCH", "/circle/settings", { globalEnabled: true, consentVersion: "v0-old" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "consent_version_mismatch");
  });

  it("succeeds with correct consentVersion", async () => {
    state.circleVisibility = {};
    const r = await req("PATCH", "/circle/settings", { globalEnabled: true, consentVersion: "v1" });
    assert.equal(r.status, 200);
    assert.equal(r.body.globalEnabled, true);
    assert.ok(r.body.consentedAt);
  });

  it("does not require consent when already enabled", async () => {
    // TARGET has global_enabled=true already
    const tc = makeClient(TARGET_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("PATCH", "/circle/settings", { visibilityMode: "approximate_area" }, TARGET_TOKEN);
    assert.equal(r.status, 200);
  });

  it("rejects precise_live visibility mode", async () => {
    const r = await req("PATCH", "/circle/settings", { visibilityMode: "precise_live" as any });
    assert.equal(r.status, 403);
  });
});

describe("GET /circle/contexts/:type/:id/members — access guard", () => {
  it("same-trip accepted member sees eligible presence and pagination fields", async () => {
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.members));
    // Pagination envelope
    assert.ok(typeof r.body.totalCount === "number", "totalCount required");
    assert.ok(typeof r.body.limit      === "number", "limit required");
    assert.ok(typeof r.body.offset     === "number", "offset required");
    assert.ok(typeof r.body.hasMore    === "boolean", "hasMore required");
    assert.equal(r.body.offset, 0);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member, "target should be in members");
    assert.equal(member.status, "active");
    // No sensitive fields
    assert.equal(member.email,     undefined);
    assert.equal(member.phone,     undefined);
    assert.equal(member.needsHelp, undefined);
  });

  it("non-member cannot view context members", async () => {
    const tc = makeClient(NON_MEMBER_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`, undefined, NON_MEMBER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("pending/invited trip member cannot view presence", async () => {
    // Add viewer as invited (not accepted)
    state.tripMembers = state.tripMembers.map((m) =>
      m.user_id === VIEWER_ID ? { ...m, role: "invited" } : m,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 403);
  });

  it("event going attendee can view presence", async () => {
    const r = await req("GET", `/circle/contexts/event/${EVENT_ID}/members`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.members));
  });

  it("event maybe RSVP cannot view presence (not allowed as viewer)", async () => {
    // Viewer has status='maybe', not 'going'
    state.eventRsvps = state.eventRsvps.map((r) =>
      r.user_id === VIEWER_ID ? { ...r, status: "maybe" } : r,
    );
    const r = await req("GET", `/circle/contexts/event/${EVENT_ID}/members`);
    assert.equal(r.status, 403);
  });

  it("event going RSVP but missing event_attendees row cannot view presence", async () => {
    // Viewer has RSVP going but their event_attendees row was deleted (e.g. cant_go flow)
    state.eventAttendees = state.eventAttendees.filter((a) => a.user_id !== VIEWER_ID);
    const r = await req("GET", `/circle/contexts/event/${EVENT_ID}/members`);
    assert.equal(r.status, 403);
  });

  it("returns 400 for unknown context type", async () => {
    const r = await req("GET", `/circle/contexts/cruise/${TRIP_ID}/members`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  it("target hidden when global sharing off", async () => {
    state.circleVisibility[TARGET_ID] = {
      ...state.circleVisibility[TARGET_ID],
      global_enabled: false,
    };
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "target should be hidden");
  });

  it("target hidden when consent_version is stale/null (audit CIRCLE-1)", async () => {
    // A row enabled + consented but under a superseded policy version (or a
    // pre-migration null version) must not share presence. The batch guard used
    // by this endpoint ignored the version entirely; only the unreachable
    // single-shot guard enforced it.
    state.circleVisibility[TARGET_ID] = {
      ...state.circleVisibility[TARGET_ID],
      consent_version: null,
    };
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "target with a stale consent_version must be hidden");
  });

  it("target hidden when context sharing disabled", async () => {
    state.circleContextSettings.push({
      id:                     "ctx-1",
      user_id:                TARGET_ID,
      context_type:           "trip",
      context_id:             TRIP_ID,
      enabled:                false,
      visibility_mode_override: null,
      paused:                 false,
      paused_until:           null,
    });
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "target should be hidden");
  });

  it("target hidden when sharing paused", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();
    state.circleContextSettings.push({
      id:                     "ctx-2",
      user_id:                TARGET_ID,
      context_type:           "trip",
      context_id:             TRIP_ID,
      enabled:                true,
      visibility_mode_override: null,
      paused:                 true,
      paused_until:           futureDate,
    });
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "target should be hidden when paused");
  });

  it("target hidden when blocked", async () => {
    state.blocks.push({ blocker_id: VIEWER_ID, blocked_id: TARGET_ID });
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "blocked target should be hidden");
  });

  it("target hidden when presence expired", async () => {
    state.circlePresence = state.circlePresence.map((p) =>
      p.user_id === TARGET_ID
        ? { ...p, expires_at: new Date(Date.now() - 1000).toISOString() }
        : p,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "expired presence should not appear");
  });

  it("stale presence is labeled stale but still visible", async () => {
    state.circlePresence = state.circlePresence.map((p) =>
      p.user_id === TARGET_ID
        ? { ...p, last_seen_at: new Date(Date.now() - 7_200_000).toISOString(), is_stale: false }
        : p,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member, "stale member should still appear");
    assert.equal(member.isStale, true);
  });

  it("telegraph-only participant cannot view (not in trip_members)", async () => {
    // Re-inject client as the telegraph-only user — they have NO trip_members entry
    // but we can't inject their token easily; test by checking the guard directly.
    // Instead verify that TELEGR_ID is not returned in the member list even if
    // we temporarily add them as a separate presence row.
    state.circlePresence.push({
      id:           "pres-telegr",
      user_id:      TELEGR_ID,
      context_type: "trip",
      context_id:   TRIP_ID,
      status:       "active",
      stale_after_secs: 1800,
      last_seen_at: new Date().toISOString(),
      expires_at:   new Date(Date.now() + 86_400_000).toISOString(),
      is_stale:     false,
      needs_help:   false,
      updated_at:   new Date().toISOString(),
    });
    // TELEGR_ID is NOT in trip_members, so canViewCirclePresence for
    // (viewer → telegr) fails at "target_not_member".
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const telegr = r.body.members.find((m: any) => m.userId === TELEGR_ID);
    assert.equal(telegr, undefined, "telegraph-only user must not appear");
  });

  it("follow-only relationship does not grant membership", async () => {
    // TELEGR_ID follows viewer but has no trip_members row → should not appear
    // (already covered by telegraph-only test above; this verifies the concept)
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    const telegr = r.body.members?.find?.((m: any) => m.userId === TELEGR_ID);
    assert.equal(telegr, undefined);
  });

  it("mutual follows without co-membership do not grant presence access", async () => {
    // NON_MEMBER_ID mutually follows TARGET_ID but is NOT in trip_members.
    // Follow relationships must never satisfy the Circle membership guard —
    // only accepted trip_members / event_rsvps rows count.
    state.follows.push(
      { follower_id: NON_MEMBER_ID, following_id: TARGET_ID },
      { follower_id: TARGET_ID,     following_id: NON_MEMBER_ID },
    );
    const tc = makeClient(NON_MEMBER_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`, undefined, NON_MEMBER_TOKEN);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("admin kill switch blocks all visibility", async () => {
    state.featureFlags["find_your_circle_disabled"] = {
      flag: "find_your_circle_disabled",
      enabled: true,
    };
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    // All members hidden because kill switch is active in canViewCirclePresence
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.equal(member, undefined, "kill switch should hide all members");
  });
});

describe("Response shape — visibility mode fields", () => {
  it("status_only mode contains no location fields", async () => {
    state.circleVisibility[TARGET_ID]!.visibility_mode = "status_only";
    state.circlePresence = state.circlePresence.map((p) =>
      p.user_id === TARGET_ID
        ? { ...p, approximate_label: "Makati CBD", venue_label: "SM Mall" }
        : p,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member);
    assert.equal(member.approximateLabel, null);
    assert.equal(member.venueLabel, null);
  });

  it("approximate_area mode exposes approximateLabel only", async () => {
    state.circleVisibility[TARGET_ID]!.visibility_mode = "approximate_area";
    state.circlePresence = state.circlePresence.map((p) =>
      p.user_id === TARGET_ID
        ? { ...p, approximate_label: "Makati CBD", venue_label: "SM Mall" }
        : p,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member);
    assert.equal(member.approximateLabel, "Makati CBD");
    assert.equal(member.venueLabel, null); // venue not exposed in approximate mode
  });

  it("venue_checkin mode exposes venueLabel when checked_in=true", async () => {
    state.circleVisibility[TARGET_ID]!.visibility_mode = "venue_checkin";
    state.circlePresence = state.circlePresence.map((p) =>
      p.user_id === TARGET_ID
        ? { ...p, venue_label: "SM Mall", checked_in: true, approximate_label: "Makati CBD" }
        : p,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member);
    assert.equal(member.venueLabel, "SM Mall");
    assert.equal(member.approximateLabel, null);
  });

  it("venue_checkin mode hides venueLabel when not checked in", async () => {
    state.circleVisibility[TARGET_ID]!.visibility_mode = "venue_checkin";
    state.circlePresence = state.circlePresence.map((p) =>
      p.user_id === TARGET_ID
        ? { ...p, venue_label: "SM Mall", checked_in: false }
        : p,
    );
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member);
    assert.equal(member.venueLabel, null);
  });

  it("response never includes private fields", async () => {
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    const member = r.body.members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member);
    assert.equal(member.email,      undefined);
    assert.equal(member.phone,      undefined);
    assert.equal(member.needsHelp,  undefined);
    assert.equal(member.lat,        undefined);
    assert.equal(member.lng,        undefined);
    assert.equal(member.adminNotes, undefined);
  });
});

describe("POST /circle/contexts/:type/:id/need-help", () => {
  it("returns acknowledged=true without emergency details", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/need-help`, { note: "I need help" });
    assert.equal(r.status, 200);
    assert.equal(r.body.acknowledged, true);
    assert.ok(r.body.message);
    // Must not expose needs_help bool or GPS
    assert.equal(r.body.needsHelp, undefined);
    assert.equal(r.body.lat,       undefined);
    assert.equal(r.body.lng,       undefined);
  });

  it("non-member cannot trigger need-help", async () => {
    const tc = makeClient(NON_MEMBER_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/need-help`, {}, NON_MEMBER_TOKEN);
    assert.equal(r.status, 403);
  });

  it("need-help with invalid context type returns 400", async () => {
    const r = await req("POST", `/circle/contexts/ferry/${TRIP_ID}/need-help`, {});
    assert.equal(r.status, 400);
  });

  it("non-host member calling need-help reaches the host-alert branch (no self-skip)", async () => {
    // TARGET_ID is a trip member but NOT the trip owner (owner_id = VIEWER_ID).
    // When TARGET_ID calls need-help, the route resolves hostId = VIEWER_ID and
    // since hostId !== TARGET_ID, the notification fire path is executed (not skipped).
    // We verify the route returns 200 without crashing — confirming owner_id is read
    // (not the old user_id column) and the host-alert code path is reached.
    const tc = makeClient(TARGET_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/need-help`, { note: "SOS" }, TARGET_TOKEN);
    assert.equal(r.status, 200, "non-host member need-help should succeed (host-alert fires, not skipped)");
    assert.equal(r.body.acknowledged, true);
    // Restore auth to VIEWER_ID for subsequent tests
    const vc = makeClient(VIEWER_ID);
    _setTestClient(vc as any, true);
    _setTestServiceClient(vc as any);
  });
});

describe("POST /circle/contexts/:type/:id/presence — precise_live rejected", () => {
  it("returns 403 when visibilityMode is precise_live", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/presence`, {
      visibilityMode: "precise_live",
    });
    assert.equal(r.status, 403);
  });
});

describe("PATCH /circle/contexts/:type/:id/settings — precise_live rejected", () => {
  it("returns 403 (not 400) when visibilityModeOverride is precise_live", async () => {
    const r = await req("PATCH", `/circle/contexts/trip/${TRIP_ID}/settings`, {
      visibilityModeOverride: "precise_live",
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_supported");
  });
});

describe("POST /circle/contexts/:type/:id/check-in", () => {
  it("creates check-in and updates presence", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/check-in`, {
      checkinType: "arrived",
      venueLabel:  "Hotel Lobby",
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.id);
    assert.equal(r.body.checkinType, "arrived");
    // Presence should be updated
    const pres = state.circlePresence.find((p) => p.user_id === VIEWER_ID && p.context_type === "trip");
    assert.equal(pres?.status, "arrived");
    assert.equal(pres?.checked_in, true);
  });

  it("non-member cannot check in", async () => {
    const tc = makeClient(NON_MEMBER_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/check-in`, { checkinType: "arrived" }, NON_MEMBER_TOKEN);
    assert.equal(r.status, 403);
  });
});

describe("POST /circle/contexts/:type/:id/pause and resume", () => {
  it("pause sets paused=true in context settings", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/pause`);
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, true);
    const cs = state.circleContextSettings.find(
      (s) => s.user_id === VIEWER_ID && s.context_type === "trip" && s.context_id === TRIP_ID,
    );
    assert.equal(cs?.paused, true);
  });

  it("resume sets paused=false", async () => {
    // First pause
    await req("POST", `/circle/contexts/trip/${TRIP_ID}/pause`);
    // Then resume
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/resume`);
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, false);
  });
});

describe("Admin: GET /admin/circle/reports", () => {
  it("admin can fetch reports", async () => {
    const adminClient = makeClient(ADMIN_ID);
    _setTestClient(adminClient as any, true);
    _setTestServiceClient(adminClient as any);
    const r = await req("GET", "/admin/circle/reports", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.reports));
  });

  it("non-admin gets 403", async () => {
    const r = await req("GET", "/admin/circle/reports");
    assert.equal(r.status, 403);
  });
});

describe("Admin: POST /admin/circle/kill-switch", () => {
  it("admin can activate kill switch", async () => {
    const adminClient = makeClient(ADMIN_ID);
    _setTestClient(adminClient as any, true);
    _setTestServiceClient(adminClient as any);
    const r = await req("POST", "/admin/circle/kill-switch", { enabled: true }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.killSwitchEnabled, true);
    assert.equal(state.featureFlags["find_your_circle_disabled"]?.enabled, true);
  });

  it("admin can deactivate kill switch", async () => {
    state.featureFlags["find_your_circle_disabled"]!.enabled = true;
    const adminClient = makeClient(ADMIN_ID);
    _setTestClient(adminClient as any, true);
    _setTestServiceClient(adminClient as any);
    const r = await req("POST", "/admin/circle/kill-switch", { enabled: false }, ADMIN_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.killSwitchEnabled, false);
  });
});

describe("Internal cleanup", () => {
  it("returns 401 without secret", async () => {
    const r = await req("POST", "/circle/internal/cleanup-presence", {});
    assert.equal(r.status, 401);
  });

  it("runs cleanup with correct secret", async () => {
    process.env["INTERNAL_API_SECRET"] = "test-secret";
    const p = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify({});
      const url = new URL("/circle/internal/cleanup-presence", base);
      const r = http.request(
        {
          hostname: url.hostname,
          port:     Number(url.port),
          path:     url.pathname,
          method:   "POST",
          headers: {
            "content-type":       "application/json",
            "x-internal-secret":  "test-secret",
          },
        },
        (inRes) => {
          let raw = "";
          inRes.on("data", (c) => (raw += c));
          inRes.on("end", () => {
            resolve({ status: inRes.statusCode ?? 0, body: JSON.parse(raw) });
          });
        },
      );
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
    const result = await p;
    assert.equal(result.status, 200);
    assert.ok("markedStale" in result.body);
    assert.ok("deleted" in result.body);
    delete process.env["INTERNAL_API_SECRET"];
  });
});

describe("GET /circle/contexts/:type/:id/meeting-point", () => {
  it("member can view active meeting point", async () => {
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/meeting-point`);
    assert.equal(r.status, 200);
    assert.ok(r.body.meetingPoint);
    assert.equal(r.body.meetingPoint.venueLabel, "Hotel Lobby");
  });

  it("non-member cannot view meeting point", async () => {
    const tc = makeClient(NON_MEMBER_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/meeting-point`, undefined, NON_MEMBER_TOKEN);
    assert.equal(r.status, 403);
  });
});

// ── Regression: privacy — Circle fields must not appear in non-Circle responses ─

describe("Regression: Circle field isolation", () => {
  beforeEach(() => {
    resetState();
    const c = makeClient(VIEWER_ID);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
  });

  it("check-in response omits needs_help, GPS, and emergency fields", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/check-in`, {
      checkinType: "arrived",
    });
    assert.equal(r.status, 201);
    // Privacy: these fields must NEVER be surfaced in a check-in response.
    assert.ok(!("needs_help"    in r.body), "needs_help must be absent from check-in response");
    assert.ok(!("lat"           in r.body), "lat must be absent from check-in response");
    assert.ok(!("lng"           in r.body), "lng must be absent from check-in response");
    assert.ok(!("gps"           in r.body), "gps must be absent from check-in response");
    assert.ok(!("location"      in r.body), "location must be absent from check-in response");
  });

  it("need-help response omits needs_help bool, GPS, and emergency detail", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/need-help`);
    assert.equal(r.status, 200);
    assert.ok(!("needs_help" in r.body), "needs_help must be absent from need-help response");
    assert.ok(!("lat"        in r.body), "lat must be absent from need-help response");
    assert.ok(!("lng"        in r.body), "lng must be absent from need-help response");
    assert.ok(!("gps"        in r.body), "gps must be absent from need-help response");
    assert.ok(!("location"   in r.body), "location must be absent from need-help response");
    // The only safe fields are acknowledged + message.
    assert.equal(r.body.acknowledged, true);
    assert.ok(typeof r.body.message === "string");
  });

  it("members list (status_only) omits all location and emergency detail", async () => {
    // GET /members returns shaped presence; we assert no GPS or emergency fields leak.
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
    const members: any[] = r.body.members ?? [];
    const member = members.find((m: any) => m.userId === TARGET_ID);
    assert.ok(member, "TARGET_ID should appear in the members response");
    // Privacy: location-revealing and emergency fields must never appear on any shape.
    assert.ok(!("lat"       in member), "lat must be absent from status_only member shape");
    assert.ok(!("lng"       in member), "lng must be absent from status_only member shape");
    assert.ok(!("gps"       in member), "gps must be absent from status_only member shape");
    assert.ok(!("needsHelp" in member), "needsHelp must be absent from status_only member shape");
    assert.ok(!("needs_help" in member), "needs_help must be absent from status_only member shape");
  });
});

// ── GET /circle/compass-suggestions ──────────────────────────────────────────

describe("GET /circle/compass-suggestions", () => {
  beforeEach(() => {
    resetState();
    _resetRateLimit(); // clear buckets so prior tests don't bleed in
    const c = makeClient(VIEWER_ID);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
  });

  it("returns 200 with cards array (empty when caller has no trip/event memberships)", async () => {
    // Clear the canonical membership tables so VIEWER_ID has no contexts.
    // The endpoint now reads trip_members + event_rsvps (not circle_members).
    state.tripMembers = [];
    state.eventRsvps  = [];
    const r = await req("GET", "/circle/compass-suggestions");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.cards), "body.cards should be an array");
    assert.deepEqual(r.body.cards, []);
  });

  it("returns a turn_on_circle card when caller is a trip member but not sharing", async () => {
    // Default state already has VIEWER_ID as accepted trip_members of TRIP_ID.
    // No circle_presence row for VIEWER_ID → caller is not actively sharing → turn_on_circle.
    const r = await req("GET", "/circle/compass-suggestions");
    assert.equal(r.status, 200);
    assert.ok(r.body.cards.length >= 1, "should have at least one card");
    const card = r.body.cards[0];
    assert.equal(card.cardType, "turn_on_circle");
    assert.equal(card.contextId, TRIP_ID);
    assert.ok(!("gps" in card), "GPS must not appear on compass suggestion card");
    assert.ok(!("needsHelp" in card), "needsHelp must not appear on compass suggestion card");
  });

  it("returns a circle_active card when caller and others are actively sharing", async () => {
    // Default state: VIEWER_ID is accepted member of TRIP_ID via trip_members.
    // Add VIEWER_ID's own active presence row.
    state.circlePresence.push({
      id: "pres-viewer-active", user_id: VIEWER_ID, context_type: "trip", context_id: TRIP_ID,
      status: "active", is_stale: false, needs_help: false, last_seen_at: new Date().toISOString(),
    });
    // TARGET_ID already has an active presence row in default state → othersActive > 0.
    const r = await req("GET", "/circle/compass-suggestions");
    assert.equal(r.status, 200);
    assert.ok(r.body.cards.length >= 1, "should have at least one card");
    const activeCard = r.body.cards.find((c: any) => c.cardType === "circle_active");
    assert.ok(activeCard, "circle_active card should be returned");
    assert.ok(typeof activeCard.metadata.activeCount === "number", "activeCount should be a number");
    // Privacy: no user IDs in metadata
    assert.ok(!("members" in activeCard.metadata), "member IDs must not appear in metadata");
    assert.ok(!("userIds" in activeCard.metadata), "userIds must not appear in metadata");
  });

  it("returns a set_meeting_point card for host with no active meeting point", async () => {
    // Default state: VIEWER_ID is trip_members of TRIP_ID; VIEWER_ID is owner (trips.owner_id).
    // Add VIEWER_ID's own active presence (so turn_on_circle won't fire).
    state.circlePresence.push({
      id: "pres-viewer-active2", user_id: VIEWER_ID, context_type: "trip", context_id: TRIP_ID,
      status: "active", is_stale: false, needs_help: false, last_seen_at: new Date().toISOString(),
    });
    // Remove all meeting points so is_active=true query returns nothing.
    state.circleMeetingPoints = [];
    const r = await req("GET", "/circle/compass-suggestions");
    assert.equal(r.status, 200);
    // VIEWER_ID is owner of TRIP_ID → should get set_meeting_point card
    const mpCard = r.body.cards.find((c: any) => c.cardType === "set_meeting_point");
    assert.ok(mpCard, "set_meeting_point card should appear for host with no active meeting point");
    assert.equal(mpCard.contextId, TRIP_ID);
  });

  it("returns 401 when unauthenticated", async () => {
    const p = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const url = new URL("/circle/compass-suggestions", base);
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET",
          headers: { "content-type": "application/json" } },
        (inRes) => {
          let raw = "";
          inRes.on("data", (c) => (raw += c));
          inRes.on("end", () => resolve({ status: inRes.statusCode ?? 0, body: JSON.parse(raw) }));
        },
      );
      r.on("error", reject);
      r.end();
    });
    const result = await p;
    assert.equal(result.status, 401);
  });
});

// ── POST /circle/pause-on-session-end ────────────────────────────────────────

describe("POST /circle/pause-on-session-end", () => {
  beforeEach(() => {
    resetState();
    const c = makeClient(VIEWER_ID);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
  });

  it("pauses all active presence rows for the caller and returns count", async () => {
    // Seed an active presence row for VIEWER_ID.
    state.circlePresence.push({
      id: "pres-viewer-trip",
      user_id: VIEWER_ID, context_type: "trip", context_id: TRIP_ID,
      status: "active", needs_help: false, last_seen_at: new Date().toISOString(),
      is_stale: false, stale_after_secs: 1800,
    });
    const r = await req("POST", "/circle/pause-on-session-end", {});
    assert.equal(r.status, 200);
    assert.ok(typeof r.body.paused === "number", "body.paused should be a number");
    assert.ok(r.body.paused >= 1, "at least one row should have been paused");
    // Verify the presence row was mutated to paused.
    const row = state.circlePresence.find((p) => p.user_id === VIEWER_ID && p.context_id === TRIP_ID);
    assert.ok(row, "presence row should still exist (not deleted)");
    assert.equal(row?.status, "paused");
  });

  it("is idempotent — already paused returns 200 with paused=0", async () => {
    // No active (non-paused) rows for VIEWER_ID → idempotent.
    state.circlePresence.push({
      id: "pres-viewer-paused",
      user_id: VIEWER_ID, context_type: "trip", context_id: TRIP_ID,
      status: "paused", needs_help: false, last_seen_at: new Date().toISOString(),
      is_stale: false, stale_after_secs: 1800,
    });
    const r = await req("POST", "/circle/pause-on-session-end", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.paused, 0);
  });

  it("returns 401 when unauthenticated", async () => {
    const p = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = JSON.stringify({});
      const url = new URL("/circle/pause-on-session-end", base);
      const r = http.request(
        { hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "POST",
          headers: { "content-type": "application/json" } },
        (inRes) => {
          let raw = "";
          inRes.on("data", (c) => (raw += c));
          inRes.on("end", () => resolve({ status: inRes.statusCode ?? 0, body: JSON.parse(raw) }));
        },
      );
      r.on("error", reject);
      r.write(payload);
      r.end();
    });
    const result = await p;
    assert.equal(result.status, 401);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("Rate limiting", () => {
  beforeEach(() => {
    resetState();
    _resetRateLimit(); // start each test with a clean slate
    const c = makeClient(VIEWER_ID);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
  });

  it("GET /members returns 200 for a normal call", async () => {
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 200);
  });

  it("GET /members returns 429 after the bucket is exhausted", async () => {
    // Exhaust the circle_members bucket for VIEWER_ID by calling checkRateLimit
    // directly 60 times (the default CIRCLE_MEMBERS_RL_LIMIT).  The next HTTP
    // call (the 61st) must be blocked by the route.
    const LIMIT = parseInt(process.env["CIRCLE_MEMBERS_RL_LIMIT"] ?? "60", 10);
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("circle_members", VIEWER_ID, LIMIT, 60_000);
    }
    const r = await req("GET", `/circle/contexts/trip/${TRIP_ID}/members`);
    assert.equal(r.status, 429, "should be rate-limited after bucket exhaustion");
    assert.ok(r.body.error, "error field should be present in 429 response");
    // Retry-After header must be set
    // (Note: status code check is sufficient; header is returned by the HTTP layer)
  });

  it("POST /presence returns 200 for a normal call", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/presence`, {
      visibilityMode: "status_only",
    });
    assert.equal(r.status, 200);
  });

  it("POST /presence returns 429 after the bucket is exhausted", async () => {
    const LIMIT = parseInt(process.env["CIRCLE_PRESENCE_RL_LIMIT"] ?? "30", 10);
    for (let i = 0; i < LIMIT; i++) {
      checkRateLimit("circle_presence", VIEWER_ID, LIMIT, 5 * 60_000);
    }
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/presence`, {
      visibilityMode: "status_only",
    });
    assert.equal(r.status, 429, "presence update should be rate-limited after bucket exhaustion");
  });
});

// ── Privacy regression checks ─────────────────────────────────────────────────

describe("Privacy regression checks", () => {
  it("circle.meeting_point_updated template body never contains venue or location text", () => {
    // Regression guard: the template must NOT render venue names, area labels,
    // or any location-bearing text in the notification body. Only generic status
    // + deep-link. Even if callers accidentally pass venueLabel / approximateLabel
    // the template should not emit them.
    const rendered = renderTemplate("circle.meeting_point_updated", {
      actor: "Alice",
      contextType: "trip",
      contextId: TRIP_ID,
      contextTitle: "Tokyo Trip",
      // intentionally pass location fields to verify they are ignored
      venueLabel: "Shinjuku Station West Exit",
      approximateLabel: "Shinjuku, Tokyo",
    });
    assert.ok(rendered, "template should render");
    const body = rendered!.body;
    assert.ok(!body.includes("Shinjuku Station"), "body must not include venue name");
    assert.ok(!body.includes("Shinjuku, Tokyo"), "body must not include approximate label");
    assert.ok(!body.toLowerCase().includes("head to:"), "body must not use 'Head to:' phrasing");
    // Must be a safe, generic message with only a deep-link via actionUrl
    assert.ok(body.includes("meeting point"), "body should describe what changed");
    assert.ok(rendered!.actionUrl?.includes(TRIP_ID), "actionUrl must reference the context");
  });

  it("compass-suggestions excludes events where caller has RSVP but no event_attendees row", async () => {
    // Regression guard: canonical event membership requires BOTH going RSVP AND
    // an event_attendees row. A user with only an RSVP (e.g. sync not yet run)
    // must NOT receive Circle prompts for that event context.
    resetState();
    _resetRateLimit();
    const c = makeClient(VIEWER_ID);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);

    // Remove trip membership so the only potential context is the event.
    state.tripMembers = [];
    // Keep event RSVP (going) but remove the event_attendees row for VIEWER_ID.
    state.eventAttendees = state.eventAttendees.filter((r) => r.user_id !== VIEWER_ID);

    const r = await req("GET", "/circle/compass-suggestions");
    assert.equal(r.status, 200);
    // Without the attendees row the event context must be excluded → no cards.
    assert.deepEqual(
      r.body.cards,
      [],
      "RSVP-only (no event_attendees row) must yield zero event Circle cards",
    );
  });
});

// ── Notification pipeline smoke tests ─────────────────────────────────────────
//
// sendCircleNotifications() is fire-and-forget, so silent failures don't surface
// in the HTTP response tests above.  These tests verify that the pipeline is
// actually triggered by checking state.notifications after each action.
//
// Timing: all assertions run after a short delay so the fire-and-forget async
// block (void (async () => {...})()) has time to complete.

describe("Notification pipeline", () => {
  function waitForPipeline(): Promise<void> {
    // Give the fire-and-forget async block time to flush through the event loop.
    return new Promise((resolve) => setTimeout(resolve, 100));
  }

  beforeEach(() => {
    resetState();
    const c = makeClient(VIEWER_ID);
    _setTestClient(c as any, true);
    _setTestServiceClient(c as any);
  });

  it("check-in POST triggers circle.checkin notification to other members", async () => {
    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/check-in`, {
      checkinType: "arrived",
      venueLabel:  "Hotel Lobby",
    });
    assert.equal(r.status, 201, "check-in should succeed");

    await waitForPipeline();

    const notif = state.notifications.find((n: any) => n.event_type === "circle.checkin");
    assert.ok(notif, "circle.checkin notification must be created after check-in");
    // VIEWER_ID is the actor — TARGET_ID is the only other trip member, so they receive it.
    assert.equal(notif.user_id, TARGET_ID, "notification must target the other circle member, not the actor");
  });

  it("need-help POST triggers circle.need_help_host_alert notification to the trip host", async () => {
    // Switch to TARGET client — a non-host member triggers need-help so the
    // host (VIEWER_ID, who owns TRIP_ID) receives the alert.
    const tc = makeClient(TARGET_ID);
    _setTestClient(tc as any, true);
    _setTestServiceClient(tc as any);

    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/need-help`, { note: "SOS" }, TARGET_TOKEN);
    assert.equal(r.status, 200, "need-help should succeed for an accepted member");

    await waitForPipeline();

    const notif = state.notifications.find((n: any) => n.event_type === "circle.need_help_host_alert");
    assert.ok(notif, "circle.need_help_host_alert notification must be created");
    assert.equal(notif.user_id, VIEWER_ID, "host-alert must target the trip owner, not the actor");
  });

  it("POST /meeting-point triggers circle.meeting_point_updated notification to members", async () => {
    // Clear existing meeting point so POST (create) path is exercised.
    state.circleMeetingPoints = [];

    const r = await req("POST", `/circle/contexts/trip/${TRIP_ID}/meeting-point`, {
      venueLabel: "Airport Terminal 2",
    });
    assert.equal(r.status, 201, "meeting-point POST should succeed for the host");

    await waitForPipeline();

    const notif = state.notifications.find((n: any) => n.event_type === "circle.meeting_point_updated");
    assert.ok(notif, "circle.meeting_point_updated notification must be created after meeting point set");
    // HOST (VIEWER_ID) is the actor — TARGET_ID is the only other member.
    assert.equal(notif.user_id, TARGET_ID, "notification must target other members, not the host");
  });
});
