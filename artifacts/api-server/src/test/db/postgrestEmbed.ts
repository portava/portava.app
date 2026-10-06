/**
 * postgrestEmbed — PostgREST's FK-hinted resource embedding, for the database
 * bridges in this directory. Not a test file.
 *
 * WHY: the account-state gate (lib/accountStateGate.ts) reads
 *
 *   profiles?select=account_status,user_account_states!user_account_states_user_id_fkey(state,expires_at)
 *
 * on EVERY authenticated request, so every database suite that drives a real
 * route through `requireUser` issues that select. The three bridges
 * (trailPostgrestBridge, discoveryVerifyBridge, creatorLedgerPsqlClient) were
 * written for plain column lists and threw on any embed. The gate read that
 * throw as what it is — an account state that could not be read — and answered
 * 503 `degraded_unavailable`, which is right for the gate and turned
 * trailsService.db.test.ts H1/H2/H4/H5 red on CI (head 9dd3aafc2). The gap was
 * in the doubles; no assertion changes.
 *
 * WHAT IT DOES, AND WHAT KEEPS IT HONEST. An embed is resolved against the
 * REAL foreign key in pg_constraint, by the constraint name the select hints —
 * the same lookup PostgREST makes in its schema cache:
 *
 *   the hinted constraint links the two tables, FK on the embedded table
 *       → a to-many embed: a JSON array of the named columns, `[]` for none
 *   …FK on the parent table
 *       → a to-one embed: one JSON object, or null
 *   no such constraint between the two tables
 *       → PGRST200 "Could not find a relationship …", HTTP 400 — what PostgREST
 *         answers, and what makes a wrong FK name in the gate's select FAIL
 *         here instead of being papered over by a double that guesses
 *
 * So a rename of `user_account_states_user_id_fkey`, or a migration that drops
 * it, fails these suites the way it would fail production.
 *
 * SCOPE, deliberately narrow (the bridges are loud by design): one level,
 * single-column foreign keys, plain column names inside the parentheses, the
 * `relation!constraint(cols)` form only. Anything else THROWS.
 */

export interface PostgrestErrorBody { code: string; message: string; details: string | null; hint: string | null }

/** An embed PostgREST would refuse: the bridge answers `body` with HTTP 400. */
export class PostgrestEmbedError extends Error {
  readonly body: PostgrestErrorBody;
  constructor(body: PostgrestErrorBody) {
    super(body.message);
    this.name = "PostgrestEmbedError";
    this.body = body;
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const EMBED = /^([a-z_][a-z0-9_]*)!([a-z_][a-z0-9_]*)\(([^()]*)\)$/;

function ident(name: string): string {
  const n = name.trim();
  if (!IDENT.test(n)) throw new Error(`postgrestEmbed: refusing identifier ${JSON.stringify(name)}`);
  return `"${n}"`;
}
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Split a `select=` value on commas that are not inside parentheses. */
export function splitSelectItems(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** `relation!constraint(col, col)` → its parts, or null when the item is not that form. */
export function parseEmbedItem(item: string): { relation: string; hint: string; columns: string[] } | null {
  const m = EMBED.exec(item.trim());
  if (!m) return null;
  const columns = m[3]!.split(",").map((c) => c.trim()).filter(Boolean);
  if (columns.length === 0) throw new Error(`postgrestEmbed: an embed with no columns is not modelled (${item})`);
  for (const c of columns) if (!IDENT.test(c)) throw new Error(`postgrestEmbed: only plain columns are modelled inside an embed (${item})`);
  return { relation: m[1]!, hint: m[2]!, columns };
}

/**
 * The SQL expression for one embed, to sit in the parent's select list as
 * `<expr> AS "<relation>"`. `parentRef` is how the enclosing statement names the
 * parent row (`"profiles"` for an unaliased FROM). `lookup` runs one catalogue
 * query and returns its stdout lines, or null when the query failed.
 */
export function embedExpression(
  parentTable: string,
  parentRef: string,
  embed: { relation: string; hint: string; columns: string[] },
  lookup: (sql: string) => string[] | null,
): string {
  const parent = ident(parentTable);
  const relation = ident(embed.relation);
  const found = lookup(
    `SELECT (c.conrelid = to_regclass(${lit(`public.${relation}`)}))::text || '|' || a.attname || '|' || fa.attname ` +
    `FROM pg_constraint c ` +
    `JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] ` +
    `JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1] ` +
    `WHERE c.contype = 'f' AND c.conname = ${lit(embed.hint)} AND array_length(c.conkey, 1) = 1 ` +
    `AND ((c.conrelid = to_regclass(${lit(`public.${relation}`)}) AND c.confrelid = to_regclass(${lit(`public.${parent}`)})) ` +
    `OR (c.conrelid = to_regclass(${lit(`public.${parent}`)}) AND c.confrelid = to_regclass(${lit(`public.${relation}`)})));`,
  );
  if (found === null) throw new Error(`postgrestEmbed: the foreign-key lookup for ${embed.relation}!${embed.hint} failed`);
  if (found.length === 0) {
    throw new PostgrestEmbedError({
      code: "PGRST200",
      message: `Could not find a relationship between '${parentTable}' and '${embed.relation}' in the schema cache`,
      details: `Searched for a foreign key relationship between '${parentTable}' and '${embed.relation}' using the hint '${embed.hint}' in the schema 'public', but no matches were found.`,
      hint: null,
    });
  }
  if (found.length > 1) throw new Error(`postgrestEmbed: ${embed.hint} matched ${found.length} constraints between ${parentTable} and ${embed.relation}`);
  const [onEmbedded, fkColumn, referencedColumn] = found[0]!.split("|");
  const object = `json_build_object(${embed.columns.map((c) => `${lit(c)}, _e.${ident(c)}`).join(", ")})`;
  if (onEmbedded === "true") {
    // The FK lives on the embedded table and points at the parent: to-many.
    return `(SELECT COALESCE(json_agg(${object}), '[]'::json) FROM public.${relation} _e WHERE _e.${ident(fkColumn!)} = ${parentRef}.${ident(referencedColumn!)})`;
  }
  // The FK lives on the parent and points at the embedded table: to-one.
  return `(SELECT ${object} FROM public.${relation} _e WHERE _e.${ident(referencedColumn!)} = ${parentRef}.${ident(fkColumn!)} LIMIT 1)`;
}

/**
 * A whole `select=` value → a SQL select list over `parentTable`, FROM'd
 * unaliased as `public."<parentTable>"`. Plain columns are passed through
 * `plainColumn` (each bridge keeps its own rules for those); embeds become
 * `embedExpression(...) AS "<relation>"`. Returns null when the select holds no
 * embed at all, so a bridge's existing path stays byte-for-byte what it was.
 */
export function selectListWithEmbeds(
  parentTable: string,
  select: string,
  plainColumn: (column: string) => string,
  lookup: (sql: string) => string[] | null,
): string | null {
  const items = splitSelectItems(select);
  const parsed = items.map((item) => ({ item, embed: parseEmbedItem(item) }));
  if (!parsed.some((p) => p.embed)) return null;
  const parentRef = ident(parentTable);
  return parsed.map(({ item, embed }) => {
    if (!embed) return plainColumn(item);
    return `${embedExpression(parentTable, parentRef, embed, lookup)} AS ${ident(embed.relation)}`;
  }).join(", ");
}
