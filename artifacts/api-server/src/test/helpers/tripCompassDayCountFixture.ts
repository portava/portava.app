import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

export const VIEWER = "10000000-0000-4000-8000-000000000001";
export const OTHER = "10000000-0000-4000-8000-000000000002";
export const TRIP = "20000000-0000-4000-8000-000000000001";
export const FOREIGN_TRIP = "20000000-0000-4000-8000-000000000002";
export const NOW = Date.parse("2026-08-05T16:30:00Z");
export const TODAY = "2026-08-05";
export const TOMORROW = "2026-08-06";
export const itemId = (index: number) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
export type Row = Record<string, unknown>;
export type Store = Record<string, Row[]>;
export type Override = (url: URL) => Response | undefined;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

export function plan(index = 0, overrides: Row = {}): Row {
  return { id: itemId(index), trip_id: TRIP, title: `Tomorrow secret ${index}`, day_date: TOMORROW,
    starts_at: null, sort_order: index, creator_id: OTHER, location_is_private: false,
    privacy_scope: "crew", removed_at: null, status: "confirmed", ...overrides };
}

export function fixture(): Store {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    trips: [{ id: TRIP, owner_id: VIEWER, title: "Cebu trip", status: "active", version: 7,
      start_date: "2026-08-01", end_date: "2026-08-10", destination_city: "Cebu", destination_country: "PH", timezone: null }],
    trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: OTHER, role: "member", status: "accepted" }],
    trip_plan_items: [plan(100, { creator_id: VIEWER, title: "Today's safe walk", day_date: TODAY, starts_at: `${TODAY}T10:00:00Z` }), plan()],
  };
}

function matches(value: unknown, predicate: string): boolean {
  if (predicate.startsWith("not.")) return !matches(value, predicate.slice(4));
  if (predicate.startsWith("eq.")) return String(value) === predicate.slice(3);
  if (predicate.startsWith("neq.")) return value != null && String(value) !== predicate.slice(4);
  if (predicate.startsWith("in.(")) return predicate.slice(4, -1).split(",").map((part) => part.replaceAll('"', "")).includes(String(value));
  if (predicate === "is.null") return value == null;
  if (predicate.startsWith("gte.")) return value != null && String(value) >= predicate.slice(4);
  if (predicate.startsWith("lte.")) return value != null && String(value) <= predicate.slice(4);
  if (predicate.startsWith("gt.")) return value != null && String(value) > predicate.slice(3);
  if (predicate.startsWith("lt.")) return value != null && String(value) < predicate.slice(3);
  if (predicate.startsWith("like.")) return new RegExp(`^${predicate.slice(5).replaceAll("%", ".*").replaceAll("_", ".")}$`).test(String(value));
  throw new Error(`Unsupported day-count fixture predicate: ${predicate}`);
}

export function isDayCountRead(url: URL, day = TOMORROW): boolean {
  return url.pathname.endsWith("/trip_plan_items") && url.searchParams.get("day_date") === `eq.${day}`
    && url.searchParams.get("limit") === "50";
}

export function clientFor(store = fixture(), override?: Override) {
  const requests: Array<{ url: URL; method: string }> = [];
  const client = createClient("http://127.0.0.1:9", "dummy", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      assert.equal(url.origin, "http://127.0.0.1:9");
      requests.push({ url, method });
      if (url.pathname === "/auth/v1/user") return json({ id: VIEWER, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
      const replaced = override?.(url);
      if (replaced) return replaced;
      const table = url.pathname.split("/").at(-1)!;
      if (method !== "GET" && method !== "HEAD") {
        assert.ok(!["trips", "trip_members", "trip_plan_items", "feature_flags"].includes(table), `Unexpected mutation of ${table}`);
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const values = Array.isArray(body) ? body : [body];
        const written = values.map((value: Row) => ({ id: itemId(1000 + requests.length), created_at: new Date().toISOString(), last_active_at: new Date().toISOString(), ...value }));
        if (method === "POST") store[table] = [...(store[table] ?? []), ...written];
        return json(new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object") ? written[0] : written);
      }
      let rows = [...(store[table] ?? [])];
      for (const [column, predicate] of url.searchParams) {
        if (["select", "order", "limit", "offset"].includes(column)) continue;
        rows = rows.filter((row) => matches(row[column], predicate));
      }
      const order = url.searchParams.get("order")?.split(",") ?? [];
      rows.sort((left, right) => {
        for (const entry of order) {
          const [column, direction] = entry.split(".");
          const leftValue = left[column!];
          const rightValue = right[column!];
          if (leftValue === rightValue) continue;
          const comparison = leftValue == null ? 1 : rightValue == null ? -1
            : typeof leftValue === "number" && typeof rightValue === "number" ? leftValue - rightValue
              : String(leftValue).localeCompare(String(rightValue));
          return direction === "desc" ? -comparison : comparison;
        }
        return 0;
      });
      const limit = url.searchParams.get("limit");
      if (limit !== null) rows = rows.slice(0, Number(limit));
      const columns = url.searchParams.get("select")?.split(",");
      const selected = !columns || columns.includes("*") ? rows
        : rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
      return json(new Headers(init?.headers).get("Accept")?.includes("vnd.pgrst.object") ? selected[0] ?? null : selected);
    } },
  });
  return { client, requests };
}
