/**
 * Telegraph §25.1 Phase 0 — the mandatory inventory, generated and re-checked.
 *
 * §25.1: "Inspect existing messaging schema, migrations, RLS, client routes,
 * realtime subscriptions, push flow, media upload paths, translation paths and
 * current enum literals." Appendix B makes it PR T0: "Inventory report only."
 *
 * The census scored it NOT-BUILT with a precise observation — "The T0 inventory
 * artifact does not exist… The *capability* to do it exists as standing CI lanes
 * (T297); the deliverable does not."
 *
 * WHY A GENERATOR AND NOT A DOCUMENT
 * ----------------------------------
 * Because an inventory written by hand is out of date the day after it is
 * written, and an out-of-date inventory is worse than none: it is a document
 * people quote. This reads the tree on every run and rewrites the report, and
 * `--check` fails when the committed report no longer matches what the tree
 * says. So the artifact exists AND cannot silently rot, which is the only
 * version of "inventory" worth having.
 *
 * WHY THERE ARE NO LINE NUMBERS IN THE OUTPUT
 * -------------------------------------------
 * Deliberate. A generated `file.ts:1234` citation is invalidated by any edit
 * above it in a file this lane does not own, and the repository's own
 * check:doc-citations would then go red for a reason nobody caused. The report
 * names files, tables, routes, event types and literals — the facts an inventory
 * is for — and every one of them is re-derived on each run.
 *
 * Usage:
 *   node --import tsx/esm src/scripts/generateTelegraphInventory.ts           # write
 *   node --import tsx/esm src/scripts/generateTelegraphInventory.ts --check   # verify
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { RLS_DISPOSITIONS } from "./rlsDispositions.js";
import {
  TELEGRAPH_SHARE_PRODUCERS,
  TELEGRAPH_DYNAMIC_SHARE_PRODUCERS,
} from "../domain/telegraph/policies/shareAuthorizationPolicy.js";
import { TELEGRAPH_PROJECTION_BYPASSES } from "../domain/telegraph/projections/projectionRegistry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");
const OUT = resolve(REPO_ROOT, "docs/architecture/telegraph-phase0-inventory.md");

/** The messaging tables production actually has, per the committed table list. */
const MESSAGING_TABLES = [
  "message_reports",
  "message_requests",
  "message_thread_members",
  "message_threads",
  "message_translations",
  "messages",
  "thread_reports",
  "saved_messages",
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const rel = p.replace(/\\/g, "/");
    if (rel.includes("node_modules") || rel.includes("__tests__") || rel.includes("/test/")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. Schema ─────────────────────────────────────────────────────────────────

function schemaSection(): string[] {
  const lines: string[] = ["### 1. Messaging schema", ""];
  const baselinePath = resolve(PKG_ROOT, "baseline/20260819_baseline_structure.sql");
  const prodPath = resolve(PKG_ROOT, "baseline/20260907_production_tables.txt");
  const baseline = existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : "";
  const prod = existsSync(prodPath) ? readFileSync(prodPath, "utf8") : "";

  lines.push("| table | in production table list | columns in baseline | RLS disposition |");
  lines.push("| --- | --- | --- | --- |");
  for (const t of MESSAGING_TABLES) {
    const inProd = new RegExp(`(^|\\s)${t}(\\s|$)`, "m").test(prod) ? "yes" : "NO";
    const create = baseline.match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?public\\.${t} \\(([\\s\\S]*?)\\n\\);`, "m"));
    const cols = create
      ? create[1].split("\n").filter((l) => l.trim() && !/^\s*(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN)/i.test(l)).length
      : 0;
    const disp = (RLS_DISPOSITIONS as Record<string, { class?: string } | undefined>)[t];
    lines.push(`| \`${t}\` | ${inProd} | ${cols || "—"} | ${disp?.class ?? "not dispositioned"} |`);
  }
  lines.push("");
  return lines;
}

// ── 2. Migrations ─────────────────────────────────────────────────────────────

function migrationSection(): string[] {
  const dir = resolve(PKG_ROOT, "src/migrations");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    if (MESSAGING_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(src))) hits.push(f);
  }
  return [
    "### 2. Migrations that touch a messaging table",
    "",
    `${hits.length} of ${files.length} migration files reference at least one messaging table.`,
    "",
    ...hits.map((f) => `- \`src/migrations/${f}\``),
    "",
  ];
}

// ── 3. Server routes ──────────────────────────────────────────────────────────

