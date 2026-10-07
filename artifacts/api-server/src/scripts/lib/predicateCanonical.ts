/**
 * predicateCanonical — compare two RLS policy predicates by STRUCTURE, not text.
 *
 * WHY. The inverse audit (audit:live-unexplained) compares each live policy's
 * predicate (pg_policies.qual / with_check, i.e. PostgreSQL's pg_get_expr
 * rendering) with the predicate the migration TEXT declares. The two are the
 * same expression written two ways: PostgreSQL parenthesises every operator,
 * casts every literal (`'x'::text`), rewrites `IN (a, b)` as `= ANY (ARRAY[a,
 * b])`, `!=` as `<>`, LIKE as `~~`, BETWEEN as two comparisons, and qualifies a
 * column with its table wherever more than one table is in scope. Compared as
 * text (normalizePredicate), 58 policies the chain declares exactly were
 * reported as POLICY_PREDICATE_DRIFT on run 37608414616.
 *
 * WHAT IS EQUAL. Both sides are parsed with PostgreSQL's operator precedence
 * into a tree, and the tree is printed canonically:
 *   * grouping parentheses vanish (the tree carries the grouping), and nested
 *     AND / OR flatten — operand ORDER is kept;
 *   * a cast applied directly to a literal is dropped (`'x'::text` == `'x'`,
 *     `'1 day'::interval` == `interval '1 day'`) — a literal's type is decided
 *     by its context either way. A cast on anything else is kept;
 *   * `x IN (list)` == `x = ANY (ARRAY[list])`, `x NOT IN (list)` ==
 *     `x <> ALL (ARRAY[list])`, `!=` == `<>`, `[NOT] [I]LIKE` == `!~~` / `~~*` …,
 *     `a BETWEEN b AND c` == `a >= b AND a <= c`;
 *   * a column reference is resolved the way PostgreSQL resolves it: a
 *     qualifier names a FROM item (alias, else table name) in the innermost
 *     scope that has it; an unqualified name belongs to the innermost scope
 *     whose table HAS that column (the caller's column inventory). The policy's
 *     own table is the outermost scope. So `user_id` inside `FROM
 *     layover_sessions` and pg's `layover_sessions.user_id` print alike, and
 *     an outer `conversation_id` matches pg's `compass_conversation_messages
 *     .conversation_id` — while a reference that resolves to a DIFFERENT table
 *     does not;
 *   * `public.` qualification and keyword / identifier case are ignored.
 * Everything else — operators, function names and arguments, literal values,
 * operand order, CASE arms, subquery shape — must match exactly.
 *
 * WHAT HAPPENS ON SOMETHING IT CANNOT PARSE. canonicalPredicate returns null,
 * and the caller falls back to the old text comparison. An unparseable
 * predicate is therefore reported exactly as before; it is never assumed equal.
 */

export type ColumnsOf = (table: string) => ReadonlySet<string> | undefined;
/** The schema a function the chain moved out of `public` now lives in (ALTER FUNCTION … SET SCHEMA). */
export type FunctionSchemaOf = (name: string) => string | undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

type Tok =
  | { k: "str"; v: string }
  | { k: "num"; v: string }
  | { k: "id"; v: string; quoted: boolean }
  | { k: "op"; v: string }
  | { k: "p"; v: string }; // ( ) [ ] , .

const OPS = ["::", "<>", "!=", "<=", ">=", "->>", "->", "#>>", "#>", "||", "@>", "<@", "&&", "!~~*", "!~~", "~~*", "~~", "!~*", "!~", "~*", "?|", "?&", "=", "<", ">", "+", "-", "*", "/", "%", "^", "~", "?"];

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let v = "";
      let j = i + 1;
      for (;;) {
        if (j >= src.length) return null;
        if (src[j] === "'" && src[j + 1] === "'") {
          v += "'";
          j += 2;
        } else if (src[j] === "'") break;
        else v += src[j++];
      }
      out.push({ k: "str", v });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) return null;
      out.push({ k: "id", v: src.slice(i + 1, j), quoted: true });
      i = j + 1;
      continue;
    }
    if (/\d/.test(ch)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][\w$]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0].toLowerCase(), quoted: false });
      i += m[0].length;
      continue;
    }
    if ("()[],.".includes(ch)) {
      out.push({ k: "p", v: ch });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) return null;
    out.push({ k: "op", v: op });
    i += op.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree
