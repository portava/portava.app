/**
 * census-telegraph T448 / T359 / T445 (lane w-tg-cardtruth, 2026-10-14) — two
 * STRUCTURAL guards behind the reader rule.
 *
 * 1. EVERY SERVER READ OF `messages.body` IS ACCOUNTED FOR.
 *    The reader rule (services/telegraph/sharedCardTruth.ts) is only as good as
 *    the list of readers it was applied to. This guard enumerates every
 *    `.from("messages")` chain in the server tree whose select list carries
 *    `body` and holds the count per file equal to a closed ledger. Each file is
 *    either RE-RESOLVES (it imports sharedCardTruth and serves cards through
 *    it) or EXEMPT with the reason a card body never leaves it. A new body read
 *    anywhere — the next door — turns this red and has to be classified.
 *
 * 2. THE BATCHING LAYER READS ONLY WHAT THE LOADERS LITERALLY NAME.
 *    `coalescedReads.ts` issues `.from(table).select(cols)` with computed
 *    arguments, which check:write-path-columns cannot see (it verifies literal
 *    and same-file-const select lists only). The lead's ruling: cover that
 *    blind spot with a test, not a promise. So a broad resolution run records
 *    every query the batching layer actually issued, and each one must be a
 *    (table, column list) pair that appears LITERALLY somewhere in the server
 *    tree — i.e. one check:write-path-columns already verifies — plus at most
 *    the key columns of the lookup it batched. The static half pins that
 *    coalescedReads.ts names no table and no column of its own.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphSharedCardReaders.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSharedCards } from "../services/telegraph/sharedCardTruth.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. the reader ledger ─────────────────────────────────────────────────────

type Ledger = Record<string, { sites: number; status: "re-resolves" | "exempt"; why: string }>;

export const CARD_BODY_READERS: Ledger = {
  "routes/messaging.ts": { sites: 7, status: "re-resolves",
    why: "GET /threads/:id/messages (2 selects: the page, with/without the sequence column) and its reply quote, GET edits and GET /me/saved-messages re-resolve; the translate-retry read and the PATCH edit read are the sender's/recipient's write path and serve no body." },
  "routes/groupChat.ts": { sites: 2, status: "re-resolves",
    why: "fetchMessagesForThread re-resolves; the second read is PATCH /messages/:id, the sender's own edit." },
  "routes/telegraphKinds.ts": { sites: 1, status: "re-resolves", why: "readIndexableRows feeds the drawer and in-thread search; a card that is not live leaves both." },
  "routes/telegraphMemory.ts": { sites: 2, status: "re-resolves",
    why: "A Memory draft's title is the card's live title; the recap counts objects and returns ids, never a card's text." },
  "services/telegraphSearch.ts": { sites: 2, status: "re-resolves", why: "§21 search: the body match and the card-row read (cardRowsInScope) both feed one re-resolution." },
  "compass/TelegraphConversationTools.ts": { sites: 1, status: "re-resolves", why: "Compass getSharedPlaces: each card re-resolved for the caller; a card that is not live is available:false." },
  "services/telegraph/inboxReads.ts": { sites: 2, status: "exempt",
    why: "Helpers: the column list is the CALLER's; the caller that selects body (GET /me/threads) serves the withheld card body (withheldCardBody)." },
  "routes/telegraphCoordination.ts": { sites: 12, status: "exempt",
    why: "Reads only §8/§6.2 envelopes through parseCoordinationEnvelope / parseKindEnvelope, keyed on msg_type — a legacy card never parses as one; the catch-up names a card by kind and id only (catchUp.ts titleOf reads envelope payloads)." },
  "routes/telegraphLifecycle.ts": { sites: 3, status: "exempt", why: "Receipts and the seen threshold: timestamps and ids; no body is returned." },
  "routes/telegraphForward.ts": { sites: 1, status: "exempt", why: "forwardShapeOf refuses a legacy card ('other'); nothing is copied or served." },
  "services/telegraph/coordinationSessions.ts": { sites: 1, status: "exempt", why: "Coordination-session envelopes only." },
  "services/telegraph/sharedRideWrites.ts": { sites: 1, status: "exempt", why: "Ride proposal envelopes only." },
  "services/telegraph/lifecycleSweep.ts": { sites: 1, status: "exempt", why: "Server sweep over §6.2 envelopes; serves nothing." },
  "services/telegraph/shareables.ts": { sites: 1, status: "exempt", why: "loadLayoverPlan reads its own layover reference message to authorize; serves no card body." },
  "services/messageTranslation.ts": { sites: 1, status: "exempt",
    why: "The translation pipeline's input: readTranslationSource (kernel/legacy ternary select) — and it refuses a card outright (isStructuredEnvelopeBody(message.body) returns null, services/messageTranslation.ts:526), so no card body is ever translated. Its OUTPUT for a card is never served: every re-resolving reader excludes card rows from the translation read. The stamp UPDATE…select at :401 is a write's returning row compared against the expected source, and is not counted." },
  "services/telegraphReliability.ts": { sites: 1, status: "exempt", why: "Idempotent resend: replays the SENDER's own just-written row to the sender." },
  "lib/liveReferenceMessages.ts": { sites: 1, status: "exempt",
    why: "Read through the MESSAGES_TABLE const (fix round 1, F2). GET /telegraph/live-references/:messageId (flag telegraph_live_references_enabled, seeded OFF) reads its OWN server-authored live-claim reference — msg_type card / subtype live_reference, refused for any other subtype — and compares it with the current claims; it is a reference by design, not a legacy card's snapshot." },
  "services/telegraphReportEvidence.ts": { sites: 2, status: "exempt",
    why: "Moderation evidence, moderators only, captured at report time (lead ruling Q-L23 / D-38a)." }, "routes/telegraphLinkPreview.ts": { sites: 2, status: "exempt", why: "B58 TM-1 (T404/T446, flag telegraph_link_previews_enabled seeded OFF): the POST reads the SENDER's own plain-text body to take its first link and hash it; the GET hashes each body to check the stored preview still describes it. Neither serves a body, and a card (msg_type not text) is never previewed." }, "services/telegraph/catchUp.ts": { sites: 1, status: "exempt", why: "census-telegraph T267: readViewerCatchUp is GET /threads/:id/catch-up's read for ONE caller (Compass getConversationContext) and feeds projectCatchUp, which reads only §8/§6.2 envelopes and names a card by kind and id (titleOf reads envelope payloads); a legacy card never parses as one, so no card body is served." }, // on this line so cited lines below hold
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "migrations" || name === "node_modules" || name === "scripts") continue;
      walk(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The first argument of the call whose `(` is at `open`, scanned with string and nesting awareness. */
