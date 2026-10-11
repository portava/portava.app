/**
 * Telegraph — every door into `public.messages` holds the send path's gates.
 *
 * WHAT THIS SUITE IS. Three sections, all of which run with nothing installed
 * (node builtins and repo files only), because the claims they make are about
 * the RULE and about the TREE, not about a request:
 *
 *   A. `resolveClientDiscriminator` — what the text door will store when a
 *      client names a msg_type / subtype. A `system` row is drawn as platform
 *      chrome, so the only `system` subtypes a client may send are the ones the
 *      app itself authors.
 *   B. The allowlist against BOTH trees. Every entry must be a subtype some
 *      client file really sends, and every `system` subtype a client file sends
 *      must be an entry. Either direction failing means the list has drifted
 *      into a block on a real feature or a door left open for a retired one.
 *   C. The door registry against the tree. Every non-test file that inserts into
 *      `messages` is declared; a declared `shared` door really calls the shared
 *      guard; the two `inline` doors really carry each gate; the doors known to
 *      be weak are counted under a ceiling that may only fall.
 *
 * WHAT IT IS NOT. It does not send a request. The request-level behaviour — a
 * forged `system` row answered 400 with nothing written, a seventh-door send
 * answered 429, a blocked sender's CREATE_COORDINATION_SESSION refused — is in
 * `telegraphMessageDoorRoutes.test.ts`, which needs express and runs in CI.
 *
 * SHOWN RED FIRST, at `f71cfb85f` with only this file and the policy module
 * added (no route changed):
 *   C3b fails — `server/telegraph/commandRoute.ts` does not call the shared guard.
 *   C4 fails — `routes/messaging.ts` has no rate gate on the media door and no
 *              discriminator gate on the text door.
 *   C5 fails — `lib/telegraphThreadWrite.ts` has no rate step.
 *   A and B pass at that commit by construction: they test the new module.
 * Mutations after the fix, each restored:
 *   • `CLIENT_SYSTEM_SUBTYPES` gains "call_missed"            → B2 red.
 *   • `CLIENT_SYSTEM_SUBTYPES` loses "meetup"                 → B1 red.
 *   • `system` + empty subtype returns ok                      → A2 red.
 *   • the media door's `refuseSendOverRate` call removed       → C4 red.
 *   • the text door storing the request's subtype again        → C4 red.
 *   • commandRoute's guard line removed                        → C3b red.
 *   • the shared guard's rate step removed                     → C5 red.
 *   • a throwing tier read returning "no refusal"              → C5 red.
 *   • a `missing` list deleted without lowering the ceiling    → C3, C6 red.
 *   • a writer removed from the registry                       → C1 red.
 * The command-route and rate-step mutations SURVIVED the first version of this
 * file: both assertions matched a helper's DEFINITION, which is still there
 * when its call is deleted. C3b and C5 were rewritten to assert the call site.
 *
 * Run: node --import tsx/esm --test src/test/telegraphMessageDoors.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLIENT_SYSTEM_SUBTYPES,
  DOOR_GATES,
  KNOWN_WEAK_DOOR_CEILING,
  MESSAGE_WRITERS,
  SEND_BUCKETS,
  knownWeakDoors,
  resolveClientDiscriminator,
  sendBucketForKind,
  sendLimiterId,
} from "../domain/telegraph/policies/messageDoorPolicy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REPO = resolve(SRC, "../../..");
const CLIENT = resolve(REPO, "travel-buddy-standalone");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/* ══════════════════════════════════════════════════════════════════════════
 * A. The discriminator rule.
 * ════════════════════════════════════════════════════════════════════════ */

