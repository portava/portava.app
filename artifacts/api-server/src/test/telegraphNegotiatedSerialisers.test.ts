/**
 * census-telegraph T431 (lane TELEGRAPH batch 4) — §30A.16 negotiation reaches EVERY serialiser that serves a
 * stored body, not only the thread page and share projections.
 *
 * §86.2 recorded the sibling gap: "the inbox preview, the drawer, search and the single-message serialisers
 * are not negotiated". With telegraph_structured_schemas_enabled ON, a client that declared it cannot draw
 * a LOCATION was served the location as the sentence on the thread page and as its stored body — label,
 * place id and coordinates — in its inbox preview, its saved messages, the message's edit history, the
 * content drawer, both searches and "ask this conversation". Each surface below is driven over the real router for one member
 * (CARL, unblocked — the location's text is his to see), in four states:
 *
 *   flag OFF, client declares nothing   → served as stored (OFF is byte-for-byte the old answer)
 *   flag ON,  no header (the baseline)  → served as stored (the baseline renders every v1 schema)
 *   flag ON,  declares location.scope.v1 → served as stored, `structured` naming the schema
 *   flag ON,  declares nothing ("none") → NONE of the location's text anywhere; the sentence instead,
 *                                          `structured.fallback` true with the reason
 *
 * The control rows make the last one non-vacuous: the same surface, same viewer, same row, DOES carry the
 * text in the first three.
 *
 * MUTANTS (tgprod/mutants-b4.txt): NS1 negotiateServed ignores the decision; NS2 the inbox preview is not
 * negotiated; NS3 saved messages; NS4 edit history; NS5 the drawer; NS6 in-thread search; NS7 global
 * search; NS8 the flag ignored (OFF negotiates); NS9 ask is not negotiated.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphNegotiatedSerialisers.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import kindsRouter from "../routes/telegraphKinds.js";
import searchRouter from "../server/telegraph/searchRoute.js";
import { negotiateEditHistory, negotiateServed } from "../services/telegraph/platformReadDecorations.js";
import { CLIENT_SCHEMAS_HEADER, parseClientCapabilities } from "../services/telegraph/structuredSchemas.js";
import { makeFakeClient, startRouter, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const CARL = "cccccccc-0000-4000-8000-0000000000c3";
const GROUP = "00000000-0000-4000-8000-0000000000e1";
const LOC = "11111111-0000-4000-8000-0000000000f1";
const NOW = Date.now();
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const SECRETS = ["Café Secret", "Old Quarter", "place-secret-123", "16.0611", "108.2208"];
const LOC_BODY = JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: {
  label: "Café Secret", approximateLabel: "Old Quarter", placeId: "place-secret-123", precision: "exact",
  lat: 16.0611, lng: 108.2208, caption: null, expiresAt: at(-60), purpose: "presence_in_context",
} });
const SENTENCE = "Shared a location";

function world(flagOn: boolean): Record<string, unknown[]> {
  const m = (user_id: string) => ({ thread_id: GROUP, user_id, role: "member", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, joined_at: at(600) });
  return {
    feature_flags: [{ flag: "telegraph_structured_schemas_enabled", enabled: flagOn }],
    blocks: [],
    message_threads: [{ id: GROUP, thread_type: "group", status: "active", title: "Crew", trip_id: null, circle_owner_id: null, is_e2ee: false, created_at: at(600), updated_at: at(1), last_message_at: at(1) }],
    message_thread_members: [m(ALICE), m(CARL)],
    messages: [{
      id: LOC, thread_id: GROUP, sender_id: ALICE, body: LOC_BODY, msg_type: "location", subtype: "exact", created_at: at(1), deleted_at: null, edited_at: null,
      original_language: null, media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null, ciphertext: null,
    }],
    message_edits: [{ message_id: LOC, version: 1, previous_body: LOC_BODY, editor_id: ALICE, edited_at: at(1) }],
    saved_messages: [{ user_id: CARL, message_id: LOC, saved_at: at(1) }],
    profiles: [ALICE, CARL].map((id) => ({ id, handle: id.slice(0, 5), name: id.slice(0, 5), avatar_url: null, is_private: false, account_status: "active" })),
    message_translations: [], user_friendships: [], memories: [],
  };
}

const SURFACES: Array<{ name: string; router: express.Router; path: string }> = [
  { name: "inbox preview (GET /me/threads)", router: messagingRouter, path: `/me/threads` },
  { name: "saved messages (GET /me/saved-messages)", router: messagingRouter, path: `/me/saved-messages` },
  { name: "edit history (GET /threads/:id/messages/:id/edits)", router: messagingRouter, path: `/threads/${GROUP}/messages/${LOC}/edits` },
  { name: "content drawer (GET /threads/:id/drawer)", router: kindsRouter, path: `/threads/${GROUP}/drawer` },
  { name: "in-thread search (GET /threads/:id/search)", router: kindsRouter, path: `/threads/${GROUP}/search?q=Secret` },
  { name: "global search (GET /telegraph/search)", router: searchRouter as unknown as express.Router, path: `/telegraph/search?q=Secret` },
  { name: "ask this conversation (GET /threads/:id/ask)", router: searchRouter as unknown as express.Router, path: `/threads/${GROUP}/ask?q=Secret` },
];

const harnesses = new Map<express.Router, RouterHarness>();
before(async () => {
  for (const s of SURFACES) if (!harnesses.has(s.router)) harnesses.set(s.router, await startRouter(s.router));
});
after(async () => { _setTestClient(null as any, false); for (const h of harnesses.values()) await h.close(); });

async function read(s: (typeof SURFACES)[number], flagOn: boolean, header: string | null) {
  _setTestClient(makeFakeClient(world(flagOn)) as any, true);
  const r = await fetch(`${harnesses.get(s.router)!.base}${s.path}`, {
    headers: { authorization: `Bearer ${CARL}`, ...(header === null ? {} : { [CLIENT_SCHEMAS_HEADER]: header }) },
  });
  const text = await r.text();
  return { status: r.status, text };
}
const leaks = (text: string) => SECRETS.filter((x) => text.includes(x));

for (const s of SURFACES) {
  describe(`T431 — ${s.name}`, () => {
    it("CONTROLS: OFF + declares nothing, ON + baseline, ON + declares location.scope.v1 — each carries the location's text", async () => {
      for (const [flagOn, header] of [[false, "none"], [true, null], [true, "location.scope.v1"]] as const) {
        const r = await read(s, flagOn, header);
        assert.equal(r.status, 200, `${flagOn}/${header}: ${r.text.slice(0, 300)}`);
        assert.ok(leaks(r.text).length > 0, `${flagOn}/${header}: the surface does not serve the row, so the negotiated case proves nothing: ${r.text.slice(0, 400)}`);
      }
    });

    it("ON + a client that draws no location: none of its text, the sentence instead, and `structured` says why", async () => {
      const r = await read(s, true, "none");
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.deepEqual(leaks(r.text), [], `${s.name} served the location to a client that cannot draw it: ${r.text.slice(0, 600)}`);
      assert.ok(r.text.includes(SENTENCE), `the fallback sentence is served: ${r.text.slice(0, 400)}`);
      const j = JSON.parse(r.text);
      const found = JSON.stringify(j).match(/"structured":\{"schema":"location\.scope\.v1","fallback":true,"reason":"client_unsupported_schema"/);
      assert.ok(found, `structured.fallback names the schema and the reason: ${r.text.slice(0, 400)}`);
    });
  });
}

describe("T431 — the helpers, directly", () => {
  const row = { id: LOC, msg_type: "location", subtype: "exact", body: LOC_BODY, deleted_at: null };
  const served = () => ({ body: LOC_BODY, displayBody: LOC_BODY, msgType: "location", subtype: "exact", mediaUrl: "u", links: ["l"], translated: true });
  const shape = { body: ["body", "displayBody"], typeField: "msgType", subtypeField: "subtype", cleared: ["mediaUrl"], emptied: ["links"], falsified: ["translated"] };

  it("caps null (flag OFF): the served object is untouched", () => {
    const out = served();
    const snap = JSON.stringify(out);
    negotiateServed(out, row, null, shape);
    assert.equal(JSON.stringify(out), snap);
  });

  it("a client that draws it: unchanged content, `structured` names the schema", () => {
    const out = served();
    negotiateServed(out, row, parseClientCapabilities({ [CLIENT_SCHEMAS_HEADER]: "location.scope.v1" }), shape);
    assert.equal(out.body, LOC_BODY);
    assert.deepEqual((out as any).structured, { schema: "location.scope.v1", fallback: false });
  });

  it("a client that does not: every named field takes its rule", () => {
    const out = served();
    negotiateServed(out, row, parseClientCapabilities({ [CLIENT_SCHEMAS_HEADER]: "none" }), shape);
    assert.deepEqual({ ...out, structured: undefined }, { body: SENTENCE, displayBody: SENTENCE, msgType: "text", subtype: null, mediaUrl: null, links: [], translated: false, structured: undefined });
    assert.deepEqual((out as any).structured, { schema: "location.scope.v1", fallback: true, reason: "client_unsupported_schema", originalMsgType: "location" });
  });

  it("an invalid payload falls back even for the baseline client, as on the thread page", () => {
    const out = served();
    negotiateServed(out, { ...row, body: "{not json" }, parseClientCapabilities({}), shape);
    assert.equal((out as any).structured?.fallback, true);
  });

  it("edit history: every version takes the sentence with the current body; caps null returns the same object", () => {
    const payload = { currentBody: LOC_BODY, editedAt: null, versions: [{ version: 1, previousBody: LOC_BODY, editorId: ALICE, editedAt: null }] };
    assert.equal(negotiateEditHistory(null, row, payload), payload);
    const out = negotiateEditHistory(parseClientCapabilities({ [CLIENT_SCHEMAS_HEADER]: "none" }), row, payload);
    assert.equal(out.currentBody, SENTENCE);
    assert.deepEqual(out.versions.map((v) => v.previousBody), [SENTENCE]);
    assert.deepEqual(leaks(JSON.stringify(out)), []);
  });
});
