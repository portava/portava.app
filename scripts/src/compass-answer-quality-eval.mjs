#!/usr/bin/env node
/**
 * Standing 9-question Compass answer-quality eval (docs/compass/master-roadmap.md).
 *
 * THIS SCRIPT USED TO ASSERT NOTHING. It looped the nine questions, printed a
 * record each, printed a summary and returned — exiting non-zero only if
 * something threw. Nine honest fallbacks and nine grounded, correct answers
 * produced the same exit code, so "the eval ran" could be reported as evidence
 * when it was only a transcript. The acceptance criteria now live in
 * ./compass-eval-criteria.mjs, are unit-tested against synthetic transcripts
 * with no provider present, and decide this process's exit code.
 *
 * EXIT CODES, following the convention the rest of this repository's checkers use:
 *   0  PASS        every machine criterion green AND every adjudicated verdict
 *                  supplied and passing — the roadmap's eight measures on each of
 *                  the nine questions ("measure each time"), plus the four v2
 *                  requires recorded separately for the run: 76 verdicts.
 *   1  FAIL        a machine criterion is red, or a measure was judged fail
 *   2  INCOMPLETE  machine criteria green, at least one measure unjudged.
 *                  NOT a pass. A run cannot certify its own semantic quality.
 *
 * The adjudication file (--adjudication) is:
 *   { "perQuestion": { "1": { "safety": "pass", "safety_note": "…" }, … },
 *     "run":         { "factual_grounding": "pass", … } }
 *
 * Requires: a WRITABLE Supabase project (this script creates and deletes an
 * ephemeral auth user), an API server on API_BASE_URL, COMPASS_ENABLED true on
 * that project, and a model provider. docs/compass/nine-query-eval-runbook.md
 * names all five and where each is read. NEVER point this at production.
 *
 * Usage: node scripts/src/compass-answer-quality-eval.mjs [--adjudication <file.json>]
 *        [--emit-adjudication <file.json>]   write the 76-slot skeleton, all null
 */
import {
  evaluateTierA, evaluateTierB, verdictOf, formatReport, EXIT_CODE, EVAL_QUESTIONS,
  collectReferencedIds, blockItemCount,
  ROADMAP_MEASURES, RUN_LEVEL_MEASURES, ADJUDICATION_SIZE,
} from "./compass-eval-criteria.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Hardcoding this to localhost:80 is why the eval had only ever run on one
// machine: port 80 needs privilege or a proxy, and nothing could point it
// elsewhere. Env-configurable, same default, so an existing invocation is
// unchanged.
const API = process.env.COMPASS_EVAL_API_BASE_URL ?? "http://localhost:80/api"; // compass routes are single-prefix: /api/compass/ask

