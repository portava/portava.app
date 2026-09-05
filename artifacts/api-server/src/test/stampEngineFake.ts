/**
 * Shared fake Supabase client for driving StampAwardEngine.awardStamp().
 *
 * Unlike the fake in stampTriggerAudit.test.ts — which answers every
 * `user_stamps` read with one canned row regardless of the filters — this one
 * APPLIES the recorded `.eq()` / `.is()` filters to seeded rows. That matters:
 * the engine's two resurrection guards (the heal path at
 * StampAwardEngine.ts:252-287 and the non-repeatable check at :294-302) differ
 * from each other only by which filters they attach, so a fake that ignores
 * filters cannot tell a correct guard from a broken one.
 *
 * Not a test file — no assertions here.
 */

export interface SeededRow { [col: string]: unknown }

export interface EngineFakeOpts {
  /** stamp_system_v2_enabled (fail-closed gate). */
  v2Enabled?: boolean;
  /** The stamp_definitions row returned for any slug. */
  definition?: SeededRow;
  /** Source rows keyed by table: trips / posts / events. `null` = not found. */
  sources?: Partial<Record<"trips" | "posts" | "events", SeededRow | null>>;
  /** Seeded stamp_award_events rows (matched on idempotency_key). */
  awardEvents?: SeededRow[];
  /** Seeded user_stamps rows (matched on every recorded filter). */
  userStamps?: SeededRow[];
  /** id handed back by a user_stamps insert. */
  newStampId?: string;
}

export interface EngineFake {
  client: any;
  inserted: { table: string; row: SeededRow }[];
  /** Every filter set the engine applied to user_stamps, in order. */
  userStampQueries: Array<Array<[string, unknown]>>;
}

const DEFAULT_DEFINITION: SeededRow = {
  id: "cccccccc-0000-0000-0000-000000000001",
  slug: "first_post",
  name: "First Post",
  stamp_type: "achievement",
  is_active: true,
  is_repeatable: false,
  max_awards_per_user: null,
  visibility_default: "public",
  criteria_type: "count",
  criteria: null,
};

function matches(row: SeededRow, filters: Array<[string, unknown]>): boolean {
  return filters.every(([k, v]) => row[k] === v);
}

export function makeEngineFake(opts: EngineFakeOpts = {}): EngineFake {
  const {
    v2Enabled = true,
    definition = DEFAULT_DEFINITION,
    sources = {},
    awardEvents = [],
    userStamps = [],
    newStampId = "dddddddd-0000-0000-0000-000000000001",
  } = opts;

  const inserted: { table: string; row: SeededRow }[] = [];
  const userStampQueries: Array<Array<[string, unknown]>> = [];

  function makeBuilder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let insertRow: SeededRow | null = null;

    const b: any = {
      select() { return b; },
      eq(col: string, val: unknown) { filters.push([col, val]); return b; },
      is(col: string, val: unknown) { filters.push([col, val]); return b; },
      not() { return b; },
      in() { return b; },
      update() { return b; },
      upsert() { return b; },
      insert(row: SeededRow) { insertRow = row; return b; },

      maybeSingle(): Promise<any> {
        if (table === "feature_flags") {
          const flag = filters.find((f) => f[0] === "flag")?.[1];
          if (flag === "stamp_system_v2_enabled") return Promise.resolve({ data: { enabled: v2Enabled }, error: null });
          // passport_stamps_enabled fails OPEN on an absent row; the criteria
          // engine flag fails CLOSED. Absent for both keeps this fake neutral.
          return Promise.resolve({ data: null, error: null });
        }
        if (table === "stamp_definitions") return Promise.resolve({ data: definition, error: null });
        if (table === "trips" || table === "posts" || table === "events") {
          return Promise.resolve({ data: (sources as any)[table] ?? null, error: null });
        }
        if (table === "stamp_award_events") {
          const key = filters.find((f) => f[0] === "idempotency_key")?.[1];
          return Promise.resolve({
            data: awardEvents.find((r) => r.idempotency_key === key) ?? null,
            error: null,
          });
        }
        if (table === "user_stamps") {
          userStampQueries.push([...filters]);
          return Promise.resolve({ data: userStamps.find((r) => matches(r, filters)) ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },

      single(): Promise<any> {
        if (table === "user_stamps" && insertRow) {
          inserted.push({ table, row: { ...insertRow } });
          return Promise.resolve({ data: { id: newStampId }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },

      then(onF: (v: any) => unknown, onR?: (e: unknown) => unknown): Promise<unknown> {
        if (insertRow) {
          inserted.push({ table, row: { ...insertRow } });
          return Promise.resolve({ data: null, error: null }).then(onF, onR);
        }
        if (table === "user_stamps") {
          userStampQueries.push([...filters]);
          const rows = userStamps.filter((r) => matches(r, filters));
          return Promise.resolve({ data: rows, error: null, count: rows.length }).then(onF, onR);
        }
        return Promise.resolve({ data: null, error: null, count: 0 }).then(onF, onR);
      },

      catch() { return b; },
    };
    return b;
  }

  return { client: { from: makeBuilder } as any, inserted, userStampQueries };
}
