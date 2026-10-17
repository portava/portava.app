import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

export const VIEWER = "10000000-0000-4000-8000-000000000001";
export const OTHER = "10000000-0000-4000-8000-000000000002";
export const TRIP = "20000000-0000-4000-8000-000000000001";
export const SECOND_TRIP = "20000000-0000-4000-8000-000000000002";
export const FOREIGN_TRIP = "20000000-0000-4000-8000-000000000003";
export const itemId = (index: number) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
export type Row = Record<string, unknown>;
export type Store = Record<string, Row[]>;
export type Override = (url: URL) => Response | undefined;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

export function plan(index = 0, overrides: Row = {}): Row {
  return { id: itemId(index), trip_id: TRIP, title: `Plan ${index}`, day_date: "2026-08-05",
    creator_id: OTHER, location_is_private: false, privacy_scope: "crew", removed_at: null,
    status: "confirmed", ...overrides };
}

export function fixture(): Store {
  return {
    trips: [
      { id: TRIP, owner_id: VIEWER, title: "First trip", status: "active", version: 7,
        start_date: "2026-08-01", end_date: "2026-08-10", destination_city: "Cebu" },
      { id: SECOND_TRIP, owner_id: OTHER, title: "Second trip", status: "upcoming", version: 12,
        start_date: "2026-08-06", end_date: "2026-08-12", destination_city: "Manila" },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: VIEWER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: OTHER, role: "member", status: "accepted" },
      { trip_id: SECOND_TRIP, user_id: VIEWER, role: "member", status: "accepted" },
      { trip_id: SECOND_TRIP, user_id: OTHER, role: "owner", status: "accepted" },
    ],
    trip_plan_items: [plan(), plan(1, { trip_id: SECOND_TRIP, day_date: "2026-08-06" })],
  };
}

function matches(value: unknown, predicate: string): boolean {
  if (predicate.startsWith("eq.")) return String(value) === predicate.slice(3);
  if (predicate.startsWith("in.(")) return predicate.slice(4, -1).split(",").map((part) => part.replaceAll('"', "")).includes(String(value));
  if (predicate === "is.null") return value == null;
  if (predicate.startsWith("gte.")) return value != null && String(value) >= predicate.slice(4);
  if (predicate.startsWith("lte.")) return value != null && String(value) <= predicate.slice(4);
  throw new Error(`Unsupported range fixture predicate: ${predicate}`);
}

export function isPlanRead(url: URL): boolean { return url.pathname.endsWith("/trip_plan_items"); }
export function isVersionRead(url: URL): boolean {
  return url.pathname.endsWith("/trips") && url.searchParams.get("select") === "id,version";
}

export function clientFor(store = fixture(), override?: Override) {
  const requests: URL[] = [];
  const client = createClient("http://127.0.0.1:9", "dummy", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      const url = new URL(String(input));
      assert.equal(url.origin, "http://127.0.0.1:9");
      requests.push(url);
      const replaced = override?.(url);
      if (replaced) return replaced;
      const table = url.pathname.split("/").at(-1)!;
      let rows = [...(store[table] ?? [])];
      for (const [column, predicate] of url.searchParams) {
        if (["select", "order", "limit"].includes(column)) continue;
        rows = rows.filter((row) => matches(row[column], predicate));
      }
      assert.equal(url.searchParams.has("order"), false, "the range read must not introduce an ordering");
      const limit = url.searchParams.get("limit");
      if (limit !== null) rows = rows.slice(0, Number(limit));
      const columns = url.searchParams.get("select")?.split(",");
      return json(columns ? rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]]))) : rows);
    } },
  });
  return { client, requests };
}
