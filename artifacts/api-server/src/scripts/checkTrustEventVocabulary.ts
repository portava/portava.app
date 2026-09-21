/**
 * `TRUST_EVENT_TYPES` is a contract, not a wish-list — `check:trust-event-vocabulary`.
 *
 * ── WHAT IT WAS ─────────────────────────────────────────────────────────────
 *
 * `TrustEventService.ts` declares TRUST_EVENT_TYPES as "all event types by
 * source system", each with its category, delta and severity. census-trust C32
 * measured what that declaration was worth: a handful of emitters read the
 * constant, **every other one hand-writes its own type, delta and severity**,
 * and fifteen declared entries were emitted by nobody at all. A vocabulary that
 * nothing checks is a comment with punctuation.
 *
 * The consequence is not tidiness. A hand-written delta that DISAGREES with the
 * declaration means the number a user's trust moves by is not the number the
 * system says it moves by, and changing the declared value fixes nothing.
 *
 * ── THE THREE FINDINGS, AND WHY THEY ARE DIFFERENT ──────────────────────────
 *
 *   DIVERGENT   an emitter passes a literal category/delta/severity that does
 *               NOT match the declared entry for its event type. This is the
 *               one that is actively false, and it is a hard failure.
 *   UNDECLARED  an emitter uses an event type the vocabulary does not contain.
 *               The vocabulary is then incomplete rather than wrong.
 *   UNEMITTED   a declared entry nothing emits. Recorded, and allowed with a
 *               written reason — a type reserved for an unbuilt surface is a
 *               plan; a type nobody remembers is rot, and the difference has to
 *               be stated by a person.
 *
 * ── WHAT IT DOES NOT COVER ──────────────────────────────────────────────────
 *
 *   1. Non-literal arguments. `delta: computeDelta(x)` is invisible; the counts
 *      are a FLOOR on divergence, never a ceiling.
 *   2. Whether a declared delta is the RIGHT number. It checks agreement, not
 *      judgement.
 *   3. Runtime. An emitter behind a condition that never runs still counts as
 *      an emitter here — census-trust A6 is the row that measures reachability,
 *      and it measures it in production.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const VOCAB_FILE = join(SRC, "services", "trust", "TrustEventService.ts");

/**
 * Declared entries with no emitter, each with the reason it is allowed to have
 * none. Validated: an entry here that HAS gained an emitter fails, so the list
 * can only shrink as the vocabulary is realised.
 */
const UNEMITTED_BY_DESIGN: Record<string, string> = {
  PLAN_NO_SHOW:
    "Plans have no attendance adjudication yet — nothing in the tree decides that a no-show HAPPENED, so an " +
    "emitter would have to invent the finding. Reserved for the plan-attendance surface.",
  PLAN_LATE_CANCEL:
    "Same surface, same reason: no cancellation-window adjudication exists to fire it.",
  HOST_POSITIVE_REVIEW:
    "Superseded in practice by EVENT_POSITIVE_REVIEW, which the events review path emits. Kept because the " +
    "plan-hosting surface is a different one from events and is not built.",
  HOST_NEGATIVE_REVIEW:
    "Same as HOST_POSITIVE_REVIEW — the plan-hosting counterpart of an events event that IS emitted.",
  RESPONDED_PROMPTLY:
    "Requires a response-latency measurement over messaging that does not exist. Declaring the reward before " +
    "the measurement is the honest order; emitting it would require inventing the latency.",
  MUTUAL_REPORT:
    "Requires detecting that two users reported EACH OTHER, which no adjudication path correlates today.",
  TRAVEL_CIRCLE_JOIN:
    "Circles exist; joining one is not currently treated as trust evidence, and whether it should be is a " +
    "product question rather than a wiring gap.",
  GPS_COORDINATE_JUMP:
    "The location-honesty detector that would emit it does not exist. GPS evidence reaches Trust today only " +
    "through CHECKIN_VERIFIED (a positive), which is why census-trust A6 records that location_honesty can " +
    "currently only go UP on the live pipeline.",
  GPS_IMPOSSIBLE_SPEED:
    "Same absent detector as GPS_COORDINATE_JUMP — the two are the same measurement at two thresholds, and " +
    "neither has a producer.",
  PULSE_POST_REPORTED:
    "DELIBERATELY unemitted. A report is not an adjudication: a naive wiring that charged an author on the " +
    "REPORT was removed (see trustEmitterWiring.test.ts R1, a one-line edit to routes/admin.ts restored by " +
    "that test), because it let any reporter move a stranger's trust. The adjudicated path is CONTENT_REMOVED, " +
    "which fires when an admin upholds the report, and it IS emitted.",
  APPEAL_APPROVED_REVERSAL:
    "The reversal half of an appeal — undoing the trust charge an upheld report applied. resolveAppeal emits " +
    "APPEAL_APPROVED (the positive acknowledgement) but nothing yet REVERSES the original event, which needs " +
    "the charge's own id to reverse and is a Trust-side capability that does not exist.",
  EVENT_HOST_NO_SHOW:
    "The events surface emits the single type EVENT_NO_SHOW at moderate severity for both parties rather than " +
    "distinguishing host from attendee. Splitting it is a product decision about whether a host failing to " +
    "appear is a worse breach than an attendee doing so; until that is answered, one type is honest and two " +
    "would be a distinction the code does not make.",
  EVENT_ATTENDEE_NO_SHOW:
    "The attendee half of the same undrawn distinction as EVENT_HOST_NO_SHOW — EVENT_NO_SHOW covers both today.",
  FAKE_GPS_CONFIRMED:
    "The severe end of the location ladder, reserved for a CONFIRMED spoof. The detector emits the two " +
    "measurable findings (GPS_COORDINATE_JUMP, GPS_IMPOSSIBLE_SPEED); nothing yet adjudicates them into a " +
    "confirmation, and a machine finding must not award itself the severe verdict.",
};