function firstArg(src: string, open: number): string {
  let depth = 0, i = open + 1, quote: string | null = null, out = "";
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += src[++i] ?? ""; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    if (ch === ")" || ch === "}" || ch === "]") { if (depth === 0) break; depth--; }
    if (ch === "," && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

/**
 * The select argument of the READ chain starting at a `.from(...)` at `at`,
 * resolved to text when it is a literal or a same-file const. A chain that
 * writes before it selects (`.insert(…).select(…)`) is a write's echo, not a
 * read, and returns null.
 */
function selectArgAfter(src: string, at: number): { text: string | null; raw: string } | null {
  const window = src.slice(at, at + 900);
  const nextFrom = window.indexOf(".from(", 6);
  const chain = nextFrom > 0 ? window.slice(0, nextFrom) : window;
  const sel = chain.indexOf(".select(");
  if (sel < 0) return null;
  if (/\.(insert|update|upsert|delete)\(/.test(chain.slice(0, sel))) return null;
  const arg = firstArg(chain, sel + ".select".length);
  const lit = /^(["'`])([\s\S]*)\1$/.exec(arg);
  if (lit) return { text: lit[2], raw: arg };
  const id = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(arg)?.[1];
  if (id) {
    const c = new RegExp(`const\\s+${id}\\s*=\\s*(["'\`])([\\s\\S]*?)\\1`).exec(src);
    if (c) return { text: c[2], raw: arg };
  }
  return { text: null, raw: arg };
}

/** `const NAME = "literal"` (exported or not) in one source file. */
function stringConsts(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(["'`])([^"'`$]*)\2/g)) out.set(m[1]!, m[3]!);
  return out;
}

/** The module a relative import names, as a key of `files` (`.js` → `.ts`, `/index`). */
function importTarget(fromPath: string, spec: string, files: Record<string, string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = join(dirname(fromPath), spec).replace(/\\/g, "/");
  for (const cand of [base.replace(/\.js$/, ".ts"), `${base}.ts`, base, `${base}/index.ts`]) if (cand in files) return cand;
  return null;
}

/**
 * Every identifier a file can pass to `.from(…)` that resolves to a string:
 * its own consts and the string consts it IMPORTS by name (`{ A }`, `{ A as B }`).
 * Fix round 1 (verifier F2): `lib/liveReferenceMessages.ts` read `messages.body`
 * through `MESSAGES_TABLE`, a const the literal-only matcher could not see — and
 * any other door could import it to walk past this ledger the same way.
 */
function tableNamesIn(path: string, src: string, files: Record<string, string>): Map<string, string> {
  const names = stringConsts(src);
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = importTarget(path, m[2]!, files);
    if (!target) continue;
    const exported = stringConsts(files[target]!);
    for (const spec of m[1]!.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [orig, alias] = spec.replace(/^type\s+/, "").split(/\s+as\s+/).map((x) => x.trim());
      const v = exported.get(orig!);
      if (v !== undefined) names.set(alias ?? orig!, v);
    }
  }
  return names;
}

/** Body-selecting `messages` reads per file. Pure over (path → source) so the test can feed it a mutant. */
export function bodyReadsByFile(files: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path, src] of Object.entries(files)) {
    const names = tableNamesIn(path, src, files);
    const re = /\.from\(\s*(?:(["'`])([A-Za-z_][\w]*)\1|([A-Za-z_$][\w$]*))\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const table = m[2] ?? names.get(m[3]!) ?? null;
      if (table !== "messages") continue;
      const sel = selectArgAfter(src, m.index);
      if (!sel) continue;
      // A non-literal select argument (a ternary between column lists, a call)
      // still reads body when ANY string literal inside it names body — the
      // kernel/legacy ternary in services/messageTranslation.ts
      // readTranslationSource was invisible to the literal-only test.
      const BODY_COL = /(^|[\s,`(])body([\s,`)]|$)/;
      const readsBody = sel.text === null
        ? /columns/i.test(sel.raw) || [...sel.raw.matchAll(/(["'`])([^"'`]*)\1/g)].some((lit) => BODY_COL.test(lit[2]!))
        : BODY_COL.test(sel.text);
      if (readsBody) out[path] = (out[path] ?? 0) + 1;
    }
  }
  return out;
}

function serverTree(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const p of walk(SRC)) files[relative(SRC, p)] = readFileSync(p, "utf8");
  return files;
}

describe("T448 — every server read of messages.body is a re-resolving reader or a stated exemption", () => {
  const tree = serverTree();
  const found = bodyReadsByFile(tree);

  it("the ledger and the tree agree, file by file and count by count", () => {
    const want = Object.fromEntries(Object.entries(CARD_BODY_READERS).map(([f, e]) => [f, e.sites]));
    assert.deepEqual(found, want, "a body read appeared, moved or vanished — classify it in CARD_BODY_READERS");
  });

  it("every re-resolving reader actually goes through sharedCardTruth", () => {
    for (const [file, e] of Object.entries(CARD_BODY_READERS)) {
      if (e.status !== "re-resolves") continue;
      assert.match(tree[file] ?? "", /sharedCardTruth\.js/, `${file} is ledgered as re-resolving and does not use sharedCardTruth`);
    }
  });

  it("every exemption says why", () => {
    for (const [file, e] of Object.entries(CARD_BODY_READERS)) assert.ok(e.why.length > 20, file);
  });

  it("detector self-test: a new body read in any file is seen; a non-body read is not", () => {
    const mutant = {
      "routes/newDoor.ts": 'const { data } = await sc.from("messages").select("id, body").eq("thread_id", t);',
      "routes/fine.ts": 'const { data } = await sc.from("messages").select("id, created_at").eq("thread_id", t);',
      "routes/viaConst.ts": 'const COLS = "id, sender_id, body";\nawait sc.from("messages")\n  .select(COLS)\n  .eq("id", x);',
      // F2: the table named through a const — in the same file, and imported (aliased) from another module.
      "routes/viaTableConst.ts": 'const T = "messages";\nawait sc.from(T).select("id, body").eq("id", x);',
      "lib/tables.ts": 'export const MSG_TABLE = "messages";\nexport const OTHER = "profiles";',
      "routes/viaImport.ts": 'import { MSG_TABLE as M, OTHER } from "../lib/tables.js";\nawait sc.from(M)\n  .select("body, id");\nawait sc.from(OTHER).select("id, body");',
      // A ternary between two column lists: either branch naming body is a body read; neither naming it is not.
      "routes/viaTernary.ts": 'await sc.from("messages")\n  .select(kernel\n    ? "id, body, unsent_at"\n    : "id, body")\n  .eq("id", x);',
      "routes/ternaryFine.ts": 'await sc.from("messages").select(kernel ? "id, unsent_at" : "id").eq("id", x);',
    };
    assert.deepEqual(bodyReadsByFile(mutant), { "routes/newDoor.ts": 1, "routes/viaConst.ts": 1, "routes/viaTableConst.ts": 1, "routes/viaImport.ts": 1, "routes/viaTernary.ts": 1 });
  });
});

// ── 2. the batching layer reads only literal (table, columns) pairs ─────────

/** Every `.from("T") … .select(<literal or same-file const>)` pair in the server tree. */
function literalReadInventory(files: Record<string, string>): Map<string, Set<string>> {
  const inv = new Map<string, Set<string>>();
  for (const src of Object.values(files)) {
    const re = /\.from\(\s*["']([a-z_][a-z0-9_]*)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const sel = selectArgAfter(src, m.index);
      if (!sel || sel.text === null || sel.text.includes("${")) continue;
      const cols = sel.text.split(",").map((c) => c.trim()).filter(Boolean).sort().join(",");
      const set = inv.get(m[1]) ?? new Set<string>();
      set.add(cols);
      inv.set(m[1], set);
    }
  }
  return inv;
}

function recordingFake() {
  const issued: Array<{ table: string; select: string; inCols: string[]; eqCols: string[] }> = [];
  const db: Record<string, any[]> = {
    places: [{ id: "0a000000-0000-4000-8000-000000000001", name: "P", city: "C", neighborhood: null, primary_category: "x", status: "active", updated_at: null }],
    hidden_gems: [{ id: "0a000000-0000-4000-8000-000000000002", name: "G", city: "C", neighborhood: null, category: "x", status: "active", sensitivity_level: "public", merged_into: null, updated_at: null }],
    posts: [{ id: "0a000000-0000-4000-8000-000000000003", author_id: "u2", content: "x", visibility: "public", status: "active", post_status: "published", deleted_at: null, media_urls: [], location_privacy_mode: "exact", created_at: "2026-01-01T00:00:00Z", updated_at: null }],
    profiles: [{ id: "u2", handle: "h", account_status: "active" }],
    rent_buddy_bookings: [{ id: "0a000000-0000-4000-8000-000000000004", buddy_id: "u2", traveler_id: "u1", city: "C", category: "x", booking_date: "2026-01-01", status: "confirmed", updated_at: null }],
    meetups: [{ id: "0a000000-0000-4000-8000-000000000005", creator_id: "u2", title: "M", location_name: null, starts_at: null, status: "pending", visibility: "private", updated_at: null }],
    meetup_invites: [{ meetup_id: "0a000000-0000-4000-8000-000000000005", user_id: "u1", status: "going" }],
    trips: [{ id: "0a000000-0000-4000-8000-000000000006", owner_id: "u2", title: "T", destination_city: "C", start_date: null, end_date: null, status: "active", visibility: "public", cover_url: null, show_destination_city: true, show_exact_dates: true, show_header_publicly: false, updated_at: null }],
    events: [{ id: "0a000000-0000-4000-8000-000000000007", host_id: "u2", title: "E", city: "C", starts_at: null, state: "open", visibility: "public", cover_url: null, circle_id: null, trip_id: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, updated_at: null }],
    blocks: [],
  };
  function from(table: string) {
    const rec = { table, select: "", inCols: [] as string[], eqCols: [] as string[] };
    const preds: Array<(r: any) => boolean> = [];
    let single = false;
    let lim: number | null = null;
    const b: any = {
      select(s?: string) { rec.select = s ?? ""; return b; },
      eq(c: string, v: unknown) { rec.eqCols.push(c); preds.push((r) => String(r[c]) === String(v)); return b; },
      in(c: string, vs: unknown[]) { rec.inCols.push(c); const s = new Set(vs.map(String)); preds.push((r) => s.has(String(r[c]))); return b; },
      is() { return b; }, neq() { return b; }, order() { return b; }, gte() { return b; }, lte() { return b; }, or() { return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { single = true; return b; },
      then(res: (v: any) => unknown, rej?: (e: unknown) => unknown) {
        issued.push(rec);
        let rows = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
        if (lim !== null) rows = rows.slice(0, lim);
        return Promise.resolve(single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }).then(res, rej);
      },
    };
    return new Proxy(b, { get(t, p) { if (p in t) return t[p as string]; if (p === "catch" || p === "finally") return undefined; return () => b; } });
  }
  return { issued, client: { from, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }) } as any };
}

describe("T448 — the batching layer re-issues only column lists the guard already verifies", () => {
  it("coalescedReads.ts names no table and no column of its own", () => {
    const src = readFileSync(join(SRC, "services/telegraph/coalescedReads.ts"), "utf8");
    assert.doesNotMatch(src, /\.from\(\s*["'`]/, "a literal .from() in the batching layer would be a read of its own");
    assert.doesNotMatch(src, /\.select\(\s*["'`]/, "a literal .select() in the batching layer would be a column list of its own");
  });

  it("every query a broad resolution run issued is a literal (table, columns) pair of the tree, plus only its lookup keys", async () => {
    const inventory = literalReadInventory(serverTree());
    const { issued, client } = recordingFake();
    const cards = [
      { msg_type: "system", subtype: "discovery_card", body: JSON.stringify({ sourceId: "0a000000-0000-4000-8000-000000000001", sourceType: "place" }) },
      { msg_type: "system", subtype: "discovery_card", body: JSON.stringify({ sourceId: "0a000000-0000-4000-8000-000000000002", sourceType: "gem" }) },
      { msg_type: "system", subtype: "discovery_card", body: JSON.stringify({ sourceId: "0a000000-0000-4000-8000-000000000006", sourceType: "trip" }) },
      { msg_type: "system", subtype: "post_card", body: JSON.stringify({ postId: "0a000000-0000-4000-8000-000000000003" }) },
      { msg_type: "system", subtype: "compass_card", body: JSON.stringify({ id: "0a000000-0000-4000-8000-000000000007", cardType: "event" }) },
      { msg_type: "card", subtype: "hidden_gem", body: JSON.stringify({ gemId: "0a000000-0000-4000-8000-000000000002" }) },
      { msg_type: "booking_card", subtype: "booking_status_confirmed", body: JSON.stringify({ booking_id: "0a000000-0000-4000-8000-000000000004" }) },
      { msg_type: "system", subtype: "meetup", body: JSON.stringify({ meetupId: "0a000000-0000-4000-8000-000000000005" }) },
    ].map((r, i) => ({ row: { id: `m${i}`, thread_id: "th1", ...r } }));
    const truth = await resolveSharedCards(client, "u1", cards);
    assert.equal(truth.size, cards.length);

    const batched = issued.filter((q) => q.inCols.length > 0);
    assert.ok(batched.length >= 5, `expected the run to batch reads, saw ${batched.length}`);
    for (const q of issued) {
      const cols = q.select.split(",").map((c) => c.trim()).filter(Boolean);
      const keys = new Set([...q.inCols, ...q.eqCols, "id"]);
      const known = [...(inventory.get(q.table) ?? [])].map((s) => s.split(","));
      const ok = known.some((lit) => lit.every((c) => cols.includes(c)) && cols.every((c) => lit.includes(c) || keys.has(c)));
      assert.ok(ok, `the batching layer issued ${q.table}(${q.select}) — not a literal column list of the tree plus its keys`);
    }
  });
});