// The nine live in ./compass-eval-criteria.mjs and are imported, not copied.
// `shape` checks the asked text against that same array, and a criterion that
// checked a list this file also owned would be checking nothing.
const QUESTIONS = EVAL_QUESTIONS;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function askCompass(accessToken, prompt, conversationId) {
  const res = await fetch(`${API}/compass/ask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(conversationId ? { prompt, conversationId } : { prompt }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 800) }; }
  return { status: res.status, body };
}

let exitCode = EXIT_CODE.FAIL;

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

  const email = `compass-eval-${Date.now()}@example.com`;
  const password = "Eval-" + Math.random().toString(36).slice(2) + "A1!";

  console.log("Creating ephemeral user", email);
  const user = await sb("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const userId = user.id;

  try {
    await sb("/rest/v1/profiles", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ id: userId, handle: `ceval${Date.now() % 100000}`, name: "Compass Eval" }),
    });

    const tok = await sb("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const accessToken = tok.access_token;

    let conversationId = undefined;
    const results = [];

    for (const [i, q] of QUESTIONS.entries()) {
      console.log(`\n===== Q${i + 1}: ${q}`);
      const started = Date.now();
      const { status, body } = await askCompass(accessToken, q, conversationId);
      const ms = Date.now() - started;

      conversationId = body.conversationId ?? conversationId;

      // uiBlocks is the new block-rich response; blocks may also appear as body.blocks
      const uiBlocks = body.uiBlocks ?? body.blocks ?? [];
      const blockTypes = uiBlocks.map(b => b.type ?? b.kind ?? JSON.stringify(b).slice(0, 40));

      // Count invented-id drops
      const droppedInventedIds =
        body.meta?.droppedInventedIds ??
        body.droppedInventedIds ??
        (Array.isArray(uiBlocks) ? uiBlocks.reduce((n, b) => n + (b._droppedIds?.length ?? 0), 0) : null);

      // The assistant text reply
      const message = body.message ?? body.reply ?? body.text ?? "";

      // Quick summary of non-empty uiBlocks.
      // This used to count `b.items` / `b.item`. NO BLOCK THE SERVER EMITS HAS
      // EITHER FIELD — place_cards carries `places`, event_cards `events`,
      // person_cards `people`, comparison `rows` — so every block was summarised
      // as a bare type and the count in the transcript was always absent.
      const blockSummary = uiBlocks.map(b => {
        const type = b.type ?? b.kind ?? "?";
        const itemCount = blockItemCount(b);
        return itemCount ? `${type}(${itemCount})` : type;
      });

      const record = {
        q,
        status,
        ms,
        // Recorded PER QUESTION, not just tracked in the loop: the criteria need
        // to see whether one id held across all nine, and a variable that gets
        // overwritten cannot show that.
        conversationId: conversationId ?? null,
        fallbackReason: body.fallbackReason ?? body.fallback_reason ?? null,
        isFallback: body.fallback ?? false,
        message: message.slice(0, 600),
        blockTypes,
        blockSummary,
        droppedInventedIds,
        // The grounding envelope's own finding on this answer: claims it caught
        // the model making with no datum behind them. An ABSENT array and an
        // EMPTY one are different facts and the criteria treat them differently,
        // so `null` is preserved rather than defaulted to [].
        groundingViolations: Array.isArray(body.meta?.groundingViolations)
          ? body.meta.groundingViolations
          : null,
        // Every entity the answer put in front of the traveller.
        referencedIds: [...collectReferencedIds(uiBlocks)],
        // "propose, never auto-execute": the only legal status out of /ask is
        // pending_confirmation. Anything else is a write that already happened.
        proposalStatuses: (body.pendingProposals ?? []).map(p => p?.status ?? "status_not_reported"),
        // payload.type is the card pipeline the turn took — "recommendation" or
        // "itinerary" — and null for plain conversation. phase1-spec.md:23 ties
        // that to the classifier's confidence.
        payloadType: typeof body.payload?.type === "string" ? body.payload.type : null,
        quickActions: (body.quickActions ?? []).slice(0, 4),
        intent: body.intent ?? null,
        promptVersion: body.promptVersion ?? null,
        // Full body keys for debugging
        _bodyKeys: Object.keys(body),
      };
      results.push(record);
      console.log(JSON.stringify(record, null, 2));
    }

    console.log("\n\n===== FINAL SUMMARY =====");
    for (const r of results) {
      const fallLabel = r.isFallback ? ` [FALLBACK: ${r.fallbackReason}]` : "";
      const msgPreview = r.message.slice(0, 120).replace(/\n/g, " ");
      console.log(`Q: ${r.q}`);
      console.log(`  status=${r.status} ms=${r.ms}${fallLabel}`);
      console.log(`  blocks: [${r.blockSummary.join(", ")}]  droppedIds=${r.droppedInventedIds}`);
      console.log(`  reply: ${msgPreview || "(empty)"}`);
      console.log(`  intent: ${JSON.stringify(r.intent)}  payload=${r.payloadType ?? "null"}`);
      console.log(`  grounding: ${r.groundingViolations === null ? "NOT REPORTED" : (r.groundingViolations.join(", ") || "none")}`);
      if (r.proposalStatuses.length > 0) console.log(`  proposals: ${r.proposalStatuses.join(", ")}`);
      console.log();
    }

    // ── The verdict. This is the part that was missing. ───────────────────────
    const adjIdx = process.argv.indexOf("--adjudication");
    let adjudication = null;
    if (adjIdx !== -1 && process.argv[adjIdx + 1]) {
      adjudication = JSON.parse(readFileSync(process.argv[adjIdx + 1], "utf8"));
    }
    const tierA = evaluateTierA(results);
    const tierB = evaluateTierB(adjudication);
    const verdict = verdictOf(tierA, tierB);
    console.log(formatReport(tierA, tierB, verdict));
    exitCode = EXIT_CODE[verdict];

    // The adjudication is 76 verdicts and nobody is going to hand-write that
    // skeleton from the README. `--emit-adjudication <file>` writes it — every
    // slot `null`, the question text beside it so the reader knows which answer
    // they are judging, and the transcript's own record inlined. A template
    // whose slots default to "pass" would be a template that certifies itself,
    // so they default to null and `verdictOf` reads null as UNJUDGED.
    const emitIdx = process.argv.indexOf("--emit-adjudication");
    if (emitIdx !== -1 && process.argv[emitIdx + 1]) {
      const perQuestion = {};
      results.forEach((r, i) => {
        perQuestion[String(i + 1)] = {
          _question: r.q,
          _reply: r.message,
          _intent: r.intent,
          _blocks: r.blockSummary,
          ...Object.fromEntries(ROADMAP_MEASURES.flatMap((m) => [[m, null], [`${m}_note`, ""]])),
        };
      });
      const run = Object.fromEntries(
        RUN_LEVEL_MEASURES.flatMap((m) => [[m, null], [`${m}_note`, ""]]),
      );
      writeFileSync(process.argv[emitIdx + 1], JSON.stringify({ perQuestion, run }, null, 2));
      console.log(`\nAdjudication skeleton written to ${process.argv[emitIdx + 1]} — ` +
        `${ADJUDICATION_SIZE} verdicts, all null. Fill each with "pass" or "fail" and re-run ` +
        `with --adjudication <file>.`);
    }
  } finally {
    console.log("Deleting ephemeral user", userId);
    await sb(`/auth/v1/admin/users/${userId}`, { method: "DELETE" }).catch(e =>
      console.error("cleanup failed:", e.message)
    );
  }
}

main().then(() => {
  // The cleanup in `finally` must run before we exit, which is why the code is
  // set there and read here rather than thrown.
  process.exit(exitCode);
}).catch(e => {
  console.error(e);
  process.exit(EXIT_CODE.FAIL);
});
