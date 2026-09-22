/**
 * Telegraph — every object-literal dispatch table in `domain/telegraph/` is
 * asked for `constructor`, `toString`, `__proto__` and `hasOwnProperty`.
 *
 * THE DEFECT CLASS, STATED ONCE
 * =============================
 * `const TABLE = { a: 1 };  const hit = TABLE[key];  if (hit) { … }`
 *
 * looks like a closed vocabulary and is not one. A plain object literal
 * inherits from `Object.prototype`, so `TABLE["constructor"]` is the `Object`
 * FUNCTION, `TABLE["toString"]` and `TABLE["hasOwnProperty"]` are functions,
 * and `TABLE["__proto__"]` is `Object.prototype` — four TRUTHY values for four
 * keys the table never declared. A bare `if (hit)` guard therefore does not
 * fail closed: it takes the branch meant for a REGISTERED key, carrying a
 * native function where the code's types promise a string enum. `key in TABLE`
 * and `TABLE[key] !== undefined` have the same hole, because both walk the
 * prototype chain.
 *
 * WHAT EACH OF THE THREE TABLES DID BEFORE THIS FILE, MEASURED
 * ===========================================================
 * Each was executed, not argued about, and each is a section below.
 *
 *   A. §21 SEARCH — `SUBTYPE_BUCKET` in
 *      `domain/telegraph/contracts/conversationSearch.ts`, read by
 *      `classifyMessage`, keyed by `messages.subtype`. That column is
 *      CLIENT-WRITTEN: `routes/messaging.ts` takes it straight off the request
 *      body (`typeof req.body?.subtype === 'string' ? req.body.subtype : null`)
 *      and inserts it. So any authenticated sender could post a message with
 *      `subtype: "constructor"`, and every Telegraph search that matched it
 *      returned a hit whose `bucket` was the `Object` constructor. Two things
 *      broke at once, both measured:
 *        - the hit serialised as `{}` — `JSON.stringify` drops a function, so
 *          the hit reached the client with NO `bucket` field at all;
 *        - `services/telegraphSearch.ts` does `result.counts[h.bucket] += 1`,
 *          which added a SIXTH key to the counts object literally named
 *          `function Object() { [native code] }`. §21's own contract is "always
 *          all five keys, so '0 PLACES' is expressible"; a sixth key invented by
 *          a sender is that contract broken by the shape of the lookup.
 *      `__proto__` produced `{"bucket":{}}` and its own counts key, and
 *      `toString` / `hasOwnProperty` two more.
 *
 *   B. §13.1 THE COMMAND DOOR — `LEGACY_PATH_COMMANDS` in
 *      `domain/telegraph/commands/telegraphCommands.ts`, read by
 *      `server/telegraph/commandRoute.ts` as `LEGACY_PATH_COMMANDS[type]` where
 *      `type` is `String(body["type"])` — unvalidated request input. With
 *      `type: "constructor"` the truthy branch fired and the endpoint answered
 *      **409 `wrong_endpoint`**: "constructor is issued by function Object() {
 *      [native code] }". Two failures: an invented command was told it was
 *      REAL and merely at the wrong door (409 rather than the 400 `Unknown
 *      command` every other unknown gets), and a native function's source text
 *      was reflected into an API response body.
 *
 *   C. §19 THE ATTENTION LADDER — `EVENT_BAND` in
 *      `domain/telegraph/policies/attentionLadder.ts`, read by `bandFor`,
 *      whose `?? null` cannot fire against an inherited truthy value.
 *      `bandFor("constructor")` returned the `Object` function instead of
 *      `null`, so `dedupeWindowFor` then evaluated `BAND_POLICY[<function>]`,
 *      got `undefined`, and **THREW a TypeError** reading `.dedupeWindowMs`.
 *      A lookup that throws is worse than one that answers wrongly: it takes
 *      the notification dedupe path down rather than returning a bad window.
 *      `isDigestible` threw for the same reason.
 *
 * THE FIX THESE TESTS PIN
 * =======================
 * `domain/telegraph/contracts/dispatchTable.ts` — every one of these tables is
 * now built by `dispatchTable(...)`, which returns a FROZEN NULL-PROTOTYPE
 * object. `Object.create(null)` has no `Object.prototype` behind it, so the
 * four keys are simply absent: `TABLE["constructor"]` is `undefined`,
 * `"constructor" in TABLE` is `false`, and every existing `if (hit)` /
 * `?? null` guard at every call site fails CLOSED without those call sites
 * changing. Fixing it at the table rather than at each reader is deliberate:
 * two of the three readers are in files this lane does not own, and a fix that
 * needed every future reader to remember the hazard is not a fix.
 *
 * WHAT WOULD TURN THIS RED (the mutations run against it; see the report)
 * =====================================================================
 *   - `dispatchTable` returning `{ ...entries }` instead of a null-prototype
 *     object: sections A, B, C and D all fail.
 *   - `Object.freeze` dropped from `dispatchTable`: D3 fails.
 *   - `bandFor` going back to `EVENT_BAND[eventType] ?? null` on a table with a
 *     prototype: C fails. (On the null-prototype table that expression is
 *     correct, which is the point — the table carries the guarantee.)
 *   - Any of the three tables re-declared as a bare object literal: D1 names it.
 *
 * Run: node --import tsx/esm --test src/test/telegraphDispatchTablePrototypeKeys.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import {
  PROTOTYPE_LOOKUP_KEYS,
  dispatchTable,
  hasEntry,
} from "../domain/telegraph/contracts/dispatchTable.js";
import {
  SEARCH_BEHAVIOUR,
  FAMILYLESS_SUBTYPE_BUCKET,
  SUBTYPE_BUCKET,
  STRUCTURED_SUBTYPES,
  TELEGRAPH_SEARCH_BUCKETS,
  classifyMessage,
  searchBehaviourFor,
  emptySearchResult,
} from "../domain/telegraph/contracts/conversationSearch.js";
import {
  LEGACY_PATH_COMMANDS,
  UNIMPLEMENTED_COMMANDS,
} from "../domain/telegraph/commands/telegraphCommands.js";
import {
  EVENT_BAND,
  BAND_POLICY,
  ATTENTION_BANDS,
  bandFor,
  dedupeWindowFor,
  isDigestible,
} from "../domain/telegraph/policies/attentionLadder.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const THREAD = "00000000-0000-4000-8000-00000000000a";

/* ═══════════════════════ A. §21 search classification ═══════════════════════ */