function routeSection(): string[] {
  const dir = resolve(PKG_ROOT, "src/routes");
  const rows: Array<{ file: string; methods: number; tables: string[] }> = [];
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    const tables = MESSAGING_TABLES.filter((t) => new RegExp(`from\\(['"]${t}['"]\\)`).test(src));
    if (tables.length === 0) continue;
    const methods = (src.match(/router\.(get|post|patch|put|delete)\(/g) ?? []).length;
    rows.push({ file: relative(PKG_ROOT, file), methods, tables });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  return [
    "### 3. Server routes that read or write a messaging table",
    "",
    "| route file | route declarations in file | messaging tables touched |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| \`${r.file}\` | ${r.methods} | ${r.tables.join(", ")} |`),
    "",
  ];
}

// ── 4. Client direct reads ────────────────────────────────────────────────────

function clientSection(): string[] {
  return [
    "### 4. Direct client reads of a messaging table (§24's closing rule)",
    "",
    "Enforced shrink-only by `check:telegraph-slos`; declared in",
    "`src/domain/telegraph/projections/projectionRegistry.ts`.",
    "",
    "| client file | table |",
    "| --- | --- |",
    ...TELEGRAPH_PROJECTION_BYPASSES.map((b) => `| \`${b.file}\` | ${b.table} |`),
    "",
  ];
}

// ── 5. Realtime ───────────────────────────────────────────────────────────────

function realtimeSection(): string[] {
  const events = resolve(PKG_ROOT, "src/lib/telegraphEvents.ts");
  const src = existsSync(events) ? readFileSync(events, "utf8") : "";
  const block = src.match(/export type TelegraphEventType =([\s\S]*?);/);
  const kinds = block ? [...block[1].matchAll(/"([a-z._]+)"/g)].map((m) => m[1]).sort() : [];
  const stream = resolve(PKG_ROOT, "src/routes/telegraphStream.ts");
  const streamSrc = existsSync(stream) ? readFileSync(stream, "utf8") : "";
  const endpoints = [...streamSrc.matchAll(/router\.(get|post)\(\s*['"]([^'"]+)['"]/g)].map(
    (m) => `${m[1].toUpperCase()} ${m[2]}`,
  );
  return [
    "### 5. Realtime subscriptions",
    "",
    `Transport: server-sent events. Endpoints in \`src/routes/telegraphStream.ts\`: ${
      endpoints.length ? endpoints.map((e) => `\`${e}\``).join(", ") : "none found"
    }.`,
    "",
    `Bus: \`src/lib/telegraphEvents.ts\`, in-memory, lossy by design, with a cross-instance`,
    "hook in `src/lib/telegraphBroadcast.ts`.",
    "",
    `${kinds.length} event types:`,
    "",
    ...kinds.map((k) => `- \`${k}\``),
    "",
  ];
}

// ── 6. Push / notification flow ───────────────────────────────────────────────

function pushSection(): string[] {
  const dir = resolve(PKG_ROOT, "src/services/notifications");
  const files = existsSync(dir) ? walk(dir).map((f) => relative(PKG_ROOT, f)).sort() : [];
  const router = resolve(PKG_ROOT, "src/services/notifications/NotificationRouter.ts");
  const writesMessages = existsSync(router) && /from\('messages'\)[\s\S]{0,200}insert/.test(readFileSync(router, "utf8"));
  return [
    "### 6. Push and notification flow",
    "",
    ...files.map((f) => `- \`${f}\``),
    "",
    writesMessages
      ? "`NotificationRouter` writes a `msg_type: 'system'` message into a thread, with the notification's own event type as the `subtype` — so the Telegraph subtype vocabulary is, in practice, the notification event vocabulary."
      : "No notification service writes into `messages`.",
    "",
  ];
}

// ── 7. Media upload ───────────────────────────────────────────────────────────

function mediaSection(): string[] {
  const routes = resolve(PKG_ROOT, "src/routes/messaging.ts");
  const src = existsSync(routes) ? readFileSync(routes, "utf8") : "";
  const mediaRoute = /router\.post\('\/threads\/:threadId\/media'/.test(src);
  // Read from the VALIDATION, not from a column reference: the route refuses
  // anything that is not one of these, and that refusal is the vocabulary.
  const accepted = [...src.matchAll(/mediaTypeRaw !== '([a-z]+)'/g)].map((m) => m[1]);
  return [
    "### 7. Media upload paths",
    "",
    mediaRoute
      ? "`POST /api/threads/:threadId/media` in `src/routes/messaging.ts`."
      : "No thread media route found.",
    `Accepted media kinds referenced on that path: ${
      accepted.length ? [...new Set(accepted)].sort().join(", ") : "none detected"
    }.`,
    "",
    "Processing and EXIF policy: `src/lib/mediaProcessing.ts`. Access: `src/lib/mediaAccess.ts`.",
    "",
  ];
}

// ── 8. Translation ────────────────────────────────────────────────────────────

function translationSection(): string[] {
  const svc = resolve(PKG_ROOT, "src/services/messageTranslation.ts");
  const exists = existsSync(svc);
  const src = exists ? readFileSync(svc, "utf8") : "";
  const exported = [...src.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
  return [
    "### 8. Translation paths",
    "",
    exists ? "`src/services/messageTranslation.ts` — per-recipient rows in `message_translations`." : "No translation service.",
    "",
    ...exported.map((f) => `- \`${f}()\``),
    "",
  ];
}

// ── 9. Enum literals ──────────────────────────────────────────────────────────

function enumSection(): string[] {
  const byColumn: Record<string, string[]> = { msg_type: [], subtype: [] };
  for (const d of TELEGRAPH_SHARE_PRODUCERS) byColumn[d.column].push(d.literal);
  for (const k of Object.keys(byColumn)) byColumn[k] = [...new Set(byColumn[k])].sort();
  return [
    "### 9. Current enum literals",
    "",
    `\`msg_type\`: ${byColumn.msg_type.map((l) => `\`${l}\``).join(", ")}`,
    "",
    `\`subtype\` (static literals): ${byColumn.subtype.map((l) => `\`${l}\``).join(", ")}`,
    "",
    `${TELEGRAPH_DYNAMIC_SHARE_PRODUCERS.length} site(s) COMPUTE a message type rather than writing a literal, so no`,
    "fixed enumeration of `subtype` is complete. They are declared in",
    "`src/domain/telegraph/policies/shareAuthorizationPolicy.ts` and re-derived by",
    "`check:telegraph-share-producers`:",
    "",
    // The expressions contain backticks (they are template literals), so they
    // are rendered inside a double-backtick span with padding — the CommonMark
    // way to quote code that itself contains a backtick. Rendering them in a
    // single-backtick span silently breaks the list, which is the kind of thing
    // a generated document does once and then carries forever.
    ...TELEGRAPH_DYNAMIC_SHARE_PRODUCERS.map(
      (d) => `- \`${d.file}\` — \`\` ${d.expression} \`\`${d.writesMessages ? "" : " (parser / passthrough, writes no message)"}`,
    ),
    "",
  ];
}

