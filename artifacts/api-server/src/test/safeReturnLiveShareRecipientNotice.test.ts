/**
 * Safe Return live share — the recipient is told, and the notice opens the
 * recipient screen (WP-04, TRUST-F10).
 *
 * `location.live_share_started` had a template and no emitter, and the template
 * had no actionUrl: a trusted contact was never told a share had started, and
 * the recipient view (`LiveShareRecipientView`) was mounted by no screen. The
 * client now serves it at `app/safe-return/[shareId].tsx`; these tests pin the
 * server half of that door:
 *
 *   - starting a share notifies the contact's Portava account, and the notice
 *     links to `/safe-return/<shareId>`;
 *   - the response says whether the contact was told (`recipientNotified`), so
 *     the sharer is never left believing a contact knows when they do not;
 *   - a contact with no Portava account, or one blocked with the sharer, is not
 *     notified, and the response says so;
 *   - the push preview never carries coordinates (the privacy guard's
 *     live-share rule is exercised, not bypassed).
 *
 * Run: node --import tsx/esm --test src/test/safeReturnLiveShareRecipientNotice.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import safeReturnRouter from "../routes/safeReturn.js";
import { renderTemplate } from "../services/notifications/NotificationTemplateService.js";

const TOKEN = "tm-events-sharer-token";
const SHARER = "00000000-0000-4000-8000-00000000a001";
const RECIPIENT = "00000000-0000-4000-8000-00000000b001";
const SESSION_ID = "00000000-0000-4000-8000-00000000c001";
const CONTACT_ID = "00000000-0000-4000-8000-00000000d001";

type Rows = Record<string, any>[];

function makeFake(tables: Record<string, Rows>) {
  const inserted: Record<string, any[]> = {};
  function builder(table: string) {
    let rows: Rows = table === "feature_flags"
      ? (tables.feature_flags ?? [])
      : [...(tables[table] ?? [])];
    let pendingInsert: any = null;
    let single = false;
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (onF: any, onR: any) => {
            if (pendingInsert) {
              const row = { id: `gen-${table}-${Math.random().toString(36).slice(2)}`, ...pendingInsert };
              return Promise.resolve({ data: single ? row : [row], error: null }).then(onF, onR);
            }
            return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(onF, onR);
          };
        }
        if (prop === "insert") {
          return (row: any) => {
            const one = Array.isArray(row) ? row[0] : row;
            (inserted[table] ??= []).push(one);
            pendingInsert = one;
            return b;
          };
        }
        if (prop === "eq") return (col: string, val: any) => { rows = rows.filter((r) => r[col] === undefined || r[col] === val); return b; };
        if (prop === "single" || prop === "maybeSingle") return () => { single = true; return b; };
        return () => b;
      },
    });
    return b;
  }
  const client: any = {
    from: (t: string) => builder(t),
    auth: {
      getUser: async (tok: string) => tok === TOKEN
        ? { data: { user: { id: SHARER } }, error: null }
        : { data: { user: null }, error: { message: "invalid" } },
    },
    __inserted: inserted,
  };
  return client;
}

const session = {
  id: SESSION_ID, user_id: SHARER, status: "active", escalation_level: 0,
  timer_start_at: null, timer_end_at: null,
  trusted_circle_enabled: false, live_share_enabled: true,
  notify_host_enabled: false, notify_trip_crew_enabled: false,
  plan_item_id: null, trip_id: null, trigger_reason: null,
  emergency_note: null, closed_at: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  last_prompt_at: null, last_safe_confirmation_at: null,
};

function tables(overrides: Record<string, Rows> = {}): Record<string, Rows> {
  return {
    feature_flags: [
      { key: "safe_return_enabled", flag: "safe_return_enabled", enabled: true },
      { key: "safe_return_live_share_enabled", flag: "safe_return_live_share_enabled", enabled: true },
    ],
    safe_return_sessions: [session],
    safe_return_contacts: [{ id: CONTACT_ID, session_id: SESSION_ID, contact_user_id: RECIPIENT, can_receive_live_location: true }],
    profiles: [{ id: SHARER, handle: "sharer", name: "Sharer Real", avatar_url: null }],
    blocks: [],
    ...overrides,
  };
}

let server: http.Server;
let base: string;

async function start(body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/api/me/safe-return/sessions/${SESSION_ID}/live-share/start`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

function use(c: any) { _setTestClient(c, true); _setTestServiceClient(c); }

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", safeReturnRouter);
  server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); });

describe("live share start tells the recipient", () => {
  it("the template's notice opens the recipient screen for that share", () => {
    const r = renderTemplate("location.live_share_started", { actor: "@sharer", shareId: "abc" });
    assert.ok(r);
    assert.equal(r!.actionUrl, "/safe-return/abc");
  });

  it("notifies the contact's account with a link to /safe-return/<shareId>", async () => {
    const c = makeFake(tables());
    use(c);
    const r = await start({ recipientContactId: CONTACT_ID, durationMinutes: 60 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.recipientNotified, true);
    const notes = c.__inserted.notifications ?? [];
    assert.equal(notes.length, 1, "exactly one notice to the recipient");
    assert.equal(notes[0].user_id, RECIPIENT);
    assert.equal(notes[0].event_type, "location.live_share_started");
    assert.equal(notes[0].action_url, `/safe-return/${r.body.share.id}`);
    assert.equal(notes[0].source_id, r.body.share.id);
    // Push preview is the guard's generic line: no area, no coordinates.
    assert.equal(notes[0].body, "Live location active — open the app to view.");
  });

  it("a contact with no Portava account is not notified, and the response says so", async () => {
    const c = makeFake(tables({
      safe_return_contacts: [{ id: CONTACT_ID, session_id: SESSION_ID, contact_user_id: null, can_receive_live_location: true }],
    }));
    use(c);
    const r = await start({ recipientContactId: CONTACT_ID, durationMinutes: 60 });
    assert.equal(r.status, 201);
    assert.equal(r.body.recipientNotified, false);
    assert.equal(r.body.recipientNoticeReason, "recipient_not_on_portava");
    assert.equal((c.__inserted.notifications ?? []).length, 0);
  });

  it("a contact blocked with the sharer is not notified", async () => {
    const c = makeFake(tables({ blocks: [{ blocker_id: RECIPIENT, blocked_id: SHARER }] }));
    use(c);
    const r = await start({ recipientContactId: CONTACT_ID, durationMinutes: 60 });
    assert.equal(r.status, 201);
    assert.equal(r.body.recipientNotified, false);
    assert.equal(r.body.recipientNoticeReason, "blocked");
    assert.equal((c.__inserted.notifications ?? []).length, 0);
  });
});