// ─────────────────────────────────────────────────────────────────────────────

type Node =
  | { t: "lit"; v: string } // already rendered: 'x', 12, true, false, null
  | { t: "col"; parts: string[] }
  | { t: "star" }
  | { t: "func"; name: string; args: Node[]; distinct: boolean }
  | { t: "cast"; e: Node; type: string }
  | { t: "bin"; op: string; l: Node; r: Node }
  | { t: "bool"; op: "and" | "or"; args: Node[] }
  | { t: "not"; e: Node }
  | { t: "neg"; e: Node }
  | { t: "is"; e: Node; what: string; r?: Node }
  | { t: "quant"; op: string; q: "any" | "all"; l: Node; r: Node }
  | { t: "array"; items: Node[] }
  | { t: "sub"; e: Node; idx: Node }
  | { t: "exists"; q: Query }
  | { t: "scalar"; q: Query }
  | { t: "case"; arg: Node | null; whens: Array<[Node, Node]>; els: Node | null };

interface FromItem {
  table: string;
  alias: string | null;
}
interface Query {
  distinct: boolean;
  select: Node[];
  from: FromItem[];
  joins: Node[]; // ON conditions, in order
  where: Node | null;
  groupBy: Node[];
  having: Node | null;
  limit: Node | null;
}

class ParseError extends Error {}

const TYPED_LITERAL_TYPES = new Set(["interval", "date", "timestamp", "timestamptz", "time", "uuid", "jsonb", "json", "text"]);
const TYPE_SYNONYMS: Record<string, string> = {
  int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean",
  varchar: "character varying", timestamptz: "timestamp with time zone", timetz: "time with time zone",
  float8: "double precision", float4: "real", decimal: "numeric", float: "double precision",
  timestamp: "timestamp without time zone", char: "character", bpchar: "character",
};
const RESERVED_STOP = new Set(["and", "or", "not", "is", "in", "like", "ilike", "similar", "between", "from", "where", "then", "when", "else", "end", "as", "on", "join", "inner", "left", "right", "full", "cross", "group", "having", "limit", "order", "union", "escape", "using"]);

class Parser {
  i = 0;
  constructor(private readonly toks: Tok[]) {}

