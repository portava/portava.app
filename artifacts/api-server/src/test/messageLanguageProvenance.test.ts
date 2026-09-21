/**
 * Census T344 / T363 — `messages.language_detection_source` must describe what
 * actually happened, not what would have been convenient.
 *
 * THE DEFECT THIS PINS. Five route sites read the sender's profile to find a
 * language preference and coalesced the result to `'en'`:
 *
 *     const { data: senderProfile } = await sc.from('profiles')
 *       .select('preferred_language, preferred_message_language')…
 *     const senderLanguage = (senderProfile as any)?.preferred_language
 *       ?? (senderProfile as any)?.preferred_message_language ?? 'en';
 *
 * supabase-js RESOLVES on a database error, so `data` is null and the error was
 * never bound. Three different worlds — the sender chose English, the sender
 * chose nothing, the `profiles` read FAILED — arrived at
 * `translateMessageForThread` as the identical string `'en'`, and the pipeline
 * then wrote a DURABLE, QUERYABLE claim about provenance:
 *
 *     .update({ original_language: sourceLanguage,
 *               language_detection_source: detectionSource })
 *
 * with `detectionSource = senderPreferredLanguage ? 'sender_preference' : 'default'`.
 * Because every caller pre-coalesced, `senderPreferredLanguage` was never
 * nullish and the `'default'` arm was unreachable in practice (strictly: it
 * needed a stored empty-string preference, which no writer produces). So every
 * profiles outage minted a row asserting "the sender told us their language is
 * English" about a sender who told us nothing and about a read that failed.
 *
 * THE VOCABULARY. This repository's house rule — AN UNREADABLE X IS NOT AN
 * EMPTY X — is applied here the way it is applied everywhere else in the tree
 * (`preferences_unreadable`, `sessions_unreadable`, `plan_unreadable`,
 * `trip_unreadable`): the failed read gets its OWN word rather than being
 * folded into the word for "nothing was stated".
 *
 *   'provider'                     the provider read the text and named a language
 *   'sender_preference'            the profile was read and it carried a stated language
 *   'default'                      the profile was read and stated nothing   ← resurrected
 *   'sender_preference_unreadable' the profile could NOT be read             ← new
 *
 * WHAT IS ASSERTED, and why each half is needed:
 *
 *   SERVICE — `translateMessageForThread` maps the three fallback worlds onto
 *   three DIFFERENT stored words, and still stamps an `original_language` and
 *   still writes a translation row in every one of them. The claim changes;
 *   the user-visible behaviour does not.
 *
 *   ROUTE — the real routers, driven through the certification harness, with
 *   `profiles` made unreadable from the sender-preference read onwards (the
 *   auth gate reads `profiles` first and refuses outright if it is down, so a
 *   whole-table error would never reach the handler). This is the half that
 *   catches the laundering, because the laundering is in the ROUTE: a service
 *   test alone stays green while the callers keep passing `'en'`.
 *
 *   STRUCTURE — all five call sites, including the one whose route is not
 *   driven here. A behavioural test can only reach the sites it can reach; the
 *   census named five, and re-introducing `?? 'en'` at the fifth must be loud.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/messageLanguageProvenance.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { _setTestClient } from "../lib/http.js";
import { _setTestTranslationProvider } from "../lib/translation.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import groupChatRouter from "../routes/groupChat.js";
import { translateMessageForThread } from "../services/messageTranslation.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // sender
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // recipient
const DM = "00000000-0000-4000-8000-00000000000d";
const MSG = "11111111-0000-4000-8000-000000000001";

const PROFILES_DOWN = { message: "permission denied for relation profiles", code: "42501" };

/** The select that identifies the sender-preference read, in every one of the five sites. */
const SENDER_PREF_SELECT = "preferred_language, preferred_message_language";

// ── Providers ─────────────────────────────────────────────────────────────────

/**
 * Detection down, translation up. Every fallback arm of the pipeline is behind
 * a failed `detectLanguage`, so a provider that still detects would make every
 * assertion below unreachable and the suite would pass by never arriving.
 */
const DETECTOR_DOWN = {
  async detectLanguage(): Promise<{ language: string; confidence: "high" | "low" }> {
    throw new Error("detector_down");
  },
  async translateText(text: string, _source: string, target: string) {
    return { translatedText: `[${target}] ${text} and then some more words.`, provider: "stub" };
  },
};

