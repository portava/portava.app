/**
 * L3-FC (lead ruling 2026-10-07; census-compass §50, CL-02) — the general
 * Compass chat on a live layover: every question is a leaving question,
 * answered with the certified text only, unless the airside allowlist
 * recognises it.
 *
 * WHAT WAS WRONG. The layover dashboard's Telegraph fallback sends a traveller
 * to `/ai` → `POST /compass/ask` with a layover prefill. That route put the
 * certified snapshot into the PROMPT only and streamed the model's prose as
 * written; the confinement lived in the layover service's own Compass, which
 * this door never reaches. "Can I see the cathedral?" could be answered "it's a
 * short cab away" on a layover the certified check says not to leave.
 *
 * WHAT IS PINNED, through the real route over the real certified snapshot:
 *   - a live layover and a non-airside question: the answer is
 *     certifiedLayoverAnswerText(snapshot), the main model is never called, and
 *     on the stream no other text reaches the wire;
 *   - an airside question gets the model, its answer is held back (never
 *     streamed as it is written) and replaced by the certified text if it drifts
 *     into leaving; a clean airside answer is shown as written;
 *   - no live layover: the route answers as it always did (the ruling's scope);
 *   - the allowlist and the certified sentence, directly (services/airport/
 *     layoverQuestionScope), including the verifier's paraphrases.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/compassAskLayoverConfinement.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import { certifiedLayoverSnapshot } from "../services/airport/LayoverSnapshot.js";
import { certifiedLayoverAnswerText, certifiedLeavingAllowed, isAirsideLayoverQuestion, mentionsLeaving, LAYOVER_STATE_UNREADABLE_MESSAGE } from "../services/airport/layoverQuestionScope.js";

const USER = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const TOKEN = "layover-ask-token";
const LEAVING_PROSE = "The cathedral is a short cab away, and you have ample margin to venture beyond the terminal.";
const AIRSIDE_PROSE = "Lounge 3 is past security on level 2, next to gate B4.";

function tables(opts: { layover: boolean }) {
  return {
    feature_flags: [
      { flag: "COMPASS_ENABLED", enabled: true },
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
    ],
    airport_profiles: [airportRow()],
    layover_sessions: opts.layover ? [sessionRow({ user_id: USER })] : [],
    layover_plan_stops: [], layover_recommendations: [], layover_events: [],
    compass_conversations: [], compass_conversation_messages: [], compass_profiles: [], compass_user_preferences: [],
    profiles: [{ id: USER, handle: "alice", name: "Alice" }],
    blocks: [], user_mutes: [], trips: [], trip_members: [], user_follows: [],
  } as Record<string, any[]>;
}

/** A model that answers `reply` to every main round; records the main (non-classifier) calls. */
function model(reply: string) {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        create: async (opts: any) => {
          const isClassifier = opts.max_completion_tokens === 256;
          if (isClassifier) return { choices: [{ message: { role: "assistant", content: JSON.stringify({ intent: "recommendation", confidence: 0.9 }) } }] };
          calls.push(opts);
          if (opts.stream) {
            const parts = reply.split(" ").map((w, i) => (i === 0 ? w : ` ${w}`));
            return { async *[Symbol.asyncIterator]() { for (const p of parts) yield { choices: [{ delta: { content: p } }] }; } };
          }
          return { choices: [{ message: { role: "assistant", content: JSON.stringify({ message: reply }) } }] };
        },
      },
    },
  };
  return { client, calls };
}

