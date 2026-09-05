import http from "node:http";
import express from "express";
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
  user_follows?: Array<{ follower_id: string; following_id: string }>;
  profiles?: Array<Record<string, any>>;
  user_friendships?: Array<Record<string, any>>;
  post_hides?: Array<Record<string, any>>;
  /** Every terminal read records the predicates its query carried, so a test can
   *  assert that a query CARRIES a filter rather than only that the response
   *  happened to be right — otherwise the fake's own row filtering hides a
   *  deleted DB predicate and a revert stays green. */
  captured?: Array<{ table: string; eqs: Record<string, any>; ors: string[] }>;
  /** Columns whose predicates the fake records but does NOT apply — both `.eq()`
   *  on that column and any `.or()` expression mentioning it. Feeds those rows
   *  PAST the query filter the way a widened query would, leaving the route's
   *  in-memory re-check as the only thing that can refuse them. */
  ignorePredicateCols?: string[];
}

export function makeFakeClient(state: FakeState) {
  const inserted: Array<{ table: string; row: Record<string, any> }> = [];
  const ignoreCols = new Set(state.ignorePredicateCols ?? []);

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const eqs: Record<string, any> = {};
    const ors: string[] = [];
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
      eq(col: string, val: any) {
        eqs[col] = val;
        if (!ignoreCols.has(col)) filters.push((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return builder; },
      or(expr: string) {
        // Parses simple "col.eq.val,col2.eq.val2" expressions (the only shape
        // the routes under test actually issue) and ORs them together. Repeated
        // `.or()` calls become separate filters, i.e. they are ANDed — the same
        // way PostgREST treats repeated `or=` query params.
        ors.push(String(expr));
        const parts = String(expr).split(",").map((part) => part.split("."));
        if (parts.some(([col]) => col && ignoreCols.has(col))) return builder;
        const conds = parts.map(([col, op, val]) => (r: any) => {
          if (op !== "eq") return false;
          const target = val === "true" ? true : val === "false" ? false : val;
          return r[col as string] === target;
        });
        filters.push((r) => conds.some((c) => c(r)));
        return builder;
      },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single() { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): any[] {
      state.captured?.push({ table, eqs: { ...eqs }, ors: [...ors] });
      let source: any[] = [];
      if (table === "trips") source = [...state.trips].map((id) => ({ id }));
      else if (table === "trip_members") source = state.members;
      else if (table === "posts") source = state.posts;
      else if (table === "user_follows") source = state.user_follows ?? [];
      else if (table === "profiles") source = state.profiles ?? [];
      else if (table === "user_friendships") source = state.user_friendships ?? [];
      else if (table === "post_hides") source = state.post_hides ?? [];
      return source.filter((r) => filters.every((f) => f(r)));
    }

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
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      },
    },
    __inserted: inserted,
  };
  return client;
}

export interface TestApp {
  baseUrl: string;
  client: any;
  close: () => Promise<void>;
}

/**
 * Build an Express app with the posts routes, wired to a fake client,
 * start an HTTP server on a random port, and return helpers to make
 * requests and shut down cleanly. Each test should call close() when done.
 */
export async function startApp(state: FakeState): Promise<TestApp> {
  const client = makeFakeClient(state);
  _setTestClient(client, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", postsRouter);

  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        client,
        close: () =>
          new Promise<void>((res, rej) => {
            srv.closeAllConnections();
            srv.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
    srv.on("error", reject);
  });
}

export const BEARER = (t: string): string => `Bearer ${t}`;
