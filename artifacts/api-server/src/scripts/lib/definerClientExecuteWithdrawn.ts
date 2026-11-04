/**
 * definerClientExecuteWithdrawn — the offline ratchet behind migration 3985.
 *
 * 3985 withdraws client EXECUTE from nine SECURITY DEFINER functions (from PUBLIC, anon and
 * authenticated on six; from PUBLIC and anon on three) and pins search_path on ten functions. The
 * house does not change Supabase's default privileges (2973 says why), so nothing in the database
 * stops a later migration from quietly putting any of it back. This file is what does: it reads the
 * migration corpus and fails on the shapes that would.
 *
 *   R0  the closing migration exists and makes exactly the statements listed here — the lists below
 *       and the file are one decision, so they cannot drift apart.
 *   R1  a later GRANT of EXECUTE (or ALL) on a withdrawn function to PUBLIC or to a role it was
 *       withdrawn from, or a later GRANT on ALL FUNCTIONS IN SCHEMA public to a client role.
 *   R2  a later DROP FUNCTION, or a plain CREATE FUNCTION, of a withdrawn function with no matching
 *       REVOKE in the same file (a new function gets the default grants back), or an ALTER FUNCTION
 *       that renames it, moves its schema or changes its owner (update these lists in that change).
 *   R3  a later CREATE OR REPLACE of a pinned function whose header has no SET search_path (a
 *       replacement keeps only the settings it states), an ALTER FUNCTION ... RESET search_path,
 *       RESET ALL or SET search_path TO DEFAULT, or a DROP with no pinned re-create in the same file.
 *       A pg_get_functiondef transform (2787's method) re-installs the definition with its settings, so
 *       it keeps the pin and is not a finding.
 *   R4  a surviving policy (CREATE, DROP and ALTER POLICY replayed over the whole corpus, including
 *       inside DO blocks) that calls a withdrawn function and applies to PUBLIC or to a role it was
 *       withdrawn from: that policy would raise "permission denied for function" for that role.
 *   R5  a later view, or a later SECURITY INVOKER function, that calls a withdrawn non-trigger function:
 *       the call is checked as the caller, who may no longer hold EXECUTE.
 *
 * WHAT IT DOES NOT COVER: the live database (the migration's own precondition and postcondition check
 * that, and certify stage 4 re-runs the postcondition), dynamic SQL whose function names are built at
 * run time, and grants made by hand.
 *
 * No function here is named by a bare string literal: checkSecurityDefinerOracles counts any bare name
 * literal in src/ as a reference, and event_is_in_state is ledgered there as referenced by nothing.
 * Names are derived from the signatures.
 */
import { stripSqlComments, splitStatements } from "./canonicalSchema.js";

export const DEFINER_EXECUTE_CLOSED_BY = "3985_definer_client_execute_and_search_path_pins.sql";

export type WithdrawnRole = "anon" | "authenticated";

export interface WithdrawnExecute {
  /** The signature exactly as 3985 writes it. */
  readonly signature: string;
  /** The client roles 3985 withdrew EXECUTE from (PUBLIC always as well). */
  readonly withdrawnFrom: readonly WithdrawnRole[];
  /** RETURNS trigger: never callable as a function, so R4 and R5 do not apply. */
  readonly triggerFn: boolean;
  readonly why: string;
}

export const WITHDRAWN_CLIENT_EXECUTE: readonly WithdrawnExecute[] = [
  { signature: "public.add_owner_as_member()", withdrawnFrom: ["anon", "authenticated"], triggerFn: true, why: "trigger function on trips" },
  { signature: "public.enforce_is_official_privileged()", withdrawnFrom: ["anon", "authenticated"], triggerFn: true, why: "trigger function on profiles" },
  { signature: "public.enforce_profile_role_privileged()", withdrawnFrom: ["anon", "authenticated"], triggerFn: true, why: "trigger function on profiles" },
  { signature: "public.enforce_trip_max_members()", withdrawnFrom: ["anon", "authenticated"], triggerFn: true, why: "trigger function on trip_members" },
  { signature: "public.handle_new_user()", withdrawnFrom: ["anon", "authenticated"], triggerFn: true, why: "trigger function on auth.users" },
  {
    signature: "public.event_is_in_state(uuid, public.event_state[])",
    withdrawnFrom: ["anon", "authenticated"],
    triggerFn: false,
    why: "referenced by nothing; an event existence-and-state oracle (SECURITY_DEFINER_ORACLES.json, HOLD)",
  },
  { signature: "public.can_post_to_trip(uuid)", withdrawnFrom: ["anon"], triggerFn: false, why: "its one policy, posts_insert, is TO authenticated" },
  { signature: "public.user_is_event_participant(uuid)", withdrawnFrom: ["anon"], triggerFn: false, why: "its one policy, events_participant_read, is TO authenticated" },
  {
    signature: "public.is_accepted_trip_member(uuid)",
    withdrawnFrom: ["anon"],
    triggerFn: false,
    why: "no policy names it; its callers are SECURITY DEFINER. authenticated kept for 2973 postcondition 4",
  },
];