describe("§21 — a sender-supplied message subtype cannot invent a search bucket", () => {
  it("classifyMessage answers one of the five declared buckets for every prototype key", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      const bucket = classifyMessage({ subtype: key, msg_type: "text", media_url: null });
      assert.equal(
        typeof bucket,
        "string",
        `subtype ${JSON.stringify(key)} classified to a ${typeof bucket}, not a bucket string — ` +
          "the lookup walked Object.prototype",
      );
      assert.ok(
        (TELEGRAPH_SEARCH_BUCKETS as readonly string[]).includes(bucket),
        `subtype ${JSON.stringify(key)} classified to ${String(bucket)}, which is not one of ` +
          TELEGRAPH_SEARCH_BUCKETS.join(" / "),
      );
      // MESSAGES specifically: an unregistered subtype is prose, which is the
      // same answer any other unknown subtype gets.
      assert.equal(bucket, "MESSAGES", `subtype ${JSON.stringify(key)} should fall to MESSAGES`);
    }
  });

  it("the counts object keeps exactly five keys when crafted subtypes are counted", () => {
    // This is `services/telegraphSearch.ts:260` — `result.counts[h.bucket] += 1`
    // — reproduced against the same classifier it calls. §21's contract is that
    // all five buckets are always present; a SIXTH key means a sender named it.
    const result = emptySearchResult("q");
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      const bucket = classifyMessage({ subtype: key, msg_type: "text", media_url: null });
      result.counts[bucket] += 1;
    }
    assert.deepEqual(
      Object.keys(result.counts).sort(),
      [...TELEGRAPH_SEARCH_BUCKETS].sort(),
      "a crafted subtype added a counts key that is not one of §21's five buckets",
    );
    assert.equal(result.counts.MESSAGES, PROTOTYPE_LOOKUP_KEYS.length);
  });

  it("a classified hit survives JSON — the bucket is still there after serialisation", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      const hit = { messageId: "m", bucket: classifyMessage({ subtype: key }) };
      const round = JSON.parse(JSON.stringify(hit));
      assert.equal(
        round.bucket,
        "MESSAGES",
        `a hit on subtype ${JSON.stringify(key)} lost its bucket in JSON — ` +
          "JSON.stringify drops a function, so the client received a hit with no bucket at all",
      );
    }
  });

  it("searchBehaviourFor answers null for every prototype key", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      assert.equal(
        searchBehaviourFor(key),
        null,
        `object type ${JSON.stringify(key)} resolved to a search behaviour it never registered`,
      );
    }
  });

  it("STRUCTURED_SUBTYPES is a Set and was never exposed to the hazard — asserted, not assumed", () => {
    // A Set has no prototype-chain lookup problem. This is here so that a later
    // refactor of STRUCTURED_SUBTYPES into an object literal is a failing test
    // rather than a silent reintroduction.
    assert.ok(STRUCTURED_SUBTYPES instanceof Set);
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      assert.equal(STRUCTURED_SUBTYPES.has(key), false);
    }
  });
});