describe("A. the text door's msg_type / subtype rule", () => {
  it("A1. an ordinary message is `text` with no subtype — including when msgType is absent or unknown", () => {
    for (const raw of [undefined, null, "text", "media", "announcement", 7, {}]) {
      const r = resolveClientDiscriminator(raw, undefined);
      assert.deepEqual(r, { ok: true, msgType: "text", subtype: null }, `msgType ${JSON.stringify(raw)}`);
    }
  });

  it("A2. THE POINT: a `system` message with no subtype is refused — it would render as a platform notice", () => {
    for (const sub of [undefined, null, "", "   ", 3, {}]) {
      const r = resolveClientDiscriminator("system", sub);
      assert.equal(r.ok, false, `subtype ${JSON.stringify(sub)} was admitted`);
      assert.equal((r as any).reason, "system_subtype_required");
    }
  });

  it("A3. THE POINT: the server's own system subtypes cannot be sent by a client", () => {
    // Each of these selects a renderer that speaks in the platform's voice, or
    // announces something only server code performs.
    const serverOnly = [
      "call_missed", "call_declined", "call_ended",
      "rent_buddy_booking_confirmed", "rent_buddy_payment_released",
      "meetup_confirmed", "event_context_card", "safety", "announcement",
      "hidden_gem", "layover_suggestion", "highlight_reply",
    ];
    for (const sub of serverOnly) {
      const r = resolveClientDiscriminator("system", sub);
      assert.equal(r.ok, false, `"${sub}" was admitted through the text door`);
      assert.equal((r as any).reason, "system_subtype_not_client_sendable");
    }
  });

  it("A4. every subtype the app authors is admitted, exactly as named", () => {
    for (const sub of CLIENT_SYSTEM_SUBTYPES) {
      assert.deepEqual(resolveClientDiscriminator("system", sub), { ok: true, msgType: "system", subtype: sub });
    }
    // Whitespace is trimmed, never matched loosely.
    assert.deepEqual(resolveClientDiscriminator("system", " meetup "), { ok: true, msgType: "system", subtype: "meetup" });
  });

  it("A5. matching is exact: a prefix, a suffix or a case variant of an allowed subtype is not that subtype", () => {
    for (const sub of ["meetup_confirmed", "meetup ", "Meetup", "MEETUP", "post_card2", "x_discovery_card", "meetup\u0000"]) {
      if (sub.trim() === "meetup") continue; // covered by A4's trim case
      const r = resolveClientDiscriminator("system", sub);
      assert.equal(r.ok, false, `"${sub}" matched an allowed subtype`);
    }
  });

  it("A6. an ordinary message cannot carry a subtype — not even an allowed one", () => {
    // `text` + `call_missed` is not drawn as a call line today. It is refused
    // anyway, because "no renderer dispatches on it today" is a fact about one
    // screen on one day, and the stored row outlives both.
    for (const sub of ["call_missed", "meetup", "anything"]) {
      const r = resolveClientDiscriminator("text", sub);
      assert.equal(r.ok, false);
      assert.equal((r as any).reason, "text_carries_no_subtype");
    }
    assert.deepEqual(resolveClientDiscriminator("text", ""), { ok: true, msgType: "text", subtype: null });
  });

  it("A7. a refusal never echoes the supplied value", () => {
    const marker = "zz-attacker-chosen-zz";
    for (const r of [resolveClientDiscriminator("system", marker), resolveClientDiscriminator("text", marker)]) {
      assert.equal(r.ok, false);
      assert.ok(!(r as any).message.includes(marker), "the refusal reflected attacker-chosen text");
    }
  });

  it("A8. the safety bucket is separate, and only SAFETY uses it", () => {
    assert.equal(sendBucketForKind("SAFETY"), "safety");
    for (const k of ["GIF", "LOCATION", "ANNOUNCEMENT", "ACTION", "MEDIA_ALBUM", "MEMORY_NOTE", "safety", undefined, null, 1]) {
      assert.equal(sendBucketForKind(k), "ordinary", `kind ${JSON.stringify(k)}`);
    }
    // The ordinary id is the text door's existing bucket — joining doors share
    // it rather than opening a second allowance beside it.
    assert.equal(sendLimiterId("ordinary", "stranger"), "telegraph_send:stranger");
    assert.notEqual(sendLimiterId("safety", "stranger"), sendLimiterId("ordinary", "stranger"));
    assert.deepEqual([...SEND_BUCKETS].sort(), ["ordinary", "safety"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * B. The allowlist against the client tree.
 * ════════════════════════════════════════════════════════════════════════ */

/**
 * Every `system` subtype the app sends through `sendMessage` / the send hooks.
 *
 * Two shapes exist in the client and both are read:
 *   `msgType: 'system', subtype: 'x'`  (in either order, across a line break)
 *   `subtype: E2EE_WELCOME_SUBTYPE`    (a constant, resolved from its definition)
 */
function clientSystemSubtypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const note = (sub: string, file: string) => {
    const rel = relative(REPO, file);
    const list = found.get(sub) ?? [];
    if (!list.includes(rel)) list.push(rel);
    found.set(sub, list);
  };
  const files = [...walk(join(CLIENT, "src")), ...walk(join(CLIENT, "app"))];
  let welcome: string | null = null;
  for (const f of files) {
    const m = readFileSync(f, "utf8").match(/E2EE_WELCOME_SUBTYPE\s*=\s*['"]([a-z0-9_]+)['"]/);
    if (m) welcome = m[1]!;
  }
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/msgType:\s*['"]system['"]\s*,\s*subtype:\s*(['"]([a-z0-9_]+)['"]|E2EE_WELCOME_SUBTYPE)/g)) {
      const sub = m[2] ?? welcome;
      if (sub) note(sub, f);
    }
  }
  return found;
}

describe("B. CLIENT_SYSTEM_SUBTYPES is exactly what the app sends", () => {
  const sent = clientSystemSubtypes();

  it("B0. the scan found the client's senders (a scan that finds nothing proves nothing)", () => {
    assert.ok(sent.size >= 4, `only ${sent.size} system subtype(s) found in the client tree — the scan is broken`);
  });

  it("B1. every system subtype a client file sends is allowed — the rule does not break a shipped feature", () => {
    for (const [sub, files] of sent) {
      assert.ok(
        (CLIENT_SYSTEM_SUBTYPES as readonly string[]).includes(sub),
        `"${sub}" is sent by ${files.join(", ")} and the text door would now refuse it`,
      );
    }
  });

  it("B2. every allowed subtype is one a client file really sends — no door left open for nobody", () => {
    for (const sub of CLIENT_SYSTEM_SUBTYPES) {
      assert.ok(sent.has(sub), `"${sub}" is allowed through the text door and no client file sends it`);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * C. The door registry against the server tree.
 * ════════════════════════════════════════════════════════════════════════ */

/** An insert into `messages`: `.from("messages")` followed closely by `.insert(`. */
const INSERTS_MESSAGES = /\.from\(\s*['"]messages['"]\s*\)\s*(?:\/\/[^\n]*\n\s*)*\.insert\(/;

function messageWriterFiles(): string[] {
  const roots = ["routes", "server", "services", "lib", "compass"].map((d) => join(SRC, d));
  const out: string[] = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      if (INSERTS_MESSAGES.test(readFileSync(f, "utf8"))) out.push(relative(SRC, f).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

describe("C. every writer into `messages` is declared, and a user door holds its gates", () => {
  const writers = messageWriterFiles();
  const declared = new Map(MESSAGE_WRITERS.map((d) => [d.file, d]));

  it("C0. the scan found the doors (a scan that finds nothing proves nothing)", () => {
    assert.ok(writers.length >= 15, `only ${writers.length} writer file(s) found — the scan is broken`);
    assert.ok(writers.includes("routes/messaging.ts"));
  });

  it("C1. no undeclared writer: a new door into `messages` must be classified here first", () => {
    const undeclared = writers.filter((f) => !declared.has(f));
    assert.deepEqual(
      undeclared,
      [],
      "declare each in MESSAGE_WRITERS (domain/telegraph/policies/messageDoorPolicy.ts). A user door either " +
        "calls guardTelegraphThreadWrite or lists the gates it is missing.",
    );
  });

  it("C2. no stale declaration: a file that no longer writes is removed, not left as a claim", () => {
    const stale = [...declared.keys()].filter((f) => !writers.includes(f));
    assert.deepEqual(stale, []);
    assert.equal(new Set(MESSAGE_WRITERS.map((d) => d.file)).size, MESSAGE_WRITERS.length, "a file is declared twice");
  });

  it("C3. THE POINT: a door declared `shared` really calls the shared guard", () => {
    for (const d of MESSAGE_WRITERS.filter((x) => x.writer === "user_door" && x.guard === "shared")) {
      // The session writer does not authorize and says so; its CALLERS do, and
      // the command route is checked separately below because it reaches the
      // guard through a helper — matching the helper's DEFINITION would pass
      // with the call deleted, which is exactly how this case first survived a
      // mutation.
      const files =
        d.file === "services/telegraph/coordinationSessions.ts" ? ["routes/telegraphCoordination.ts"]
        : d.file === "services/telegraph/threadEnvelopeWrites.ts" ? ["routes/telegraphKinds.ts", "routes/telegraphCoordination.ts"]
        : [d.file];
      // The two doors closed in the OD-TRUST-5 wave name their clients differently; each is held
      // to its OWN call text, and their behaviour is driven in telegraphRestrictionSendGate.test.ts.
      const CALL_TEXT: Record<string, RegExp> = {
        "routes/highlights.ts": /const guard = await guardTelegraphThreadWrite\(sc, threadId, user\.id(, \{ groupSend: \{ text: message \} \})?\); if \(!guard\.ok\) \{/, // the options argument hands the §30A.12 link gate the reply text (lane T-GRP)
        "lib/threadMessage.ts": /const guard = await guardTelegraphThreadWrite\(sc, threadId, senderId(, \{ groupSend: \{ text: body \} \})?\);\n  if \(!guard\.ok\) \{/,
        // §14.3 carry-forward (lane T-GRP): the guard runs on the NEW group before each carried message.
        "services/telegraph/groupFormation.ts": /const guard = await guardTelegraphThreadWrite\(sc, threadId, req\.actorId\);\n    if \(!guard\.ok\) \{/,
      };
      for (const f of files) {
        assert.match(
          read(f),
          CALL_TEXT[f] ?? /const guard = await guardTelegraphThreadWrite\(client, threadId, user\.id[,)]/,
          `${f} writes into messages for a person and does not pass through the shared guard`,
        );
      }
    }
  });

  it("C3b. THE POINT: the command door runs the guard BEFORE any command that writes", () => {
    const src = read("server/telegraph/commandRoute.ts");
    const call = src.indexOf(
      "if (GUARDED_WRITE_COMMANDS.has(type) && (await refuseGuardedWrite(res, sc, type, conversationId, user.id, textOfPayload(body)))) return;", // the last argument is the command's text for the §30A.12 link gate (lane T-GRP)
    );
    assert.ok(call > 0, "server/telegraph/commandRoute.ts dispatches a writing command without the shared guard");
    // Before both places a command is carried out — the session branch and the switch.
    const session = src.indexOf('if (type === "CREATE_COORDINATION_SESSION") {');
    const dispatch = src.indexOf("switch (type) {");
    assert.ok(session > call && dispatch > call, "the guard runs after a command has already been dispatched");
    // After the route's own membership refusal, so a non-member is told only that.
    assert.ok(src.indexOf('reason: "TELEGRAPH_AUTH_NOT_MEMBER" });') < call);
    // Both writing commands are guarded; the two retractions deliberately are not.
    const set = src.match(/const GUARDED_WRITE_COMMANDS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/);
    assert.ok(set, "GUARDED_WRITE_COMMANDS is not declared as a literal set");
    const guarded = [...set![1]!.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(guarded, [
      "ADD_REACTION", "CREATE_COORDINATION_SESSION", "CREATE_DECISION", "SET_COORDINATION_STATUS", "SHARE_LOCATION",
    ]);
    // And the helper it calls really is the shared guard, not a second copy of it.
    const helper = src.slice(src.indexOf("async function refuseGuardedWrite("));
    // The options argument (§30A.12 lane T-GRP) only classifies a reaction as a RESPONSE for group controls.
    assert.match(helper, /const guard = await guardTelegraphThreadWrite\(sc, conversationId, userId(, \{ groupSend: \{ contribution: type === "ADD_REACTION" \? "response" : "post", text \} \})?\);/);
  });

  it("C4. THE POINT: the two inline doors carry every gate — including the two this change added", () => {
    const src = read("routes/messaging.ts");
    const text = src.slice(src.indexOf("router.post('/threads/:threadId/messages'"), src.indexOf("router.post('/threads/:threadId/media'"));
    const media = src.slice(src.indexOf("router.post('/threads/:threadId/media'"), src.indexOf("router.post('/messages/:messageId/translate/retry'"));
    assert.ok(text.length > 1000 && media.length > 1000, "the two handlers were not located");

    const gates: Array<[string, RegExp, RegExp]> = [
      ["stop", /isKillSwitchEngaged\(flagSc!?, 'disable_messaging'\)/, /isKillSwitchEngaged\(flagSc!?, 'disable_messaging'\)/],
      ["membership", /\.is\('left_at', null\)/, /\.is\('left_at', null\)/],
      ["block", /isBlockedBetween\(blockSc, user\.id, others\[0\]\)/, /isBlockedBetween\(blockSc, user\.id, others\[0\]\)/],
      ["e2ee", /is_e2ee/, /is_e2ee/],
      ["restriction", /await refuseRestrictedSend\(req, res, getServiceClient\(\) \?\? client, threadId, user\.id\)\) return;/, /await refuseRestrictedSend\(req, res, getServiceClient\(\) \?\? client, threadId, user\.id\)\) return;/],
      ["rate", /checkSendRateLimit\(limiterSc, user\.id\)/, /await refuseSendOverRate\(/],
    ];
    assert.deepEqual(gates.map((g) => g[0]).sort(), [...DOOR_GATES].sort(), "a gate is not asserted here");
    for (const [name, onText, onMedia] of gates) {
      assert.match(text, onText, `the text door has no ${name} gate`);
      assert.match(media, onMedia, `the media door has no ${name} gate`);
    }
    // The discriminator: the text door no longer stores a client-chosen subtype.
    assert.match(text, /resolveClientDiscriminator\(req\.body\?\.msgType, req\.body\?\.subtype\)/);
    assert.doesNotMatch(
      text,
      /typeof req\.body\?\.subtype === 'string' \? req\.body\.subtype : null/,
      "the text door is back to storing whatever subtype the request names",
    );
  });

  it("C5. the shared guard has all five gates, the rate gate last, and it fails toward the strictest tier", () => {
    const src = read("lib/telegraphThreadWrite.ts");
    const start = src.indexOf("export async function guardTelegraphThreadWrite(");
    // The guard's OWN body. Slicing to the end of the file would find
    // `sendRateRefusal(` in that function's definition and pass with the call
    // removed — the second mutation this suite first failed to kill.
    const guard = src.slice(start, src.indexOf("\n}\n", start));
    assert.ok(guard.length > 1500, "the guard body was not located");
    const at = (re: RegExp, what: string) => {
      const i = guard.search(re);
      assert.ok(i >= 0, `the shared guard has no ${what} gate`);
      return i;
    };
    const stop = at(/isKillSwitchEngaged\(flagSc, "disable_messaging"\)/, "stop");
    const membership = at(/\.is\("left_at", null\)/, "membership");
    const block = at(/isBlockedBetween\(/, "block");
    const e2ee = at(/is_e2ee/, "e2ee");
    const restriction = at(/const restrictionVerdict = decideRestrictedSend\(/, "restriction");
    const rate = at(/const rate = await sendRateRefusal\(/, "rate");
    assert.ok(stop < membership && membership < block && block < e2ee && e2ee < restriction && restriction < rate, "the gates are out of order");
    assert.match(guard.slice(restriction, rate), /if \(!restrictionVerdict\.allowed\) \{/, "the restriction verdict is computed and not acted on");
    assert.match(guard.slice(rate), /if \(rate\) return rate;\s*\n\s*return \{ ok: true/, "the rate verdict is computed and not acted on");
    // A limiter that THROWS must not become a limiter that is skipped.
    const fn = src.slice(src.indexOf("export async function sendRateRefusal("));
    assert.match(fn, /catch[\s\S]{0,400}verdict = strictestSendRate\(userId, bucket\);/, "a throwing tier read must fall to the strictest tier");
    assert.match(fn, /if \(verdict\.allowed\) return null;/);
  });

  it("C6. the weak doors are counted, named, and under a ceiling that may only fall", () => {
    const weak = knownWeakDoors();
    assert.equal(
      weak.length,
      KNOWN_WEAK_DOOR_CEILING,
      weak.length < KNOWN_WEAK_DOOR_CEILING
        ? "a door was closed — lower KNOWN_WEAK_DOOR_CEILING to match, so it cannot quietly reopen"
        : "a NEW weak door was declared. Close it, or justify raising a ceiling that exists to fall.",
    );
    for (const d of weak) {
      assert.ok(d.missing!.every((g) => (DOOR_GATES as readonly string[]).includes(g)));
      assert.ok(d.owner.length > 0 && d.note.length > 40, `${d.file} is declared weak without saying why or whose it is`);
      // A door that has been moved onto the shared guard must not stay listed as
      // weak: the entry would then be a false statement about the tree.
      assert.doesNotMatch(
        read(d.file),
        /await guardTelegraphThreadWrite\(/,
        `${d.file} now calls the shared guard — remove its \`missing\` list and lower the ceiling`,
      );
    }
  });

  it("C7. a user door is either guarded or says what it lacks — never neither", () => {
    for (const d of MESSAGE_WRITERS.filter((x) => x.writer === "user_door")) {
      const guarded = d.guard === "shared" || d.guard === "inline";
      const admitsGap = (d.missing?.length ?? 0) > 0;
      assert.ok(guarded !== admitsGap, `${d.file} must declare exactly one of \`guard\` or \`missing\``);
    }
  });
});
