#!/usr/bin/env node
/**
 * Standing 9-question Compass answer-quality eval (docs/compass/master-roadmap.md).
 * Requires: dev API server running and Replit OpenAI AI integration enabled.
 * Usage: node scripts/src/compass-answer-quality-eval.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API = "http://localhost:80/api"; // compass routes are single-prefix: /api/compass/ask

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
  } finally {
    console.log("Deleting ephemeral user", userId);
    await sb(`/auth/v1/admin/users/${userId}`, { method: "DELETE" }).catch(e =>
      console.error("cleanup failed:", e.message)
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