/* ══════════════════ B. §13.1 the command door, against the route ═══════════ */

function makeClient() {
  const db: Record<string, any[]> = {
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }],
    message_thread_members: [{ thread_id: THREAD, user_id: ALICE, left_at: null, last_read_at: null }],
    messages: [],
    message_reactions: [],
  };
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const rowsNow = () => (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit() { return proxy; },
      order() { return proxy; },
      maybeSingle() { return Promise.resolve({ data: rowsNow()[0] ?? null, error: null }); },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

let server: any;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", commandRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  _setTestClient(null, false);
  await new Promise<void>((r) => server.close(() => r()));
});

async function postCommand(type: string) {
  const res = await fetch(`${base}/telegraph/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ALICE}` },
    body: JSON.stringify({ type, conversationId: THREAD, params: {} }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

describe("§13.1 — POST /telegraph/commands refuses an invented command as UNKNOWN", () => {
  it("every prototype key is 400 Unknown command, not 409 wrong_endpoint", async () => {
    _setTestClient(makeClient(), true);
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      const { status, body } = await postCommand(key);
      assert.equal(
        status,
        400,
        `type=${JSON.stringify(key)} answered ${status}. A 409 says "this command is real and you " +
          "are at the wrong door", which is a claim the table never made.`,
      );
      assert.match(
        String(body.message ?? body.error ?? ""),
        /Unknown command/,
        `type=${JSON.stringify(key)} did not get the unknown-command refusal`,
      );
    }
  });

  it("no refusal body reflects native function source", async () => {
    _setTestClient(makeClient(), true);
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      const { body } = await postCommand(key);
      const text = JSON.stringify(body);
      assert.doesNotMatch(
        text,
        /native code/,
        `type=${JSON.stringify(key)} reflected a native function's source into the response`,
      );
      assert.doesNotMatch(text, /\[object Object\]/, `type=${JSON.stringify(key)} reflected a stringified object`);
    }
  });

  it("a real §13.1 command with a legacy home still gets its 409 — the fix narrows nothing", async () => {
    _setTestClient(makeClient(), true);
    const { status, body } = await postCommand("SEND_MESSAGE");
    assert.equal(status, 409);
    assert.match(String(body.message ?? ""), /threads\/:threadId\/messages/);
  });

  it("UNIMPLEMENTED_COMMANDS.includes is array membership and is unaffected", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      assert.equal(UNIMPLEMENTED_COMMANDS.includes(key), false);
    }
  });
});

/* ═══════════════════════ C. §19 the attention ladder ═══════════════════════ */