// ── Assemble ──────────────────────────────────────────────────────────────────

function render(): string {
  return [
    "# Telegraph Phase 0 — mandatory inventory",
    "",
    "**Generated. Do not edit by hand.**",
    "`node --import tsx/esm artifacts/api-server/src/scripts/generateTelegraphInventory.ts`",
    "rewrites this file; `--check` fails when it no longer matches the tree, and that",
    "check runs in `check:all`.",
    "",
    "This is the deliverable Telegraph §25.1 calls the mandatory Phase 0 inventory and",
    "Appendix B calls PR T0 — \"Inventory report only: current schema, paths, RLS, enums,",
    "realtime, media, direct writes, source-domain bridges\". It is generated rather than",
    "written because an inventory written by hand is stale the next day, and a stale",
    "inventory is worse than none: it is a document people quote.",
    "",
    "It carries no `file:line` citations on purpose — a generated line number is",
    "invalidated by any edit above it, in files this report does not own. What it names",
    "are files, tables, routes, event types and literals, each re-derived on every run.",
    "",
    "---",
    "",
    ...schemaSection(),
    ...migrationSection(),
    ...routeSection(),
    ...clientSection(),
    ...realtimeSection(),
    ...pushSection(),
    ...mediaSection(),
    ...translationSection(),
    ...enumSection(),
    "---",
    "",
    "## What this inventory does NOT establish",
    "",
    "- **That any of it is correct.** It records what is there, not whether it is right.",
    "  The verdicts live in `docs/architecture/census-telegraph.md`.",
    "- **That the production schema matches.** The table list column is read from a",
    "  committed snapshot, not from a live database. `check:production-drift` and",
    "  `check:missing-live-columns` are the lanes that compare against the real thing.",
    "- **Completeness of the `subtype` vocabulary.** Several sites compute it; §9 says",
    "  which, and that is a bound on this document rather than a gap in it.",
    "",
  ].join("\n");
}

const content = render();
const isCheck = process.argv.includes("--check");

if (isCheck) {
  if (!existsSync(OUT)) {
    console.error("check:telegraph-inventory FAILED — docs/architecture/telegraph-phase0-inventory.md does not exist.");
    console.error("  Run: node --import tsx/esm src/scripts/generateTelegraphInventory.ts");
    process.exit(1);
  }
  const current = readFileSync(OUT, "utf8");
  if (current !== content) {
    const a = current.split("\n");
    const b = content.split("\n");
    const firstDiff = a.findIndex((l, i) => l !== b[i]);
    console.error("check:telegraph-inventory FAILED — the committed Phase 0 inventory no longer matches the tree.");
    console.error(`  First difference at line ${firstDiff + 1}:`);
    console.error(`    committed: ${a[firstDiff] ?? "(end of file)"}`);
    console.error(`    re-derived: ${b[firstDiff] ?? "(end of file)"}`);
    console.error("  Regenerate it in the same commit as the change that moved it.");
    process.exit(1);
  }
  const lines = content.split("\n").length;
  console.log(`check:telegraph-inventory PASSED — ${lines} inventory lines re-derived and identical.`);
  console.log("  DOES NOT COVER: whether anything inventoried is CORRECT — that is the census's job,");
  console.log("  and this only guarantees the list is not stale.");
} else {
  writeFileSync(OUT, content, "utf8");
  // The count line is phrased the same way in both modes on purpose:
  // check:guard-reachability proves a guard LOOKED by running it and reading a
  // declared count out of its output, and it runs this script in its default
  // mode. A count that only appeared under --check would make this guard
  // unprovable, and "nothing is wrong" and "I did not look" would again be
  // indistinguishable.
  console.log(
    `${content.split("\n").length} inventory lines re-derived and written to ${relative(REPO_ROOT, OUT)}.`,
  );
}
