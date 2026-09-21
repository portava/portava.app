/**
 * Telegraph §22 — travel scam signals and link reputation.
 *
 * §22's control table, two rows:
 *   Links/files          "Reputation/scanning; reserved official identities."
 *   Travel scam signals  "Off-platform payment, fake taxi, visa help, ticket
 *                         resale, fake hotel, urgent money request."
 *
 * census-telegraph T282 measured ONE of the six families built — the 14-pattern
 * off-app payment detector at `routes/messaging.ts:2201`, which is real, is
 * enforced, and is scoped to buddy-booking threads — and T281 measured link
 * reputation as wholly absent: "No link scanning, no URL reputation, no
 * reserved-identity list."
 *
 * WHO THIS IS FOR, AND WHY THAT DECIDES THE DESIGN
 * ===============================================
 * The existing off-app detector acts on the SENDER: it logs an admin event and
 * can suspend a buddy profile. That is the right shape for a platform-integrity
 * control and the wrong shape for a traveller-safety one, because it helps
 * nobody in the conversation right now. A traveller being told "send 200 USDT
 * today or your visa appointment is cancelled" needs the warning, and needs it
 * before they act.
 *
 * So these signals are computed for the RECIPIENT, at read time, and are never
 * returned to the sender. A sender who could see their own signals would tune
 * their wording against the detector in a single afternoon; a recipient who
 * sees them gets the one thing a scam depends on them not having, which is a
 * second opinion.
 *
 * WHY NOTHING IS BLOCKED
 * ======================
 * Every pattern here has an innocent reading. "I can help with your visa" is
 * what a friend says. "Can you send me money, I lost my card" is what a friend
 * in trouble says — and is also the single most common travel scam. A detector
 * that blocked would be wrong often and expensively, and §16's rule that
 * scanning must never block basic text delivery points the same way. These
 * signals ANNOTATE. The decision stays with the person.
 *
 * PURE, AND THEREFORE TESTABLE
 * ============================
 * No I/O, no clients, no clock. Everything here is a function of a string, so
 * the adversarial corpus in `test/telegraphAbuseControls.test.ts` is the whole
 * specification of the behaviour and a false positive is a failing test rather
 * than a support ticket.
 */

/** The six families §22 names, verbatim and in order. */
export const SCAM_FAMILIES = [
  "OFF_PLATFORM_PAYMENT",
  "FAKE_TAXI",
  "VISA_HELP",
  "TICKET_RESALE",
  "FAKE_HOTEL",
  "URGENT_MONEY_REQUEST",
] as const;
export type ScamFamily = (typeof SCAM_FAMILIES)[number];

export type SignalSeverity = "notice" | "caution" | "warning";

export interface ScamSignal {
  family: ScamFamily;
  severity: SignalSeverity;
  /** The phrase that matched, truncated. Shown so the warning is checkable. */
  matched: string;
}

interface FamilyRule {
  family: ScamFamily;
  severity: SignalSeverity;
  patterns: RegExp[];
}

/**
 * The rules.
 *
 * Every pattern requires EXPLICIT wording. "taxi" alone is not a signal —
 * travellers talk about taxis constantly. "my cousin has a taxi, pay him
 * directly, meter is broken" is three explicit markers and one of them is
 * enough. Where a family's innocent reading is common (VISA_HELP,
 * URGENT_MONEY_REQUEST) the severity is lower and the copy above it is a
 * question, not an accusation.
 */
