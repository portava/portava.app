import tzLookup from 'tz-lookup';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();
type Rule = { days: Set<number>; spans: Array<[number, number]> };

/** Conservative weekly-hours subset. Holidays, seasons and solar times stay
 * unknown. A geographic IANA zone handles DST and fractional UTC offsets. */
export function discoveryOpenNow(hours: string | null, lat: number | null, lng: number | null, now = Date.now()): boolean | null {
  if (!hours || hours.length > 2048 || !Number.isFinite(now)) return null;
  if (hours.trim() === '24/7') return true;
  if (/^(off|closed)$/.test(hours.trim())) return false;
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const rules: Rule[] = [];
  const assigned = new Set<number>();
  for (const source of hours.split(';')) {
    const match = source.trim().match(/^(?:(Su|Mo|Tu|We|Th|Fr|Sa)([A-Za-z,\-]*)\s+)?(off|closed|\d{2}:\d{2}-\d{2}:\d{2}(?:\s*,\s*\d{2}:\d{2}-\d{2}:\d{2})*)$/);
    if (!match) return null;
    const days = new Set<number>();
    if (!match[1]) DAYS.forEach((_, i) => days.add(i));
    else for (const part of (match[1] + match[2]).split(',')) {
      const ends = part.split('-');
      if (ends.length > 2 || ends.some((d) => !DAYS.includes(d))) return null;
      const start = DAYS.indexOf(ends[0]!); const end = DAYS.indexOf(ends[1] ?? ends[0]!);
      for (let day = start; ; day = (day + 1) % 7) { days.add(day); if (day === end) break; }
    }
    // Repeated days can imply OSM override rules. Do not guess their meaning.
    if ([...days].some((day) => assigned.has(day))) return null;
    days.forEach((day) => assigned.add(day));
    const spans: Array<[number, number]> = [];
    if (!/^(off|closed)$/.test(match[3]!)) for (const span of match[3]!.split(',')) {
      const [a, b] = span.trim().split('-').map((v) => v.split(':').map(Number));
      if (!a || !b || a[0]! > 23 || a[1]! > 59 || b[0]! > 24 || b[1]! > 59 || b[0] === 24 && b[1] !== 0) return null;
      const start = a[0]! * 60 + a[1]!; const end = b[0]! * 60 + b[1]!;
      if (start === end) return null;
      spans.push([start, end]);
    }
    rules.push({ days, spans });
  }
  try {
    const timeZone = tzLookup(lat, lng);
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
      formatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(new Date(now));
    const value = (type: string) => parts.find((p) => p.type === type)?.value;
    const day = WEEKDAYS.indexOf(value('weekday') ?? '');
    const minute = Number(value('hour')) * 60 + Number(value('minute'));
    if (day < 0 || !Number.isFinite(minute)) return null;
    return rules.some((rule) => rule.spans.some(([start, end]) => end > start
      ? rule.days.has(day) && minute >= start && minute < end
      : rule.days.has(day) && minute >= start || rule.days.has((day + 6) % 7) && minute < end));
  } catch { return null; }
}

export function refreshDiscoveryHours<T extends { openingHours: string | null; lat: number | null; lng: number | null; isOpenNow: boolean | null }>(place: T, now = Date.now()): T {
  // Provider open-now booleans without hours have no validity window here.
  return { ...place, isOpenNow: discoveryOpenNow(place.openingHours, place.lat, place.lng, now) };
}
