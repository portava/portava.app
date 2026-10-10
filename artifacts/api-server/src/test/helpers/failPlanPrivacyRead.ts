/**
 * Make ONLY the plan items' privacy read fail — `compass/planItemAccess.ts`
 * readPlanItemPrivacy's `id, creator_id, location_is_private` select — while
 * every other `trip_plan_items` read (the projection builders', the impact
 * state's) still answers. Wave-6 verifier F2: without it, an error on
 * `trip_plan_items` fails the builder first and the "unreadable privacy read
 * withholds" branch is never reached by a test.
 *
 * `privacyReads` counts the reads that were failed, so a test can assert the
 * branch really ran.
 */
import { PLAN_ITEM_PRIVACY_COLUMNS } from "../../compass/planItemAccess.js";

export const PLAN_PRIVACY_SELECT = `id, ${PLAN_ITEM_PRIVACY_COLUMNS}`;
const ERR = { message: "canceling statement due to statement timeout", code: "57014" };

function erroring(): unknown {
  const settle = () => Promise.resolve({ data: null, error: ERR });
  const f: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (ok: any, bad: any) => settle().then(ok, bad);
      if (prop === "maybeSingle" || prop === "single") return () => settle();
      return () => f;
    },
  });
  return f;
}

export function failPlanPrivacyRead<C extends { from(table: string): any }>(client: C): C & { privacyReads: number } {
  const out = client as C & { privacyReads: number };
  const realFrom = client.from.bind(client);
  out.privacyReads = 0;
  (out as any).from = (table: string) => {
    const q = realFrom(table);
    if (table !== "trip_plan_items") return q;
    const realSelect = q.select;
    q.select = (cols?: string, ...rest: unknown[]) => {
      if (String(cols ?? "") === PLAN_PRIVACY_SELECT) { out.privacyReads++; return erroring(); }
      return realSelect.call(q, cols, ...rest);
    };
    return q;
  };
  return out;
}