const RULES: FamilyRule[] = [
  {
    family: "OFF_PLATFORM_PAYMENT",
    severity: "warning",
    patterns: [
      /\boff[-\s]?app\b/i, /\bpay\s+outside\b/i, /\bcash\s+only\b[^.]*\boutside\b/i,
      /\bvenmo\s+me\b/i, /\bpaypal\s+me\b/i, /\bcashapp\b/i, /\bzelle\s+me\b/i,
      /\bbank\s+transfer\s+only\b/i, /\bno\s+app\s+payment\b/i,
      /\bpay\s+me\s+directly\b/i, /\bcontact\s+me\s+outside\b/i,
      /\bwestern\s+union\b/i, /\bmoneygram\b/i,
      /\b(usdt|btc|bitcoin|crypto)\s+(only|wallet|address)\b/i,
      /\bgift\s+cards?\b[^.]*\b(pay|send|buy)\b/i,
      /\b(pay|send)\b[^.]*\bgift\s+cards?\b/i,
    ],
  },
  {
    family: "FAKE_TAXI",
    severity: "caution",
    patterns: [
      /\bmeter\s+(is\s+)?(broken|not\s+working)\b/i,
      /\bmy\s+(cousin|friend|brother|uncle)\b[^.]*\b(taxi|driver|car)\b/i,
      /\b(taxi|driver|car)\b[^.]*\bmy\s+(cousin|friend|brother|uncle)\b/i,
      /\bofficial\s+(airport\s+)?taxi\b[^.]*\b(pay|cash|fee|price)\b/i,
      /\bfixed\s+price\b[^.]*\b(airport|station|terminal)\b/i,
      /\b(skip|avoid)\s+the\s+(taxi\s+)?queue\b/i,
    ],
  },
  {
    family: "VISA_HELP",
    severity: "caution",
    patterns: [
      /\bvisa\b[^.]*\b(guarantee|guaranteed|100%\s+approval|no\s+rejection)\b/i,
      /\b(guarantee|guaranteed)\b[^.]*\bvisa\b/i,
      /\b(fix|speed\s+up|fast[-\s]?track)\b[^.]*\bvisa\b/i,
      /\bvisa\b[^.]*\b(agent|fixer|connection)\b[^.]*\b(fee|pay|cash)\b/i,
      /\bembassy\s+(contact|insider|friend)\b/i,
      /\bvisa\s+on\s+arrival\b[^.]*\b(pay\s+me|send\s+me|deposit)\b/i,
    ],
  },
  {
    family: "TICKET_RESALE",
    severity: "caution",
    patterns: [
      /\b(spare|extra)\s+ticket\b[^.]*\b(sell|selling|send|transfer|pay)\b/i,
      /\bselling\s+(my\s+)?(ticket|tickets|pass|passes)\b/i,
      /\bticket\b[^.]*\b(below|under)\s+face\s+value\b/i,
      /\be[-\s]?ticket\b[^.]*\b(pdf|screenshot)\b[^.]*\b(pay|send|transfer)\b/i,
      /\btransfer\s+the\s+money\s+first\b/i,
    ],
  },
  {
    family: "FAKE_HOTEL",
    severity: "caution",
    patterns: [
      /\b(hotel|hostel|guesthouse|apartment)\b[^.]*\b(deposit|prepay|pay\s+first)\b[^.]*\b(transfer|wire|crypto|western\s+union)\b/i,
      /\b(deposit|prepay)\b[^.]*\b(hold|secure|reserve)\s+(the\s+)?(room|apartment|flat)\b/i,
      /\b(booking|reservation)\s+(site|platform)\s+(is\s+)?down\b/i,
      /\bbook\s+directly\s+with\s+me\b/i,
      /\bno\s+(booking|reservation)\s+(fee|needed)\b[^.]*\b(transfer|deposit)\b/i,
    ],
  },
  {
    family: "URGENT_MONEY_REQUEST",
    severity: "warning",
    patterns: [
      /\b(urgent|emergency|right\s+now|immediately|today\s+only)\b[^.]*\b(send|transfer|wire)\b[^.]*\b(money|cash|funds|\d+\s*(usd|eur|gbp|usdt))\b/i,
      /\b(send|transfer|wire)\b[^.]*\b(money|cash|funds)\b[^.]*\b(urgent|emergency|right\s+now|immediately)\b/i,
      /\b(lost|stolen)\b[^.]*\b(wallet|passport|card|phone)\b[^.]*\b(send|lend|transfer|help\s+me\s+with)\b[^.]*\b(money|cash|\d+)\b/i,
      /\b(i\s+need|need)\s+\d+\s*(usd|eur|gbp|dollars|euros)\b/i,
      /\bdon'?t\s+tell\s+anyone\b/i,
      /\bstuck\s+at\s+(the\s+)?(airport|border|police)\b[^.]*\b(money|pay|fee|fine)\b/i,
    ],
  },
];

const MATCH_EXCERPT_MAX = 80;

/**
 * Detect §22's six travel-scam families in a message body.
 *
 * Returns at most one signal per family — a message that says "venmo me" three
 * times is one signal, not three, because the count would otherwise be read as
 * a severity and it is not one.
 */
export function detectTravelScamSignals(body: string | null | undefined): ScamSignal[] {
  const text = (body ?? "").trim();
  if (text === "") return [];
  const out: ScamSignal[] = [];
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      const m = p.exec(text);
      if (m) {
        out.push({
          family: rule.family,
          severity: rule.severity,
          matched: m[0].slice(0, MATCH_EXCERPT_MAX),
        });
        break;
      }
    }
  }
  return out;
}

/* ───────────────────────── links and official identities ──────────────────── */

/**
 * The identities a message may claim to be, and which nothing outside this
 * platform may spell.
 *
 * §22: "reserved official identities". A link that LOOKS like one of these and
 * is not one is the single highest-value phishing signal available without a
 * reputation feed, because the lookalike is the whole attack.
 */
export const RESERVED_OFFICIAL_HOSTS: readonly string[] = [
  "portava.app",
  "www.portava.app",
  "api.portava.app",
];

/** Link shorteners hide the destination, which is the point of using one. */
const SHORTENER_HOSTS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly",
  "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "tiny.cc", "s.id", "lnkd.in",
]);

