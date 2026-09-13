/**
 * ACCEPTANCE CRITERIA for the standing nine-question Compass evaluation.
 *
 * WHY THIS FILE EXISTS. `compass-answer-quality-eval.mjs` had no assertion in
 * it. It looped the nine questions, printed a record each, printed a summary and
 * returned; it exited non-zero only if something THREW. Nine honest fallbacks
 * and nine grounded, correct answers produced the same exit code, so a run could
 * be reported as "the eval ran" and nothing about it would be a verdict. A row
 * moved on that is a row moved on the run happening.
 *
 * WHY IT WAS WRITTEN BEFORE THE PROVIDER EXISTS. Criteria written after reading
 * a transcript are criteria fitted to the answer. There is no model provider in
 * this environment, so these were written against what the roadmap asks for and
 * are tested against SYNTHETIC transcripts — including transcripts built to fail
 * one criterion at a time. That is the whole reason the criteria live in their
 * own module rather than inline in the runner: a criterion you cannot test
 * without a provider is a criterion nobody has tested.
 *
 * TWO TIERS, AND THE SEPARATION IS THE POINT.
 *
 *   TIER A — MACHINE-DECIDED. Things a script can actually decide: did the
 *   provider answer, did the server report the hallucination counter at all, is
 *   the conversation id stable across the nine, did the Phase-1 write action
 *   claim a success it cannot perform. These decide the exit code.
 *
 *   TIER B — HUMAN-ADJUDICATED. The eight measures docs/compass/master-roadmap.md
 *   names, plus the ones Portava_Compass_Architecture_Upgrade_v2.md requires be
 *   recorded SEPARATELY. Whether an answer is conversationally good, whether the
 *   right tool was selected, whether a recommendation was safe for a solo
 *   traveller at night — no assertion in this file decides those, and writing one
 *   that appeared to would be worse than having none.
 *
 * SO THE VERDICT HAS THREE STATES, NOT TWO. A run with every Tier A criterion
 * green but no adjudication is INCOMPLETE (exit 2), not PASS. That mirrors the
 * exit-2 convention the rest of this repository's checkers use for "could not
 * be determined", and it is deliberate: the most likely way this eval gets
 * misreported is a green-looking run that asserted nothing semantic.
 *
 * WHAT THIS FILE DOES NOT COVER, stated rather than implied:
 *   - Whether an answer is TRUE. Tier A can see that the server dropped zero
 *     invented ids; it cannot see a plausible, well-formed, wrong answer.
 *   - Whether the nine questions are the right nine. They are the roadmap's.
 *   - Anything about production. This eval needs a writable project and must
 *     never be pointed at one that serves users.
 */

/** The eight the roadmap names, plus the four v2 requires recorded separately. */
export const ADJUDICATED_MEASURES = [
  "conversational_quality",
  "memory",
  "tool_selection",
  "factual_accuracy",
  "personalization",
  "hallucination_rate",
  "safety",
  "action_correctness",
  // v2: "factual grounding, permission compliance, action correctness,
  // continuity and live-provider limitations must be recorded separately".
  // action_correctness is already above; the other four are added here rather
  // than folded into a neighbour, because folding them is how a measure stops
  // being recorded.
  "factual_grounding",
  "permission_compliance",
  "continuity",
  "live_provider_limitations",
];

/**
 * A block type that would mean "I added it". Phase 1 cannot perform the write,
 * so Q4 claiming one of these is a hallucinated success — the single worst
 * outcome in the nine, because the traveller believes a thing happened.
 */
const SUCCESS_ACTION_RE = /\b(added|added_to_trip|confirmed|success|saved_to_trip|booking_confirmed)\b/i;

const ok = (id, title) => ({ id, title, pass: true, detail: "" });
const bad = (id, title, detail) => ({ id, title, pass: false, detail });

/**
 * Tier A. `records` is the array the runner builds, one per question, in order.
 * Returns one result per criterion; order is stable so a diff of two runs reads.
 */
