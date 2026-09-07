/**
 * Trip Kernel — lib/tripKernel.ts, the gated plan-item handlers in
 * routes/trips.ts, and the §24 Phase 1 writer ratchet.
 *
 * Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
 *   §4.1  command envelope; schema + actor + version validation
 *   §18.3 optimistic concurrency, explicit conflict
 *   §21.1 trip_command_rejected_total by reason
 *   §22.4 duplicate idempotency key => no duplicate transition
 *   §24   ratchet direct writes
 *
 * WHAT THE FAKE IS AND IS NOT
 * ===========================
 * The fake client below models public.trip_kernel_execute (migration 2420)
 * in memory so the TypeScript layer can be exercised: gating, envelope
 * headers, authorization-before-command ordering, rejection-to-HTTP mapping,
 * the counter. It is a MODEL of the SQL, not the SQL. The function's own
 * semantics (locking, receipt, crew re-check, version check, transition
 * refusal, event/outbox/receipt in one transaction, append-only trigger) were
 * measured live on portava-ci in a rolled-back DO block and recorded in the
 * lane report; nothing here re-proves them.
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/tripKernel.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";
import routePlanRouter from "../routes/routePlan.js";
import {
  planCommandTypeForPatch,
  readCommandEnvelope,
  readTripCommandRejectedTotal,
  _resetTripCommandRejectedTotal,
  executeTripCommand,
  tripCommandFamily,
  TRIP_EVENT_TYPES,
  TRIP_KERNEL_CONTRACT_VERSION,
} from "../lib/tripKernel.js";
import { countCanonicalWrites, judge, surveyTree, ungatedOf } from "../scripts/checkTripKernelWriters.js";
import { TRIP_KERNEL_DIRECT_WRITERS } from "../scripts/tripKernelWriterBaseline.js";

// ── IDs ───────────────────────────────────────────────────────────────────────
const ALICE_ID = "aaaaaaaa-0000-0000-0000-000000000001"; // owner (no trip_members row)
const BOB_ID   = "bbbbbbbb-0000-0000-0000-000000000002"; // accepted member
const CAROL_ID = "cccccccc-0000-0000-0000-000000000003"; // non-member
const DAVE_ID  = "dddddddd-0000-0000-0000-000000000004"; // pending invitee (role 'invited')
const TRIP_ID  = "33333333-0000-0000-0000-000000000001";
const ITEM_A   = "66666666-0000-0000-0000-000000000004";
const ITEM_B   = "77777777-0000-0000-0000-000000000005";

// ── State ─────────────────────────────────────────────────────────────────────
interface State {
  users: Record<string, { id: string } | null>;
  trips: any[];
  trip_members: any[];
  trip_plan_items: any[];
  feature_flags: any[];
  trip_events: any[];
  trip_outbox: any[];
  trip_command_receipts: any[];
  route_plans: any[];
  route_stops: any[];
  route_legs: any[];
  plan_editors: any[];
  rpcCalls: Array<{ name: string; args: any }>;
  rpcFail: boolean;
}

function baseState(kernelOn: boolean): State {
  return {
    users: { "alice-tok": { id: ALICE_ID }, "bob-tok": { id: BOB_ID }, "carol-tok": { id: CAROL_ID }, "dave-tok": { id: DAVE_ID } },
    trips: [{ id: TRIP_ID, owner_id: ALICE_ID, plan_edit_permission: "all_members", version: 0,
      title: "Lisbon", destination_city: "Lisbon", destination_country: "PT", start_date: "2026-10-01", end_date: "2026-10-05",
      status: "upcoming", visibility: "private", timezone: "Europe/Lisbon", trip_notes: null, cover_url: null, cover_media_type: null,
      show_header_publicly: false, reminder_sent_at: null, internal_notes: "NEVER-TO-CLIENT",
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: BOB_ID, role: "member", status: "accepted" },
      // Legacy invite row shape: role 'invited', status left at its default.
      { trip_id: TRIP_ID, user_id: DAVE_ID, role: "invited", status: "accepted" },
    ],
    trip_plan_items: [
      { id: ITEM_A, trip_id: TRIP_ID, creator_id: ALICE_ID, title: "Dinner", category: "dining", status: "tentative",
        source_type: "manual", source_id: null, day_date: null, starts_at: null, ends_at: null, location_name: null,
        notes: null, sort_order: 0, visibility: "members", removed_at: null, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z" },
      { id: ITEM_B, trip_id: TRIP_ID, creator_id: BOB_ID, title: "Bar", category: "activity", status: "tentative",
        source_type: "manual", source_id: null, day_date: null, starts_at: null, ends_at: null, location_name: null,
        notes: null, sort_order: 1, visibility: "members", removed_at: null, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z" },
    ],
    feature_flags: kernelOn ? [{ flag: "trip_kernel_enabled", enabled: true }] : [],
    trip_events: [],
    trip_outbox: [],
    trip_command_receipts: [],
    route_plans: [],
    route_stops: [],
    route_legs: [],
    plan_editors: [],
    rpcCalls: [],
    rpcFail: false,
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────
let counter = 0;

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _insertRow: any = null;
    let _updatePayload: any = null;

    const b: any = {
      select() { return b; },
      insert(row: any) { _op = "insert"; _insertRow = row; return b; },
      update(patch: any) { _op = "update"; _updatePayload = patch; return b; },
      delete() { _op = "delete"; return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      is(col: string, val: any) { filters.push((r: any) => (val === null ? r[col] == null : r[col] === val)); return b; },
      // Filters the trip routes' side-effects use on tables this fake keeps
      // empty (trust_restrictions, message_threads, ...): pass-through.
      or() { return b; },
      gt() { return b; },
      gte() { return b; },
      lt() { return b; },
      lte() { return b; },
      neq() { return b; },
      not() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolveOne(); },
      single() { return resolveInsertOrOne(); },
      then(onF: any, onR: any) {
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        if (_op === "insert") return resolveInsertList().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] {
      if (!(state as any)[table]) (state as any)[table] = [];
      return (state as any)[table];
    }
    // Array insert awaited directly (route_stops / route_legs in routes/routePlan.ts).
    async function resolveInsertList() {
      const rows = (Array.isArray(_insertRow) ? _insertRow : [_insertRow]).map((r: any) => ({
        id: `${table}-${++counter}`, created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", ...r,
      }));
      for (const r of rows) getSource().push(r);
      return { data: rows, error: null };
    }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() {
      if (_op === "update") {
        const m = matchedRows();
        return { data: m[0] ? { ...m[0], ..._updatePayload } : null, error: null };
      }
      const m = matchedRows();
      return { data: m[0] ?? null, error: null };
    }
    async function resolveInsertOrOne() {
      if (_op === "insert" && _insertRow) {
        const newRow: any = { id: `direct-${++counter}`, created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", removed_at: null, ..._insertRow };
        getSource().push(newRow);
        return { data: newRow, error: null };
      }
      if (_op === "update" && _updatePayload) {
        let updated: any = null;
        for (const row of getSource()) if (filters.every((f) => f(row))) { Object.assign(row, _updatePayload); updated = row; }
        return { data: updated ?? null, error: null };
      }
      const m = matchedRows();
      return { data: m[0] ?? null, error: null };
    }
    async function resolveList() { return { data: matchedRows(), error: null }; }
    async function resolveUpdate() {
      for (const row of getSource()) if (filters.every((f) => f(row))) Object.assign(row, _updatePayload);
      return { data: null, error: null };
    }
    async function resolveDelete() {
      (state as any)[table] = getSource().filter((r: any) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    return b;
  }

  // In-memory model of public.trip_kernel_execute (2420). See file header.
  async function rpc(name: string, args: any) {
    state.rpcCalls.push({ name, args });
    if (state.rpcFail) return { data: null, error: { message: "simulated database error" } };
    if (name !== "trip_kernel_execute") return { data: null, error: { message: `unknown rpc ${name}` } };
    const c = args.p_command;
    const reject = (reason: string, extra: Record<string, unknown> = {}) => ({ data: { ok: false, reason, ...extra, contract_version: 2 }, error: null });

    // Contract v2 (2450): capability per command family.
    const REQUIRED: Record<string, string> = {
      ADD_PLAN: "crew", UPDATE_PLAN: "crew", MOVE_PLAN: "crew", CONFIRM_PLAN: "crew", CANCEL_PLAN: "crew",
      COMPLETE_ACTIVITY: "crew", REMOVE_PLAN: "crew", REORDER_PLAN: "crew", LINK_PLAN_ROUTE_STOP: "crew",
      CREATE_TRIP: "none", UPDATE_TRIP: "owner", CANCEL_TRIP: "owner", COMPLETE_TRIP: "owner", ARCHIVE_TRIP: "owner",
      INVITE_PARTICIPANT: "owner", ADD_PARTICIPANT: "owner", SET_PARTICIPANT_ROLE: "owner", REMOVE_PARTICIPANT: "owner",
      ACCEPT_INVITE: "invited", DECLINE_INVITE: "invited", ADMIN_HIDE_TRIP: "admin", SET_TRIP_COVER: "system",
    };
    const required = REQUIRED[c.type];
    if (required === undefined) return reject("TRIP_COMMAND_UNKNOWN_TYPE", { type: c.type });
    const actorRole = c.actor_role ?? "user";
    if ((required === "admin" && actorRole !== "admin") || (required === "system" && actorRole !== "system")
        || (!["admin", "system"].includes(required) && actorRole !== "user")) {
      return reject("TRIP_AUTH_ROLE_NOT_PERMITTED", { actor_role: actorRole, type: c.type });
    }
    let trip = state.trips.find((t) => t.id === c.trip_id);
    if (c.type === "CREATE_TRIP") {
      if (trip) {
        const rc = state.trip_command_receipts.find((r) => r.trip_id === c.trip_id && r.idempotency_key === c.idempotency_key);
        if (rc && rc.command_type === "CREATE_TRIP" && rc.actor_user_id === c.actor_user_id) {
          return { data: { ok: true, duplicate: true, version: rc.result_version, event_id: rc.event_id, result: rc.result_json, contract_version: 2 }, error: null };
        }
        return reject("TRIP_IDENTITY_ALREADY_EXISTS");
      }
      const p0 = c.payload ?? {};
      if (p0.start_date && p0.end_date && p0.start_date > p0.end_date) return reject("TRIP_TEMPORAL_RANGE_INVERTED");
      trip = { id: c.trip_id, owner_id: c.actor_user_id, version: 0, plan_edit_permission: "all_members",
        title: p0.title ?? null, destination_city: p0.destination_city ?? null, destination_country: p0.destination_country ?? null,
        start_date: p0.start_date ?? null, end_date: p0.end_date ?? null, status: p0.status ?? "planning",
        visibility: p0.visibility ?? "private", cover_url: p0.cover_url ?? null, cover_media_type: p0.cover_media_type ?? null,
        trip_notes: p0.trip_notes ?? null, show_header_publicly: p0.show_header_publicly ?? ((p0.visibility ?? "private") === "public"),
        reminder_sent_at: null, internal_notes: "NEVER-TO-CLIENT",
        created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" };
      state.trips.push(trip);
      // trg_trip_owner_member: the owner row appears with the trip.
      state.trip_members.push({ trip_id: trip.id, user_id: c.actor_user_id, role: "owner", status: "accepted" });
    } else {
      if (!trip) return reject("TRIP_NOT_FOUND");
      const receipt = state.trip_command_receipts.find((r) => r.trip_id === c.trip_id && r.idempotency_key === c.idempotency_key);
      if (receipt) {
        if (receipt.actor_user_id !== (c.actor_user_id ?? null) || (receipt.actor_role ?? "user") !== actorRole) return reject("TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN");
        return { data: { ok: true, duplicate: true, version: receipt.result_version, event_id: receipt.event_id, result: receipt.result_json, contract_version: 2 }, error: null };
      }
      const isCrew = trip.owner_id === c.actor_user_id || state.trip_members.some((m) =>
        m.trip_id === c.trip_id && m.user_id === c.actor_user_id &&
        ["owner", "co_host", "member", "viewer"].includes(m.role) && (m.status ?? "accepted") === "accepted");
      const isOwner = trip.owner_id === c.actor_user_id || state.trip_members.some((m) =>
        m.trip_id === c.trip_id && m.user_id === c.actor_user_id && m.role === "owner" && (m.status ?? "accepted") === "accepted");
      const ownRow = state.trip_members.find((m) => m.trip_id === c.trip_id && m.user_id === c.actor_user_id);
      if (required === "crew" && !isCrew) return reject("TRIP_AUTH_NOT_CREW");
      if (required === "owner" && !isOwner) return reject("TRIP_AUTH_NOT_OWNER");
      if (required === "invited" && (!ownRow || ownRow.role !== "invited")) return reject("TRIP_AUTH_NOT_INVITED", { current_role: ownRow?.role ?? null });
      if (required === "admin" && !(state as any).admins?.includes(c.actor_user_id)) return reject("TRIP_AUTH_NOT_ADMIN");
    }
    const current = trip.version ?? 0;
    if (c.expected_trip_version != null && c.expected_trip_version !== current) {
      return reject("TRIP_VERSION_CONFLICT", { current_version: current, expected_version: c.expected_trip_version });
    }

    const live = (id: string) => state.trip_plan_items.find((i) => i.id === id && i.trip_id === c.trip_id && i.removed_at == null);
    let eventType: string;
    let result: any;
    const p = c.payload ?? {};
    switch (c.type) {
      case "ADD_PLAN": {
        const row = { id: `kernel-${++counter}`, trip_id: c.trip_id, creator_id: c.actor_user_id, title: p.title,
          category: p.category ?? "activity", status: p.status ?? "tentative", source_type: p.source_type ?? "manual",
          source_id: p.source_id ?? null, day_date: p.day_date ?? null, starts_at: p.starts_at ?? null, ends_at: p.ends_at ?? null,
          location_name: p.location_name ?? null, lat: p.lat ?? null, lng: p.lng ?? null, location_is_private: p.location_is_private ?? false,
          notes: p.notes ?? null, sort_order: p.sort_order ?? 0, lock_type: p.lock_type ?? "flexible", visibility: p.visibility ?? "members",
          removed_at: null, created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" };
        state.trip_plan_items.push(row);
        eventType = "trip.plan_added"; result = row; break;
      }
      case "UPDATE_PLAN": case "MOVE_PLAN": case "CONFIRM_PLAN": case "CANCEL_PLAN": case "COMPLETE_ACTIVITY": {
        const item = live(p.item_id);
        if (!item) return reject("TRIP_PLAN_NOT_FOUND");
        const patch = p.patch ?? {};
        if (patch.status !== undefined && patch.status !== item.status && ["done", "cancelled"].includes(item.status)) {
          return reject("TRIP_PLAN_INVALID_TRANSITION", { from: item.status, to: patch.status });
        }
        Object.assign(item, patch, { updated_at: p.updated_at ?? "2026-01-03T00:00:00.000Z" });
        eventType = ({ MOVE_PLAN: "trip.plan_moved", CONFIRM_PLAN: "trip.plan_confirmed", CANCEL_PLAN: "trip.plan_cancelled", COMPLETE_ACTIVITY: "trip.plan_completed" } as Record<string, string>)[c.type] ?? "trip.plan_updated";
        result = item; break;
      }
      case "REMOVE_PLAN": {
        const item = live(p.item_id);
        if (!item) return reject("TRIP_PLAN_NOT_FOUND");
        item.removed_at = p.removed_at ?? "2026-01-03T00:00:00.000Z";
        eventType = "trip.plan_removed"; result = { id: p.item_id }; break;
      }
      case "REORDER_PLAN": {
        const items: any[] = p.items ?? [];
        if (items.length === 0) return reject("TRIP_COMMAND_MALFORMED");
        if (!items.every((e) => live(e.item_id))) return reject("TRIP_PLAN_NOT_FOUND");
        for (const e of items) Object.assign(live(e.item_id), { sort_order: e.sort_order, updated_at: p.updated_at });
        eventType = "trip.plan_reordered"; result = { items }; break;
      }
      case "LINK_PLAN_ROUTE_STOP": {
        const item = live(p.item_id);
        if (!item) return reject("TRIP_PLAN_NOT_FOUND");
        item.route_stop_id = p.route_stop_id;
        eventType = "trip.plan_route_stop_linked"; result = { id: p.item_id, route_stop_id: p.route_stop_id }; break;
      }
      // ── Contract v2 families (2450) ──
      case "CREATE_TRIP": {
        eventType = "trip.created"; result = trip; break;
      }
      case "UPDATE_TRIP": {
        const patch = p.patch ?? {};
        const allowed = ["title","destination_city","destination_country","destination_lat","destination_lng","destination_place_id",
          "start_date","end_date","status","visibility","trip_type","timezone","travel_style","open_to_meet","cover_url","cover_media_type",
          "cover_image_width","cover_image_height","trip_notes","show_on_profile","show_in_discovery","allow_friend_suggestions",
          "allow_trip_crew_invites","allow_join_requests","show_exact_dates","show_destination_city","delayed_posting_default",
          "precise_location_visible","plan_edit_permission","progress","show_header_publicly"];
        const bad = Object.keys(patch).find((k) => !allowed.includes(k));
        if (bad) return reject("TRIP_COMMAND_MALFORMED", { detail: `UPDATE_TRIP does not accept column ${bad}` });
        const start = patch.start_date !== undefined ? patch.start_date : trip.start_date;
        const end = patch.end_date !== undefined ? patch.end_date : trip.end_date;
        if (start && end && start > end) return reject("TRIP_TEMPORAL_RANGE_INVERTED");
        const from = trip.status; const to = patch.status ?? from;
        if (to !== from && ["cancelled", "archived"].includes(from)) return reject("TRIP_LIFECYCLE_INVALID_TRANSITION", { from, to });
        Object.assign(trip, patch, { updated_at: p.updated_at ?? "2026-01-03T00:00:00.000Z" });
        eventType = to === "completed" && from !== "completed" ? "trip.trip_completed" : "trip.updated";
        result = trip; break;
      }
      case "CANCEL_TRIP": case "COMPLETE_TRIP": case "ARCHIVE_TRIP": {
        const to = c.type === "CANCEL_TRIP" ? "cancelled" : c.type === "COMPLETE_TRIP" ? "completed" : "archived";
        const from = trip.status;
        if (from === to || from === "archived" || (c.type === "COMPLETE_TRIP" && from === "cancelled")) return reject("TRIP_LIFECYCLE_INVALID_TRANSITION", { from, to });
        trip.status = to;
        eventType = `trip.trip_${to}`; result = trip; break;
      }
      case "SET_TRIP_COVER": {
        if (!p.cover_url) return reject("TRIP_COMMAND_MALFORMED", { detail: "cover_url required" });
        trip.cover_url = p.cover_url; if (p.cover_media_type !== undefined) trip.cover_media_type = p.cover_media_type;
        eventType = "trip.cover_set"; result = trip; break;
      }
      case "ADMIN_HIDE_TRIP": {
        trip.visibility = "private"; eventType = "trip.hidden_by_admin"; result = trip; break;
      }
      case "INVITE_PARTICIPANT": case "ADD_PARTICIPANT": {
        const role = c.type === "INVITE_PARTICIPANT" ? "invited" : (p.role ?? "member");
        if (!p.user_id) return reject("TRIP_COMMAND_MALFORMED", { detail: "user_id required" });
        if (p.user_id === c.actor_user_id) return reject("TRIP_COMMAND_MALFORMED", { detail: "the actor cannot add or invite themselves" });
        if (!["member", "invited"].includes(role)) return reject("TRIP_COMMAND_MALFORMED", { detail: "role must be member or invited" });
        const existing = state.trip_members.find((m) => m.trip_id === c.trip_id && m.user_id === p.user_id);
        if (existing) return reject("TRIP_PARTICIPANT_ALREADY_EXISTS", { current_role: existing.role });
        if (role === "member" && trip.max_members != null &&
            state.trip_members.filter((m) => m.trip_id === c.trip_id && (m.status ?? "accepted") === "accepted").length >= trip.max_members) {
          return reject("TRIP_PARTICIPANT_CAPACITY_REACHED");
        }
        // Legacy row shape for an invite: role 'invited', status default.
        const row = { trip_id: c.trip_id, user_id: p.user_id, role, status: c.type === "INVITE_PARTICIPANT" ? "accepted" : (p.status ?? "accepted") };
        state.trip_members.push(row);
        eventType = c.type === "INVITE_PARTICIPANT" ? "trip.participant_invited" : "trip.participant_added";
        result = { trip_id: c.trip_id, user_id: p.user_id, role, status: row.status }; break;
      }
      case "SET_PARTICIPANT_ROLE": {
        const row = state.trip_members.find((m) => m.trip_id === c.trip_id && m.user_id === p.user_id);
        if (!row) return reject("TRIP_PARTICIPANT_NOT_FOUND");
        if (row.role === "owner" || p.user_id === trip.owner_id) return reject("TRIP_PARTICIPANT_IS_OWNER");
        if (!["member", "invited"].includes(p.role)) return reject("TRIP_COMMAND_MALFORMED");
        row.role = p.role;
        eventType = "trip.participant_role_set"; result = { trip_id: c.trip_id, user_id: p.user_id, role: p.role, status: row.status }; break;
      }
      case "REMOVE_PARTICIPANT": {
        const row = state.trip_members.find((m) => m.trip_id === c.trip_id && m.user_id === p.user_id);
        if (!row) return reject("TRIP_PARTICIPANT_NOT_FOUND");
        if (row.role === "owner" || p.user_id === trip.owner_id) return reject("TRIP_PARTICIPANT_IS_OWNER");
        state.trip_members = state.trip_members.filter((m) => m !== row);
        eventType = "trip.participant_removed"; result = { trip_id: c.trip_id, user_id: p.user_id, role: row.role }; break;
      }
      case "ACCEPT_INVITE": {
        const row = state.trip_members.find((m) => m.trip_id === c.trip_id && m.user_id === c.actor_user_id)!;
        row.role = "member";
        eventType = "trip.participant_joined"; result = { trip_id: c.trip_id, user_id: c.actor_user_id, role: "member", status: row.status }; break;
      }
      case "DECLINE_INVITE": {
        state.trip_members = state.trip_members.filter((m) => !(m.trip_id === c.trip_id && m.user_id === c.actor_user_id));
        eventType = "trip.participant_declined"; result = { trip_id: c.trip_id, user_id: c.actor_user_id }; break;
      }
      default:
        return reject("TRIP_COMMAND_UNKNOWN_TYPE", { type: c.type });
    }

    trip.version = current + 1;
    const sequence = state.trip_events.filter((e) => e.trip_id === c.trip_id).length + 1;
    const event_id = `evt-${++counter}`;
    const strip = (o: any) => { if (!o || typeof o !== "object") return o; const { lat: _a, lng: _b, ...rest } = o; return rest; };
    state.trip_events.push({ event_id, trip_id: c.trip_id, aggregate_version: trip.version, sequence, type: eventType,
      actor_user_id: c.actor_user_id ?? null, actor_role: actorRole, causation_id: c.command_id,
      payload_json: { command_type: c.type, payload: strip(p), result: strip(result) } });
    state.trip_outbox.push({ event_id, trip_id: c.trip_id, type: eventType });
    state.trip_command_receipts.push({ trip_id: c.trip_id, idempotency_key: c.idempotency_key, command_id: c.command_id,
      command_type: c.type, actor_user_id: c.actor_user_id ?? null, actor_role: actorRole, event_id, result_version: trip.version, result_json: result });
    return { data: { ok: true, duplicate: false, version: trip.version, event_id, sequence, result, contract_version: 2 }, error: null };
  }

  return {
    from,
    rpc,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── Server helpers ─────────────────────────────────────────────────────────────
interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", tripsRouter);
  app.use("/api", routePlanRouter);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({ port, state, close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }) });
    });
    srv.on("error", reject);
  });
}

async function call(port: number, method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close", ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, body: json, text, version: res.headers.get("x-trip-version") };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
describe("planCommandTypeForPatch (§3.3)", () => {
  it("maps status transitions to the spec's command names", () => {
    assert.equal(planCommandTypeForPatch({ status: "confirmed" }), "CONFIRM_PLAN");
    assert.equal(planCommandTypeForPatch({ status: "cancelled" }), "CANCEL_PLAN");
    assert.equal(planCommandTypeForPatch({ status: "done" }), "COMPLETE_ACTIVITY");
    assert.equal(planCommandTypeForPatch({ status: "tentative" }), "UPDATE_PLAN");
  });
  it("maps a time/day change to MOVE_PLAN and anything else to UPDATE_PLAN", () => {
    assert.equal(planCommandTypeForPatch({ dayDate: "2026-07-10" }), "MOVE_PLAN");
    assert.equal(planCommandTypeForPatch({ startsAt: null }), "MOVE_PLAN");
    assert.equal(planCommandTypeForPatch({ title: "x" } as any), "UPDATE_PLAN");
  });
});

describe("readCommandEnvelope (§4.1 over HTTP)", () => {
  const req = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] } as any);
  it("generates a key when none is sent (request is not idempotent, as today)", () => {
    const a = readCommandEnvelope(req({}));
    const b = readCommandEnvelope(req({}));
    assert.ok(a.ok && b.ok);
    assert.notEqual((a as any).idempotencyKey, (b as any).idempotencyKey);
    assert.equal((a as any).expectedTripVersion, null);
  });
  it("accepts If-Match as a bare or quoted integer and refuses anything else", () => {
    const bare = readCommandEnvelope(req({ "if-match": "7" }));
    assert.equal(bare.ok, true);
    assert.equal((bare as any).expectedTripVersion, 7);
    assert.equal((readCommandEnvelope(req({ "if-match": '"12"' })) as any).expectedTripVersion, 12);
    assert.equal(readCommandEnvelope(req({ "if-match": "abc" })).ok, false);
    assert.equal(readCommandEnvelope(req({ "if-match": "-1" })).ok, false);
  });
  it("bounds the idempotency key", () => {
    assert.equal(readCommandEnvelope(req({ "idempotency-key": "x".repeat(201) })).ok, false);
    assert.equal((readCommandEnvelope(req({ "idempotency-key": " k1 " })) as any).idempotencyKey, "k1");
  });
});

// ── Flag OFF: nothing changes ────────────────────────────────────────────────
describe("trip_kernel_enabled = false (seeded value): the direct writes run untouched", () => {
  let srv: TestServer;
  beforeEach(async () => { counter = 0; srv = await startServer(baseState(false)); });

  it("create / patch / remove / delete / reorder never call the kernel, never bump the version, write no event", async () => {
    const { port, state } = srv;
    const c = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "Museum" });
    assert.equal(c.status, 201);
    assert.equal(c.body.title, "Museum");
    assert.equal(c.version, null, "no X-Trip-Version header on the legacy path");

    const p = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { status: "done" });
    assert.equal(p.status, 200);
    const back = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { status: "tentative" });
    assert.equal(back.status, 200, "legacy path accepts done -> tentative, exactly as before");

    const rm = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_B}/remove`, "bob-tok");
    assert.equal(rm.status, 200);
    assert.deepEqual(rm.body, { status: "removed", itemId: ITEM_B });

    const re = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}/reorder`, "alice-tok", { sortOrder: 5 });
    assert.equal(re.status, 200);
    const batch = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", { orderedItemIds: [ITEM_A] });
    assert.equal(batch.status, 200);
    const del = await call(port, "DELETE", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok");
    assert.equal(del.status, 204);

    assert.equal(state.rpcCalls.length, 0, "the kernel function was never called");
    assert.equal(state.trips[0].version, 0, "trips.version untouched");
    assert.equal(state.trip_events.length, 0);
    assert.equal(state.trip_outbox.length, 0);
    assert.equal(state.trip_command_receipts.length, 0);
    await srv.close();
  });

  it("an explicitly false flag row is the same as no row", async () => {
    srv.state.feature_flags.push({ flag: "trip_kernel_enabled", enabled: false });
    const c = await call(srv.port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "bob-tok", { title: "Cafe" });
    assert.equal(c.status, 201);
    assert.equal(srv.state.rpcCalls.length, 0);
    await srv.close();
  });
});

// ── Flag ON ──────────────────────────────────────────────────────────────────
describe("trip_kernel_enabled = true: plan-item writes are commands", () => {
  let srv: TestServer;
  beforeEach(async () => { counter = 0; _resetTripCommandRejectedTotal(); srv = await startServer(baseState(true)); });

  it("ADD_PLAN: one row, one event, one outbox row, one receipt, version 1, X-Trip-Version header", async () => {
    const { port, state } = srv;
    const c = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "bob-tok", { title: "Museum", lat: 1.5, lng: 2.5 });
    assert.equal(c.status, 201);
    assert.equal(c.body.title, "Museum");
    assert.equal(c.body.creatorId, BOB_ID, "creator_id from the token, never the body");
    assert.equal(c.version, "1");
    assert.equal(state.rpcCalls.length, 1);
    assert.equal(state.rpcCalls[0].args.p_command.type, "ADD_PLAN");
    assert.equal(state.rpcCalls[0].args.p_command.actor_user_id, BOB_ID);
    assert.equal(state.trips[0].version, 1);
    assert.equal(state.trip_events.length, 1);
    assert.equal(state.trip_events[0].type, "trip.plan_added");
    assert.equal(state.trip_events[0].aggregate_version, 1);
    assert.equal(state.trip_events[0].sequence, 1);
    assert.equal(state.trip_events[0].causation_id, state.rpcCalls[0].args.p_command.command_id);
    assert.equal(state.trip_outbox.length, 1);
    assert.equal(state.trip_command_receipts.length, 1);
    assert.equal(state.trip_plan_items.length, 3);
    await srv.close();
  });

  it("duplicate Idempotency-Key: same body, same version, ONE row, ONE event (§22.4)", async () => {
    const { port, state } = srv;
    const h = { "Idempotency-Key": "client-k1" };
    const a = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "Museum" }, h);
    const b = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "Museum" }, h);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body, a.body);
    assert.equal(b.version, "1");
    assert.equal(state.trip_plan_items.length, 3, "no second row");
    assert.equal(state.trip_events.length, 1, "no second event");
    assert.equal(state.trips[0].version, 1, "no second version bump");
    await srv.close();
  });

  it("If-Match with a stale version: 409 conflict with TRIP_VERSION_CONFLICT and both versions (§18.3)", async () => {
    const { port, state } = srv;
    await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "First" });
    const stale = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "Second" }, { "If-Match": "0" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "conflict");
    assert.equal(stale.body.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(stale.body.currentVersion, 1);
    assert.equal(stale.body.expectedVersion, 0);
    assert.equal(state.trip_plan_items.length, 3, "the stale write did not land");
    const fresh = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "Second" }, { "If-Match": "1" });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.version, "2");
    assert.equal(readTripCommandRejectedTotal()["TRIP_VERSION_CONFLICT"], 1, "§21.1 counter by reason");
    await srv.close();
  });

  it("a malformed If-Match is refused before any command is issued", async () => {
    const r = await call(srv.port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "x" }, { "If-Match": "latest" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal(srv.state.rpcCalls.length, 0);
    await srv.close();
  });

  it("PATCH status: CONFIRM_PLAN then COMPLETE_ACTIVITY; a done item cannot become tentative (§3.3)", async () => {
    const { port, state } = srv;
    const c = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { status: "confirmed" });
    assert.equal(c.status, 200);
    assert.equal(c.body.status, "confirmed");
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.type, "CONFIRM_PLAN");
    assert.equal(state.trip_events.at(-1)!.type, "trip.plan_confirmed");

    const d = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { status: "done" });
    assert.equal(d.status, 200);
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.type, "COMPLETE_ACTIVITY");
    assert.equal(state.trips[0].version, 2);

    const back = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { status: "tentative", title: "renamed" });
    assert.equal(back.status, 409);
    assert.equal(back.body.error, "invalid_state_transition");
    assert.equal(back.body.reason, "TRIP_PLAN_INVALID_TRANSITION");
    assert.equal(back.body.from, "done");
    assert.equal(back.body.to, "tentative");
    const item = state.trip_plan_items.find((i) => i.id === ITEM_A);
    assert.equal(item.title, "Dinner", "a refused command writes nothing, not even the title");
    assert.equal(state.trips[0].version, 2, "no version bump on a rejection");
    assert.equal(state.trip_events.length, 2);
    await srv.close();
  });

  it("a time change is MOVE_PLAN with trip.plan_moved; a title change is UPDATE_PLAN", async () => {
    const { port, state } = srv;
    const m = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { dayDate: "2026-07-10" });
    assert.equal(m.status, 200);
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.type, "MOVE_PLAN");
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.payload.patch.day_date, "2026-07-10");
    assert.equal(state.trip_events.at(-1)!.type, "trip.plan_moved");
    const u = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok", { title: "Late dinner" });
    assert.equal(u.status, 200);
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.type, "UPDATE_PLAN");
    await srv.close();
  });

  it("authorization runs BEFORE the command: a non-member and a member editing another's item never reach the kernel", async () => {
    const { port, state } = srv;
    const stranger = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "carol-tok", { title: "x" });
    assert.equal(stranger.status, 403);
    const other = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "bob-tok", { title: "mine now" });
    assert.equal(other.status, 403);
    const reorderByMember = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items/${ITEM_B}/reorder`, "bob-tok", { sortOrder: 9 });
    assert.equal(reorderByMember.status, 403);
    assert.equal(state.rpcCalls.length, 0);
    assert.equal(state.trips[0].version, 0);
    await srv.close();
  });

  it("REMOVE_PLAN via PATCH .../remove and via DELETE: soft-delete, event, version header", async () => {
    const { port, state } = srv;
    const rm = await call(port, "PATCH", `/api/trips/${TRIP_ID}/plan/items/${ITEM_B}/remove`, "bob-tok");
    assert.equal(rm.status, 200);
    assert.deepEqual(rm.body, { status: "removed", itemId: ITEM_B });
    assert.equal(rm.version, "1");
    assert.ok(state.trip_plan_items.find((i) => i.id === ITEM_B).removed_at);
    assert.equal(state.trip_events.at(-1)!.type, "trip.plan_removed");

    const del = await call(port, "DELETE", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}`, "alice-tok");
    assert.equal(del.status, 204);
    assert.equal(del.text, "");
    assert.equal(del.version, "2");
    assert.ok(state.trip_plan_items.find((i) => i.id === ITEM_A).removed_at);
    await srv.close();
  });

  it("single reorder is one REORDER_PLAN command", async () => {
    const { port, state } = srv;
    const re = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items/${ITEM_A}/reorder`, "alice-tok", { sortOrder: 5 });
    assert.equal(re.status, 200);
    assert.deepEqual(re.body, { status: "reordered", itemId: ITEM_A, sortOrder: 5 });
    assert.equal(re.version, "1");
    assert.deepEqual(state.rpcCalls[0].args.p_command.payload.items, [{ item_id: ITEM_A, sort_order: 5 }]);
    assert.equal(state.trip_plan_items.find((i) => i.id === ITEM_A).sort_order, 5);
    await srv.close();
  });

  it("batch reorder is ONE command and ONE event; an all-in-place order issues no command", async () => {
    const { port, state } = srv;
    const swap = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", { orderedItemIds: [ITEM_B, ITEM_A] });
    assert.equal(swap.status, 200);
    assert.deepEqual(swap.body, { status: "reordered", count: 2, order: [ITEM_B, ITEM_A] });
    assert.equal(state.rpcCalls.length, 1);
    assert.equal(state.trip_events.length, 1);
    assert.equal(state.trip_events[0].type, "trip.plan_reordered");
    assert.equal(state.trip_plan_items.find((i) => i.id === ITEM_B).sort_order, 0);
    assert.equal(state.trip_plan_items.find((i) => i.id === ITEM_A).sort_order, 1);

    const noop = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", { orderedItemIds: [ITEM_B, ITEM_A] });
    assert.equal(noop.status, 200);
    assert.deepEqual(noop.body, { status: "reordered", count: 0, order: [ITEM_B, ITEM_A] });
    assert.equal(state.rpcCalls.length, 1, "nothing changed, nothing commanded");
    assert.equal(state.trips[0].version, 1);
    await srv.close();
  });

  it("a database error is a counted TRIP_KERNEL_UNAVAILABLE 500, never an empty success (supabase-js resolves on error)", async () => {
    const { port, state } = srv;
    state.rpcFail = true;
    const r = await call(port, "POST", `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "x" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.equal(r.body.reason, "TRIP_KERNEL_UNAVAILABLE");
    assert.equal(state.trip_plan_items.length, 2);
    assert.equal(readTripCommandRejectedTotal()["TRIP_KERNEL_UNAVAILABLE"], 1);
    await srv.close();
  });

  it("executeTripCommand maps every structured rejection and never throws on a thrown rpc", async () => {
    const throwing = { rpc: async () => { throw new Error("socket hang up"); } };
    const r = await executeTripCommand(throwing, { commandId: "c", tripId: TRIP_ID, actorUserId: ALICE_ID, idempotencyKey: "k", type: "ADD_PLAN", payload: {} });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "TRIP_KERNEL_UNAVAILABLE");
    const rejecting = { rpc: async () => ({ data: { ok: false, reason: "TRIP_AUTH_NOT_CREW" }, error: null }) };
    const r2 = await executeTripCommand(rejecting, { commandId: "c", tripId: TRIP_ID, actorUserId: ALICE_ID, idempotencyKey: "k", type: "ADD_PLAN", payload: {} });
    assert.equal((r2 as any).reason, "TRIP_AUTH_NOT_CREW");
    assert.equal(readTripCommandRejectedTotal()["TRIP_AUTH_NOT_CREW"], 1);
    await srv.close();
  });
});

// ── §24 Phase 1 ratchet ──────────────────────────────────────────────────────
describe("check:trip-kernel-writers (§24 Phase 1 ratchet)", () => {
  it("counts a literal .from(canonical).insert/update/upsert/delete and ignores reads and other tables", () => {
    const src = `
      const a = await client.from("trips").select("id").eq("id", x).maybeSingle();
      const b = await client.from("trip_plan_items").update({ x: 1 }).eq("id", y);
      const c = await sc.from('trips').update({ original_language: lang }).eq('id', id);
      const d = await sc.from("trip_notes").insert({});
      const e = await (client as any).from("trip_members").delete().eq("trip_id", t);
    `;
    assert.deepEqual(countCanonicalWrites(src), { count: 3, gated: 0, importsKernel: false, dynamicFrom: false });
  });
  it("flags a dynamic .from(expr) as incomplete attribution without counting it", () => {
    const src = `const t = TABLE; await sc.from(t).insert({}); const arr = Array.from(new Set([1]));`;
    assert.deepEqual(countCanonicalWrites(src), { count: 0, gated: 0, importsKernel: false, dynamicFrom: true });
  });
  it("a trip-kernel:legacy-path marker gates exactly the statement it precedes, and only in a file that imports the kernel", () => {
    const gatedSrc = `
      import { executeTripCommand } from "../lib/tripKernel.js";
      if (kernel) { await executeTripCommand(kernel, cmd); return; }
      // trip-kernel:legacy-path — flag-off twin
      const { error } = kernelDone ? { error: null } : await client.from("trip_members").insert({ a: 1 });
      const { error: e2 } = await client.from("trip_members").delete().eq("x", 1);
    `;
    assert.deepEqual(countCanonicalWrites(gatedSrc), { count: 2, gated: 1, importsKernel: true, dynamicFrom: false });
    // Same marker, no kernel import: the write is counted, the marker is a false claim.
    const liar = gatedSrc.replace(/import .*tripKernel\.js";/, "");
    const c = countCanonicalWrites(liar);
    assert.equal(c.importsKernel, false);
    assert.equal(ungatedOf(c), 2, "without the import every write is ungated");
    const v = judge([{ file: "routes/liar.ts", ...c }], { "routes/liar.ts": { direct: 2, ungated: 2 } });
    assert.deepEqual(v.falseMarkers.map((r) => r.file), ["routes/liar.ts"]);
  });
  it("a new writer or a grown direct/ungated count fails; a shrunk count is reported, not failed", () => {
    const baseline = { "routes/a.ts": { direct: 2, ungated: 2 }, "routes/b.ts": { direct: 1, ungated: 1 }, "routes/d.ts": { direct: 2, ungated: 0 } };
    const v = judge([
      { file: "routes/a.ts", count: 3, gated: 0, importsKernel: false, dynamicFrom: false },
      { file: "routes/b.ts", count: 0, gated: 0, importsKernel: false, dynamicFrom: false },
      { file: "routes/c.ts", count: 1, gated: 0, importsKernel: false, dynamicFrom: false },
      // direct unchanged but a gated write lost its marker: ungated grew 0 -> 1.
      { file: "routes/d.ts", count: 2, gated: 1, importsKernel: true, dynamicFrom: false },
    ], baseline);
    assert.deepEqual(v.newWriters.map((r) => r.file), ["routes/c.ts"]);
    assert.deepEqual(v.grew.map((r) => r.file), ["routes/a.ts", "routes/d.ts"]);
    assert.deepEqual(v.vanished, ["routes/b.ts"]);
    assert.deepEqual(v.shrank, []);
    // Gating a write shrinks `ungated` while `direct` stays: reported as shrank, not failed.
    const s = judge([{ file: "routes/a.ts", count: 2, gated: 1, importsKernel: true, dynamicFrom: false }], { "routes/a.ts": { direct: 2, ungated: 2 } });
    assert.deepEqual(s.grew, []);
    assert.deepEqual(s.shrank.map((r) => [r.file, r.ungated]), [["routes/a.ts", 1]]);
  });
  it("the committed baseline matches the tree: 47 direct, 32 ungated, routes/trips.ts fully gated", () => {
    const rows = surveyTree();
    const v = judge(rows, TRIP_KERNEL_DIRECT_WRITERS);
    assert.deepEqual(v.newWriters, [], "a new direct writer appeared");
    assert.deepEqual(v.grew, [], "a direct or ungated count grew");
    assert.deepEqual(v.falseMarkers, []);
    assert.equal(rows.reduce((n, r) => n + r.count, 0), 47);
    assert.equal(rows.reduce((n, r) => n + ungatedOf(r), 0), 32);
    const trips = rows.find((r) => r.file === "routes/trips.ts")!;
    assert.equal(trips.count, 14);
    assert.equal(ungatedOf(trips), 0, "every direct write in routes/trips.ts has a kernel path");
  });
});

// ── §25: the route-plan system integrates by ISSUING a Trip Command ──────────
describe("route-plan accept links a plan item through the kernel (§25), legacy write when off or detached", () => {
  const routePlanBody = (tripId: string | null) => ({
    title: "Night out",
    tripId: tripId ?? undefined,
    routeStyle: "custom",
    stops: [
      { title: "Dinner", lat: 10.31, lng: 123.89, sourceType: "plan_item", sourceId: ITEM_A },
      { title: "Bar", lat: 10.32, lng: 123.9 },
    ],
  });

  it("flag on + attached plan: ONE LINK_PLAN_ROUTE_STOP command per plan-item stop, deterministic idempotency key, event, version", async () => {
    counter = 0;
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const r = await call(port, "POST", "/api/route-plans", "bob-tok", routePlanBody(TRIP_ID));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const links = state.rpcCalls.filter((c) => c.args.p_command.type === "LINK_PLAN_ROUTE_STOP");
    assert.equal(links.length, 1);
    const cmd = links[0].args.p_command;
    assert.equal(cmd.trip_id, TRIP_ID);
    assert.equal(cmd.actor_user_id, BOB_ID);
    assert.equal(cmd.payload.item_id, ITEM_A);
    assert.ok(cmd.payload.route_stop_id, "the new stop's id is carried on the command");
    assert.equal(cmd.idempotency_key, `route-plan:${state.route_plans[0].id}:link:${ITEM_A}`);
    assert.equal(state.trip_plan_items.find((i) => i.id === ITEM_A).route_stop_id, cmd.payload.route_stop_id);
    assert.equal(state.trip_events.at(-1)!.type, "trip.plan_route_stop_linked");
    assert.equal(state.trips[0].version, 1);
    await srv.close();
  });

  it("flag off: the legacy direct write still links the item and the kernel is never called", async () => {
    counter = 0;
    const srv = await startServer(baseState(false));
    const { port, state } = srv;
    const r = await call(port, "POST", "/api/route-plans", "bob-tok", routePlanBody(TRIP_ID));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(state.rpcCalls.length, 0);
    assert.ok(state.trip_plan_items.find((i) => i.id === ITEM_A).route_stop_id, "legacy link written");
    assert.equal(state.trips[0].version, 0);
    assert.equal(state.trip_events.length, 0);
    await srv.close();
  });

  it("flag on + detached plan (tripId null): no aggregate to command, legacy write kept", async () => {
    counter = 0;
    const srv = await startServer(baseState(true));
    const { port, state } = srv;
    const r = await call(port, "POST", "/api/route-plans", "bob-tok", routePlanBody(null));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(state.rpcCalls.length, 0);
    assert.ok(state.trip_plan_items.find((i) => i.id === ITEM_A).route_stop_id);
    await srv.close();
  });
});

// ── Contract v2 (migration 2450): trip and participant families ──────────────
describe("trip_kernel_enabled = false: the trip and participant writes are the direct writes, untouched", () => {
  let srv: TestServer;
  beforeEach(async () => { counter = 0; srv = await startServer(baseState(false)); });

  it("create / patch / invite / accept / decline / add / role / remove never call the kernel, never bump the version, write no event", async () => {
    const { port, state } = srv;
    const c = await call(port, "POST", "/api/trips", "carol-tok", { title: "Porto", destinationCity: "Porto", visibility: "public" });
    assert.equal(c.status, 201);
    assert.equal(c.body.owner_id, CAROL_ID);
    assert.equal(c.version, null, "no X-Trip-Version header on the legacy path");
    assert.equal("internal_notes" in c.body, false, "no internal column reaches the client");

    const p = await call(port, "PATCH", `/api/trips/${TRIP_ID}`, "alice-tok", { title: "Lisboa", showInDiscovery: true });
    assert.equal(p.status, 200);
    assert.equal(p.body.title, "Lisboa");
    const pb = await call(port, "PATCH", `/api/trips/${TRIP_ID}`, "bob-tok", { title: "nope" });
    assert.equal(pb.status, 403);

    const inv = await call(port, "POST", `/api/trips/${TRIP_ID}/invite`, "alice-tok", { userId: CAROL_ID });
    assert.equal(inv.status, 201);
    assert.deepEqual(inv.body, { status: "invited", tripId: TRIP_ID, userId: CAROL_ID });
    const acc = await call(port, "POST", `/api/trips/${TRIP_ID}/accept-invite`, "dave-tok");
    assert.equal(acc.status, 200);
    assert.deepEqual(acc.body, { status: "accepted", tripId: TRIP_ID, role: "member" });
    const dec = await call(port, "POST", `/api/trips/${TRIP_ID}/decline-invite`, "carol-tok");
    assert.equal(dec.status, 200);
    assert.deepEqual(dec.body, { status: "declined", tripId: TRIP_ID });

    const add = await call(port, "POST", `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: CAROL_ID, role: "invited" });
    assert.equal(add.status, 201);
    const role = await call(port, "POST", `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: CAROL_ID, role: "member" });
    assert.equal(role.status, 200);
    assert.deepEqual(role.body, { status: "updated", tripId: TRIP_ID, userId: CAROL_ID, role: "member" });
    const rm = await call(port, "DELETE", `/api/trips/${TRIP_ID}/members/${CAROL_ID}`, "alice-tok");
    assert.equal(rm.status, 200);

    assert.equal(state.rpcCalls.length, 0, "the kernel function was never called");
    assert.equal(state.trips.find((t) => t.id === TRIP_ID)!.version, 0, "trips.version untouched");
    assert.equal(state.trip_events.length, 0);
    assert.equal(state.trip_outbox.length, 0);
    assert.equal(state.trip_command_receipts.length, 0);
    await srv.close();
  });
});

describe("trip_kernel_enabled = true: trip and participant writes are commands (contract v2)", () => {
  let srv: TestServer;
  beforeEach(async () => { counter = 0; _resetTripCommandRejectedTotal(); srv = await startServer(baseState(true)); });

  it("CREATE_TRIP: actor becomes owner, version 1, trip.created, response is exactly TRIP_COLUMNS", async () => {
    const { port, state } = srv;
    const c = await call(port, "POST", "/api/trips", "carol-tok", { title: "Porto", destinationCity: "Porto", startDate: "2026-11-01", endDate: "2026-11-03", visibility: "public" });
    assert.equal(c.status, 201);
    assert.equal(c.version, "1");
    assert.equal(state.rpcCalls.length, 1);
    const cmd = state.rpcCalls[0].args.p_command;
    assert.equal(cmd.type, "CREATE_TRIP");
    assert.equal(cmd.actor_user_id, CAROL_ID, "actor from the token");
    assert.equal(cmd.actor_role, "user");
    assert.equal(cmd.expected_trip_version, null, "nothing to match on a create");
    assert.equal(c.body.owner_id, CAROL_ID);
    // show_header_publicly is NOT in TRIP_COLUMNS: the legacy .select(TRIP_COLUMNS)
    // never returned it, and the projection of the kernel row must not either.
    assert.equal("show_header_publicly" in c.body, false);
    assert.equal(state.trips.find((t) => t.owner_id === CAROL_ID)!.show_header_publicly, true, "public trips show the header publicly, as before");
    assert.equal("internal_notes" in c.body, false, "kernel result is projected to TRIP_COLUMNS");
    assert.equal("version" in c.body, false, "version travels in the header, not the body");
    assert.equal(state.trip_events.at(-1)!.type, "trip.created");
    assert.equal(state.trip_members.some((m) => m.user_id === CAROL_ID && m.role === "owner"), true);
    await srv.close();
  });

  it("CREATE_TRIP with start > end is refused by the route before any command (route check unchanged)", async () => {
    const { port, state } = srv;
    const c = await call(port, "POST", "/api/trips", "carol-tok", { title: "x", destinationCity: "x", startDate: "2026-11-05", endDate: "2026-11-01" });
    assert.equal(c.status, 400);
    assert.equal(state.rpcCalls.length, 0);
    await srv.close();
  });

  it("UPDATE_TRIP: owner only; status computed by the route is validated by the kernel; If-Match conflict; terminal status sticky", async () => {
    const { port, state } = srv;
    const p = await call(port, "PATCH", `/api/trips/${TRIP_ID}`, "alice-tok", { title: "Lisboa", showInDiscovery: true }, { "if-match": "0" });
    assert.equal(p.status, 200);
    assert.equal(p.version, "1");
    assert.equal(p.body.title, "Lisboa");
    assert.equal("internal_notes" in p.body, false);
    const cmd = state.rpcCalls[0].args.p_command;
    assert.equal(cmd.type, "UPDATE_TRIP");
    assert.ok("status" in cmd.payload.patch, "the route's computed status rides in the patch");
    assert.ok(!("updated_at" in cmd.payload.patch), "updated_at is envelope, not a column patch");
    assert.equal(state.trip_events.at(-1)!.type, "trip.updated");

    const stale = await call(port, "PATCH", `/api/trips/${TRIP_ID}`, "alice-tok", { title: "again" }, { "if-match": "0" });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.reason, "TRIP_VERSION_CONFLICT");
    assert.equal(stale.body.currentVersion, 1);

    const bob = await call(port, "PATCH", `/api/trips/${TRIP_ID}`, "bob-tok", { title: "nope" });
    assert.equal(bob.status, 403, "route-level owner check runs before the command");
    assert.equal(state.rpcCalls.length, 2);

    // A cancelled trip stays cancelled: the route hands the kernel status 'cancelled'
    // (computeTripStatus never leaves a terminal state) and the kernel accepts the no-op.
    state.trips[0].status = "cancelled";
    const t = await call(port, "PATCH", `/api/trips/${TRIP_ID}`, "alice-tok", { title: "Cancelled trip" });
    assert.equal(t.status, 200);
    assert.equal(t.body.status, "cancelled");
    await srv.close();
  });

  it("INVITE_PARTICIPANT / ADD_PARTICIPANT / SET_PARTICIPANT_ROLE / REMOVE_PARTICIPANT: owner commands, one event each, legacy row shape kept", async () => {
    const { port, state } = srv;
    const inv = await call(port, "POST", `/api/trips/${TRIP_ID}/invite`, "alice-tok", { userId: CAROL_ID });
    assert.equal(inv.status, 201);
    assert.equal(inv.version, "1");
    assert.deepEqual(inv.body, { status: "invited", tripId: TRIP_ID, userId: CAROL_ID });
    const row = state.trip_members.find((m) => m.user_id === CAROL_ID)!;
    assert.deepEqual({ role: row.role, status: row.status }, { role: "invited", status: "accepted" }, "legacy invite row shape");
    assert.equal(state.trip_events.at(-1)!.type, "trip.participant_invited");

    const again = await call(port, "POST", `/api/trips/${TRIP_ID}/invite`, "alice-tok", { userId: CAROL_ID });
    assert.equal(again.status, 200, "idempotent already_member answer is the route's, before any command");
    assert.equal(again.body.idempotent, true);

    const role = await call(port, "POST", `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: CAROL_ID, role: "member" });
    assert.equal(role.status, 200);
    assert.equal(role.version, "2");
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.type, "SET_PARTICIPANT_ROLE");
    assert.equal(state.trip_events.at(-1)!.type, "trip.participant_role_set");

    const rm = await call(port, "DELETE", `/api/trips/${TRIP_ID}/members/${CAROL_ID}`, "alice-tok");
    assert.equal(rm.status, 200);
    assert.equal(rm.version, "3");
    assert.equal(state.trip_events.at(-1)!.type, "trip.participant_removed");
    assert.equal(state.trip_members.some((m) => m.user_id === CAROL_ID), false);

    const add = await call(port, "POST", `/api/trips/${TRIP_ID}/members`, "alice-tok", { userId: CAROL_ID, role: "member" });
    assert.equal(add.status, 201);
    assert.equal(state.rpcCalls.at(-1)!.args.p_command.type, "ADD_PARTICIPANT");
    assert.equal(state.trip_events.at(-1)!.type, "trip.participant_added");

    const bob = await call(port, "POST", `/api/trips/${TRIP_ID}/invite`, "bob-tok", { userId: CAROL_ID });
    assert.equal(bob.status, 403, "a member is not the owner; refused before any command");
    assert.equal(state.rpcCalls.length, 4);
    await srv.close();
  });

  it("ACCEPT_INVITE / DECLINE_INVITE: the invitee — who is NOT accepted crew — is the actor; a member cannot re-accept", async () => {
    const { port, state } = srv;
    const acc = await call(port, "POST", `/api/trips/${TRIP_ID}/accept-invite`, "dave-tok");
    assert.equal(acc.status, 200);
    assert.equal(acc.version, "1");
    assert.deepEqual(acc.body, { status: "accepted", tripId: TRIP_ID, role: "member" });
    assert.equal(state.rpcCalls[0].args.p_command.type, "ACCEPT_INVITE");
    assert.equal(state.rpcCalls[0].args.p_command.actor_user_id, DAVE_ID);
    assert.equal(state.trip_events.at(-1)!.type, "trip.participant_joined");
    assert.equal(state.trip_members.find((m) => m.user_id === DAVE_ID)!.role, "member");

    const twice = await call(port, "POST", `/api/trips/${TRIP_ID}/accept-invite`, "dave-tok");
    assert.equal(twice.status, 400, "route answers 'Already a member' before any command");
    assert.equal(state.rpcCalls.length, 1);

    await call(port, "POST", `/api/trips/${TRIP_ID}/invite`, "alice-tok", { userId: CAROL_ID });
    const dec = await call(port, "POST", `/api/trips/${TRIP_ID}/decline-invite`, "carol-tok");
    assert.equal(dec.status, 200);
    assert.equal(dec.version, "3");
    assert.equal(state.trip_events.at(-1)!.type, "trip.participant_declined");
    assert.equal(state.trip_members.some((m) => m.user_id === CAROL_ID), false, "declined row is deleted, as legacy does");
    await srv.close();
  });

  it("the kernel's own capability check catches what a route did not: a v2 rejection maps to HTTP by reason", async () => {
    const { port, state } = srv;
    // Simulate a route that authorized but the row changed underneath: the fake
    // kernel sees no 'invited' row for Bob (he is a member) => TRIP_AUTH_NOT_INVITED.
    const r = await executeTripCommand(makeFakeClient(state), {
      commandId: "c1", tripId: TRIP_ID, actorUserId: BOB_ID, idempotencyKey: "k-bob", type: "ACCEPT_INVITE", payload: {},
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "TRIP_AUTH_NOT_INVITED");
    assert.equal((r as any).currentRole, "member");
    assert.equal((r as any).contractVersion, 2);
    const owner = await executeTripCommand(makeFakeClient(state), {
      commandId: "c2", tripId: TRIP_ID, actorUserId: BOB_ID, idempotencyKey: "k-bob-2", type: "UPDATE_TRIP", payload: { patch: { title: "x" } },
    });
    assert.equal((owner as any).reason, "TRIP_AUTH_NOT_OWNER");
    const sys = await executeTripCommand(makeFakeClient(state), {
      commandId: "c3", tripId: TRIP_ID, actorUserId: ALICE_ID, idempotencyKey: "k-sys", type: "SET_TRIP_COVER", payload: { cover_url: "https://x" },
    });
    assert.equal((sys as any).reason, "TRIP_AUTH_ROLE_NOT_PERMITTED", "a user envelope cannot issue a system command");
    const sysOk = await executeTripCommand(makeFakeClient(state), {
      commandId: "c4", tripId: TRIP_ID, actorUserId: null, actorRole: "system", idempotencyKey: "k-sys-2", type: "SET_TRIP_COVER", payload: { cover_url: "https://x" },
    });
    assert.equal(sysOk.ok, true);
    assert.equal(state.trip_command_receipts.at(-1)!.actor_user_id, null);
    assert.equal(state.trip_command_receipts.at(-1)!.actor_role, "system");
    const counts = readTripCommandRejectedTotal();
    assert.equal(counts.TRIP_AUTH_NOT_INVITED, 1);
    assert.equal(counts.TRIP_AUTH_NOT_OWNER, 1);
    assert.equal(counts.TRIP_AUTH_ROLE_NOT_PERMITTED, 1);
    await srv.close();
  });

  it("a contract-v1 database (2420 without 2450) refuses a v2 command as TRIP_COMMAND_UNKNOWN_TYPE — a 400, counted, never a silent success", async () => {
    const { port, state } = srv;
    const v1rpc = async (_name: string, args: any) => {
      state.rpcCalls.push({ name: _name, args });
      return { data: { ok: false, reason: "TRIP_COMMAND_UNKNOWN_TYPE", type: args.p_command.type }, error: null };
    };
    const fake = makeFakeClient(state);
    _setTestClient({ ...fake, rpc: v1rpc }, true);
    const inv = await call(port, "POST", `/api/trips/${TRIP_ID}/invite`, "alice-tok", { userId: CAROL_ID });
    assert.equal(inv.status, 400);
    assert.equal(inv.body.reason, "TRIP_COMMAND_UNKNOWN_TYPE");
    assert.equal(state.trip_members.some((m) => m.user_id === CAROL_ID), false, "no direct write ran either");
    assert.equal(readTripCommandRejectedTotal().TRIP_COMMAND_UNKNOWN_TYPE, 1);
    await srv.close();
  });

  it("tripCommandFamily and the event vocabulary cover every declared command type", () => {
    assert.equal(tripCommandFamily("CREATE_TRIP"), "trip");
    assert.equal(tripCommandFamily("ACCEPT_INVITE"), "participant");
    assert.equal(tripCommandFamily("ADMIN_HIDE_TRIP"), "admin");
    assert.equal(tripCommandFamily("SET_TRIP_COVER"), "system");
    assert.equal(tripCommandFamily("ADD_PLAN"), "plan");
    for (const t of ["trip.participant_joined", "trip.trip_completed", "trip.plan_added", "trip.plan_moved", "trip.plan_confirmed"]) {
      assert.ok((TRIP_EVENT_TYPES as readonly string[]).includes(t), `${t} is a spec-named event and must stay in the vocabulary`);
    }
    assert.equal(TRIP_KERNEL_CONTRACT_VERSION, 2);
  });
});