export type LinkFinding =
  | "NON_HTTPS"
  | "SHORTENER"
  | "IP_LITERAL_HOST"
  | "PUNYCODE_HOST"
  | "MIXED_SCRIPT_HOST"
  | "LOOKALIKE_OFFICIAL_HOST"
  | "CREDENTIALS_IN_URL"
  | "UNKNOWN_HOST";

export interface ScannedLink {
  raw: string;
  host: string | null;
  findings: LinkFinding[];
  /** True when at least one finding is one a traveller should be warned about. */
  suspicious: boolean;
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+)/gi;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Characters that are not ASCII and not the dot/hyphen a hostname may carry. */
const NON_ASCII_RE = /[^\x00-\x7F]/;

/**
 * Damerau-free, deliberately simple edit distance capped at `max`.
 *
 * Exact enough for "is this host one character away from an official one",
 * which is the only question asked of it. A full string-similarity library
 * would be a dependency added to answer a question with three inputs.
 */
function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > max) return false;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]! <= max;
}

/** The registrable-ish tail: last two labels. Enough to compare brands. */
function registrableTail(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/**
 * Scan a message body for links and report what is wrong with each.
 *
 * NOT a reputation feed. This repository has no blocklist source and inventing
 * one would be worse than having none: a made-up verdict of "safe" is the only
 * output here that could get somebody hurt. Every finding below is a STRUCTURAL
 * property of the URL, decidable from the string, and `UNKNOWN_HOST` is
 * returned for everything else precisely so that "we have not checked" is
 * visible rather than silently reading as "fine".
 */
export function scanLinks(body: string | null | undefined): ScannedLink[] {
  const text = (body ?? "").trim();
  if (text === "") return [];
  const out: ScannedLink[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(URL_RE)) {
    const raw = m[1]!;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const findings: LinkFinding[] = [];
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;

    let host: string | null = null;
    let parsed: URL | null = null;
    try { parsed = new URL(withScheme); host = parsed.hostname.toLowerCase(); }
    catch { host = null; }

    if (parsed) {
      if (parsed.protocol !== "https:") findings.push("NON_HTTPS");
      if (parsed.username !== "" || parsed.password !== "") findings.push("CREDENTIALS_IN_URL");
    }

    if (host) {
      if (IPV4_RE.test(host)) findings.push("IP_LITERAL_HOST");
      if (host.includes("xn--")) findings.push("PUNYCODE_HOST");
      if (NON_ASCII_RE.test(host)) findings.push("MIXED_SCRIPT_HOST");
      if (SHORTENER_HOSTS.has(host)) findings.push("SHORTENER");

      const official = RESERVED_OFFICIAL_HOSTS.includes(host);
      if (!official) {
        const tail = registrableTail(host);
        const lookalike = RESERVED_OFFICIAL_HOSTS.some((o) => {
          const ot = registrableTail(o);
          if (tail === ot) return false;
          // One edit away, OR the brand embedded as a label of another domain
          // ("portava.app.secure-login.example").
          return editDistanceAtMost(tail, ot, 1) || host.split(".").slice(0, -2).includes("portava");
        });
        if (lookalike) findings.push("LOOKALIKE_OFFICIAL_HOST");
      }
      if (findings.length === 0 && !official) findings.push("UNKNOWN_HOST");
    }

    out.push({
      raw: raw.slice(0, 200),
      host,
      findings,
      // UNKNOWN_HOST alone is not suspicious — most links are to places nobody
      // has heard of, and warning on all of them trains the warning away.
      suspicious: findings.some((f) => f !== "UNKNOWN_HOST" && f !== "NON_HTTPS")
        || (findings.includes("NON_HTTPS") && findings.length > 1),
    });
  }
  return out;
}

/* ─────────────────────────── the recipient's view ─────────────────────────── */

export interface MessageSafetySignals {
  scam: ScamSignal[];
  links: ScannedLink[];
  /** The strongest severity present, or null when nothing fired. */
  severity: SignalSeverity | null;
}

const SEVERITY_ORDER: Record<SignalSeverity, number> = { notice: 1, caution: 2, warning: 3 };

/**
 * The whole §22 annotation for ONE message, for its RECIPIENT.
 *
 * Returns `null` when there is nothing to say, so the field is absent rather
 * than an empty object — a per-message empty object on every message in a long
 * thread is bytes, and an absent field is unambiguous.
 */
export function messageSafetySignals(body: string | null | undefined): MessageSafetySignals | null {
  const scam = detectTravelScamSignals(body);
  const links = scanLinks(body).filter((l) => l.suspicious);
  if (scam.length === 0 && links.length === 0) return null;
  let severity: SignalSeverity | null = null;
  for (const s of scam) {
    if (severity === null || SEVERITY_ORDER[s.severity] > SEVERITY_ORDER[severity]) severity = s.severity;
  }
  if (links.length > 0 && (severity === null || SEVERITY_ORDER["caution"] > SEVERITY_ORDER[severity])) {
    severity = "caution";
  }
  return { scam, links, severity };
}
