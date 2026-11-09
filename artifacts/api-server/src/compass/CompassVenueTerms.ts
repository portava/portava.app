// Place search supplies a current open/closed signal, not exact opening hours.
// Event price_type supplies free admission, not a price for other venues.
type ToolResult = { name: string; result: unknown };
type Payload = Record<string, unknown> | null;
const HOURS = /\b(?:open(?:ing|s)?|clos(?:es|ed|ing)|last (?:entry|admission)|hours|until|24\s*\/\s*7|around the clock)\b/i;
const CLOCK = /\b(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?\b|o['’]?clock)|\d{1,2}:\d{2}|midnight|noon|24\s*\/\s*7|around the clock|\d{1,2}\s*(?:to|[-–])\s*\d{1,2})\b/i;
const MONEY = /(?:[$€£¥₫₹]\s*\d|\b(?:USD|EUR|GBP|VND|PHP|THB|JPY|CAD|AUD)\s*\d|\d[\d,.]*\s*(?:USD|EUR|GBP|VND|PHP|THB|JPY|CAD|AUD|dollars?|euros?|pounds?|dong|pesos?|baht|yen|rupees?)\b)/i;
const PRICE = /\b(?:admission|entry|entrance|ticket|price|fees?|charges?|costs?|priced|tickets?|paid|complimentary)\b/i;
const NON_VENUE = /\b(?:flight|train|bus|taxi|transport|route|transfer|booking|hotel|reservation|estimated travel cost)\b/i;
const FREE = /\b(?:free (?:admission|entry|tickets?)|(?:admission|entry|tickets?) (?:is |are )?free|(?:is|are) free(?:\s+to enter)?|complimentary (?:admission|entry))\b/i;
const BUDGET = /\b(?:budget|limit|set aside|allowance|aim to spend|spending cap|maximum spend|spend at most)\b/i;
const UNKNOWN_HOURS = "I couldn’t verify the opening or closing time.";
const UNKNOWN_PRICE = "I couldn’t verify the admission price.";
const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function claimKinds(text: string, prompt: string) {
  const kinds: string[] = [];
  const planningTime = /\b(?:meet|visit|arrive|schedule|aim|suggest|plan to|leave by|set out)\b/i.test(text);
  if (CLOCK.test(text) && (HOURS.test(text) || (HOURS.test(prompt) && !planningTime))) kinds.push("hours");
  const priceContext = PRICE.test(text) || PRICE.test(prompt);
  const budgetOnly = BUDGET.test(text) && !/\b(?:admission|entry|entrance|ticket)(?:\s+fee)?\s+(?:costs?|is|at|of|=)/i.test(text);
  if (!NON_VENUE.test(text) && !budgetOnly && (FREE.test(text) || (priceContext && (MONEY.test(text) || /\b(?:free|complimentary)\b/i.test(text))))) kinds.push("price");
  return kinds;
}
function freeEvents(log: readonly ToolResult[]) {
  const names = new Set<string>();
  for (const tool of log) {
    const rows = asObject(tool.result)?.candidates;
    if (tool.name !== "search_events" || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const event = asObject(row);
      if (event?.priceType !== "free" || typeof event.title !== "string") continue;
      const title = event.title.replace(/^<portava:ugc>|<\/portava:ugc>$/g, "").trim();
      if (title.length >= 3 && title.length < 150 && !/[\p{C}<>]/u.test(title)) names.add(title);
    }
  }
  return [...names];
}

export function groundVenueTerms<A extends { label: string }>(message: string, payload: Payload, toolLog: readonly ToolResult[], prompt = "", actions: readonly A[] = []) {
  const venues = freeEvents(toolLog);
  const violations = new Set<string>();
  function safeText(text: string) {
    return text.replace(/[^\n]+/g, line => line.split(/((?<=[.!?;])\s+(?=[\p{Lu}\d])|(?<=;)\s+)/u).map(part => {
      const kinds = claimKinds(part, prompt);
      if (!kinds.length) return part;
      // Rebuild supported data from the named source. Matching the number
      // somewhere else on the turn cannot authorize this sentence or its subject.
      if (kinds.length === 1 && kinds[0] === "price" && FREE.test(part)) {
        const matching = venues.filter(name => part.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
        if (matching.length) return matching.map(name => `${name} is listed with free admission.`).join(" ");
      }
      return kinds.map(kind => {
        violations.add(kind === "hours" ? "unverified_venue_hours" : "unverified_admission_price");
        return kind === "hours" ? UNKNOWN_HOURS : UNKNOWN_PRICE;
      }).join(" ");
    }).join(""));
  }
  const result = safeText(message);
  let corrected = false;
  function safeField(value: unknown) {
    if (typeof value !== "string") return value;
    const safe = safeText(value);
    if (safe !== value) corrected = true;
    return safe;
  }
  let safePayload = payload;
  if (payload?.type === "itinerary" && Array.isArray(payload.days)) {
    safePayload = { ...payload, destination: safeField(payload.destination), days: payload.days.map(day => {
      const d = asObject(day);
      if (!d) return day;
      return { ...d, label: safeField(d.label), highlights: Array.isArray(d.highlights) ? d.highlights.map(safeField) : [] };
    }) };
  }
  const quickActions = actions.filter(action => safeText(action.label) === action.label);
  return { message: result, payload: safePayload, quickActions, violations: [...violations], changed: corrected || result !== message || quickActions.length !== actions.length };
}

/** Send safe complete narrative sentences early. The remaining model JSON is
 * held until the validated envelope is available, including its itinerary. */
export class CompassVenueStream {
  private raw = "";
  private chunks: string[] = [];
  private sent = 0;
  private prefixText = "";
  constructor(private readonly emit: (chunk: string) => void, private readonly prompt: string) {}
  push(chunk: string) {
    if (this.chunks.length === 0) this.emit(""); // Let a caller disconnect before a complete sentence arrives.
    this.raw += chunk;
    this.chunks.push(chunk);
    const header = /^\s*\{\s*"message"\s*:\s*"/.exec(this.raw);
    if (!header) return;
    const content = /^(?:[^"\\]|\\.)*/.exec(this.raw.slice(header[0].length))![0];
    const boundary = [...content.matchAll(/[.!?]\s+(?=[A-Z])/g)].at(-1);
    if (!boundary) return;
    const end = boundary.index! + boundary[0].length;
    const position = header[0].length + end;
    if (position <= this.sent) return;
    let prefix: string;
    try { prefix = JSON.parse('"' + content.slice(0, end) + '"'); } catch { return; }
    if (groundVenueTerms(prefix, null, [], this.prompt).changed) return;
    this.emit(this.raw.slice(this.sent, position));
    this.sent = position;
    this.prefixText = prefix;
  }
  finish(corrected?: { message: string; payload: Payload; quickActions: unknown[] }) {
    if (corrected) {
      if (!this.sent) { this.emit(JSON.stringify(corrected)); return; }
      // Only complete, unchanged prefix sentences can have been sent.
      const rest = corrected.message.slice(this.prefixText.length);
      this.emit(JSON.stringify(rest).slice(1) + ',"payload":' + JSON.stringify(corrected.payload) + ',"quickActions":' + JSON.stringify(corrected.quickActions) + '}');
      return;
    }
    let position = 0;
    for (const chunk of this.chunks) {
      const end = position + chunk.length;
      if (end > this.sent) this.emit(chunk.slice(Math.max(0, this.sent - position)));
      position = end;
    }
  }
}