export const PINNED_SEARCH_PATH: readonly string[] = [
  "public.canonical_events_append_only()",
  "public.input_normalize_city_key(text)",
  "public.stories_freeze_deleted_at()",
  "public.trip_presence_freshness(timestamptz, timestamptz, timestamptz)",
  "public.trip_reservation_events_append_only()",
  "public.trip_reservation_events_no_direct_delete()",
  "public.trip_snapshot_fold(jsonb, jsonb)",
  "public.trip_snapshot_fold_all(jsonb, jsonb[])",
  "public.trip_snapshot_replay(uuid, jsonb, bigint, bigint)",
  "public.trip_snapshot_seed(uuid)",
];

/** "public.x(uuid)" -> "x". */
export function fnName(signature: string): string {
  const m = /^public\.([a-z0-9_]+)\(/.exec(signature);
  if (!m) throw new Error(`not a public function signature: ${signature}`);
  return m[1]!;
}

/** The exact statements 3985 must make, whitespace-normalised, without the trailing semicolon. */
export function expectedClosingStatements(): string[] {
  const out: string[] = [];
  for (const w of WITHDRAWN_CLIENT_EXECUTE) {
    out.push(`REVOKE ALL ON FUNCTION ${w.signature} FROM PUBLIC, ${w.withdrawnFrom.join(", ")}`);
    const keep = w.withdrawnFrom.includes("authenticated") ? "service_role" : "authenticated, service_role";
    out.push(`GRANT EXECUTE ON FUNCTION ${w.signature} TO ${keep}`);
  }
  for (const sig of PINNED_SEARCH_PATH) out.push(`ALTER FUNCTION ${sig} SET search_path = ''`);
  return out;
}

export interface CorpusFile {
  /** Path as the caller names it; the closing migration is found by its basename. */
  readonly file: string;
  readonly sql: string;
}

export interface RegressionStats {
  closingIndex: number;
  laterFiles: number;
  policiesSurviving: number;
  /** Surviving policies that call a withdrawn function for a role that keeps EXECUTE (the allowed edges). */
  guardedPolicyEdges: number;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
const unquote = (s: string): string => s.replace(/"/g, "").trim().toLowerCase();

/**
 * Statements, comments stripped. A DO block is replaced by the statements inside its body, so a GRANT
 * or CREATE POLICY written in plpgsql is read exactly once and with its own boundaries.
 */
function fragments(sql: string): string[] {
  const out: string[] = [];
  for (const raw of splitStatements(stripSqlComments(sql))) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const m = /^DO\s+(?:LANGUAGE\s+\w+\s+)?(\$[A-Za-z0-9_]*\$)/i.exec(stmt);
    const end = m ? stmt.indexOf(m[1]!, m[0].length) : -1;
    if (!m || end < 0) {
      out.push(stmt);
      continue;
    }
    for (const inner of splitStatements(stmt.slice(m[0].length, end))) {
      const s = inner.trim().replace(/^(?:DECLARE[\s\S]*?\bBEGIN\b|BEGIN\b)\s*/i, "");
      if (s) out.push(s);
    }
  }
  return out;
}

/** Does `text` call public.<name>( or an unqualified <name>( — never another schema's same name. */
function callsFn(text: string, name: string): boolean {
  return new RegExp(`(?:^|[^.\\w"])"?${name}"?\\s*\\(|\\bpublic\\."?${name}"?\\s*\\(`, "i").test(text);
}

/** Function names (public or unqualified) listed in a GRANT/REVOKE/DROP object list. */
function listedFunctions(objects: string): string[] {
  // Split on top-level commas only: an argument list carries commas of its own, and PostgreSQL also
  // accepts a function named without one when the name is unambiguous.
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of objects) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  const out: string[] = [];
  for (const item of items) {
    const m = /^\s*(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?\s*(?:\(|$)/.exec(item);
    const schema = m?.[1]?.toLowerCase();
    if (m && (schema === undefined || schema === "public")) out.push(m[2]!.toLowerCase());
  }
  return out;
}

function roleList(s: string): string[] {
  return s.split(",").map((r) => unquote(r.replace(/^\s*GROUP\s+/i, ""))).filter(Boolean);
}

/** Roles a fragment REVOKEs EXECUTE (or ALL) on `name` from. */
function revokedRoles(frag: string, name: string): string[] {
  const m = /\bREVOKE\s+(?:GRANT\s+OPTION\s+FOR\s+)?(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+(?:FUNCTION|ROUTINE)S?\s+([\s\S]+?)\s+FROM\s+([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT|GRANTED\s+BY\s+\S+))*\s*;?\s*$/i.exec(frag);
  if (!m || !listedFunctions(m[1]!).includes(name)) return [];
  return roleList(m[2]!);
}

/** Text inside the parentheses that open at `open` (balanced), or "" when unbalanced. */
function parenBody(s: string, open: number): string {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return "";
}

interface Policy { roles: string[]; using: string; check: string; file: string }

function policyExprs(rest: string): { using?: string; check?: string } {
  const out: { using?: string; check?: string } = {};
  const u = /\bUSING\s*\(/i.exec(rest);
  if (u) out.using = parenBody(rest, u.index + u[0].length - 1);
  const c = /\bWITH\s+CHECK\s*\(/i.exec(rest);
  if (c) out.check = parenBody(rest, c.index + c[0].length - 1);
  return out;
}

function policyRoles(rest: string): string[] | null {
  const head = rest.split(/\bUSING\b|\bWITH\s+CHECK\b/i)[0]!;
  const m = /\bTO\s+([\s\S]+?)\s*;?\s*$/i.exec(head);
  return m ? roleList(m[1]!) : null;
}

const POL_TARGET = String.raw`("[^"]+"|[A-Za-z0-9_%]+)\s+ON\s+((?:"?[A-Za-z0-9_]+"?\.)?"?[A-Za-z0-9_%]+"?)`;
const CREATE_POLICY = new RegExp(String.raw`\bCREATE\s+POLICY\s+${POL_TARGET}([\s\S]*)$`, "i");
const DROP_POLICY = new RegExp(String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?${POL_TARGET}`, "i");
const ALTER_POLICY = new RegExp(String.raw`\bALTER\s+POLICY\s+${POL_TARGET}([\s\S]*)$`, "i");

function polKey(name: string, table: string): string {
  const t = unquote(table);
  return `${t.includes(".") ? t : `public.${t}`}::${unquote(name)}`;
}

export function findDefinerExecuteRegressions(corpus: readonly CorpusFile[]): { problems: string[]; stats: RegressionStats } {
  const problems: string[] = [];
  const withdrawn = new Map(WITHDRAWN_CLIENT_EXECUTE.map((w) => [fnName(w.signature), w]));
  const pinned = new Set(PINNED_SEARCH_PATH.map(fnName));
  const closingIndex = corpus.findIndex((f) => f.file === DEFINER_EXECUTE_CLOSED_BY || f.file.endsWith(`/${DEFINER_EXECUTE_CLOSED_BY}`));

  // R0
  if (closingIndex < 0) {
    problems.push(`::error::${DEFINER_EXECUTE_CLOSED_BY} is missing from the migration corpus. src/scripts/lib/definerClientExecuteWithdrawn.ts names it as the file that withdrew client EXECUTE and pinned search_path; restore it, or update that file in the same change that renames it.`);
  } else {
    const made = new Set(splitStatements(stripSqlComments(corpus[closingIndex]!.sql)).map(norm));
    for (const want of expectedClosingStatements()) {
      if (!made.has(want)) problems.push(`::error::${DEFINER_EXECUTE_CLOSED_BY} no longer makes \`${want};\`, which definerClientExecuteWithdrawn.ts lists. The list and the file are one decision: change both.`);
    }
    const wanted = new Set(expectedClosingStatements());
    for (const s of made) {
      if (/^(GRANT|REVOKE|ALTER\s+FUNCTION)\b/i.test(s) && !wanted.has(s)) {
        problems.push(`::error::${DEFINER_EXECUTE_CLOSED_BY} makes \`${s};\`, which definerClientExecuteWithdrawn.ts does not list. Add it there, or take it out of the file.`);
      }
    }
  }

  // R4 needs every file; R1-R3 and R5 only the files after the closing one.
  const policies = new Map<string, Policy>();
  let laterFiles = 0;
  corpus.forEach(({ file, sql }, index) => {
    const later = closingIndex >= 0 && index > closingIndex;
    if (later) laterFiles++;
    const frags = fragments(sql);
    for (const frag of frags) {
      const dp = DROP_POLICY.exec(frag);
      if (dp) policies.delete(polKey(dp[1]!, dp[2]!));
      const cp = CREATE_POLICY.exec(frag);
      if (cp) {
        const e = policyExprs(cp[3]!);
        policies.set(polKey(cp[1]!, cp[2]!), { roles: policyRoles(cp[3]!) ?? ["public"], using: e.using ?? "", check: e.check ?? "", file });
      }
      const ap = ALTER_POLICY.exec(frag);
      if (ap) {
        const key = polKey(ap[1]!, ap[2]!);
        const prev = policies.get(key);
        const rename = /^\s*RENAME\s+TO\s+("[^"]+"|[A-Za-z0-9_]+)/i.exec(ap[3]!);
        if (prev && rename) {
          policies.delete(key);
          policies.set(polKey(rename[1]!, ap[2]!), prev);
        } else if (prev) {
          const e = policyExprs(ap[3]!);
          policies.set(key, { roles: policyRoles(ap[3]!) ?? prev.roles, using: e.using ?? prev.using, check: e.check ?? prev.check, file: `${prev.file}, altered in ${file}` });
        }
      }
    }
    if (!later) return;

    for (const frag of frags) {
      // R1
      const g = /\bGRANT\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+(?:FUNCTION|ROUTINE)S?\s+([\s\S]+?)\s+TO\s+([\s\S]+?)(?:\s+WITH\s+GRANT\s+OPTION|\s+GRANTED\s+BY\s+\S+)*\s*;?\s*$/i.exec(frag);
      if (g) {
        const roles = roleList(g[2]!);
        for (const name of listedFunctions(g[1]!)) {
          const w = withdrawn.get(name);
          if (!w) continue;
          const back = roles.filter((r) => r === "public" || (w.withdrawnFrom as readonly string[]).includes(r));
          if (back.length > 0) {
            problems.push(`::error::${file} grants EXECUTE on ${w.signature} to ${back.join(", ")}, which ${DEFINER_EXECUTE_CLOSED_BY} withdrew (${w.why}). If that is now intended, say so by removing the entry from WITHDRAWN_CLIENT_EXECUTE in src/scripts/lib/definerClientExecuteWithdrawn.ts in the same change.`);
          }
        }
      }
      const ga = /\bGRANT\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+ALL\s+(?:FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+([\s\S]+?)\s+TO\s+([\s\S]+?)\s*;?\s*$/i.exec(frag);
      if (ga && roleList(ga[1]!).includes("public")) {
        const back = roleList(ga[2]!).filter((r) => r === "public" || r === "anon" || r === "authenticated");
        if (back.length > 0) problems.push(`::error::${file} grants EXECUTE on ALL FUNCTIONS IN SCHEMA public to ${back.join(", ")}, which re-grants every function ${DEFINER_EXECUTE_CLOSED_BY} withdrew.`);
      }

      // R2 and R3: DROP
      const df = /\bDROP\s+(?:FUNCTION|ROUTINE)\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?\s*;?\s*$/i.exec(frag);
      if (df) {
        for (const name of listedFunctions(df[1]!)) {
          const w = withdrawn.get(name);
          if (w) {
            const revoked = new Set(frags.flatMap((f) => revokedRoles(f, name)));
            const missing = ["public", ...w.withdrawnFrom].filter((r) => !revoked.has(r));
            if (missing.length > 0) problems.push(`::error::${file} drops ${w.signature} and does not revoke EXECUTE from ${missing.join(", ")} in the same file: a re-created function gets Supabase's default grants back, undoing ${DEFINER_EXECUTE_CLOSED_BY}.`);
          }
          if (pinned.has(name)) {
            const recreated = frags.some((f) => {
              const c = new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?${name}"?\s*\(`, "i").exec(f);
              return c !== null && setsSearchPath(f.slice(c.index));
            });
            if (!recreated) problems.push(`::error::${file} drops public.${name} and does not re-create it with SET search_path in the same file, which undoes the pin ${DEFINER_EXECUTE_CLOSED_BY} set.`);
          }
        }
      }

      // R2 and R3: CREATE
      const cf = /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/i.exec(frag);
      if (cf && (cf[2] === undefined || cf[2].toLowerCase() === "public")) {
        const name = cf[3]!.toLowerCase();
        const w = withdrawn.get(name);
        if (w && !cf[1]) {
          const revoked = new Set(frags.flatMap((f) => revokedRoles(f, name)));
          const missing = ["public", ...w.withdrawnFrom].filter((r) => !revoked.has(r));
          if (missing.length > 0) problems.push(`::error::${file} creates ${w.signature} without OR REPLACE and does not revoke EXECUTE from ${missing.join(", ")} in the same file: a new function gets Supabase's default grants, undoing ${DEFINER_EXECUTE_CLOSED_BY}.`);
        }
        if (pinned.has(name) && !setsSearchPath(frag.slice(cf.index))) {
          problems.push(`::error::${file} re-defines public.${name} without SET search_path. CREATE OR REPLACE keeps only the settings it states, so this drops the pin ${DEFINER_EXECUTE_CLOSED_BY} set; add SET search_path = '' to the header.`);
        }
      }

      // R2 and R3: ALTER FUNCTION
      const af = /\bALTER\s+(?:FUNCTION|ROUTINE)\s+(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?\s*\(([\s\S]*)$/i.exec(frag);
      if (af && (af[1] === undefined || af[1].toLowerCase() === "public")) {
        const name = af[2]!.toLowerCase();
        const tail = af[3]!;
        if (withdrawn.has(name) && /\b(?:RENAME\s+TO|SET\s+SCHEMA|OWNER\s+TO)\b/i.test(tail)) {
          problems.push(`::error::${file} renames, moves or re-owns ${withdrawn.get(name)!.signature}. Update WITHDRAWN_CLIENT_EXECUTE in src/scripts/lib/definerClientExecuteWithdrawn.ts in the same change so the ratchet follows it.`);
        }
        if (pinned.has(name) && /\bRESET\s+(?:search_path|ALL)\b|\bSET\s+search_path\s*(?:TO|=)\s*DEFAULT\b|\bSET\s+SCHEMA\b|\bRENAME\s+TO\b/i.test(tail)) {
          problems.push(`::error::${file} resets, renames or moves public.${name}, undoing or orphaning the search_path pin ${DEFINER_EXECUTE_CLOSED_BY} set. Update PINNED_SEARCH_PATH in the same change if that is intended.`);
        }
      }

      // R5
      for (const [name, w] of withdrawn) {
        if (w.triggerFn) continue;
        const isView = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i.test(frag);
        const fn = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?[A-Za-z0-9_]+"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/i.exec(frag);
        const invokerFn = fn !== null && fn[1]!.toLowerCase() !== name && !/\bSECURITY\s+DEFINER\b/i.test(frag);
        if ((isView || invokerFn) && callsFn(frag, name)) {
          problems.push(`::error::${file} has a ${isView ? "view" : "SECURITY INVOKER function"} that calls ${w.signature}. That call is checked as the caller, and ${DEFINER_EXECUTE_CLOSED_BY} withdrew EXECUTE from PUBLIC and ${w.withdrawnFrom.join(", ")}. Make the caller SECURITY DEFINER, or update WITHDRAWN_CLIENT_EXECUTE in the same change.`);
        }
      }
    }
  });

  // R4
  let guardedPolicyEdges = 0;
  for (const [key, p] of policies) {
    for (const [name, w] of withdrawn) {
      if (w.triggerFn || !callsFn(`${p.using} ${p.check}`, name)) continue;
      const hit = p.roles.filter((r) => r === "public" || (w.withdrawnFrom as readonly string[]).includes(r));
      if (hit.length > 0) {
        problems.push(`::error::policy ${key} (${p.file}) calls ${w.signature} and applies to ${hit.join(", ")}, which ${DEFINER_EXECUTE_CLOSED_BY} withdrew EXECUTE from: the policy raises "permission denied for function" for that role. Scope the policy TO authenticated, or update WITHDRAWN_CLIENT_EXECUTE in the same change.`);
      } else guardedPolicyEdges++;
    }
  }

  return { problems, stats: { closingIndex, laterFiles, policiesSurviving: policies.size, guardedPolicyEdges } };
}

/** Does a CREATE FUNCTION statement carry SET search_path outside its body (before or after it)? */
function setsSearchPath(createStmt: string): boolean {
  const bodyless = createStmt.replace(/(\$[A-Za-z0-9_]*\$)[\s\S]*?\1/, " ").replace(/\bBEGIN\s+ATOMIC\b[\s\S]*$/i, " ");
  return /\bSET\s+search_path\b/i.test(bodyless);
}