  peek(o = 0): Tok | undefined {
    return this.toks[this.i + o];
  }
  isWord(w: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.k === "id" && !t.quoted && t.v === w;
  }
  isP(v: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.k === "p" && t.v === v;
  }
  isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.k === "op" && t.v === v;
  }
  eatWord(w: string): boolean {
    if (this.isWord(w)) {
      this.i++;
      return true;
    }
    return false;
  }
  expectP(v: string): void {
    if (!this.isP(v)) throw new ParseError(`expected ${v}`);
    this.i++;
  }
  expectWord(w: string): void {
    if (!this.eatWord(w)) throw new ParseError(`expected ${w}`);
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }

  // expr := or
  expr(): Node {
    return this.or();
  }
  or(): Node {
    const args = [this.and()];
    while (this.eatWord("or")) args.push(this.and());
    return args.length === 1 ? args[0]! : { t: "bool", op: "or", args };
  }
  and(): Node {
    const args = [this.not()];
    while (this.eatWord("and")) args.push(this.not());
    return args.length === 1 ? args[0]! : { t: "bool", op: "and", args };
  }
  not(): Node {
    if (this.eatWord("not")) return { t: "not", e: this.not() };
    return this.isExpr();
  }
  isExpr(): Node {
    let e = this.cmp();
    for (;;) {
      if (this.isWord("is")) {
        this.i++;
        const neg = this.eatWord("not");
        if (this.eatWord("null")) e = { t: "is", e, what: neg ? "not null" : "null" };
        else if (this.eatWord("true")) e = { t: "is", e, what: neg ? "not true" : "true" };
        else if (this.eatWord("false")) e = { t: "is", e, what: neg ? "not false" : "false" };
        else if (this.eatWord("distinct")) {
          this.expectWord("from");
          e = { t: "is", e, what: neg ? "not distinct from" : "distinct from", r: this.cmp() };
        } else throw new ParseError("IS what?");
      } else if (this.eatWord("isnull")) e = { t: "is", e, what: "null" };
      else if (this.eatWord("notnull")) e = { t: "is", e, what: "not null" };
      else return e;
    }
  }
  cmp(): Node {
    const l = this.likeIn();
    const t = this.peek();
    if (t && t.k === "op" && ["=", "<>", "!=", "<", ">", "<=", ">="].includes(t.v)) {
      this.i++;
      const op = t.v === "!=" ? "<>" : t.v;
      if (this.isWord("any") || this.isWord("all") || this.isWord("some")) {
        const q = this.peek()!.v === "all" ? "all" : "any";
        this.i++;
        this.expectP("(");
        const r = this.isWord("select") ? ({ t: "scalar", q: this.query() } as Node) : this.expr();
        this.expectP(")");
        return { t: "quant", op, q, l, r };
      }
      return { t: "bin", op, l, r: this.likeIn() };
    }
    return l;
  }
  likeIn(): Node {
    const l = this.other();
    const neg = this.isWord("not") && (this.isWord("in", 1) || this.isWord("like", 1) || this.isWord("ilike", 1) || this.isWord("between", 1));
    if (neg) this.i++;
    if (this.eatWord("in")) {
      this.expectP("(");
      if (this.isWord("select")) {
        const q = this.query();
        this.expectP(")");
        return { t: "quant", op: neg ? "<>" : "=", q: neg ? "all" : "any", l, r: { t: "scalar", q } };
      }
      const items = [this.expr()];
      while (this.isP(",")) {
        this.i++;
        items.push(this.expr());
      }
      this.expectP(")");
      return { t: "quant", op: neg ? "<>" : "=", q: neg ? "all" : "any", l, r: { t: "array", items } };
    }
    if (this.eatWord("like") || this.eatWord("ilike")) {
      const ci = this.toks[this.i - 1]!.v === "ilike";
      const op = `${neg ? "!" : ""}~~${ci ? "*" : ""}`;
      return { t: "bin", op, l, r: this.other() };
    }
    if (this.eatWord("between")) {
      const lo = this.other();
      this.expectWord("and");
      const hi = this.other();
      return neg
        ? { t: "bool", op: "or", args: [{ t: "bin", op: "<", l, r: lo }, { t: "bin", op: ">", l, r: hi }] }
        : { t: "bool", op: "and", args: [{ t: "bin", op: ">=", l, r: lo }, { t: "bin", op: "<=", l, r: hi }] };
    }
    if (neg) throw new ParseError("NOT what?");
    return l;
  }
  other(): Node {
    let l = this.add();
    for (;;) {
      const t = this.peek();
      if (t && t.k === "op" && !["=", "<>", "!=", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "^", "::"].includes(t.v)) {
        this.i++;
        l = { t: "bin", op: t.v, l, r: this.add() };
      } else return l;
    }
  }
  add(): Node {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.peek()!.v;
      this.i++;
      l = { t: "bin", op, l, r: this.mul() };
    }
    return l;
  }
  mul(): Node {
    let l = this.pow();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.peek()!.v;
      this.i++;
      l = { t: "bin", op, l, r: this.pow() };
    }
    return l;
  }
  pow(): Node {
    let l = this.unary();
    while (this.isOp("^")) {
      this.i++;
      l = { t: "bin", op: "^", l, r: this.unary() };
    }
    return l;
  }
  unary(): Node {
    if (this.isOp("-")) {
      this.i++;
      const e = this.unary();
      return e.t === "lit" && /^\d/.test(e.v) ? { t: "lit", v: `-${e.v}` } : { t: "neg", e };
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    return this.postfix();
  }
  postfix(): Node {
    let e = this.primary();
    for (;;) {
      if (this.isOp("::")) {
        this.i++;
        e = { t: "cast", e, type: this.typeName() };
      } else if (this.isP("[")) {
        this.i++;
        const idx = this.expr();
        this.expectP("]");
        e = { t: "sub", e, idx };
      } else return e;
    }
  }
  typeName(): string {
    const qparts: string[] = [];
    const first = this.peek();
    if (!first || first.k !== "id") throw new ParseError("type");
    qparts.push(first.v);
    this.i++;
    while (this.isP(".")) {
      this.i++;
      const n = this.peek();
      if (!n || n.k !== "id") throw new ParseError("type");
      qparts.push(n.v);
      this.i++;
    }
    if (qparts.length > 1 && qparts[0] === "public") qparts.shift();
    let name = qparts.join(".");
    // Multiword built-in types.
    const multi: Record<string, string[][]> = {
      character: [["varying"]],
      double: [["precision"]],
      timestamp: [["with", "time", "zone"], ["without", "time", "zone"]],
      time: [["with", "time", "zone"], ["without", "time", "zone"]],
    };
    for (const tail of multi[name] ?? []) {
      if (tail.every((w, k) => this.isWord(w, k))) {
        this.i += tail.length;
        name = `${name} ${tail.join(" ")}`;
        break;
      }
    }
    name = TYPE_SYNONYMS[name] ?? name;
    if (this.isP("(")) {
      // A typmod — varchar(20), numeric(10,2) — kept verbatim.
      let depth = 0;
      let mod = "";
      do {
        const x = this.peek();
        if (!x) throw new ParseError("typmod");
        if (x.k === "p" && x.v === "(") depth++;
        if (x.k === "p" && x.v === ")") depth--;
        mod += x.v;
        this.i++;
      } while (depth > 0);
      name += mod;
    }
    while (this.isP("[") && this.isP("]", 1)) {
      this.i += 2;
      name += "[]";
    }
    return name;
  }
  primary(): Node {
    const t = this.peek();
    if (!t) throw new ParseError("eof");
    if (t.k === "str") {
      this.i++;
      return { t: "lit", v: `'${t.v.replace(/'/g, "''")}'` };
    }
    if (t.k === "num") {
      this.i++;
      return { t: "lit", v: t.v };
    }
    if (t.k === "op" && t.v === "*") {
      this.i++;
      return { t: "star" };
    }
    if (t.k === "p" && t.v === "(") {
      this.i++;
      if (this.isWord("select")) {
        const q = this.query();
        this.expectP(")");
        return { t: "scalar", q };
      }
      const e = this.expr();
      this.expectP(")");
      return e;
    }
    if (t.k !== "id") throw new ParseError(`unexpected ${t.v}`);
    if (!t.quoted) {
      if (t.v === "true" || t.v === "false" || t.v === "null") {
        this.i++;
        return { t: "lit", v: t.v };
      }
      if (t.v === "exists" && this.isP("(", 1)) {
        this.i += 2;
        const q = this.query();
        this.expectP(")");
        return { t: "exists", q };
      }
      if (t.v === "array" && this.isP("[", 1)) {
        this.i += 2;
        const items: Node[] = [];
        if (!this.isP("]")) {
          items.push(this.expr());
          while (this.isP(",")) {
            this.i++;
            items.push(this.expr());
          }
        }
        this.expectP("]");
        return { t: "array", items };
      }
      if (t.v === "case") {
        this.i++;
        const arg = this.isWord("when") ? null : this.expr();
        const whens: Array<[Node, Node]> = [];
        while (this.eatWord("when")) {
          const c = this.expr();
          this.expectWord("then");
          whens.push([c, this.expr()]);
        }
        const els = this.eatWord("else") ? this.expr() : null;
        this.expectWord("end");
        return { t: "case", arg, whens, els };
      }
      if (TYPED_LITERAL_TYPES.has(t.v) && this.peek(1)?.k === "str") {
        this.i++;
        const s = this.peek() as { k: "str"; v: string };
        this.i++;
        return { t: "lit", v: `'${s.v.replace(/'/g, "''")}'` };
      }
      if ((t.v === "current_date" || t.v === "current_timestamp" || t.v === "current_user" || t.v === "session_user") && !this.isP("(", 1)) {
        this.i++;
        return { t: "func", name: t.v, args: [], distinct: false };
      }
      if (RESERVED_STOP.has(t.v)) throw new ParseError(`keyword ${t.v}`);
    }
    // name [. name]* [ ( args ) ]
    const parts = [t.v];
    this.i++;
    while (this.isP(".")) {
      this.i++;
      const n = this.peek();
      if (n && n.k === "op" && n.v === "*") {
        this.i++;
        return { t: "star" };
      }
      if (!n || n.k !== "id") throw new ParseError("name");
      parts.push(n.v);
      this.i++;
    }
    if (this.isP("(")) {
      this.i++;
      const distinct = this.eatWord("distinct");
      const args: Node[] = [];
      if (!this.isP(")")) {
        args.push(this.expr());
        while (this.isP(",")) {
          this.i++;
          args.push(this.expr());
        }
      }
      this.expectP(")");
      const name = (parts[0] === "public" && parts.length > 1 ? parts.slice(1) : parts).join(".");
      return { t: "func", name, args, distinct };
    }
    return { t: "col", parts };
  }
  query(): Query {
    this.expectWord("select");
    const distinct = this.eatWord("distinct");
    const select: Node[] = [];
    do {
      if (this.isP(",")) this.i++;
      select.push(this.expr());
      if (this.eatWord("as")) this.i++;
      else if (this.peek()?.k === "id" && !RESERVED_STOP.has(this.peek()!.v)) this.i++; // bare alias
    } while (this.isP(","));
    const from: FromItem[] = [];
    const joins: Node[] = [];
    if (this.eatWord("from")) {
      const item = (): FromItem => {
        if (this.isP("(") && !this.isWord("select", 1)) {
          // A parenthesised join group, as pg_get_expr writes every JOIN:
          // FROM (a x JOIN b y ON (...)). Its items join this FROM list in order.
          this.i++;
          const groupFirst = item();
          joinTail(groupFirst);
          this.expectP(")");
          return groupFirst;
        }
        const n = this.peek();
        if (!n || n.k !== "id") throw new ParseError("from item");
        const parts = [n.v];
        this.i++;
        while (this.isP(".")) {
          this.i++;
          parts.push(this.peek()!.v);
          this.i++;
        }
        const table = parts[parts.length - 1]!;
        let alias: string | null = null;
        if (this.eatWord("as")) {
          alias = this.peek()!.v;
          this.i++;
        } else if (this.peek()?.k === "id" && !RESERVED_STOP.has(this.peek()!.v)) {
          alias = this.peek()!.v;
          this.i++;
        }
        return { table, alias };
      };
      // Join tails after `first`: every further item is appended to `from`,
      // every ON condition to `joins`, in order. A group's first item is
      // pushed by its caller, so the group's members land in source order.
      const joinTail = (first: FromItem | null): void => {
        if (first && !from.includes(first)) from.push(first);
        for (;;) {
          if (this.isP(",")) {
            this.i++;
            joinTail(item());
            return;
          }
          if (this.isWord("join") || this.isWord("inner") || this.isWord("left") || this.isWord("right") || this.isWord("full") || this.isWord("cross")) {
            const kind: string[] = [];
            while (!this.isWord("join")) {
              if (!this.peek()) throw new ParseError("join");
              kind.push(this.peek()!.v);
              this.i++;
            }
            this.i++;
            if (kind.some((k) => k === "left" || k === "right" || k === "full")) throw new ParseError("outer join");
            joinTail(item());
            if (this.eatWord("on")) joins.push(this.expr());
            continue;
          }
          return;
        }
      };
      joinTail(item());
    }
    const where = this.eatWord("where") ? this.expr() : null;
    const groupBy: Node[] = [];
    if (this.isWord("group") && this.isWord("by", 1)) {
      this.i += 2;
      groupBy.push(this.expr());
      while (this.isP(",")) {
        this.i++;
        groupBy.push(this.expr());
      }
    }
    const having = this.eatWord("having") ? this.expr() : null;
    const limit = this.eatWord("limit") ? this.expr() : null;
    return { distinct, select, from, joins, where, groupBy, having, limit };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical printing, with PostgreSQL's column resolution
// ─────────────────────────────────────────────────────────────────────────────

type Scope = FromItem[][]; // [0] = the policy's own table; inner scopes appended

function resolveCol(parts: string[], scope: Scope, columnsOf: ColumnsOf): string {
  const col = parts[parts.length - 1]!;
  const qual = parts.length >= 2 ? parts[parts.length - 2]! : null;
  for (let d = scope.length - 1; d >= 0; d--) {
    const items = scope[d]!;
    for (let k = 0; k < items.length; k++) {
      const it = items[k]!;
      if (qual !== null) {
        if (it.alias === qual || (it.alias === null && it.table === qual) || it.table === qual) return `$${d}.${k}.${col}`;
      } else if (columnsOf(it.table)?.has(col)) return `$${d}.${k}.${col}`;
    }
  }
  if (qual !== null) return `${qual}.${col}`; // a qualifier no scope names: kept verbatim
  // Unqualified and in no known table's inventory: the innermost scope's single
  // item if there is exactly one, else the bare name. Both sides of a
  // comparison go through this same rule.
  const inner = scope[scope.length - 1]!;
  return inner.length === 1 ? `$${scope.length - 1}.0.${col}` : col;
}

function print(n: Node, scope: Scope, cols: ColumnsOf, fns: FunctionSchemaOf): string {
  const p = (x: Node) => print(x, scope, cols, fns);
  switch (n.t) {
    case "lit":
      return n.v;
    case "star":
      return "*";
    case "col":
      return resolveCol(n.parts, scope, cols);
    case "func": {
      // A function the chain moved out of public is the same function under its
      // new schema: PostgreSQL stored its OID, and pg_get_expr prints the new
      // qualified name (2182 moved can_see_location and in_accepted_circle to authz).
      const moved = n.name.includes(".") ? undefined : fns(n.name);
      return `${moved ? `${moved}.` : ""}${n.name}(${n.distinct ? "distinct " : ""}${n.args.map(p).join(", ")})`;
    }
    case "cast":
      // A cast on a literal is the literal: its type comes from its context.
      // So is a cast on an ARRAY[] of literals: `ARRAY['a','b']::member_role[]`
      // is `ARRAY['a'::member_role, 'b'::member_role]`, which pg_get_expr prints.
      return n.e.t === "lit" || (n.e.t === "array" && n.e.items.every((x) => x.t === "lit" || (x.t === "cast" && x.e.t === "lit")))
        ? p(n.e)
        : `cast(${p(n.e)} as ${n.type})`;
    case "bin":
      return `(${p(n.l)} ${n.op} ${p(n.r)})`;
    case "bool": {
      const flat: Node[] = [];
      for (const a of n.args) {
        if (a.t === "bool" && a.op === n.op) flat.push(...a.args);
        else flat.push(a);
      }
      return `(${flat.map(p).join(` ${n.op} `)})`;
    }
    case "not":
      return `(not ${p(n.e)})`;
    case "neg":
      return `(- ${p(n.e)})`;
    case "is":
      return `(${p(n.e)} is ${n.what}${n.r ? ` ${p(n.r)}` : ""})`;
    case "quant":
      return `(${p(n.l)} ${n.op} ${n.q} ${p(n.r)})`;
    case "array":
      return `array[${n.items.map(p).join(", ")}]`;
    case "sub":
      return `${p(n.e)}[${p(n.idx)}]`;
    case "exists":
      return `exists ${printQuery(n.q, scope, cols, fns)}`;
    case "scalar":
      return printQuery(n.q, scope, cols, fns);
    case "case":
      return `case${n.arg ? ` ${p(n.arg)}` : ""} ${n.whens.map(([c, r]) => `when ${p(c)} then ${p(r)}`).join(" ")}${n.els ? ` else ${p(n.els)}` : ""} end`;
  }
}

function printQuery(q: Query, scope: Scope, cols: ColumnsOf, fns: FunctionSchemaOf): string {
  const inner: Scope = [...scope, q.from];
  const p = (x: Node) => print(x, inner, cols, fns);
  // Aliases are not printed: references were resolved to positions.
  return (
    `(select${q.distinct ? " distinct" : ""} ${q.select.map(p).join(", ")}` +
    (q.from.length ? ` from ${q.from.map((f) => f.table).join(", ")}` : "") +
    (q.joins.length ? ` on ${q.joins.map(p).join(" ; ")}` : "") +
    (q.where ? ` where ${p(q.where)}` : "") +
    (q.groupBy.length ? ` group by ${q.groupBy.map(p).join(", ")}` : "") +
    (q.having ? ` having ${p(q.having)}` : "") +
    (q.limit ? ` limit ${p(q.limit)}` : "") +
    ")"
  );
}

/**
 * The canonical form of one policy predicate on `table`, or null when it
 * cannot be parsed (the caller then compares text, as before). `null` input
 * (no USING / no WITH CHECK) is the string "<none>".
 */
export function canonicalPredicate(
  expr: string | null,
  table: string,
  columnsOf: ColumnsOf = () => undefined,
  functionSchemaOf: FunctionSchemaOf = () => undefined,
): string | null {
  if (expr === null || expr === undefined) return "<none>";
  const toks = tokenize(expr);
  if (!toks || !toks.length) return null;
  try {
    const ps = new Parser(toks);
    const tree = ps.expr();
    if (!ps.done()) return null;
    return print(tree, [[{ table: table.toLowerCase(), alias: null }]], columnsOf, functionSchemaOf);
  } catch (e) {
    if (e instanceof ParseError) return null;
    throw e;
  }
}