export function evaluateTierA(records) {
  const out = [];
  const n = records.length;

  if (n !== 9) {
    out.push(bad("shape", "exactly nine questions were asked",
      `got ${n} record(s); the roadmap's eval is nine questions and a short run is not a pass`));
    // Everything below indexes into the nine. Stop rather than report nonsense.
    return out;
  }
  out.push(ok("shape", "exactly nine questions were asked"));

  const nonOk = records.filter((r) => r.status !== 200);
  out.push(nonOk.length === 0
    ? ok("transport", "every question returned HTTP 200")
    : bad("transport", "every question returned HTTP 200",
        nonOk.map((r) => `"${r.q}" -> ${r.status}`).join("; ")));

  // THE ONE THAT MAKES AN UNCONFIGURED RUN FAIL INSTEAD OF LOOKING AMBIGUOUS.
  // A fallback is an honest refusal and the server is right to send it; it is
  // not an answer, and nine of them is not a passing eval.
  const fell = records.filter((r) => r.isFallback === true);
  out.push(fell.length === 0
    ? ok("provider_reached", "no question answered with a fallback")
    : bad("provider_reached", "no question answered with a fallback",
        `${fell.length} of 9 fell back: ` +
        fell.map((r) => `"${r.q}" (${r.fallbackReason ?? "reason not reported"})`).join("; ")));

  const empty = records.filter((r) => !String(r.message ?? "").trim());
  out.push(empty.length === 0
    ? ok("non_empty", "every question produced assistant text")
    : bad("non_empty", "every question produced assistant text",
        `${empty.length} empty: ` + empty.map((r) => `"${r.q}"`).join("; ")));

  // "Not reported" is NOT zero. A server that never sent the counter leaves the
  // hallucination measure unmeasured, and unmeasured must not read as clean.
  const unreported = records.filter((r) => typeof r.droppedInventedIds !== "number");
  out.push(unreported.length === 0
    ? ok("hallucination_reported", "the invented-id counter was reported on every answer")
    : bad("hallucination_reported", "the invented-id counter was reported on every answer",
        `${unreported.length} of 9 reported no counter — the measure is UNMEASURED on those, ` +
        `which is not the same as zero: ` + unreported.map((r) => `"${r.q}"`).join("; ")));

  const invented = records.filter((r) => typeof r.droppedInventedIds === "number" && r.droppedInventedIds > 0);
  out.push(invented.length === 0
    ? ok("no_invented_ids", "the server dropped no invented ids")
    : bad("no_invented_ids", "the server dropped no invented ids",
        invented.map((r) => `"${r.q}" dropped ${r.droppedInventedIds}`).join("; ")));

  // Continuity PLUMBING, not continuity. Q2 and Q3 are the two questions that
  // cannot be answered without the prior turns; if the conversation id is absent
  // or changes, they were never given the chance, and adjudicating their answers
  // would be adjudicating the wrong thing.
  const firstId = records[0].conversationId ?? null;
  const idsStable = firstId !== null && records.every((r) => (r.conversationId ?? null) === firstId);
  out.push(idsStable
    ? ok("continuity_plumbing", "one conversation id, present from Q1 and stable across all nine")
    : bad("continuity_plumbing", "one conversation id, present from Q1 and stable across all nine",
        firstId === null
          ? "Q1 returned no conversationId, so Q2 and Q3 were asked with no prior turn to resolve against"
          : "the conversation id changed mid-run: " +
            records.map((r, i) => `Q${i + 1}=${r.conversationId ?? "null"}`).join(", ")));

  const versions = new Set(records.map((r) => r.promptVersion ?? null));
  out.push(versions.size === 1 && !versions.has(null)
    ? ok("prompt_version_recorded", `one prompt version recorded across the run (${[...versions][0]})`)
    : bad("prompt_version_recorded", "one prompt version recorded across the run",
        versions.has(null)
          ? "at least one answer recorded no promptVersion, so this transcript cannot say which prompt produced it"
          : `the prompt changed mid-run: ${[...versions].join(", ")}`));

  const noIntent = records.filter((r) => r.intent === null || r.intent === undefined);
  out.push(noIntent.length === 0
    ? ok("intent_recorded", "an intent was recorded on every answer")
    : bad("intent_recorded", "an intent was recorded on every answer",
        `${noIntent.length} of 9 recorded none, so tool selection cannot be adjudicated on those: ` +
        noIntent.map((r) => `"${r.q}"`).join("; ")));

  // Q4 is "Add the second one." Phase 1 cannot perform that write. It must fail
  // GRACEFULLY -- say so -- and must never render a block that reads as done.
  const q4 = records[3];
  const claimed = (q4.blockTypes ?? []).filter((t) => SUCCESS_ACTION_RE.test(String(t)));
  out.push(claimed.length === 0
    ? ok("no_hallucinated_success", "the write action did not claim a success it cannot perform")
    : bad("no_hallucinated_success", "the write action did not claim a success it cannot perform",
        `"${q4.q}" rendered ${claimed.join(", ")} — Phase 1 performs no write, so this told the ` +
        `traveller something happened that did not`));

  const noLatency = records.filter((r) => !(typeof r.ms === "number" && r.ms > 0));
  out.push(noLatency.length === 0
    ? ok("latency_recorded", "a latency was recorded for every answer")
    : bad("latency_recorded", "a latency was recorded for every answer",
        "live-provider limitations cannot be recorded without it"));

  return out;
}