const DETECTOR_SAYS_IT = {
  async detectLanguage(): Promise<{ language: string; confidence: "high" | "low" }> {
    return { language: "it", confidence: "high" };
  },
  async translateText(text: string, _source: string, target: string) {
    return { translatedText: `[${target}] ${text} and then some more words.`, provider: "stub" };
  },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * `preferred_language` is DELIBERATELY absent from A's row in the default seed.
 * "Stated nothing" is one of the three worlds under test and it has to be
 * spelled as an absent column, which is what a profile that never touched the
 * setting actually looks like.
 */
function store(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A", account_status: null, auto_translate_messages: true },
      { id: B, handle: "b", name: "B", account_status: null, preferred_language: "es", auto_translate_messages: true },
    ],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trust_profiles: [],
    trust_restrictions: [],
    message_requests: [],
    message_threads: [
      {
        id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
      },
    ],
    message_thread_members: [
      { thread_id: DM, user_id: A, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM, user_id: B, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      {
        id: MSG, thread_id: DM, sender_id: A, body: "nos vemos en el muelle a las ocho.",
        created_at: "2026-01-01T00:00:00.000Z", deleted_at: null, edited_at: null,
        original_language: null, language_detection_source: null,
        msg_type: "text", subtype: null, media_url: null, media_type: null,
        media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null,
      },
    ],
    message_translations: [],
    trips: [],
    trip_members: [],
    ...over,
  };
}

let messagingHarness: RouterHarness;
let groupChatHarness: RouterHarness;

before(async () => {
  messagingHarness = await startRouter(messagingRouter);
  groupChatHarness = await startRouter(groupChatRouter);
});
after(async () => {
  _setTestTranslationProvider(null);
  await messagingHarness.close();
  await groupChatHarness.close();
});
beforeEach(() => {
  resetFakeIds();
  _resetRateLimit();
  _clearSendTierCache();
  _setTestTranslationProvider(DETECTOR_DOWN as any);
});

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  // BOTH OF THESE ARE PROCESS-WIDE AND MUST BE RESET PER CLIENT, not per test.
  // The route cases below run the same request TWICE — once to measure where
  // the sender-preference read falls, once with `profiles` failing from that
  // point — and the second run must take the identical path. It does not
  // otherwise: the send tier is memoised per user, so the warm second run
  // skipped the profile reads the cold first run made, the measured offset
  // pointed past the sender read, and the case reported 'default' while
  // looking like it had tested an outage.
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(state, opts);
  _setTestClient(c, true);
  return c;
}