type Decl = { category: string; delta: number; severity: string; line: number };

/** Parse TRUST_EVENT_TYPES from its source — the declaration IS the contract. */
function readVocabulary(): Map<string, Decl> {
  const src = readFileSync(VOCAB_FILE, "utf8");
  const start = src.indexOf("export const TRUST_EVENT_TYPES");
  if (start < 0) throw new Error("TRUST_EVENT_TYPES not found in TrustEventService.ts");
  const block = src.slice(start, src.indexOf("\n};", start));
  const out = new Map<string, Decl>();
  const re =
    /^\s*([A-Z][A-Z0-9_]*):\s*\{\s*category:\s*"([a-z_]+)"[^,]*,\s*delta:\s*(-?\d+)\s*,\s*severity:\s*"([a-z]+)"/gm;
  for (const m of block.matchAll(re)) {
    out.set(m[1]!, {
      category: m[2]!,
      delta: Number(m[3]),
      severity: m[4]!,
      line: src.slice(0, start + (m.index ?? 0)).split("\n").length,
    });
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "migrations", "scripts", "test", "__tests__"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const vocab = readVocabulary();
const problems: string[] = [];
const emitted = new Map<string, { file: string; line: number }[]>();
let divergent = 0;
let undeclared = 0;
let literalSites = 0;
let nonLiteralSites = 0;

/** `plan_attended` → `PLAN_ATTENDED`. The vocabulary keys are the snake types upper-cased. */
const keyOf = (t: string) => t.toUpperCase();

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs).replace(/\\/g, "/");
  // services/trust IS scanned. Its helpers -- recordStampVerifiedTrustEvent,
  // the event-cancellation and event-review helpers -- are emitters like any
  // other, and skipping the directory reported four types as "emitted by
  // nothing" that the service emits itself. Caught on this checker's first run:
  // a vacuity of exactly the kind it exists to find.
  const src = readFileSync(abs, "utf8");
  // An emitter call is `eventType: "<snake>"` with its sibling fields nearby.
  // Every string literal on the eventType expression, not just a bare one. The
  // events review helper writes `eventType: positive ? "event_positive_review" :
  // "event_negative_review"`, and a bare-literal regex reported BOTH types as
  // emitted by nothing -- this checker under-reporting emitters is the same
  // vacuity as over-reporting them.
  for (const m of src.matchAll(/eventType:\s*([^,\n]*"[a-z][a-z0-9_]*"[^,\n]*)/g)) {
    for (const lit of m[1]!.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
    const type = lit[1]!;
    const line = src.slice(0, m.index).split("\n").length;
    // Only Trust emitters — other subsystems (call signalling, notifications)
    // use the same field name for their own vocabularies.
    const window = src.slice(Math.max(0, (m.index ?? 0) - 400), (m.index ?? 0) + 400);
    if (!/record(?:Trust|Adjudicated)?Event|recordTrustEvent|trustEvent|insertTrustEvent/i.test(window)) continue;
    // Not the declaration block itself.
    if (rel === "services/trust/TrustEventService.ts" && /TRUST_EVENT_TYPES = \{/.test(src.slice(0, m.index ?? 0).slice(-8000)) && (m.index ?? 0) > src.indexOf("export const TRUST_EVENT_TYPES")) continue;

    const key = keyOf(type);
    (emitted.get(key) ?? emitted.set(key, []).get(key)!).push({ file: rel, line });

    const decl = vocab.get(key);
    if (!decl) {
      undeclared++;
      problems.push(
        `::error::${rel}:${line} emits trust event type "${type}", which TRUST_EVENT_TYPES does not declare. ` +
          `The vocabulary calls itself "all event types by source system"; either add ${key} to it, or emit a ` +
          `type it contains.`,
      );
      continue;
    }

    // Compare the LITERAL siblings only. A computed delta is not a divergence
    // this check can see, and saying so is the point of the count below.
    const cat = /category:\s*"([a-z_]+)"/.exec(window.slice(window.indexOf(m[0]!)));
    const del = /delta:\s*(-?\d+)\b/.exec(window.slice(window.indexOf(m[0]!)));
    const sev = /severity:\s*"([a-z]+)"/.exec(window.slice(window.indexOf(m[0]!)));
    if (!cat && !del && !sev) { nonLiteralSites++; continue; }
    literalSites++;

    const mismatches: string[] = [];
    if (cat && cat[1] !== decl.category) mismatches.push(`category "${cat[1]}" ≠ declared "${decl.category}"`);
    if (del && Number(del[1]) !== decl.delta) mismatches.push(`delta ${del[1]} ≠ declared ${decl.delta}`);
    if (sev && sev[1] !== decl.severity) mismatches.push(`severity "${sev[1]}" ≠ declared "${decl.severity}"`);
    if (mismatches.length > 0) {
      divergent++;
      problems.push(
        `::error::${rel}:${line} emits "${type}" with ${mismatches.join(", ")}. ` +
          `TRUST_EVENT_TYPES.${key} (TrustEventService.ts:${decl.line}) is the DECLARED contract — a user's trust ` +
          `moves by the emitted number, so a declaration that disagrees with it is false. Read the constant ` +
          `(\`const t = TRUST_EVENT_TYPES.${key}\`) instead of restating its fields.`,
      );
    }
    }
  }
}

// Declared entries nobody emits.
const unemitted = [...vocab.keys()].filter((k) => !emitted.has(k) && !(k in UNEMITTED_BY_DESIGN));
for (const k of unemitted) {
  problems.push(
    `::error::TRUST_EVENT_TYPES.${k} is declared and emitted by NOTHING. The constant claims to be "all event ` +
      `types by source system"; a type nobody emits makes it a wish-list. Wire an emitter, or add ${k} to ` +
      `UNEMITTED_BY_DESIGN with the reason it has none yet.`,
  );
}
for (const [k, reason] of Object.entries(UNEMITTED_BY_DESIGN)) {
  if (!vocab.has(k)) {
    problems.push(`::error::UNEMITTED_BY_DESIGN names ${k}, which TRUST_EVENT_TYPES no longer declares. Delete the entry.`);
  } else if (emitted.has(k)) {
    problems.push(
      `::error::UNEMITTED_BY_DESIGN says ${k} has no emitter, but ${emitted.get(k)![0]!.file}:${emitted.get(k)![0]!.line} ` +
        `emits it. The exemption is spent — delete it.`,
    );
  } else if (reason.length < 80) {
    problems.push(`::error::UNEMITTED_BY_DESIGN entry for ${k} carries a ${reason.length}-character reason. That is a label.`);
  }
}

if (vocab.size === 0) {
  problems.push("::error::TRUST_EVENT_TYPES parsed as EMPTY — this check found no vocabulary to enforce, so its verdict is vacuous.");
}

for (const p of problems) console.error(p);
console.log(
  `check:trust-event-vocabulary — ${vocab.size} declared type(s); ${emitted.size} emitted; ` +
    `${literalSites} emitter site(s) with literal fields compared, ${nonLiteralSites} computed (not comparable); ` +
    `${divergent} divergent, ${undeclared} undeclared, ${Object.keys(UNEMITTED_BY_DESIGN).length} unemitted with a written reason.`,
);
console.log(
  "NOTE: DOES NOT COVER — (1) non-literal arguments, so the divergence count is a FLOOR; (2) whether a declared " +
    "delta is the RIGHT number; (3) whether an emitter is ever REACHED, which census-trust A6 measures in production.",
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\n✅ every emitted trust event type is declared, and every literal field agrees with its declaration.");
