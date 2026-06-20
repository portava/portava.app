import express from "express";
import type { Express } from "express";
import { vi } from "vitest";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";

/**
 * In-memory fake of the supabase-js client surface that the posts routes use.
 * Records inserts/updates and answers selects from staged tables. Enough to
 * exercise the route authorization logic without a live database.
 *
 * Staged state per test:
 *   users:   token -> { id } | null    (auth.getUser)
 *   trips:   Set<tripId>
 *   members: Array<{ trip_id, user_id, role }>
 *   posts:   Array<post rows>
 */
export interface FakeState {
  users: Record<string, { id: string } | null>;
  trips: Set<string>;
  members: Array<{ trip_id: string; user_id: string; role: string }>;
  posts: Array<Record<string, any>>;
}

export function makeFakeClient(state: FakeState) {
  // capture inserts for assertions
  const inserted: Array<{ table: string; row: Record<string, any> }> = [];

  function from(table: string) {
    // builder accumulates filters; terminal methods resolve
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: Record<string, any> | null = null;
    let pendingUpdate: Record<string, any> | null = null;

    const builder: any = {
      select() { return builder; },
      insert(row: Record<string, any>) {
        pendingInsert = row;
        inserted.push({ table, row });
        return builder;
      },
      update(patch: Record<string, any>) {
        pendingUpdate = patch;
        return builder;
      },
      delete() { return builder; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return builder; },
      or() { return builder; }, // visibility OR is not exercised by these unit tests
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single() { return resolveSingle(false); },
      // Awaitable (list) path — returns { data: row[], error } matching supabase-js
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      let source: any[] = [];
      if (table === "trips") source = [...state.trips].map((id) => ({ id }));
      else if (table === "trip_members") source = state.members;
      else if (table === "posts") source = state.posts;
      return source.filter((r) => filters.every((f) => f(r)));
    }

    /** .maybeSingle() / .single() — return one row or null. */
    async function resolveSingle(maybe: boolean) {
      if (pendingInsert) {
        const row = { id: "post-new", ...pendingInsert };
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        const matched = rows();
        const row = matched[0] ? { ...matched[0], ...pendingUpdate } : null;
        return { data: row, error: null };
      }
      const matched = rows();
      if (maybe) return { data: matched[0] ?? null, error: null };
      if (matched.length === 1) return { data: matched[0], error: null };
      return { data: matched[0] ?? null, error: null };
    }

    /** Awaitable (no .single()) — return array of rows matching supabase-js list shape. */
    async function resolveList() {
      if (pendingInsert) {
        const row = { id: "post-new", ...pendingInsert };
        return { data: row, error: null };
      }
      if (pendingUpdate) {
        const matched = rows();
        const row = matched[0] ? { ...matched[0], ...pendingUpdate } : null;
        return { data: row, error: null };
      }
      return { data: rows(), error: null };
    }

    return builder;
  }

  const client: any = {
    from,
    auth: {
      getUser: vi.fn(async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      }),
    },
    __inserted: inserted,
  };
  return client;
}

/**
 * Build an Express app with the posts routes, wired to a fake client.
 * Injects the fake client into http.ts's test slot so requireUser() uses it
 * instead of the real Supabase service-role client.
 */
export async function makeApp(state: FakeState): Promise<{ app: Express; client: any }> {
  const client = makeFakeClient(state);

  // Inject fake client into the http module's test slot.
  // requireUser() will use this instead of the real service-role client.
  _setTestClient(client, true);

  const app = express();
  app.use(express.json());
  // minimal req.log so route error logging doesn't throw
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", postsRouter);
  return { app, client };
}

export const BEARER = (t: string) => ({ Authorization: `Bearer ${t}` });