/** The pipeline is fire-and-forget, so the stamp lands after the response. */
async function stampedRow(c: FakeClient, messageId: string, timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (c._store.messages ?? []).find((m: any) => m.id === messageId);
    if (row?.language_detection_source) return row;
    if (Date.now() > deadline) {
      throw new Error("the translation pipeline never stamped language_detection_source");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * How many operations hit `profiles` BEFORE the sender-preference read.
 *
 * Measured rather than hardcoded. The auth gate reads `profiles` on every
 * authenticated request and REFUSES when it is unreadable, so "make profiles
 * unreadable" cannot mean "from op 1": the handler would never run and the
 * suite would prove a 503, not a provenance claim. Guessing the number would
 * make this suite silently stop testing the thing the moment a route grows
 * another profile read above the one under test.
 */
function senderReadOpIndex(c: FakeClient): number {
  const idx = c._observed.selects.findIndex(
    (s) => s.table === "profiles" && s.sel === SENDER_PREF_SELECT,
  );
  assert.ok(
    idx >= 0,
    `no profiles read selecting "${SENDER_PREF_SELECT}" was observed — the call site moved or changed its select`,
  );
  assert.equal(
    c._observed.inserts.filter((w) => w.table === "profiles").length +
      c._observed.updates.filter((w) => w.table === "profiles").length +
      c._observed.upserts.filter((w) => w.table === "profiles").length +
      c._observed.deletes.filter((w) => w.table === "profiles").length,
    0,
    "this counter assumes profiles is read-only on these paths; a write would desynchronise it",
  );
  return c._observed.selects.filter((s, i) => s.table === "profiles" && i < idx).length;
}

// ── The service: three fallback worlds, three different words ────────────────

describe("T344 — the pipeline distinguishes 'stated', 'stated nothing' and 'could not be read'", () => {
  it("the provider naming a language is still 'provider'", async () => {
    _setTestTranslationProvider(DETECTOR_SAYS_IT as any);
    const c = use(store());
    await translateMessageForThread(c as any, {
      messageId: MSG,
      body: "ci vediamo al molo alle otto.",
      senderId: A,
      threadId: DM,
      senderPreferredLanguage: "es",
      senderPreferenceUnreadable: false,
    } as any);
    const row = c._store.messages[0];
    assert.equal(row.language_detection_source, "provider");
    assert.equal(row.original_language, "it");
  });

  it("a sender who DID state a preference is 'sender_preference'", async () => {
    const c = use(store());
    await translateMessageForThread(c as any, {
      messageId: MSG,
      body: "nos vemos en el muelle a las ocho.",
      senderId: A,
      threadId: DM,
      senderPreferredLanguage: "es",
      senderPreferenceUnreadable: false,
    } as any);
    const row = c._store.messages[0];
    assert.equal(row.language_detection_source, "sender_preference");
    assert.equal(row.original_language, "es");
  });

  it("a sender who stated NOTHING is 'default' — the arm the callers made unreachable", async () => {
    const c = use(store());
    await translateMessageForThread(c as any, {
      messageId: MSG,
      body: "see you at the pier at eight.",
      senderId: A,
      threadId: DM,
      senderPreferredLanguage: null,
      senderPreferenceUnreadable: false,
    } as any);
    const row = c._store.messages[0];
    assert.equal(
      row.language_detection_source,
      "default",
      "'default' is the honest word for a successful read that found no preference",
    );
    assert.equal(row.original_language, "en", "the message still gets a language");
    assert.equal(
      (c._store.message_translations ?? []).length,
      1,
      "and it is still translated for the recipient — only the CLAIM changed",
    );
  });

  it("a profiles read that FAILED is 'sender_preference_unreadable', never 'default'", async () => {
    const c = use(store());
    await translateMessageForThread(c as any, {
      messageId: MSG,
      body: "see you at the pier at eight.",
      senderId: A,
      threadId: DM,
      senderPreferredLanguage: null,
      senderPreferenceUnreadable: true,
    } as any);
    const row = c._store.messages[0];
    assert.equal(
      row.language_detection_source,
      "sender_preference_unreadable",
      "an unreadable preference is not an absent preference — the house rule, applied here",
    );
    assert.equal(row.original_language, "en", "a placeholder language, still recorded");
    assert.equal(
      (c._store.message_translations ?? []).length,
      1,
      "the message is still translated; the row no longer lies about why",
    );
  });

  it("the three fallback worlds are three DIFFERENT stored words", async () => {
    const words: string[] = [];
    for (const input of [
      { senderPreferredLanguage: "es", senderPreferenceUnreadable: false },
      { senderPreferredLanguage: null, senderPreferenceUnreadable: false },
      { senderPreferredLanguage: null, senderPreferenceUnreadable: true },
    ]) {
      const c = use(store());
      await translateMessageForThread(c as any, {
        messageId: MSG,
        body: "see you at the pier at eight.",
        senderId: A,
        threadId: DM,
        ...input,
      } as any);
      words.push(c._store.messages[0].language_detection_source);
    }
    assert.equal(
      new Set(words).size,
      3,
      `three distinguishable worlds must not collapse onto one word: ${words.join(", ")}`,
    );
  });
});

// ── The interpreter the five call sites share ────────────────────────────────

describe("T344 — senderLanguageFrom() is what stops a failed read becoming a fact", () => {
  it("a bound error yields no language AND says the read failed", async () => {
    const mod: any = await import("../services/messageTranslation.js");
    assert.equal(
      typeof mod.senderLanguageFrom,
      "function",
      "the five call sites need one shared interpreter, not five copies of a coalesce",
    );
    assert.deepEqual(mod.senderLanguageFrom(null, PROFILES_DOWN), {
      preferredLanguage: null,
      unreadable: true,
    });
  });

  it("a successful read with no preference yields no language and does NOT claim failure", async () => {
    const mod: any = await import("../services/messageTranslation.js");
    assert.deepEqual(mod.senderLanguageFrom(null, null), { preferredLanguage: null, unreadable: false });
    assert.deepEqual(mod.senderLanguageFrom({ preferred_language: null, preferred_message_language: null }, null), {
      preferredLanguage: null,
      unreadable: false,
    });
  });

  it("a stated preference is carried through, explicit column first, legacy second", async () => {
    const mod: any = await import("../services/messageTranslation.js");
    assert.deepEqual(mod.senderLanguageFrom({ preferred_language: "es", preferred_message_language: "en" }, null), {
      preferredLanguage: "es",
      unreadable: false,
    });
    assert.deepEqual(mod.senderLanguageFrom({ preferred_message_language: "fr" }, null), {
      preferredLanguage: "fr",
      unreadable: false,
    });
  });
});

// ── The routes: the laundering lived here ────────────────────────────────────

describe("T344 — PATCH /threads/:t/messages/:m stores what actually happened", () => {
  async function edit(c: FakeClient) {
    const r = await call(messagingHarness.base, "PATCH", `/threads/${DM}/messages/${MSG}`, A, {
      body: "see you at the pier at eight instead.",
    });
    assert.equal(r.status, 200, `the edit itself must succeed: ${JSON.stringify(r.body)}`);
    return c;
  }

  it("a sender who stated a preference: 'sender_preference'", async () => {
    const s = store();
    (s.profiles.find((p: any) => p.id === A) as any).preferred_language = "es";
    const c = use(s);
    await edit(c);
    const row = await stampedRow(c, MSG);
    assert.equal(row.language_detection_source, "sender_preference");
    assert.equal(row.original_language, "es");
  });

  it("a sender who stated NOTHING: 'default', not a fabricated English preference", async () => {
    const c = use(store());
    await edit(c);
    const row = await stampedRow(c, MSG);
    assert.equal(
      row.language_detection_source,
      "default",
      "the route coalesced absence to 'en' and the pipeline then called it a stated preference",
    );
    assert.equal(row.original_language, "en");
  });

  it("an unreadable profiles: 'sender_preference_unreadable', and the message still lands", async () => {
    const probe = use(store());
    await edit(probe);
    await stampedRow(probe, MSG);
    const afterOps = senderReadOpIndex(probe);

    const c = use(store(), { errors: { profiles: { ...PROFILES_DOWN, afterOps } } });
    await edit(c);
    const row = await stampedRow(c, MSG);
    assert.equal(
      row.language_detection_source,
      "sender_preference_unreadable",
      "a profiles outage must not mint a durable claim that the sender chose English",
    );
    assert.equal(row.original_language, "en", "the message still carries a language");
    assert.ok(
      (c._store.message_translations ?? []).length >= 1,
      "and the translation pipeline still ran for the recipient",
    );
  });
});

describe("T344 — the other four call sites do not launder either", () => {
  it("POST /threads/:t/messages (the send path)", async () => {
    const probe = use(store({ messages: [] }));
    const sent = await call(messagingHarness.base, "POST", `/threads/${DM}/messages`, A, {
      body: "see you at the pier at eight.",
    });
    assert.equal(sent.status, 201, `send must succeed: ${JSON.stringify(sent.body)}`);
    await stampedRow(probe, sent.body.id);
    const afterOps = senderReadOpIndex(probe);

    const c = use(store({ messages: [] }), { errors: { profiles: { ...PROFILES_DOWN, afterOps } } });
    const r = await call(messagingHarness.base, "POST", `/threads/${DM}/messages`, A, {
      body: "see you at the pier at eight.",
    });
    assert.equal(r.status, 201, `send must still succeed: ${JSON.stringify(r.body)}`);
    const row = await stampedRow(c, r.body.id);
    assert.equal(row.language_detection_source, "sender_preference_unreadable");
  });

  it("POST /messages/:m/translate/retry (the retry path)", async () => {
    const seed = () =>
      store({
        message_translations: [
          {
            id: "22222222-0000-4000-8000-000000000001",
            message_id: MSG, recipient_id: B, source_language: "en", target_language: "es",
            translated_body: null, provider: null, status: "failed", error_message: "x",
          },
        ],
      });

    const probe = use(seed());
    const p = await call(messagingHarness.base, "POST", `/messages/${MSG}/translate/retry`, B);
    assert.equal(p.status, 202, `retry must be queued: ${JSON.stringify(p.body)}`);
    await stampedRow(probe, MSG);
    const afterOps = senderReadOpIndex(probe);

    const c = use(seed(), { errors: { profiles: { ...PROFILES_DOWN, afterOps } } });
    const r = await call(messagingHarness.base, "POST", `/messages/${MSG}/translate/retry`, B);
    assert.equal(r.status, 202, `retry must still be queued: ${JSON.stringify(r.body)}`);
    const row = await stampedRow(c, MSG);
    assert.equal(row.language_detection_source, "sender_preference_unreadable");
  });

  it("PATCH /messages/:m (the group-chat edit path)", async () => {
    const probe = use(store());
    const p = await call(groupChatHarness.base, "PATCH", `/messages/${MSG}`, A, {
      body: "see you at the pier at eight instead.",
    });
    assert.equal(p.status, 200, `the group-chat edit must succeed: ${JSON.stringify(p.body)}`);
    await stampedRow(probe, MSG);
    const afterOps = senderReadOpIndex(probe);

    const c = use(store(), { errors: { profiles: { ...PROFILES_DOWN, afterOps } } });
    const r = await call(groupChatHarness.base, "PATCH", `/messages/${MSG}`, A, {
      body: "see you at the pier at eight instead.",
    });
    assert.equal(r.status, 200, `the group-chat edit must still succeed: ${JSON.stringify(r.body)}`);
    const row = await stampedRow(c, MSG);
    assert.equal(row.language_detection_source, "sender_preference_unreadable");
  });
});

// ── All five sites, including the one no route test above reaches ────────────

describe("T344 — no call site launders the sender-preference read", () => {
  const FILES = ["src/routes/messaging.ts", "src/routes/groupChat.ts"] as const;

  function read(rel: string): string {
    return readFileSync(resolve(process.cwd(), rel), "utf8");
  }

  it("every sender-preference read binds its error", () => {
    for (const f of FILES) {
      const src = read(f);
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!line.includes(SENDER_PREF_SELECT)) return;
        // Walk back to the destructuring line that opened this read.
        let j = i;
        while (j > 0 && !lines[j].includes("const {")) j--;
        assert.match(
          lines[j],
          /error:/,
          `${f}:${j + 1} reads the sender's language preference without binding the error — ` +
            "supabase-js resolves on a database failure, so the absence becomes a fact",
        );
      });
    }
  });

  it("no call site coalesces the sender's preference to a hardcoded language", () => {
    for (const f of FILES) {
      read(f)
        .split("\n")
        .forEach((line, i) => {
          assert.ok(
            !/senderProfile[\s\S]*\?\?\s*'en'/.test(line),
            `${f}:${i + 1} coalesces an unread preference into a stated one: ${line.trim()}`,
          );
        });
    }
  });

  it("all five sites hand the pipeline both halves of the answer", () => {
    let calls = 0;
    let flags = 0;
    for (const f of FILES) {
      const src = read(f);
      // The import names the function without a paren, so only invocations match.
      calls += (src.match(/translateMessageForThread\(/g) ?? []).length;
      flags += (src.match(/senderPreferenceUnreadable:/g) ?? []).length;
    }
    assert.equal(calls, 5, "the census named five call sites; that count is the contract");
    assert.equal(
      flags,
      5,
      "every call site must say whether the read succeeded — a missing flag silently means 'it did'",
    );
  });
});

