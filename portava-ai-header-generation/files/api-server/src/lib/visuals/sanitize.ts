/**
 * Input sanitizer — the ONLY gate through which entity data reaches a prompt.
 *
 * Two jobs:
 *   1. Strip private/PII fields that must never enter a provider prompt, log, or hash.
 *   2. Normalize free text (length-clamp, collapse whitespace, drop control chars)
 *      so raw user input is never forwarded verbatim to the image provider.
 */

/** Field names that must never be forwarded into a prompt, hash, or log. */
const BANNED_KEYS = [
  "phone", "phone_number", "internationalphone", "email", "emailaddress",
  "passport", "passport_number", "payment", "card", "cardnumber",
  "address", "street", "home_address", "emergency_contact", "emergencycontact",
  "attendee", "attendees", "attendee_names", "user_id", "userid", "owner_id",
  "ownerid", "chat", "message", "messages", "lat", "lng", "latitude", "longitude",
  "coordinates", "precise_location", "dob", "date_of_birth",
];

const bannedSet = new Set(BANNED_KEYS.map((k) => k.toLowerCase()));

export function isBannedKey(key: string): boolean {
  return bannedSet.has(key.toLowerCase().replace(/[\s_-]/g, "").replace(/[^a-z]/g, ""))
    || bannedSet.has(key.toLowerCase());
}

/** Clamp + normalize a single free-text value. Returns null for empty/garbage. */
export function cleanText(v: unknown, maxLen = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")   // strip control chars
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

/** Normalize an enum-ish token: lowercase, trimmed, spaces→single. */
export function cleanEnum(v: unknown): string | null {
  const s = cleanText(v, 40);
  return s ? s.toLowerCase() : null;
}

/** Clean a string[] — dedupe, drop empties, cap count. */
export function cleanList(v: unknown, maxItems = 8, maxLen = 40): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const c = cleanText(item, maxLen);
    if (c && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      out.push(c);
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Remove any banned keys from a raw object before it is snapshotted. Defensive:
 * callers should already be selecting explicit fields, but this guarantees no PII
 * slips through if a caller passes a whole DB row.
 */
export function stripBanned<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (isBannedKey(k)) continue;
    out[k] = val;
  }
  return out as Partial<T>;
}

/** Map a rough hour or label to a coarse time-of-day bucket for prompts. */
export function timeOfDayFromHour(hour: number | null | undefined): string | null {
  if (hour == null || Number.isNaN(hour)) return null;
  const h = ((hour % 24) + 24) % 24;
  if (h < 5) return "night";
  if (h < 11) return "morning";
  if (h < 16) return "afternoon";
  if (h < 19) return "sunset";
  if (h < 22) return "evening";
  return "night";
}
