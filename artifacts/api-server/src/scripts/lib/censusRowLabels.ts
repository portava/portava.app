/**
 * Does a labelled requirement id name ANOTHER requirement's object?
 *
 * A census revises a verdict by restating the row in a later "Row moves"
 * section, and the restatement carries a human label after the id —
 * `| TR90 <backtick>trip_snapshots<backtick> | N | **W** | ... |`. The id is
 * what every count uses. When the label and the id name different objects,
 * either the id is wrong or the label is, and a reader tracing the row lands on
 * the wrong object.
 *
 * The measured instance, and why the narrow rule below is the right one, is in
 * the header of ../checkCensusRowMoveLabels.ts. This module is the part a test
 * can drive with synthetic input.
 */

const isSeparator = (l: string) => /^\|[\s:|-]+\|?$/.test(l.trim()) && l.includes("-");

/** `TR91` / `**TR91**` / `CX-03`, then whatever follows it in the same cell. */
const LEAD = /^\s*\*{0,2}([A-Z]{1,4}-?[0-9]{1,4})\*{0,2}\s*(.*)$/;

/** `TR91` -> `TR`, `CX-03` -> `CX-`. The numbering sequence an id belongs to. */
export function prefixOf(id: string): string {
  return /^([A-Z]{1,4}-?)/.exec(id)![1]!;
}

/**
 * The FIRST backticked identifier in a cell, or null.
 *
 * "First" rather than "any": a body requirement cell routinely cites several
 * (a type, then the nearest existing table, then the migration that defines
 * it), and only the leading one is the object the row is ABOUT. Comparing
 * against the whole set would make every incidental citation a licence for a
 * wrong label.
 */
export function leadingIdent(cell: string): string | null {
  const m = /`([A-Za-z_][A-Za-z0-9_.]{2,})`/.exec(cell);
  return m ? m[1]! : null;
}

export interface Mislabelled {
  line: number;
  id: string;
  label: string;
  /** The object this census's body assigns to `id`, when its body row names one. */
  ownBody: string | null;
  ownBodyLine: number | null;
  /** The id whose body row owns `label`. */
  belongsTo: string;
  belongsToLine: number;
}

export function findMislabelledRows(text: string): Mislabelled[] {
  const lines = text.split("\n");
  interface Row { line: number; label: string; req: string }
  const rowsById = new Map<string, Row[]>();

  lines.forEach((line, i) => {
    if (!line.startsWith("|") || isSeparator(line)) return;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 3) return;
    const lead = LEAD.exec(cells[0] ?? "");
    if (!lead) return;
    const list = rowsById.get(lead[1]!) ?? [];
    list.push({ line: i + 1, label: lead[2]!.trim(), req: (cells[1] ?? "").trim() });
    rowsById.set(lead[1]!, list);
  });

  // The BODY row for an id is its first occurrence whose id cell carries no
  // label — the requirement table. A restatement always carries one.
  const bodyIdent = new Map<string, { ident: string; line: number }>();
  for (const [id, rows] of rowsById) {
    const body = rows.find((r) => r.label === "");
    if (!body) continue;
    const ident = leadingIdent(body.req);
    if (ident) bodyIdent.set(id, { ident, line: body.line });
  }

  // Reverse index, KEYED BY PREFIX: an identifier owned by two body rows in the
  // same sequence is ambiguous and is dropped rather than guessed.
  //
  // THE PREFIX SCOPING IS NOT TUNING, and leaving it out produced two false
  // accusations on the first run. census-discovery keys its requirements A/B/C,
  // its open decisions D1..D10, and the fixes that closed them F1..F5 — and D2
  // ("migrate the community byline to displayName") is CLOSED BY F2 ("canonical
  // displayName on the community byline"). Two tables sharing a vocabulary on
  // purpose is a cross-reference working, not an off-by-one. An off-by-one
  // happens INSIDE one numbering sequence; a label matching an id in another
  // namespace is a coincidence, and failing it would have been an accusation
  // aimed at a document doing exactly the right thing.
  const owner = new Map<string, { id: string; line: number } | null>();
  for (const [id, entry] of bodyIdent) {
    const key = prefixOf(id) + " " + entry.ident;
    owner.set(key, owner.has(key) ? null : { id, line: entry.line });
  }

  const out: Mislabelled[] = [];
  for (const [id, rows] of rowsById) {
    for (const r of rows) {
      if (r.label === "") continue;
      const ident = leadingIdent(r.label);
      if (!ident) continue;
      const own = bodyIdent.get(id);
      if (own && own.ident === ident) continue; // label agrees with the body
      const owns = owner.get(prefixOf(id) + " " + ident);
      if (!owns || owns.id === id) continue;    // refinement, or unowned: fine
      out.push({
        line: r.line, id, label: ident,
        ownBody: own?.ident ?? null, ownBodyLine: own?.line ?? null,
        belongsTo: owns.id, belongsToLine: owns.line,
      });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Labelled id cells, for reporting how much of the corpus the check reached. */
export function countLabelledCells(text: string): number {
  return (text.match(/^\|\s*\*{0,2}[A-Z]{1,4}-?[0-9]{1,4}\*{0,2}\s+\S/gm) ?? []).length;
}