let server: Server; let base = "";
before(async () => {
  const { default: compassRouter } = await import("../routes/compass.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); });
afterEach(() => { _setTestClient(null as any, false); _setTestOpenAI(null); invalidateFlagsCache(); });

async function ask(prompt: string, opts: { layover: boolean; reply: string; stream?: boolean; sessionsUnreadable?: boolean; sessionsThrow?: boolean }) {
  const inner = makeLayoverDb(tables({ layover: opts.layover }), {
    users: { [TOKEN]: USER },
    // L3-FC-2: the layover session store cannot be read.
    ...(opts.sessionsUnreadable ? { failures: { "layover_sessions:select": { message: "connection reset", code: "08006" } } } : {}),
  });
  // The ask route reads its flags with `.like("flag", "COMPASS_%")` and calls
  // a few rpcs on non-fatal paths; this double models neither, so: `like` as
  // its case-insensitive `ilike`, and an rpc answers an error (never a shape).
  const db: any = {
    ...inner,
    from: (t: string) => {
      if (opts.sessionsThrow && t === "layover_sessions") throw new Error("socket hang up");
      const b = inner.from(t); b.like = (c: string, p: string) => b.ilike(c, p); return b;
    },
    rpc: async () => ({ data: null, error: { message: "rpc not modelled in this test", code: "XX000" } }),
  };
  _setTestClient(db, true);
  const m = model(opts.reply);
  _setTestOpenAI(m.client as any);
  invalidateFlagsCache();
  const r = await fetch(`${base}/api/compass/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ prompt, ...(opts.stream ? { stream: true } : {}) }),
  });
  const raw = await r.text();
  let body: any = null; let wire = raw;
  if (opts.stream) {
    const events = raw.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    body = events.find((e) => e.done) ?? events[events.length - 1];
    wire = events.filter((e) => typeof e.delta === "string").map((e) => e.delta).join("");
  } else {
    body = JSON.parse(raw);
  }
  const snap = opts.layover && !opts.sessionsUnreadable && !opts.sessionsThrow ? await certifiedLayoverSnapshot(db, USER) : null;
  return { status: r.status, body, wire, mainCalls: m.calls.length, snap };
}

describe("L3-FC — the general Compass chat on a live layover", () => {
  it("a non-airside question gets the certified text only, and the model is never called", async () => {
    for (const q of ["Can I see the cathedral?", "What should I do with my time?", "Is it worth exploring a bit?"]) {
      const r = await ask(q, { layover: true, reply: LEAVING_PROSE });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.snap?.ok, "fixture: the session is live and certified");
      assert.equal(r.body.message, certifiedLayoverAnswerText((r.snap as any).snapshot), q);
      assert.equal(r.body.meta.layoverAnswer, "certified_only", q);
      assert.equal(r.mainCalls, 0, `${q}: the model was asked`);
      assert.doesNotMatch(JSON.stringify(r.body), /cathedral is a short cab|venture beyond/);
    }
  });

  it("streamed: the wire carries the certified text and nothing else", async () => {
    const r = await ask("Can I see the cathedral?", { layover: true, reply: LEAVING_PROSE, stream: true });
    assert.equal(r.wire, certifiedLayoverAnswerText((r.snap as any).snapshot));
    assert.equal(r.body.done, true);
    assert.equal(r.mainCalls, 0);
  });

  it("an airside question gets the model — but an answer that drifts into leaving is replaced, and on the stream it never reaches the wire", async () => {
    for (const stream of [false, true]) {
      const r = await ask("Where is the nearest lounge?", { layover: true, reply: LEAVING_PROSE, stream });
      assert.equal(r.mainCalls, 1, `stream=${stream}: the allowlisted question reached the model`);
      const certified = certifiedLayoverAnswerText((r.snap as any).snapshot);
      assert.equal(r.body.message, certified, `stream=${stream}`);
      if (stream) assert.equal(r.wire, certified, "the drifting prose was streamed before it was checked");
      assert.doesNotMatch(r.wire + JSON.stringify(r.body), /venture beyond|short cab/);
    }
  });

  it("control: a clean airside answer is shown as written (streamed once it is checked)", async () => {
    for (const stream of [false, true]) {
      const r = await ask("Where is the nearest lounge?", { layover: true, reply: AIRSIDE_PROSE, stream });
      assert.equal(r.body.message, AIRSIDE_PROSE, `stream=${stream}`);
      if (stream) assert.equal(r.wire, AIRSIDE_PROSE);
    }
  });

  it("control: with no live layover the route answers as it always did (the ruling covers layover sessions)", async () => {
    const r = await ask("Can I see the cathedral?", { layover: false, reply: LEAVING_PROSE });
    assert.equal(r.body.message, LEAVING_PROSE);
    assert.equal(r.mainCalls, 1);
    assert.equal(r.body.meta?.layoverAnswer, undefined);
  });
});

describe("L3-FC-2 — the layover session store cannot be read", () => {
  it("a question outside the allowlist gets the retryable refusal, and the model is never called", async () => {
    for (const q of ["Can I see the cathedral?", "What should I do with my time?"]) {
      const r = await ask(q, { layover: true, sessionsUnreadable: true, reply: LEAVING_PROSE });
      assert.equal(r.status, 200);
      assert.equal(r.body.message, LAYOVER_STATE_UNREADABLE_MESSAGE, q);
      assert.equal(r.body.fallback, true);
      assert.equal(r.body.fallbackReason, "layover_state_unreadable");
      assert.equal(r.body.retryable, true);
      assert.equal(r.mainCalls, 0, `${q}: the model was asked over an unreadable layover state`);
      assert.doesNotMatch(JSON.stringify(r.body), /cathedral is a short cab|venture beyond/);
    }
  });

  it("streamed: one error event carrying the retryable sentence; no model text on the wire", async () => {
    const r = await ask("Can I see the cathedral?", { layover: true, sessionsUnreadable: true, reply: LEAVING_PROSE, stream: true });
    assert.equal(r.body.error, true);
    assert.equal(r.body.message, LAYOVER_STATE_UNREADABLE_MESSAGE);
    assert.equal(r.body.retryable, true);
    assert.equal(r.wire, "", "no delta was streamed");
    assert.equal(r.mainCalls, 0);
  });

  it("a read that THROWS is unreadable too", async () => {
    const r = await ask("Can I see the cathedral?", { layover: true, sessionsThrow: true, reply: LEAVING_PROSE });
    assert.equal(r.body.message, LAYOVER_STATE_UNREADABLE_MESSAGE);
    assert.equal(r.mainCalls, 0);
  });

  it("an airside question proceeds as normal", async () => {
    const r = await ask("Where is the nearest lounge?", { layover: true, sessionsUnreadable: true, reply: AIRSIDE_PROSE });
    assert.equal(r.mainCalls, 1);
    assert.equal(r.body.message, AIRSIDE_PROSE);
    assert.equal(r.body.fallback, undefined);
  });

  it("control: a READABLE store with no live layover is not a refusal (an answer, not an unknown)", async () => {
    const r = await ask("Can I see the cathedral?", { layover: false, reply: LEAVING_PROSE });
    assert.equal(r.body.message, LEAVING_PROSE);
    assert.equal(r.body.fallbackReason, undefined);
  });
});

describe("services/airport/layoverQuestionScope — the allowlist and the certified sentence", () => {
  it("the allowlist admits only questions about something inside the airport", () => {
    for (const q of ["Where is the nearest lounge?", "Is there wifi at gate B4?", "Where can I shower?", "Is duty free open?",
      "Where can I eat in the terminal?", "How long is the security line?", "Is there a transit hotel?"]) {
      assert.equal(isAirsideLayoverQuestion(q), true, q);
    }
    for (const q of ["Can I see the cathedral?", "What should I do with my time?", "Is the old town worth it?",
      "Can I grab a taxi into the city?", "Any good museums nearby?", "How do I get to my gate from the city?",
      "Can I leave the airport?", "Is there a lounge outside security I could walk to?", "Is it worth exploring a bit?", ""]) {
      assert.equal(isAirsideLayoverQuestion(q), false, q);
    }
  });

  it("the leaving test catches the wave-2 verifier's paraphrases in a model answer", () => {
    for (const a of ["ample margin to venture beyond the terminal", "the cathedral is a short cab away", "you could take the train downtown",
      "a quick visit to the night market is doable", "plenty of time to head out for dinner"]) {
      assert.equal(mentionsLeaving(a), true, a);
    }
    assert.equal(mentionsLeaving(AIRSIDE_PROSE), false);
    assert.equal(mentionsLeaving("The transit hotel is on level 3."), false);
  });

  it("the certified text says 'you can leave' only on an open gate with at least 30 usable minutes", () => {
    const base = { verdict: "yes", usableMinutes: 120, minutesToHardReturn: 200, landsideOpen: true, landsideStatus: "open", landsideCautions: [], landsideClosedReason: null } as any;
    assert.match(certifiedLayoverAnswerText(base), /allows leaving the airport — be back at security within 200 minutes/);
    assert.match(certifiedLayoverAnswerText({ ...base, verdict: "no", landsideOpen: false, landsideStatus: "closed" }), /not recommended .* says no/);
    assert.match(certifiedLayoverAnswerText({ ...base, landsideOpen: false, landsideStatus: "caution", landsideCautions: ["entry_unconfirmed"] }), /has not been confirmed as possible on this layover \(entry_unconfirmed\)/);
    assert.match(certifiedLayoverAnswerText({ ...base, usableMinutes: 20 }), /^With only 20 minutes of usable time, staying inside the airport is the safe choice/);
    assert.match(certifiedLayoverAnswerText({ ...base, landsideStatus: "surprise" as any, landsideOpen: false }), /has not been confirmed/, "an unknown status is not an open gate");
    for (const s of [{ ...base, verdict: "no", landsideOpen: false, landsideStatus: "closed" }, { ...base, usableMinutes: 20 }, { ...base, landsideOpen: false, landsideStatus: "caution" }]) {
      assert.doesNotMatch(certifiedLayoverAnswerText(s), /allows leaving/);
    }
  });

  it("V-L6c F6: 'allows leaving' needs the VERDICT yes too, and a NaN figure is never rendered", () => {
    const open = { verdict: "yes", usableMinutes: 120, minutesToHardReturn: 200, landsideStatus: "open", landsideCautions: [], landsideClosedReason: null } as any;
    assert.equal(certifiedLeavingAllowed(open), true, "control: the one explicit yes");
    // An open gate under any verdict other than an explicit yes is not a yes (the Pick type is assembled by hand by callers).
    for (const verdict of ["tight", "entry_unverified", "stay_airside", "maybe", undefined]) {
      const s = { ...open, verdict };
      assert.equal(certifiedLeavingAllowed(s), false, String(verdict));
      assert.doesNotMatch(certifiedLayoverAnswerText(s), /allows leaving/, String(verdict));
      assert.match(certifiedLayoverAnswerText(s), /has not been confirmed/, String(verdict));
    }
    for (const bad of [{ usableMinutes: NaN }, { minutesToHardReturn: NaN }, { usableMinutes: Infinity }, { usableMinutes: undefined }]) {
      const s = { ...open, ...bad };
      assert.equal(certifiedLeavingAllowed(s), false, JSON.stringify(bad));
      const text = certifiedLayoverAnswerText(s);
      assert.doesNotMatch(text, /allows leaving|NaN|Infinity|undefined/, JSON.stringify(bad));
    }
  });
});