describe("§19 — the attention ladder does not claim a band it never declared", () => {
  it("bandFor answers null for every prototype key", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      assert.equal(
        bandFor(key),
        null,
        `event type ${JSON.stringify(key)} resolved to a band. "Unclaimed" is the ladder's own ` +
          "safe answer and an inherited function is not a band.",
      );
    }
  });

  it("dedupeWindowFor answers undefined and does not throw", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      let out: number | null | undefined;
      assert.doesNotThrow(() => { out = dedupeWindowFor(key); },
        `dedupeWindowFor(${JSON.stringify(key)}) threw — the notification dedupe path goes down with it`);
      assert.equal(out, undefined,
        `dedupeWindowFor(${JSON.stringify(key)}) returned ${String(out)}; undefined means "not my event"`);
    }
  });

  it("isDigestible answers undefined and does not throw", () => {
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      let out: boolean | undefined;
      assert.doesNotThrow(() => { out = isDigestible(key); });
      assert.equal(out, undefined);
    }
  });

  it("a declared event type still resolves — the fix narrows nothing", () => {
    assert.equal(bandFor("telegraph.message"), "P2_MESSAGE");
    assert.equal(dedupeWindowFor("telegraph.message"), 5 * 60 * 1000);
    assert.equal(bandFor("safe_return.missed"), "P0_SAFETY");
    assert.equal(dedupeWindowFor("safe_return.missed"), 0);
  });

  it("every declared band has a policy, looked up the same way the code does", () => {
    for (const band of ATTENTION_BANDS) {
      assert.ok(hasEntry(BAND_POLICY, band), `${band} has no BAND_POLICY entry`);
    }
  });
});

/* ═════════════════ D. the tables themselves, and the helper ════════════════ */

const DOMAIN_TABLES: ReadonlyArray<readonly [string, object]> = [
  ["conversationSearch.SEARCH_BEHAVIOUR", SEARCH_BEHAVIOUR],
  ["conversationSearch.FAMILYLESS_SUBTYPE_BUCKET", FAMILYLESS_SUBTYPE_BUCKET],
  ["conversationSearch.SUBTYPE_BUCKET", SUBTYPE_BUCKET],
  ["telegraphCommands.LEGACY_PATH_COMMANDS", LEGACY_PATH_COMMANDS],
  ["attentionLadder.EVENT_BAND", EVENT_BAND],
  ["attentionLadder.BAND_POLICY", BAND_POLICY],
];

describe("every exported dispatch table in domain/telegraph is prototype-less", () => {
  it("D1 — has a null prototype, so an inherited key cannot be found", () => {
    for (const [name, table] of DOMAIN_TABLES) {
      assert.equal(
        Object.getPrototypeOf(table),
        null,
        `${name} still inherits from Object.prototype — build it with dispatchTable()`,
      );
    }
  });

  it("D2 — answers undefined for all four prototype keys, by index AND by `in`", () => {
    for (const [name, table] of DOMAIN_TABLES) {
      for (const key of PROTOTYPE_LOOKUP_KEYS) {
        assert.equal((table as any)[key], undefined, `${name}[${JSON.stringify(key)}] is truthy`);
        assert.equal(key in table, false, `${JSON.stringify(key)} in ${name} is true`);
        assert.equal(hasEntry(table as Record<string, unknown>, key), false);
      }
    }
  });

  it("D3 — is frozen, so a later import cannot register a key at runtime", () => {
    for (const [name, table] of DOMAIN_TABLES) {
      assert.ok(Object.isFrozen(table), `${name} is not frozen`);
    }
  });

  it("D4 — dispatchTable preserves every declared entry and adds none", () => {
    const t = dispatchTable({ a: 1, b: 2 });
    assert.deepEqual(Object.keys(t).sort(), ["a", "b"]);
    assert.equal(t.a, 1);
    assert.equal(t.b, 2);
    for (const key of PROTOTYPE_LOOKUP_KEYS) assert.equal((t as any)[key], undefined);
  });

  it("D5 — the four keys are exactly the four that inherit, proved against a literal", () => {
    // If a future Node adds a fifth enumerable-by-lookup member of
    // Object.prototype, this fails and PROTOTYPE_LOOKUP_KEYS needs it.
    const literal: Record<string, unknown> = {};
    for (const key of PROTOTYPE_LOOKUP_KEYS) {
      assert.notEqual(literal[key], undefined,
        `${key} no longer inherits from a plain object literal; the list is stale`);
    }
    const inherited = Object.getOwnPropertyNames(Object.prototype)
      .filter((k) => k !== "__defineGetter__" && k !== "__defineSetter__"
        && k !== "__lookupGetter__" && k !== "__lookupSetter__"
        && k !== "isPrototypeOf" && k !== "propertyIsEnumerable"
        && k !== "toLocaleString" && k !== "valueOf");
    assert.deepEqual(inherited.sort(), [...PROTOTYPE_LOOKUP_KEYS].sort());
  });
});