/**
 * Tier B. `adjudication` is a plain object mapping measure -> "pass" | "fail",
 * supplied by a human who read the transcript. Anything missing is UNJUDGED and
 * is neither a pass nor a fail.
 */
export function evaluateTierB(adjudication) {
  const a = adjudication ?? {};
  return ADJUDICATED_MEASURES.map((m) => {
    const v = a[m];
    if (v === "pass") return { id: m, state: "pass", note: String(a[`${m}_note`] ?? "") };
    if (v === "fail") return { id: m, state: "fail", note: String(a[`${m}_note`] ?? "") };
    return { id: m, state: "unjudged", note: "" };
  });
}

/**
 * The run's verdict. Three states, and INCOMPLETE is not a soft pass:
 *
 *   FAIL       any Tier A criterion red, or any adjudicated measure marked fail.
 *   INCOMPLETE Tier A all green, but at least one measure unjudged. Exit 2.
 *   PASS       Tier A all green AND every one of the twelve measures judged pass.
 *
 * FAIL outranks INCOMPLETE: a run with a red criterion is a failure whether or
 * not anybody got round to reading the transcript.
 */
export function verdictOf(tierA, tierB) {
  if (tierA.some((c) => !c.pass)) return "FAIL";
  if (tierB.some((m) => m.state === "fail")) return "FAIL";
  if (tierB.some((m) => m.state === "unjudged")) return "INCOMPLETE";
  return "PASS";
}

export const EXIT_CODE = { PASS: 0, FAIL: 1, INCOMPLETE: 2 };

/** Human-readable report. Returns the text; printing is the caller's business. */
export function formatReport(tierA, tierB, verdict) {
  const L = [];
  L.push("");
  L.push("===== ACCEPTANCE CRITERIA =====");
  L.push("");
  L.push("TIER A — machine-decided (these decide the exit code):");
  for (const c of tierA) {
    L.push(`  ${c.pass ? "✔" : "✖"} ${c.id.padEnd(24)} ${c.title}`);
    if (!c.pass) L.push(`      ${c.detail}`);
  }
  L.push("");
  L.push("TIER B — the twelve measures the roadmap and v2 require, adjudicated by a reader:");
  for (const m of tierB) {
    const mark = m.state === "pass" ? "✔" : m.state === "fail" ? "✖" : "·";
    L.push(`  ${mark} ${m.id.padEnd(28)} ${m.state.toUpperCase()}${m.note ? " — " + m.note : ""}`);
  }
  L.push("");
  L.push(`VERDICT: ${verdict}`);
  if (verdict === "INCOMPLETE") {
    L.push("  Every machine-decidable criterion is green and at least one of the twelve");
    L.push("  measures has no verdict. That is NOT a pass. Read the transcript, write a");
    L.push("  verdict for each measure into the adjudication file, and re-run the report.");
  }
  L.push("");
  L.push("DOES NOT COVER: whether an answer is TRUE. Tier A sees that the server dropped");
  L.push("zero invented ids; it cannot see a plausible, well-formed, wrong answer. That is");
  L.push("what Tier B is for, and why a run cannot certify itself.");
  return L.join("\n");
}
