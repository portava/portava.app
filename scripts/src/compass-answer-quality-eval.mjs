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
 *   0  PASS        every machine criterion green AND all twelve measures judged pass
 *   1  FAIL        a machine criterion is red, or a measure was judged fail
 *   2  INCOMPLETE  machine criteria green, at least one measure unjudged.
 *                  NOT a pass. A run cannot certify its own semantic quality.
 *
 * Requires: a WRITABLE Supabase project (this script creates and deletes an
 * ephemeral auth user), an API server on API_BASE_URL, COMPASS_ENABLED true on
 * that project, and a model provider. docs/compass/nine-query-eval-runbook.md
 * names all five and where each is read. NEVER point this at production.
 *
 * Usage: node scripts/src/compass-answer-quality-eval.mjs [--adjudication <file.json>]
 */
import {
  evaluateTierA, evaluateTierB, verdictOf, formatReport, EXIT_CODE,
} from "./compass-eval-criteria.mjs";
import { readFileSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Hardcoding this to localhost:80 is why the eval had only ever run on one
// machine: port 80 needs privilege or a proxy, and nothing could point it
// elsewhere. Env-configurable, same default, so an existing invocation is
// unchanged.
const API = process.env.COMPASS_EVAL_API_BASE_URL ?? "http://localhost:80/api"; // compass routes are single-prefix: /api/compass/ask

const QUESTIONS = [
  "What should I do in Cebu?",
  "What did you mean?",
  "Which one is closer?",
  "Add the second one.",
  "Find something romantic but not a date.",
  "I'm traveling alone tonight.",
  "Find my circle.",
  "I'm tired.",
  "My event was canceled.",
];

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

      // Quick summary of non-empty uiBlocks
      const blockSummary = uiBlocks.map(b => {
        const type = b.type ?? b.kind ?? "?";
        const itemCount = Array.isArray(b.items) ? b.items.length : (b.item ? 1 : 0);
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
      console.log(`  intent: ${JSON.stringify(r.intent)}`);
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
