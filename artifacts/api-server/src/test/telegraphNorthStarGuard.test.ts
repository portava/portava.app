/**
 * Telegraph §1.2 — the north star, guarded.
 *
 *   "Optimize for successful coordinated real-world actions, not message
 *    volume, streaks, time in chat or endless engagement. A conversation
 *    ending because everyone met is a successful outcome."
 *
 * census-telegraph T1 recorded an UNGUARDED ABSENCE: "No streak,
 * session-length or message-volume mechanic exists in either tree; nothing
 * guards against one." The absence was a coincidence. This suite makes it a
 * rule that fails, on the three places such a mechanic would have to live:
 *
 *   1. WHAT TELEGRAPH MEASURES ITSELF BY. Every SLO in `TELEGRAPH_SLOS` is read;
 *      none may be a volume or attention objective, and the ONE product-severity
 *      metric must be the coordinated-action outcome (SLO-09 → T354). A
 *      "messages sent per user" objective added beside it fails here.
 *   2. WHAT TELEGRAPH SENDS PEOPLE. Every `telegraph.*` notification template
 *      is in a CLOSED list, each entry naming the act by another person that
 *      triggers it. A template nobody's act triggers — "you haven't chatted in
 *      a while", "keep your streak" — is a new event type, and a new event
 *      type fails here until somebody adds it to the list and says what act
 *      causes it. Every template is also RENDERED and its words checked.
 *   3. WHAT TELEGRAPH CODE DOES. The Telegraph server and client trees are
 *      scanned, comments stripped, for the vocabulary of the mechanics §1.2
 *      names: streaks, time-in-chat, session length, daily message goals.
 *
 * What this does NOT do: measure the positive half. Whether people met is not
 * in this system (T354 is W — SLO-09 counts confirmed proposals and labels
 * itself a proxy). So this turns T1's negative half from an unguarded absence
 * into a guarded one and nothing more.
 *
 * Run: node --import tsx/esm --test src/test/telegraphNorthStarGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { TELEGRAPH_SLOS } from "../domain/telegraph/services/telegraphObservability.js";
import { TEMPLATES, renderTemplate } from "../services/notifications/NotificationTemplateService.js";

const SRC = new URL("..", import.meta.url).pathname; // artifacts/api-server/src/
const REPO = join(SRC, "../../..");
const CLIENT = join(REPO, "travel-buddy-standalone");

// ── the vocabulary of §1.2's forbidden mechanics ─────────────────────────────

/** Metric names that would make volume or attention an objective. */
const VOLUME_METRIC = /(messages?_(sent|count|volume|per)|message_volume|time_(spent_)?in_(chat|thread|app)|minutes_in_(chat|thread|app)|streak|daily_active|engagement|dau|mau)/i;

/** Code that implements a streak / time-in-chat / volume-goal mechanic. */
const MECHANIC_PATTERNS: readonly RegExp[] = [
  // No leading \b: a camelCase identifier (`messageStreak`, `trackSessionLength`)
  // has no word boundary before the part that matters.
  /streaks?/i,
  /time_?(spent_?)?in_?(chat|thread|app)/i,
  /minutes_?in_?(chat|thread|app)/i,
  /consecutive_?days/i,
  /messages?_?sent_?today/i,
  /daily_?message_?(goal|target)/i,
  /days_?in_?a_?row/i,
  // NOT `session_?length`: a coordination session has a length, and measuring it
  // is not an engagement mechanic (verifier F8 found the false positive).
];

