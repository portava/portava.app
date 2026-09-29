/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-97): three smaller honest-state defects the
 * round-12 verifier noted beside its breaks, each now said instead of stated as a fact or omitted.
 *
 *   SB1  the structured context's bookings buddy-handle read fails → marked, and the prompt says the
 *        buddies could not be read (§109.5's "each read checks its .error" was not true of this read)
 *   SBc  CONTROL: the handle read succeeds → "with @buddy", no marker, no line
 *   SA1  /compass/ask: the profile read throws (a failed blocks read) → the prompt says the circle,
 *        booking and passport context could not be read, instead of dropping the whole block silently
 *   SAc  CONTROL: a healthy /compass/ask adds no such line
 *   TN1  Compass Home, 12 events tonight → the headline never says "8 events on tonight" (it counted
 *        after `slice(0, 8)`); it says "8+"
 *   TN2  a read that reached its row cap (hidden hosts filtered after it) → "N+", never an exact count
 *   TNc  CONTROL: 3 events tonight → "3 events on tonight"
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { buildCompassHomeProjection, _clearCompassHomeCache } from "../routes/compassHome.js";
import { buildStructuredCompassContext, formatStructuredContextLines } from "../compass/CompassStructuredContext.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import type { CompassProfile } from "../compass/types.js";
import { compassWorld, VIEWER, TOKEN, DB_ERR, type Call } from "./helpers/compassReadWorld.js";

const BUDDY = "b0000000-0000-4000-a000-0000000000b1";
const profile = { userId: VIEWER, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [] } as unknown as CompassProfile;
const inCall = (calls: Call[], column: string) => calls.some(([k, a]) => k === "in" && a[0] === column);
const limitOf = (calls: Call[]) => { const c = calls.find(([k]) => k === "limit"); return c ? Number(c[1][0]) : Infinity; };

describe("the structured context's bookings buddy-handle read (§110, D-W11X2-97)", () => {
  const world = (handlesFail: boolean) => compassWorld({
    answer: (t, calls) => {
      if (t === "rent_buddy_bookings") return { data: [{ buddy_id: BUDDY, city: "Porto", booking_date: "2026-10-01", start_time: "10:00:00", duration_h: 2, status: "confirmed" }], error: null };
      if (t === "profiles" && inCall(calls, "id")) return handlesFail ? { data: null, error: DB_ERR } : { data: [{ id: BUDDY, handle: "rui" }], error: null };
      return undefined;
    },
  });
  it("SB1 the handle read fails → marked, and the prompt says the buddies could not be read", async () => {
    const ctx = await buildStructuredCompassContext(world(true).client as any, profile);
    assert.equal(ctx.activeBookings.length, 1);
    assert.equal(ctx.unread?.bookingBuddies, true, JSON.stringify(ctx.unread));
    assert.ok(formatStructuredContextLines(ctx).some((l) => /buddies on these bookings could not be read/i.test(l)));
  });
  it("SBc CONTROL: the handle read succeeds → 'with @rui', no marker, no line", async () => {
    const ctx = await buildStructuredCompassContext(world(false).client as any, profile);
    assert.equal(ctx.unread, undefined);
    const lines = formatStructuredContextLines(ctx);
    assert.ok(lines.some((l) => l.includes("with @rui")), lines.join("\n"));
    assert.ok(!lines.some((l) => /could not be read/i.test(l)));
  });
});

describe("/compass/ask over a thrown profile read (§110, D-W11X2-97)", () => {
  let base = ""; let server: Server;
  before(async () => {
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; n(); });
    app.use("/api", compassRouter);
    server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  });
  after(() => { server.close(); _setTestOpenAI(null); });
  beforeEach(() => { invalidateFlagsCache(); clearCompassProfileCache(); });
  async function askPrompt(failTables: string[]): Promise<string> {
    const seen: any[] = [];
    _setTestOpenAI({ chat: { completions: { create: async (opts: any) => { seen.push(opts); return { choices: [{ message: { role: "assistant", content: "ok" } }] }; } } } } as any);
    _setTestClient(compassWorld({ failTables, answer: (t, _c, single) => (t === "compass_conversations" && single ? { data: { id: "cc000000-0000-4000-a000-000000000001" }, error: null } : undefined) }).client as any, true);
    const r = await fetch(`${base}/compass/ask`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "what's good tonight?" }) });
    assert.equal(r.status, 200);
    const answer = seen.find((o) => JSON.stringify(o.messages).includes("You are Compass"));
    assert.ok(answer, "the answer call was made");
    return JSON.stringify(answer.messages);
  }
  it("SA1 the profile read throws (a failed blocks read) → the prompt says the structured context could not be read", async () => {
    const prompt = await askPrompt(["blocks"]);
    assert.match(prompt, /circles, buddy bookings and passport history could not be read/i);
  });
  it("SAc CONTROL: a healthy ask adds no such line", async () => {
    const prompt = await askPrompt([]);
    assert.doesNotMatch(prompt, /circles, buddy bookings and passport history could not be read/i);
  });
});

describe("Compass Home's 'events on tonight' count (§110, D-W11X2-97)", () => {
  beforeEach(() => { invalidateFlagsCache(); clearCompassProfileCache(); _clearCompassHomeCache(); });
  const tonight = (n: number, hiddenFirst = 0) => compassWorld({
    answer: (t, calls) => {
      if (t !== "events" || String(calls.find(([k]) => k === "select")?.[1][0] ?? "").includes("going_count")) return undefined;
      const rows = Array.from({ length: n }, (_, i) => ({ id: `ev-${i}`, title: `Event ${i}`, city: "Paris", country: "FR", starts_at: new Date(Date.now() + (i + 1) * 60_000).toISOString(), category: "music", host_id: i < hiddenFirst ? "hidden-host" : `h-${i}`, state: "open", visibility: "public" }));
      return { data: rows.slice(0, limitOf(calls)), error: null };
    },
  });
  const hiddenProfile = { blocks: "hidden-host" };
  it("TN1 12 events tonight → '8+ events on tonight', never '8 events on tonight'", async () => {
    const home: any = await buildCompassHomeProjection(tonight(12).client as any, VIEWER, { localHour: 22 });
    assert.equal(home.tonightVibe?.events?.length, 4);
    assert.match(String(home.tonightVibe?.headline), /^8\+ events on tonight/, JSON.stringify(home.tonightVibe));
  });
  it("TN2 a read that reached its row cap → an 'N+' count, never an exact one", async () => {
    void hiddenProfile;
    const home: any = await buildCompassHomeProjection(tonight(24).client as any, VIEWER, { localHour: 22 });
    assert.match(String(home.tonightVibe?.headline), /^8\+ events/, JSON.stringify(home.tonightVibe));
  });
  it("TNc CONTROL: 3 events tonight → '3 events on tonight'", async () => {
    const home: any = await buildCompassHomeProjection(tonight(3).client as any, VIEWER, { localHour: 22 });
    assert.match(String(home.tonightVibe?.headline), /^3 events on tonight/, JSON.stringify(home.tonightVibe));
  });
});