// ── §15.2's second named consequence, in the same class ──────────────────────

/**
 * "An unreadable `profiles` becomes a confident 404." Same file, same dropped
 * error, different lie: `GET /circles/:id/chat` answered "Circle owner not
 * found" from a read that never happened. A 404 tells the caller the circle is
 * gone and they stop asking; an outage is not a deletion. Kept in this suite
 * because it is the same defect class and the same fixture, not because it is
 * about language.
 */
describe("T344 — an unreadable circle owner is a REFUSAL, not 'Circle owner not found'", () => {
  const NO_SUCH_OWNER = "cccccccc-0000-4000-8000-00000000000c";

  it("a circle owner who genuinely does not exist is still a 404", async () => {
    use(store());
    const r = await call(messagingHarness.base, "GET", `/circles/${NO_SUCH_OWNER}/chat`, NO_SUCH_OWNER);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body?.error, "not_found");
  });

  it("but an unreadable profiles refuses retryably instead of reporting the owner gone", async () => {
    // Op 1 on `profiles` is the auth gate's ban read, which refuses outright if
    // it fails; the owner read is op 2, which is the one under test.
    use(store(), { errors: { profiles: { ...PROFILES_DOWN, afterOps: 1 } } });
    const r = await call(messagingHarness.base, "GET", `/circles/${A}/chat`, A);
    assert.notEqual(r.status, 404, `a failed read must not be reported as an absent circle: ${JSON.stringify(r.body)}`);
    assert.notEqual(
      r.body?.error,
      "not_found",
      "the caller acts on 'not_found' by giving up; they must be told to retry instead",
    );
    assert.equal(r.body?.error, "degraded_unavailable", JSON.stringify(r.body));
  });
});