/** Words in a notification that nag for engagement rather than report an act. */
const NAG_PATTERNS: readonly RegExp[] = [
  /streak/i,
  /in a row/i,
  /haven'?t (chatted|messaged|replied|talked)/i,
  /keep (it|the conversation|your) going/i,
  /(you('ve| have) been|it'?s been) (away|quiet)/i,
  /miss(ing)? you/i,
  /beat your (record|streak|best)/i,
  /keep chatting/i,
];

/**
 * The CLOSED list of Telegraph notification event types, each with the act by
 * ANOTHER PERSON (or by the person's own trip assistant, on request) that
 * triggers it. A type not listed here fails the suite.
 */
const TELEGRAPH_NOTIFICATION_EVENTS: Readonly<Record<string, string>> = {
  "telegraph.message": "someone sent the person a message",
  "telegraph.message_request": "a stranger asked to start a conversation",
  "telegraph.ai_suggestion": "Compass produced a trip suggestion in a thread the person is coordinating in",
  "telegraph.mention": "someone mentioned the person",
  "telegraph.reaction": "someone reacted to the person's message",
  "telegraph.thread_archived": "a participant archived the conversation",
  "call.incoming": "someone is calling the person (filed under the telegraph category)",
};

// ── helpers ──────────────────────────────────────────────────────────────────

/** Strip // and /* *\/ comments, so prose explaining a refusal is not a hit. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function mechanicsIn(src: string): string[] {
  const code = stripComments(src);
  return MECHANIC_PATTERNS.filter((p) => p.test(code)).map((p) => p.source);
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Every non-test source file that belongs to Telegraph, server and client. */
function telegraphSources(): string[] {
  const server = [
    ...walk(join(SRC, "services/telegraph")),
    ...walk(join(SRC, "domain/telegraph")),
    ...walk(join(SRC, "server/telegraph")),
    ...readdirSync(join(SRC, "routes"))
      .filter((f) => /^(telegraph.*|messaging|groupChat|savedMessages|calls|callsWebhook|keyPackages|nearbyReachable)\.ts$/.test(f))
      .map((f) => join(SRC, "routes", f)),
    ...readdirSync(join(SRC, "lib"))
      .filter((f) => /^telegraph.*\.ts$/.test(f))
      .map((f) => join(SRC, "lib", f)),
  ];
  const client = [
    ...walk(join(CLIENT, "src/features/telegraph")),
    ...walk(join(CLIENT, "app/messages")),
    ...walk(join(CLIENT, "app/telegraph")),
  ];
  return [...server, ...client];
}

// ── 1. what Telegraph measures itself by ─────────────────────────────────────

describe("§1.2 — Telegraph's objectives are outcomes, not volume", () => {
  it("no SLO metric is a volume or attention objective", () => {
    const offenders = TELEGRAPH_SLOS.filter((s) => VOLUME_METRIC.test(s.metric)).map((s) => `${s.id} ${s.metric}`);
    assert.deepEqual(offenders, [], `volume/attention objectives declared: ${offenders.join(", ")}`);
  });

  it("the one PRODUCT objective is the coordinated-action outcome (SLO-09 / T354), and it says it is a proxy", () => {
    const product = TELEGRAPH_SLOS.filter((s) => s.severity === "product");
    assert.deepEqual(product.map((s) => s.metric), ["coordinated_actions_confirmed"]);
    assert.equal(product[0]!.censusRow, "T354");
    assert.match(String(product[0]!.note), /proxy/i);
  });

  it("CONTROL: the detector recognises a volume objective", () => {
    assert.equal(VOLUME_METRIC.test("messages_sent_per_user"), true);
    assert.equal(VOLUME_METRIC.test("time_in_chat_p50"), true);
    assert.equal(VOLUME_METRIC.test("coordinated_actions_confirmed"), false);
    assert.equal(VOLUME_METRIC.test("messages_per_active_user"), true);
  });
});

// ── 2. what Telegraph sends people ───────────────────────────────────────────

describe("§1.2 — Telegraph notifications report acts; none nags for engagement", () => {
  // By event type OR by category: a re-engagement template filed under
  // `category: 'telegraph'` with another prefix is still a Telegraph notification
  // (verifier F8).
  const telegraphTemplates = TEMPLATES.filter((t) => t.eventType.startsWith("telegraph.") || t.category === "telegraph");

  it("every telegraph.* template is in the closed list, each with the act that triggers it", () => {
    const unlisted = telegraphTemplates.map((t) => t.eventType).filter((e) => !(e in TELEGRAPH_NOTIFICATION_EVENTS));
    assert.deepEqual(unlisted, [],
      `new Telegraph notification type(s) with no declared triggering act: ${unlisted.join(", ")}`);
  });

  it("the closed list has no stale entry — every listed type still exists", () => {
    const present = new Set(telegraphTemplates.map((t) => t.eventType));
    const stale = Object.keys(TELEGRAPH_NOTIFICATION_EVENTS).filter((e) => !present.has(e));
    assert.deepEqual(stale, []);
  });

  it("no template's rendered words nag (streaks, 'haven't chatted', 'keep it going', 'miss you')", () => {
    const params = { actor: "Marcus", preview: "See you at 8", emoji: "🎉", threadId: "t", suggestion: "Dinner by the river" };
    for (const t of telegraphTemplates) {
      const rendered = renderTemplate(t.eventType, params);
      const text = `${rendered?.title ?? t.title(params)} ${rendered?.body ?? t.body(params)}`;
      for (const p of NAG_PATTERNS) {
        assert.equal(p.test(text), false, `${t.eventType} reads as an engagement nag (${p.source}): "${text}"`);
      }
    }
  });

  it("CONTROL: the nag detector catches the copy it exists for", () => {
    assert.equal(NAG_PATTERNS.some((p) => p.test("You haven't chatted with Nina in a while")), true);
    assert.equal(NAG_PATTERNS.some((p) => p.test("Keep your 5-day streak going!")), true);
    assert.equal(NAG_PATTERNS.some((p) => p.test("Marcus mentioned you")), false);
    assert.equal(NAG_PATTERNS.some((p) => p.test("Keep chatting to beat your record!")), true);
  });
});

// ── 3. what Telegraph code does ──────────────────────────────────────────────

describe("§1.2 — no streak, time-in-chat or volume-goal mechanic in Telegraph code", () => {
  const files = telegraphSources();

  it("the scan reaches both trees (a guard that read nothing would pass)", () => {
    const rels = files.map((f) => relative(REPO, f));
    assert.ok(rels.some((r) => r.startsWith("artifacts/api-server/src/services/telegraph/")), "server tree not scanned");
    assert.ok(rels.some((r) => r.startsWith("artifacts/api-server/src/routes/messaging.ts")), "messaging route not scanned");
    assert.ok(rels.some((r) => r.startsWith("travel-buddy-standalone/src/features/telegraph/")), "client tree not scanned");
    assert.ok(files.length > 100, `only ${files.length} files scanned`);
  });

  it("no Telegraph source file implements one", () => {
    const hits: string[] = [];
    for (const f of files) {
      const found = mechanicsIn(readFileSync(f, "utf8"));
      if (found.length > 0) hits.push(`${relative(REPO, f)}: ${found.join(", ")}`);
    }
    assert.deepEqual(hits, [], `engagement mechanics found:\n${hits.join("\n")}`);
  });

  it("CONTROL: the scanner finds a mechanic in code and ignores one named in a comment", () => {
    assert.deepEqual(mechanicsIn("const streak = days.filter(Boolean).length;").length, 1);
    assert.deepEqual(mechanicsIn("// we deliberately have no streak here\nconst x = 1;"), []);
    assert.deepEqual(mechanicsIn("/* time_in_chat is not measured */ const y = 2;"), []);
    assert.deepEqual(mechanicsIn("const minutesInThreadToday = 0;").length, 1);
    assert.deepEqual(mechanicsIn("const consecutiveDaysChatting = 3;").length, 1);
    // A coordination session has a length; measuring it is not an engagement mechanic.
    assert.deepEqual(mechanicsIn("const sessionLengthMinutes = end - start;"), []);
  });
});
