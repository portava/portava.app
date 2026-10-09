/**
 * §24 Paste Intelligence — classify a pasted blob, then resolve every item it
 * contains through the SAME gateway typed text goes through (census G154–G157,
 * G161, G162; flow GII-F08).
 *
 * WHAT THIS IS NOT: a second resolver. Classification here only decides WHAT
 * was pasted (coordinates, a map link, a list, an itinerary, one place) and
 * cuts it into items. Every item that carries text is then handed to
 * `generateSuggestionsWithCoverage` — the typed path's own entry point — so a
 * pasted "hcmc" is resolved by the same alias table, stroke fold, privacy gate
 * and ranking as a typed one. Coordinates are first named by the existing
 * server-side reverse geocoder and the NAME is then resolved the same way.
 *
 * WHAT IT NEVER DOES: write. §24 — "Bulk extraction must always lead to a
 * review screen before persistent mutation." This module reads; the client's
 * review screen is the only thing that can persist, and only what the person
 * ticked. The response says `mutated: false` so no caller can mistake it.
 *
 * FAILURE HONESTY (the DV-83 principle). An item has four outcomes and they are
 * never merged: `resolved`, `no_match` (the sources ANSWERED and nothing
 * matched), `failed` (a source could not be read — the gateway's coverage
 * refusal, a thrown serve, a geocoder that did not answer) and `unsupported`
 * (a link shape no configured parser reads, e.g. a shortened link). A failed
 * read is never reported as "nothing found".
 *
 * WHAT IT NEVER ASKS (lead ruling PR-D2-7c): a third-party provider. Every
 * lookup — a pasted name, a map link's place, a coordinate — reads Portava's own
 * catalog lanes only: the gateway with `catalogOnly`, and the canonical registry
 * for a bare coordinate (`nearestCatalogCity`). No geocoder, no model, no
 * outbound request. And WHAT IT NEVER ECHOES: a line that did not resolve to a
 * place. An unmatched line is dropped from the answer, silently, and never
 * logged; a failed or unsupported one keeps only fixed copy (`echoOnlyResolved`).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateSuggestionsWithCoverage } from './gateway';
import { splitSequence } from './semanticParser';
import type { InputContext, InputFieldPolicy, InputSuggestion, SuggestSessionContext } from './types';
import { haversineKm } from '../canonicalLocations';

/** A paste longer than this is cut, and the response says so. */
export const PASTE_MAX_CHARS = 5000;
/** At most this many items are resolved per paste; the rest are reported as truncated. */
export const PASTE_MAX_ITEMS = 25;
/** Candidates returned per item — enough to correct a wrong first pick on the review screen. */
export const PASTE_CANDIDATES_PER_ITEM = 3;
const MAX_QUERY_CHARS = 120;

/**
 * The fields a paste can be extracted INTO. Each is a place-or-city picker whose
 * accepted value is a location; bulk extraction into a username, a caption or a
 * message has no meaning and is refused rather than guessed at.
 */
export const PASTE_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>([
  'trip_destination',
  'trip_stop_place',
  'place_picker',
  'city_picker',
  'event_location',
]);

export type PasteShape = 'coordinates' | 'map_link' | 'list' | 'itinerary' | 'single' | 'empty';
export type PasteSource = 'coordinates' | 'map_link' | 'text';
export type MapLinkProvider = 'google' | 'apple' | 'osm' | 'geo_uri';
export type UnsupportedLink = 'short_link' | 'unsupported_link' | 'flight_text' | 'booking_text';

export interface PasteItem {
  index: number;
  /** The sanitized line this item came from (bounded; safe to render as text). */
  raw: string;
  source: PasteSource;
  provider: MapLinkProvider | null;
  /** The text resolved through the gateway, or null for a bare coordinate. */
  query: string | null;
  lat: number | null;
  lng: number | null;
  /** "7", "7:30pm" — an itinerary time, carried for the review screen, never searched. */
  timeHint: string | null;
  /** "Friday", "Day 2" — the itinerary heading this item sits under. */
  dayLabel: string | null;
  unsupported: UnsupportedLink | null;
}

export interface PasteClassification {
  shape: PasteShape;
  items: PasteItem[];
  truncated: boolean;
}

// ── Sanitizing (§47: "Sanitize pasted URLs and untrusted text before rendering") ─

/**
 * Strip what must never reach a renderer or a query: bidi overrides and
 * zero-width characters (which can make a pasted line DISPLAY as something it
 * is not), and control characters other than newline. NFC so a decomposed
 * paste and a composed one are the same text. Bounded.
 */
export function sanitizePastedText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .slice(0, PASTE_MAX_CHARS * 2)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .slice(0, PASTE_MAX_CHARS);
}

/**
 * §47 "Sanitize pasted URLs … before rendering" (census G337) — the URL half.
 *
 * `sanitizePastedText` above makes a line safe to render as TEXT. A pasted URL
 * needs one more step before it is echoed back as an item's `raw`, which the
 * review screen shows whenever no place could be read from it (a shortened
 * link, an unknown host): the URL a person copies from a browser or a booking
 * e-mail routinely carries things that must not be repeated onto a screen —
 * credentials in the userinfo (`https://user:secret@…`), session and tracking
 * tokens in the query (`?token=…&utm_source=…`), state in the fragment.
 *
 * The DISPLAY form keeps what lets the person recognise the link — scheme,
 * host, port and path — and replaces any query or fragment with a single "…".
 * It is applied only to what is RENDERED (`raw`): parsing (`parseMapLink`) still
 * reads the full URL, so a Google Maps `?q=` or Apple `ll=` still resolves.
 * A string that is not an http(s) URL is returned unchanged (a `geo:` URI holds
 * only coordinates and a label, both already sanitized as text).
 */
export function displaySafeUrl(text: string): string {
  const s = (text ?? '').trim();
  const scheme = (s.match(/^https?:\/\//i) ?? [''])[0];
  const host = urlHost(s);
  if (!host) return scheme ? `${scheme}…` : '…';
  const at = s.toLowerCase().lastIndexOf(host.toLowerCase());
  // An internationalised host comes back from the parser in punycode and is not
  // found verbatim: show it, and assume something followed it.
  if (at < 0) return `${scheme}${host}…`;
  const rest = s.slice(at + host.length);
  return `${scheme}${host}${rest.length > 0 ? '…' : ''}`;
}

/**
 * The host of a URL-like token, or null. The URL parser is trusted when it
 * parses (userinfo is then never part of `hostname`); when it does not — a
 * password containing "/", a bad percent-escape — everything up to the LAST
 * "@" is treated as userinfo and dropped, and only a plain host is accepted.
 * Scheme-less tokens (`www.…`, `booking.com/…`) are read as https.
 */
function urlHost(token: string): string | null {
  const withScheme = /^https?:\/\//i.test(token) ? token : `https://${token}`;
  try {
    const u = new URL(withScheme);
    if (u.hostname && /^[\p{L}\p{N}.-]+$/u.test(u.hostname)) return u.hostname;
  } catch {
    // fall through to the defensive read below
  }
  let rest = withScheme.replace(/^https?:\/\//i, '');
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = rest.slice(at + 1);
  const host = rest.split(/[\/?#;:\\]/)[0] ?? '';
  return /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(host) ? host : null;
}

/** Scheme-less (G337): optional userinfo (a `mailto:`/`data:`/`javascript:` address is text), a domain or IPv4 host, optional port, then a path, query, fragment or parameter. */
const SCHEMELESS_URL = String.raw`(?!(?:mailto|data|javascript):)(?:\w[^\s@:\/]*(?::(?!\/\/)[^\s@]*)?@)?(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))(?::\d{1,5})?[\/?#;]\S*`;
/** A URL-like token: with a scheme, starting `www.`, or scheme-less (`booking.com/r?sid=…`, `user:pw@host.com/…`, `host.com:8443/…`, `192.168.1.1/…`). */
const URL_TOKEN = new RegExp(String.raw`(?:\bhttps?:\/\/|\bwww\.)\S+|\b` + SCHEMELESS_URL, 'gi');
const URL_LINE = new RegExp(String.raw`^(?:(?:https?:\/\/|geo:|www\.)\S+|` + SCHEMELESS_URL + ')$', 'i');

/** Every URL-like token inside a rendered line, in its display-safe form. */
export function redactUrlsForDisplay(line: string): string {
  return (line ?? '').replace(URL_TOKEN, (m) => displaySafeUrl(m));
}

/** A text line with every URL-like token removed — what may become a place query. */
export function stripUrls(line: string): string {
  return (line ?? '').replace(URL_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

/** What an item's `raw` may hold: sanitized text with every URL display-safe, bounded. */
function displayRaw(line: string): string {
  return redactUrlsForDisplay(line).slice(0, 200);
}

// ── Coordinates (G157) ─────────────────────────────────────────────────────────

function inRange(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const DECIMAL_PAIR = /^\(?\s*([+-]?\d{1,3}\.\d{2,})\s*[,;\s]\s*([+-]?\d{1,3}\.\d{2,})\s*\)?$/;
const HEMISPHERE_PAIR = /^(\d{1,3}(?:\.\d+)?)\s*°?\s*([NS])\s*[,;\s]\s*(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])$/i;
const DMS_PAIR =
  /^(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|″|'')?\s*([NS])\s*[,;\s]?\s*(\d{1,3})\s*°\s*(\d{1,2})\s*['′]\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|″|'')?\s*([EW])$/i;

/**
 * A coordinate pair in the three forms people paste: `16.0544, 108.2022`,
 * `33.8568° S, 151.2153° E`, and Google's DMS copy `16°03'15.8"N 108°12'07.9"E`.
 * Bare integers ("12, 7") are NOT coordinates — that is a list of numbers.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const s = (text ?? '').trim();
  let m = s.match(DECIMAL_PAIR);
  if (m) {
    const lat = parseFloat(m[1]!);
    const lng = parseFloat(m[2]!);
    return inRange(lat, lng) ? { lat, lng } : null;
  }
  m = s.match(HEMISPHERE_PAIR);
  if (m) {
    const lat = parseFloat(m[1]!) * (m[2]!.toUpperCase() === 'S' ? -1 : 1);
    const lng = parseFloat(m[3]!) * (m[4]!.toUpperCase() === 'W' ? -1 : 1);
    return inRange(lat, lng) ? { lat, lng } : null;
  }
  m = s.match(DMS_PAIR);
  if (m) {
    const deg = (d: string, mi: string, se: string) => parseFloat(d) + parseFloat(mi) / 60 + parseFloat(se) / 3600;
    const lat = round6(deg(m[1]!, m[2]!, m[3]!) * (m[4]!.toUpperCase() === 'S' ? -1 : 1));
    const lng = round6(deg(m[5]!, m[6]!, m[7]!) * (m[8]!.toUpperCase() === 'W' ? -1 : 1));
    return inRange(lat, lng) ? { lat, lng } : null;
  }
  return null;
}

// ── Map links (G156) ──────────────────────────────────────────────────────────

export interface MapLinkStop {
  query: string | null;
  lat: number | null;
  lng: number | null;
}

export interface MapLinkParse {
  provider: MapLinkProvider | null;
  stops: MapLinkStop[];
  unsupported: UnsupportedLink | null;
}

function decodePart(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
  } catch {
    return s.replace(/\+/g, ' ').trim();
  }
}

/** A coordinate pair as a map link carries it: `16.05,108.2` (a link's own precision). */
function linkCoords(value: string): { lat: number; lng: number } | null {
  const m = value.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]!);
  const lng = parseFloat(m[2]!);
  return inRange(lat, lng) ? { lat, lng } : null;
}

/** A query-string value that is either a coordinate pair or a place name. */
function stopFromValue(value: string | null, coords: { lat: number; lng: number } | null = null): MapLinkStop | null {
  const v = value ? decodePart(value) : '';
  const asCoords = v ? (linkCoords(v) ?? parseCoordinates(v)) : null;
  if (asCoords) return { query: null, ...asCoords };
  if (!v && !coords) return null;
  return { query: v ? v.slice(0, MAX_QUERY_CHARS) : null, lat: coords?.lat ?? null, lng: coords?.lng ?? null };
}

const AT_COORDS = /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/;

function atCoords(path: string): { lat: number; lng: number } | null {
  const m = path.match(AT_COORDS);
  if (!m) return null;
  const lat = parseFloat(m[1]!);
  const lng = parseFloat(m[2]!);
  return inRange(lat, lng) ? { lat, lng } : null;
}

const SHORT_LINK_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'g.co', 'bit.ly', 'tinyurl.com']);

/**
 * Parse a map link from a configured provider. Returns null for anything that is
 * not an http(s) or geo: URL (a `javascript:` string is not a link we read).
 * A link we recognise as a link but cannot read — a shortener, whose target is
 * only known by following a redirect this endpoint will not follow, or a host no
 * parser is configured for — comes back with `unsupported` set, so the review
 * screen can SAY so instead of dropping it.
 */
export function parseMapLink(text: string): MapLinkParse | null {
  const s = (text ?? '').trim();
  if (/^geo:/i.test(s)) {
    const m = s.match(/^geo:(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:[;,][^?]*)?(?:\?(.*))?$/i);
    if (!m) return { provider: 'geo_uri', stops: [], unsupported: 'unsupported_link' };
    const coords = { lat: parseFloat(m[1]!), lng: parseFloat(m[2]!) };
    const q = m[3] ? new URLSearchParams(m[3]).get('q') : null;
    const label = q ? decodePart(q).replace(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\s*/, '').replace(/^\((.*)\)$/, '$1') : '';
    if (!inRange(coords.lat, coords.lng)) return { provider: 'geo_uri', stops: [], unsupported: 'unsupported_link' };
    return { provider: 'geo_uri', stops: [{ query: label || null, ...coords }], unsupported: null };
  }
  if (!/^https?:\/\//i.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const params = url.searchParams;

  if (SHORT_LINK_HOSTS.has(host)) return { provider: host.includes('goo') ? 'google' : null, stops: [], unsupported: 'short_link' };

  const isGoogle = /(^|\.)google\.[a-z.]+$/.test(host) && (host.startsWith('maps.') || url.pathname.startsWith('/maps'));
  if (isGoogle) {
    const path = url.pathname;
    const coords = atCoords(path);
    const segs = path.split('/').filter(Boolean);
    const dirIdx = segs.indexOf('dir');
    if (dirIdx >= 0) {
      const stops = segs
        .slice(dirIdx + 1)
        .filter((p) => !p.startsWith('@') && !p.startsWith('data='))
        .map((p) => stopFromValue(p))
        .filter((x): x is MapLinkStop => x !== null);
      return { provider: 'google', stops, unsupported: stops.length ? null : 'unsupported_link' };
    }
    const placeIdx = segs.indexOf('place');
    const searchIdx = segs.indexOf('search');
    const named = placeIdx >= 0 ? segs[placeIdx + 1] : searchIdx >= 0 ? segs[searchIdx + 1] : undefined;
    if (named && !named.startsWith('@')) {
      const stop = stopFromValue(named, coords);
      if (stop) return { provider: 'google', stops: [stop], unsupported: null };
    }
    const qp = params.get('q') ?? params.get('query') ?? params.get('destination') ?? params.get('daddr') ?? params.get('ll') ?? params.get('center');
    const fromParam = stopFromValue(qp, coords);
    if (fromParam) return { provider: 'google', stops: [fromParam], unsupported: null };
    if (coords) return { provider: 'google', stops: [{ query: null, ...coords }], unsupported: null };
    return { provider: 'google', stops: [], unsupported: 'unsupported_link' };
  }

  if (host === 'maps.apple.com') {
    const ll = params.get('ll') ?? params.get('sll');
    const coords = ll ? linkCoords(decodePart(ll)) : null;
    const name = params.get('q') ?? params.get('daddr') ?? params.get('address');
    const stop = stopFromValue(name, coords) ?? (coords ? { query: null, ...coords } : null);
    return stop ? { provider: 'apple', stops: [stop], unsupported: null } : { provider: 'apple', stops: [], unsupported: 'unsupported_link' };
  }

  if (host === 'openstreetmap.org' || host.endsWith('.openstreetmap.org') || host === 'osm.org') {
    const mlat = params.get('mlat');
    const mlon = params.get('mlon');
    if (mlat && mlon) {
      const lat = parseFloat(mlat);
      const lng = parseFloat(mlon);
      if (inRange(lat, lng)) return { provider: 'osm', stops: [{ query: null, lat, lng }], unsupported: null };
    }
    const hash = url.hash.match(/map=\d+\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    if (hash) {
      const lat = parseFloat(hash[1]!);
      const lng = parseFloat(hash[2]!);
      if (inRange(lat, lng)) return { provider: 'osm', stops: [{ query: null, lat, lng }], unsupported: null };
    }
    const query = stopFromValue(params.get('query'));
    return query ? { provider: 'osm', stops: [query], unsupported: null } : { provider: 'osm', stops: [], unsupported: 'unsupported_link' };
  }

  return { provider: null, stops: [], unsupported: 'unsupported_link' };
}

// ── Lists and itineraries (G155 / G161) ──────────────────────────────────────

const BULLET = /^\s*(?:[-*•·◦▪–—]|\d{1,2}[.)]|[a-z][.)])\s+/i;
const DAY_WORD =
  '(?:day\\s*\\d{1,2}|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tonight|tomorrow|weekend)';
const DAY_HEADER = new RegExp(`^(${DAY_WORD}(?:[\\s,]+[\\w\\s]{0,20})?)\\s*:\\s*(.*)$`, 'i');
const BARE_HEADER = /^([^:]{1,30}):$/;
/** "at 7", "around 11:30pm", "by 9", "@ 8", plus standalone "7pm" / "19:00". */
const TIME_HINT =
  /(?:\s*[,-]?\s*\b(?:at|around|by|from|until|til)\s+|\s*@\s*)(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|h)?)\b|\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/i;
const SEQUENCE_SEPARATORS = /\s*(?:→|->|=>|⇒|›|»|;|\|)\s*/;

function stripTime(text: string): { query: string; timeHint: string | null } {
  const m = text.match(TIME_HINT);
  if (!m) return { query: text.trim(), timeHint: null };
  const hint = (m[1] ?? m[2] ?? '').replace(/\s+/g, '').trim();
  const query = (text.slice(0, m.index) + ' ' + text.slice((m.index ?? 0) + m[0].length))
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:-]+|[\s,:-]+$/g, '')
    .trim();
  return { query, timeHint: hint || null };
}

function isUrlLine(line: string): boolean {
  // The SAME scheme-less shape URL_TOKEN redacts, anchored — userinfo, port and IPv4 included.
  return URL_LINE.test(line.trim());
}

/** A URL-only line in the form parseMapLink reads (scheme-less → https). */
function asParseableUrl(line: string): string {
  const t = line.trim();
  return /^(?:https?:\/\/|geo:)/i.test(t) ? t : `https://${t}`;
}

function textItems(line: string, dayLabel: string | null): Array<Omit<PasteItem, 'index'>> {
  const out: Array<Omit<PasteItem, 'index'>> = [];
  const parts = line
    .split(SEQUENCE_SEPARATORS)
    .flatMap((p) => splitSequence(p))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const part of parts.length > 0 ? parts : [line]) {
    // A URL inside a text line is never part of a place name, and every part
    // of it after the host is what G337 forbids repeating — the query is
    // rendered (as the item's label and in "No place matched “…”") and is sent
    // to search. So every URL-like token — scheme-less ones included — leaves
    // the QUERY before anything else reads the line (a port or a path digit
    // must not become a "time"); `raw` keeps its display-safe form.
    const { query, timeHint } = stripTime(stripUrls(part));
    if (!query || dropBeforeLookup(part)) continue; // PR-D2-7b (a): a personal segment is never looked up or echoed
    out.push({
      raw: displayRaw(part),
      source: 'text',
      provider: null,
      query: query.slice(0, MAX_QUERY_CHARS),
      lat: null,
      lng: null,
      timeHint,
      dayLabel,
      unsupported: null,
    });
  }
  return out;
}

function lineItems(line: string, dayLabel: string | null): Array<Omit<PasteItem, 'index'>> {
  const coords = parseCoordinates(line);
  if (coords) {
    return [{ raw: displayRaw(line), source: 'coordinates', provider: null, query: null, ...coords, timeHint: null, dayLabel, unsupported: null }];
  }
  if (isUrlLine(line)) {
    const link = parseMapLink(asParseableUrl(line));
    // A line that LOOKS like a link but cannot be parsed is reported as a link
    // this endpoint cannot read — never dropped, which would answer "nothing was
    // pasted" for a paste that plainly had something in it. (isUrlLine admits
    // only http(s), geo:, www. and scheme-less host shapes, so a `javascript:`
    // or `mailto:` string never reaches here.)
    if (!link) {
      return [{ raw: displayRaw(line), source: 'map_link', provider: null, query: null, lat: null, lng: null, timeHint: null, dayLabel, unsupported: 'unsupported_link' }];
    }
    if (link.unsupported || link.stops.length === 0) {
      return [{ raw: displayRaw(line), source: 'map_link', provider: link.provider, query: null, lat: null, lng: null, timeHint: null, dayLabel, unsupported: link.unsupported ?? 'unsupported_link' }];
    }
    return link.stops.filter((stop) => !(stop.query && dropBeforeLookup(stop.query))).map((stop) => ({ // PR-D2-7b (a)
      raw: displayRaw(line),
      source: 'map_link' as const,
      provider: link.provider,
      query: stop.query,
      lat: stop.lat,
      lng: stop.lng,
      timeHint: null,
      dayLabel,
      unsupported: null,
    }));
  }
  return textItems(line, dayLabel);
}

/**
 * Cut a pasted blob into items. Pure. A comma is deliberately NOT a separator:
 * "2 Bach Dang, Hai Chau, Da Nang" is one address, and splitting it would turn
 * one place into three wrong ones. Lists are lines, bullets, arrows,
 * semicolons, pipes and the sequence words the semantic parser already splits
 * on ("then", "after that").
 */
export function classifyPaste(rawText: unknown): PasteClassification {
  const original = typeof rawText === 'string' ? rawText : '';
  const text = sanitizePastedText(original);
  let truncated = original.length > PASTE_MAX_CHARS;
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { shape: 'empty', items: [], truncated };

  // census G159 / lead ruling PR-D2-7: a flight or hotel booking is read BEFORE
  // the line splitter, so no other line of it can become an item.
  const booking = classifyTravelBooking(lines);
  if (booking) return { shape: 'single', items: [{ ...booking, index: 0 }], truncated };

  const collected: Array<Omit<PasteItem, 'index'>> = [];
  let dayLabel: string | null = null;
  let sawItinerarySignal = false; let skipNameValue = false;
  for (const rawLine of lines) {
    let line = rawLine.replace(BULLET, '').trim();
    if (!line) continue;
    if (!isUrlLine(line)) {
      const header = line.match(DAY_HEADER);
      if (header) {
        dayLabel = header[1]!.trim().slice(0, 40);
        sawItinerarySignal = true;
        line = header[2]!.trim();
        if (!line) continue;
      } else {
        const bare = line.match(BARE_HEADER);
        if (bare && isNameLabel(line)) { skipNameValue = true; continue; } // PR-D2-7c: "Guest:" on its own line — the NAME is the next line; neither is read
        if (bare) {
          dayLabel = bare[1]!.trim().slice(0, 40);
          sawItinerarySignal = true;
          continue;
        }
      }
    }
    if (skipNameValue) { skipNameValue = false; continue; }
    collected.push(...lineItems(line, dayLabel));
  }

  if (collected.length > PASTE_MAX_ITEMS) truncated = true;
  const items = collected.slice(0, PASTE_MAX_ITEMS).map((it, index) => ({ ...it, index }));
  if (items.some((i) => i.timeHint)) sawItinerarySignal = true;

  let shape: PasteShape;
  if (items.length === 0) shape = 'empty';
  else if (sawItinerarySignal) shape = 'itinerary';
  else if (items.length > 1) shape = 'list';
  else if (items[0]!.source === 'coordinates') shape = 'coordinates';
  else if (items[0]!.source === 'map_link') shape = 'map_link';
  else shape = 'single';
  return { shape, items, truncated };
}

// ── Resolution through the shared gateway (G154) ──────────────────────────────

export type PasteItemStatus = 'resolved' | 'no_match' | 'failed' | 'unsupported';

export interface ResolvedPasteItem extends PasteItem {
  status: PasteItemStatus;
  /** Why an item failed, was unsupported or did not match. Safe, fixed copy. */
  reason: string | null;
  /** True when some sources could not be read but others still produced candidates. */
  partial: boolean;
  candidates: InputSuggestion[];
}

export interface PasteResolveParams {
  context: InputContext;
  policy: InputFieldPolicy;
  userId: string;
  sessionContext?: SuggestSessionContext;
  tz?: string | null;
}

export interface PasteResolveDeps {
  generate?: typeof generateSuggestionsWithCoverage;
  /** PR-D2-7c: a coordinate is named from Portava's own registry, never a geocoder. */
  nearestCity?: (sc: SupabaseClient, lat: number, lng: number) => Promise<NearestCityOutcome>;
}

const UNSUPPORTED_COPY: Record<UnsupportedLink, string> = {
  short_link: 'Shortened map links can’t be read. Open the link and copy the full address from the browser.',
  unsupported_link: 'This link isn’t from a map we can read (Google Maps, Apple Maps, OpenStreetMap).',
  // census G159, lead ruling PR-D2-7: fixed copy, nothing from the paste echoed.
  flight_text: 'Flight details can’t be added as a place. Add the destination city instead.',
  booking_text: 'We couldn’t find the property’s name or address in this booking.',
};

type GatewayOutcome =
  | { kind: 'answered'; suggestions: InputSuggestion[]; partial: boolean }
  | { kind: 'failed'; reason: string };

async function resolveText(
  sc: SupabaseClient,
  params: PasteResolveParams,
  text: string,
  coords: { lat: number | null; lng: number | null },
  generate: typeof generateSuggestionsWithCoverage,
): Promise<GatewayOutcome> {
  try {
    const { suggestions, refusal } = await generate(sc, {
      context: params.context,
      policy: params.policy,
      text,
      userId: params.userId,
      limit: PASTE_CANDIDATES_PER_ITEM,
      sessionContext: params.sessionContext,
      lat: coords.lat,
      lng: coords.lng,
      city: null,
      tz: params.tz ?? null,
      catalogOnly: true, // PR-D2-7c: Portava's own catalog lanes only — the gateway refuses every provider lane
    });
    // Only rows that resolve to an entity are candidates; a typo-correction or
    // validation row is advice for a typing person, not a place to add.
    const rows = suggestions.filter((s) => !!s.entityType && s.type !== 'correction' && s.type !== 'validation').slice(0, PASTE_CANDIDATES_PER_ITEM);
    if (rows.length === 0 && refusal) {
      return { kind: 'failed', reason: 'We couldn’t check this one — the place lookup didn’t answer.' };
    }
    return { kind: 'answered', suggestions: rows, partial: !!refusal };
  } catch {
    return { kind: 'failed', reason: 'We couldn’t check this one — the place lookup failed.' };
  }
}

// ── PR-D2-7c: a coordinate is named from Portava's own registry ───────────────
//
// A pasted coordinate used to go to the reverse geocoder (Nominatim) — a third
// party that then held the pasted point. It is now named by the NEAREST city or
// town in `canonical_locations` within {@link NEAREST_CITY_MAX_KM}, read with a
// bounded box around the point, and that name is resolved through the gateway
// like typed text. No catalog city near the point is an honest no-match; an
// unreadable registry is a failure. Nothing leaves Portava.

/** How far a pasted point may be from the catalog city that names it. */
export const NEAREST_CITY_MAX_KM = 40;
/** Half-side of the box read around the point, in degrees (≈ 55 km of latitude). */
const NEAREST_CITY_BOX_DEG = 0.5;

export type NearestCityOutcome =
  | { ok: true; row: { id: string; name: string } | null }
  | { ok: false };

/** The nearest catalog city or town to a point, from Portava's registry only. */
export async function nearestCatalogCity(sc: SupabaseClient, lat: number, lng: number): Promise<NearestCityOutcome> {
  try {
    const { data, error } = await sc
      .from('canonical_locations')
      .select('id, kind, name, lat, lng')
      .in('kind', ['city', 'town'])
      .gte('lat', lat - NEAREST_CITY_BOX_DEG)
      .lte('lat', lat + NEAREST_CITY_BOX_DEG)
      .gte('lng', lng - NEAREST_CITY_BOX_DEG)
      .lte('lng', lng + NEAREST_CITY_BOX_DEG)
      .limit(200);
    if (error || !Array.isArray(data)) return { ok: false };
    let best: { id: string; name: string } | null = null;
    let bestKm = Infinity;
    for (const r of data as Array<{ id?: unknown; name?: unknown; lat?: unknown; lng?: unknown }>) {
      if (typeof r.id !== 'string' || typeof r.name !== 'string' || !r.name.trim()) continue;
      if (typeof r.lat !== 'number' || typeof r.lng !== 'number') continue;
      const km = haversineKm(lat, lng, r.lat, r.lng);
      if (km <= NEAREST_CITY_MAX_KM && km < bestKm) { best = { id: r.id, name: r.name }; bestKm = km; }
    }
    return { ok: true, row: best };
  } catch {
    return { ok: false };
  }
}

async function resolveOne(
  sc: SupabaseClient,
  params: PasteResolveParams,
  item: PasteItem,
  deps: Required<PasteResolveDeps>,
): Promise<ResolvedPasteItem> {
  const done = (status: PasteItemStatus, reason: string | null, candidates: InputSuggestion[] = [], partial = false): ResolvedPasteItem =>
    ({ ...item, status, reason, partial, candidates });

  if (item.unsupported) return done('unsupported', UNSUPPORTED_COPY[item.unsupported]);

  const coords = { lat: item.lat, lng: item.lng };
  if (item.query) {
    const res = await resolveText(sc, params, item.query, coords, deps.generate);
    if (res.kind === 'failed') return done('failed', res.reason);
    if (res.suggestions.length > 0) return done('resolved', null, res.suggestions, res.partial);
    // A named map pin the registry does not know still has a position: fall
    // through to naming the position, rather than calling it "no match".
    if (item.lat === null || item.lng === null) return done('no_match', null);
  }

  if (item.lat === null || item.lng === null) return done('no_match', null);
  const near = await deps.nearestCity(sc, item.lat, item.lng).catch((): NearestCityOutcome => ({ ok: false }));
  if (!near.ok) return done('failed', 'We couldn’t name this point — the place lookup didn’t answer.');
  if (!near.row) return done('no_match', null);

  const res = await resolveText(sc, params, near.row.name, coords, deps.generate);
  if (res.kind === 'failed') return done('failed', res.reason);
  // The registry row that named the point leads; the gateway's other readings follow.
  const named = near.row.id;
  const rows = [...res.suggestions].sort((a, b) => Number(b.entityId === named) - Number(a.entityId === named));
  return rows.length > 0 ? done('resolved', null, rows, res.partial) : done('no_match', null);
}

// ── PR-D2-7c: only a line that resolved to a place is echoed back ─────────────
//
// `resolved` items are returned as they are. A `no_match` item is DROPPED — the
// person sees fewer items, never their unmatched line repeated, and nothing
// about it is logged (the route logs counts of what it returns). A `failed` or
// `unsupported` item keeps its slot, so a failure is never read as "nothing
// found", but carries fixed copy only: no query, no line, no coordinate, no
// heading from the paste.

const NOT_ECHOED_LABEL: Record<PasteSource, string> = {
  coordinates: 'Pasted coordinates',
  map_link: 'Map link',
  text: 'Pasted line',
};

const UNSUPPORTED_LABEL: Record<UnsupportedLink, string> = {
  short_link: 'Shortened map link',
  unsupported_link: 'Link',
  flight_text: 'Flight details',
  booking_text: 'Hotel booking',
};

/** PR-D2-7c: the answer's items — resolved lines as they are, the rest fixed copy or nothing. Pure. */
export function echoOnlyResolved(items: readonly ResolvedPasteItem[]): ResolvedPasteItem[] {
  const out: ResolvedPasteItem[] = [];
  for (const it of items) {
    if (it.status === 'resolved') { out.push(it); continue; }
    if (it.status === 'no_match') continue;
    out.push({
      index: it.index,
      raw: it.unsupported ? UNSUPPORTED_LABEL[it.unsupported] : NOT_ECHOED_LABEL[it.source],
      source: it.source,
      provider: it.provider,
      query: null,
      lat: null,
      lng: null,
      timeHint: null,
      dayLabel: null,
      unsupported: it.unsupported,
      status: it.status,
      reason: it.status === 'unsupported' && it.unsupported ? UNSUPPORTED_COPY[it.unsupported] : (it.reason ?? 'We couldn’t check this one.'),
      partial: false,
      candidates: [],
    });
  }
  return out;
}

/**
 * Resolve every classified item, sequentially (a paste is bounded at
 * {@link PASTE_MAX_ITEMS}, and one lookup at a time keeps a paste from bursting
 * the registry). The answer passes through {@link echoOnlyResolved}.
 */
export async function resolvePaste(
  sc: SupabaseClient,
  params: PasteResolveParams,
  classification: PasteClassification,
  deps: PasteResolveDeps = {},
): Promise<ResolvedPasteItem[]> {
  const full: Required<PasteResolveDeps> = {
    generate: deps.generate ?? generateSuggestionsWithCoverage,
    nearestCity: deps.nearestCity ?? nearestCatalogCity,
  };
  const out: ResolvedPasteItem[] = [];
  for (const item of classification.items) {
    out.push(await resolveOne(sc, params, item, full));
  }
  return echoOnlyResolved(out); // PR-D2-7c: nothing unmatched leaves this function
}

// ── §24 flight / hotel text (census G159; lead ruling PR-D2-7) ────────────────
//
// THE RULING. A hotel confirmation yields EXACTLY ONE item: the property's name,
// or, failing that, its labelled address. Every other line — guest names,
// confirmation and booking numbers, card digits, dates, prices — is dropped
// before any lookup and never echoed, not even in `raw`. Flight text yields ONE
// unsupported item with fixed copy and no query: nothing from it is searched.
// Fail closed: a booking with neither a name nor an address is one unsupported
// item, never a guess at which line is the hotel.
//
// WHAT COUNTS AS ONE. A paste is a booking on one BOOKING_KEYWORD, or on TWO
// independent signals — one line that names "Hotel Majestic" is a place, not a
// confirmation. Flight signals win over hotel signals: an itinerary that
// mentions both is refused rather than half-read.
//
// LOCALISED (lead ruling PR-D2-7c). Every set below is read against a line's
// DETECTION FORM (`detectionForm`: NFKC — so a fullwidth "：" is ":" and
// fullwidth letters and digits are ASCII — then every Unicode decimal digit
// folded to 0-9) and carries the launch languages: en, vi, ja, th, de, es.
// Latin-script words are bounded by letters on both sides (`W`; JS `\b` is
// ASCII-only); Japanese and Thai words are not, because neither script puts
// spaces between words.

/** A Latin-script word or phrase with no letter or digit on either side. */
const W = (alts: string): string => `(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`;
/** A Latin-script STEM: bounded on the left only, so a compound matches ("Buchungsnummer"). */
const STEM = (alts: string): string => `(?<![\\p{L}\\p{N}])(?:${alts})`;
/** Case-insensitive, Unicode, written in the detection form's own normalisation. */
const rx = (src: string, flags = 'iu'): RegExp => new RegExp(src.normalize('NFKC'), flags);

const FLIGHT_SIGNALS: readonly RegExp[] = [
  rx(`${W('flights?|passengers?|boarding|departure|departs|arrival|arrives|gate|e-?ticket|ticket number|itinerary receipt|baggage|seat|flug|abflug|vuelo|embarque|chuyến bay')}|搭乗|フライト|便名|เที่ยวบิน|ขึ้นเครื่อง`),
  /\b(?:pnr|booking reference|record locator)\b/i,
  /\b[A-Z][A-Z0-9]\s?\d{2,4}\b/, // a flight number: "VN 123", "QR1083"
  /\b[A-Z]{3}\s*(?:→|->|–|—|-|to)\s*[A-Z]{3}\b/, // an airport pair: "SGN → HAN"
  // V-D2f F-C: a flight number in any case right after a flight word ("Flight vn123", "vuelo ib 6401")
  rx(`${W('flights?|flug|vuelo|chuyến bay|chuyen bay')}\\s*(?:no\\.?|number|nr\\.?|#)?\\s*[a-z][a-z0-9]\\s?\\d{2,4}(?![\\p{L}\\p{N}])`),
];

/** Two DISTINCT classes make a booking without a keyword. */
const HOTEL_SIGNALS: readonly RegExp[] = [
  rx(W('(?:booking|reservation)\\s+(?:confirm(?:ed|ation)|number|no|id|reference)|confirmation\\s+(?:number|no|code)') + '|confirmation\\s*#'),
  // check-in / arrival
  rx(`${W('check[\\s-]?in|anreise|llegada|nhận phòng')}|チェックイン|เช็[คก]อิน`),
  // check-out / departure — "check out the old town" is ordinary English, so this is never a keyword (F6)
  rx(`${W('check[\\s-]?out|abreise|salida|trả phòng')}|チェックアウト|เช็[คก]เอา[ทต]์`),
  // guests, room type, nights — counted, never alone (F6: "dinner for 2 guests" is an itinerary)
  rx(`${W('guests|guest name|guest(?=\\s*[:#])|\\d+\\s*guests?|room type|\\d+\\s*nights?|gäste|gast(?=\\s*[:#])|zimmer(?:typ|kategorie|art)|\\d+\\s*nächte|übernachtung(?:en)?|hu[eé]sped(?:es)?|tipo de habitaci[oó]n|\\d+\\s*noches?|khách(?= *[:#])|loại phòng|số đêm|\\d+\\s*đêm')}|宿泊者|ゲスト|客室|部屋タイプ|\\d+泊|ผู้เข้าพัก|ประเภทห้อง|\\d+\\s*คืน`),
  // PR-D2-7c (F6): words that alone are an ordinary itinerary — they only ever count beside another signal
  rx(`${W('itinerar(?:y|ies)|confirmed|bestätigt|confirmad[oa]|đã xác nhận')}|旅程|行程表|กำหนดการเดินทาง`),
];

const LABEL_SEP = '\\s*[:\\-–]\\s*';
/** The property's own label, any launch language. */
const PROPERTY_LABEL = rx(`^(?:${[
  'hotel(?:\\s*name)?', 'property(?:\\s+name)?', 'accommodation', 'hostel', 'resort', 'stay(?:ing)?\\s+at', 'lodging', 'guest\\s?house',
  'tên khách sạn', 'khách sạn', 'chỗ ở', 'nơi lưu trú', 'cơ sở lưu trú',
  'ホテル名?', '宿泊施設名?', '施設名', '宿泊先',
  'ชื่อโรงแรม', 'โรงแรม', 'ชื่อที่พัก', 'ที่พัก',
  '(?:name\\s+der\\s+)?unterkunft',
  'nombre del (?:hotel|alojamiento)', 'alojamiento', 'establecimiento', 'propiedad',
].join('|')})${LABEL_SEP}(.+)$`);
/** The property's address label, any launch language. Its value must hold a digit (F4). */
const ADDRESS_LABEL = rx(`^(?:(?:hotel|property)\\s+)?(?:address|địa chỉ|住所|所在地|ที่อยู่|adresse|anschrift|direcci[oó]n)${LABEL_SEP}(.+)$`);

/** How many DISTINCT signal patterns appear anywhere in the paste. */
function signalCount(lines: readonly string[], signals: readonly RegExp[]): number {
  let n = 0;
  for (const re of signals) if (lines.some((l) => re.test(l))) n++;
  return n;
}

function bookingItem(
  query: string | null,
  unsupported: UnsupportedLink | null,
): Omit<PasteItem, 'index'> {
  const clean = query ? stripUrls(query).trim().slice(0, MAX_QUERY_CHARS) : null;
  return {
    // `raw` is the extracted value only — never the line it came from, never
    // another line. An unsupported booking echoes nothing from the paste: its
    // label is fixed copy.
    raw: clean ? displayRaw(clean) : unsupported === 'flight_text' ? 'Flight details' : 'Hotel booking',
    source: 'text',
    provider: null,
    query: clean && clean.length > 0 ? clean : null,
    lat: null,
    lng: null,
    timeHint: null,
    dayLabel: null,
    unsupported: clean && clean.length > 0 ? null : unsupported,
  };
}

/**
 * The single item a flight or hotel booking yields, or null when the paste is
 * not a booking (the ordinary splitter then reads it). Pure.
 */
export function classifyTravelBooking(lines: readonly string[]): Omit<PasteItem, 'index'> | null {
  // PR-D2-7b (d): a ONE-line paste follows the same rules as many (the old
  // "fewer than two lines is never a booking" guard is gone). Signals are read
  // from the text with URLs removed, so a pasted booking-site LINK is a link;
  // PR-D2-7c: and in its detection form, so "：" is ":" and "７" is "7".
  const text = lines.map((l) => detectionForm(stripUrls(l)));
  // F8: a flight needs a flight word or an airport pair among its two signals —
  // a hotel's "Booking reference: HM 1234" is not a flight number.
  const flightWord = text.some((l) => FLIGHT_SIGNALS[0]!.test(l) || FLIGHT_SIGNALS[3]!.test(l));
  if (flightWord && signalCount(text, FLIGHT_SIGNALS) >= 2) return bookingItem(null, 'flight_text');
  // PR-D2-7b (c): ANY booking keyword makes the paste a booking, read ONLY for
  // its property or address; two hotel signals still do on their own.
  // V-D2f F-B: a property label with a name label on the same line is a booking too, read only for the property.
  const keyword = text.some((l) => BOOKING_KEYWORD.test(l) || (PROPERTY_LABEL.test(l.replace(BULLET, '').trim()) && INNER_NAME_LABEL.test(l)));
  // PR-D2-7c: a property or address LABEL is itself one hotel signal ("Property: …" beside "Check-out 14 Oct").
  const labelled = text.some((l) => { const t = l.replace(BULLET, '').trim(); return PROPERTY_LABEL.test(t) || ADDRESS_LABEL.test(t); }) ? 1 : 0;
  if (!keyword && signalCount(text, HOTEL_SIGNALS) + labelled < 2) return null;
  for (const [label, needsDigit] of [[PROPERTY_LABEL, false], [ADDRESS_LABEL, true]] as const) {
    for (const line of lines) {
      const m = detectionForm(line.replace(BULLET, '').trim()).match(label);
      const value = m ? safeLabelValue(m[1]!, needsDigit) : null;
      if (value) return bookingItem(value, 'booking_text');
    }
  }
  // Nothing safe remains: one unsupported item, fixed copy, no query — never the list splitter.
  return bookingItem(null, 'booking_text');
}

// ── Lead ruling PR-D2-7b (2026-10-08): personal data is dropped BEFORE any lookup ──
//
// PR-D2-7 promised that a booking's guest names, confirmation numbers and card
// digits are dropped before lookup and never echoed. The verifier showed what
// that missed (VERIFY-D2d F2–F4): text sharing the labelled hotel line, a one-line
// confirmation, a confirmation matching fewer than two signals, and — for any
// paste at all — a list line that is an e-mail, a card or a reference number.
//
// (a) For EVERY paste, one line or many, a line or segment that contains an
//     e-mail address, a run of six or more digits (spaces or dashes allowed
//     inside it), a card-like group (four groups of four, "ending NNNN",
//     "**** NNNN") or a phone number is dropped entirely: never looked up, never
//     echoed (`raw`), never logged. A bare "label: reference" line is dropped too.
//     URL tokens are removed first — a map link is parsed for its place, never
//     searched as text — and a decimal fraction is not a run (coordinates stay).
// (b) A PROPERTY / ADDRESS label's value stops at the first secondary separator
//     (" — ", " – ", ",", ";", "(", " | ") and at any inner label (Guest, Name,
//     Confirmation, Paid, Card, …); what remains must itself pass (a).
// (c) A paste with ANY booking keyword is read only for that value; if none is
//     safe it is one unsupported item with fixed copy and no query.
// (d) One-line pastes follow the same rules.

// (e) PR-D2-7c widens every shape above to the launch languages and to the
//     shapes the verifier showed slipping through (VERIFY-D2e F1–F4, F6, F7):
//     the detection form (fullwidth and \p{Nd} digits fold to ASCII, "：" to ":"),
//     dotted card and phone groups, a card-brand word near four digits, a
//     Unicode e-mail domain, a reference code with or without its colon or with
//     no label at all, and a NAME label in any launch language ("Guest:",
//     "Khách:", "宿泊者：", "ผู้เข้าพัก:", "Gast:", "Huésped:").

/**
 * PR-D2-7c: the form every check reads. NFKC folds fullwidth letters, digits and
 * the fullwidth colon to ASCII; then every Unicode decimal digit (\p{Nd} —
 * Arabic-Indic, Thai, Devanagari, …) folds to its ASCII value. Unicode encodes
 * each script's digits as a contiguous run starting at zero, so a digit's value
 * is its distance from the start of its run, mod 10. Pure.
 */
export function detectionForm(text: string): string {
  return (text ?? '').normalize('NFKC').replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0)!;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

const EMAIL = rx(`[^\\s@<>()"',;]+@[^\\s@<>()"',;]+\\.\\p{L}{2,}`);
/** Six or more digits, single spaces or dashes allowed between them; never inside a decimal fraction. */
const LONG_DIGIT_RUN = /(?<![\d.,])\d(?:[ -]?\d){5,}(?!\d)/;
/** Four groups of four; PR-D2-7c (F2): dots separate groups too. */
const CARD_GROUPS = /(?<!\d)\d{4}(?:[ .-]?\d{4}){3}(?!\d)/;
const CARD_TAIL = rx([
  `${W('end(?:ing|s)(?:\\s+(?:in|with))?|endet auf|endend (?:auf|mit)|(?:que )?termina(?:da)? en|đuôi|kết thúc bằng')}\\s*[:#]?\\s*\\d{4}(?!\\d)`,
  '(?:末尾|下4桁|ลงท้ายด้วย)\\s*[:#]?\\s*\\d{4}(?!\\d)',
  '(?:[x*•]{4}[ -]?){1,3}\\d{4}(?!\\d)',
  // PR-D2-7c (F1/F2): a card-brand word within 20 characters of a group of four digits ("Visa x4242", "Thẻ Visa đuôi 4242")
  `(?:${W('visa|master\\s?card|amex|american express|discover|jcb|diners|unionpay|maestro|cards?|karte|kreditkarte|tarjeta|thẻ')}|カード|บัตร)[^\\n\\d]{0,20}?(?<!\\d)\\d{4}(?!\\d)`,
].join('|'));
const PHONE = rx([
  String.raw`(?:\+|\b00)\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .()-]?\d){5,}`,
  String.raw`\(\d{2,4}\)\s*\d{3}[ .-]?\d{3,4}\b`,
  String.raw`\b0\d{1,3}[ .-]\d{3}[ .-]\d{3,4}\b`,
  String.raw`\b\d{2,4}[ -]\d{3}[ -]\d{3,4}\b`,
  String.raw`(?<![\d.])\d{3}\.\d{3}\.\d{4}(?![\d.])`, // PR-D2-7c (F2): a dotted local number, "555.123.4567"
  `(?:${W('tel|phone|mobile|telefon|tel[eé]fono|m[oó]vil|handy|điện thoại|sđt|đt')}|電話|携帯|โทร)\\s*[:.]?\\s*\\+?\\d`,
].join('|'));
/** "Ref: AB12345", "Reservation ID: 7781-234", "予約番号：AB12345" — a label, then an upper-case code with three or more digits. */
const LABEL_REFERENCE = /^\p{L}[\p{L}\p{N} .'#/-]{0,30}?\s*[:#]\s*(?=(?:[A-Z\d -]*\d){3})[A-Z\d][A-Z\d -]{3,}$/u;
/** PR-D2-7c (F3): a reference label whose colon is optional ("Record locator ABC123", "PNR QXZTPB"). */
const REFERENCE_LABEL = rx(`^(?:record\\s+locator|locator|pnr|ref(?:erence)?(?:\\s+(?:no|number|code))?|conf(?:irmation)?(?:\\s+(?:no|number|code))?|booking\\s+(?:ref(?:erence)?|code|id|no|number)|localizador|buchungsnummer|reservierungsnummer|mã đặt(?: phòng| chỗ)?|予約番号|確認番号|หมายเลขการจอง|รหัสการจอง)\\.?\\s*[:#]?\\s*(\\S.*)$`);
/** An upper-case code: digits, or five or more capitals. Case-sensitive on purpose. */
const REFERENCE_CODE = /^[A-Z0-9][A-Z0-9 -]{3,}$/;
/** PR-D2-7c (F3): a bare booking code on its own ("X7K9P2") — capitals and at least one digit. Case-sensitive. */
const BARE_CODE = /^(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,10}$/;
/**
 * PR-D2-7c (F1/F3): a line or segment that is a person's NAME by its label, in
 * any launch language. Dropped whole, whatever follows the label. V-D2f F-A: the
 * label may be followed by a spaced dash ("Guest – Jane Doe") and may be a
 * compound ("Name of guest", "Name des Gastes", "Nombre del huésped"); F-D: a
 * date of birth is a person's label too, and Vietnamese typed without diacritics
 * ("Khach:") is the same label. A Japanese/Thai label needs no colon at all.
 */
const NAME_LABEL = rx(`^(?:(?:${[
  // a compound person label; never the property's own ("Name der Unterkunft", "Nombre del hotel")
  'names?\\s+(?:of|des|der|del|de\\s+la|du)\\s+(?!(?:the\\s+)?(?:unterkunft|hotels?|h[oô]tel|property|propiedad|accommodation|alojamiento|establecimiento|lodging|resort|hostel)(?![\\p{L}\\p{N}]))\\p{L}+', 'nombre\\s+(?:del?|de\\s+la)\\s+(?!(?:the\\s+)?(?:unterkunft|hotels?|h[oô]tel|property|propiedad|accommodation|alojamiento|establecimiento|lodging|resort|hostel)(?![\\p{L}\\p{N}]))\\p{L}+', 'nom\\s+du\\s+(?!(?:the\\s+)?(?:unterkunft|hotels?|h[oô]tel|property|propiedad|accommodation|alojamiento|establecimiento|lodging|resort|hostel)(?![\\p{L}\\p{N}]))\\p{L}+',
  'tên\\s+(?:của\\s+)?khách(?:\\s+hàng)?', 'ten(?:\\s+khach(?:\\s+hang)?)?', 'ho(?:\\s+va)?\\s+ten', 'khach(?:\\s+hang)?', 'nguoi\\s+dat(?:\\s+phong)?', 'chu\\s+the', 'hanh\\s+khach',
  'dob', 'd\\.o\\.b\\.?', 'date\\s+of\\s+birth', 'birth\\s*date', 'geburtsdatum', 'fecha\\s+de\\s+nacimiento', 'ngày\\s+sinh', 'ngay\\s+sinh', '生年月日', 'วันเกิด',
  '(?:full\\s+|first\\s+|last\\s+|guest\\s+|travell?er\\s+|passenger\\s+|contact\\s+|customer\\s+)?names?', 'surname',
  '(?:lead\\s+|main\\s+|primary\\s+)?guests?', 'host', 'travell?ers?', 'passengers?', 'card\\s?holder', 'contact', 'client', 'customer',
  'booked\\s+by', 'booker', 'reserved\\s+for', 'attn', 'attention',
  'tên(?: khách(?: hàng)?)?', 'họ(?: và)? tên', 'khách(?: hàng)?', 'người đặt(?: phòng)?', 'chủ thẻ', 'hành khách',
  '氏名', '名前', 'お名前', '宿泊者(?:名|氏名)?', '予約者(?:名|氏名)?', 'ゲスト名?', '代表者(?:名|氏名)?', '搭乗者名?', 'カード名義人?',
  'ชื่อ(?:\\s*-?\\s*นามสกุล)?', 'ชื่อผู้เข้าพัก', 'ผู้เข้าพัก', 'ชื่อผู้จอง', 'ผู้จอง', 'แขก', 'ผู้โดยสาร', 'ชื่อลูกค้า', 'ลูกค้า',
  '(?:vor|nach)name', 'gast(?:name)?', 'gäste', 'reisender?', 'passagier(?:e)?', 'karteninhaber(?:in)?', 'gastgeber(?:in)?', 'kunde', 'ansprechpartner(?:in)?', 'gebucht\\s+von',
  'nombre(?:\\s+completo)?', 'apellidos?', 'hu[eé]sped(?:es)?', 'titular', 'viajer[oa]s?', 'pasajer[oa]s?', 'anfitri[oó]n', 'cliente', 'reservado\\s+por',
].join('|')})(?:\\s*[:#]|\\s+[–—-]\\s)|(?:氏名|お名前|名前|宿泊者(?:名|氏名)?|予約者(?:名|氏名)?|代表者(?:名|氏名)?|搭乗者名?|カード名義人?|ゲスト名|生年月日|ชื่อผู้เข้าพัก|ผู้เข้าพัก|ชื่อผู้จอง|วันเกิด)\\s+\\S)`);
/**
 * V-D2f F-B: a name label INSIDE a line ("Hotel: Majestic Saigon Name: Jane Doe").
 * The line is dropped before lookup; beside a property label it makes the line a
 * booking, read only for the property. "Hotel name:" is the property's own label, not a person's.
 */
const INNER_NAME_LABEL = rx([
  `(?<!(?:hotel|property|accommodation|guest\\s?house)\\s*)${W('names?|guests?|guest\\s+name|gast(?:name)?|gäste|hu[eé]sped(?:es)?|nombre|khách|khach|tên|card\\s?holder|passengers?|travell?ers?|dob|date\\s+of\\s+birth')}\\s*[:#]`,
  '(?<!(?:ホテル|施設))(?:宿泊者|氏名|予約者|ゲスト名?|生年月日)\\s*[:#]', '(?:ผู้เข้าพัก|ชื่อผู้จอง)\\s*[:#]',
].join('|'));
/** V-D2f F-D: a labelled value that is only a date ("DOB: 12/05/1990") is never a place. */
const LABELLED_DATE = /^\p{L}[\p{L} .'/-]{0,30}?\s*[:#]\s*\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\.?$/u;
/** V-D2f F-D: a lower-case code after a reference label ("Locator: abc123") — one token with a digit. */
const LOWER_REFERENCE_CODE = /^(?=[a-z0-9]*\d)[a-z0-9]{5,12}$/i;

/** PR-D2-7b (c) / PR-D2-7c: ONE of these makes a paste a booking. Narrow on purpose (F6): "itinerary", "guests" and "check out" only count as two-signal words. */
const BOOKING_KEYWORD = rx([
  W('reservations?|bookings?|booked|reserved|confirmations?|pnr|e-?tickets?|record\\s+locator|check-?in'),
  `${W('check\\s+in')}(?=\\s*[:\\-–]|[^\\n]{0,8}\\d)`, // a spaced "check in" only as a label or beside a time or date
  STEM('buchung|reservierung|bestätigung'), W('gebucht|reserviert'),
  W('reservaci[oó]n|localizador|confirmaci[oó]n|(?:número|n[.º°o]) de reserva|(?:tu|su) reserva|reserva (?:confirmada|n[.º°o]|número|#)'),
  W('đặt phòng|đặt chỗ|mã đặt(?: phòng| chỗ)?|nhận phòng'),
  '予約|確認番号|チェックイン',
  'การจอง|จองห้อง|เช็[คก]อิน|หมายเลขยืนยัน',
].join('|'));
/** PR-D2-7b (b) / PR-D2-7c (F4, F7): where a labelled value ends. */
const VALUE_STOP = rx([
  '\\s[—–]\\s', '\\s-\\s', '[,;(]', '\\s\\|\\s', '\\s/|/\\s', '\\s[·•]\\s',
  W('for|guests?|confirmation|paid|card|e-?mail|visa|mastercard|amex|booking|reservation'),
  W('mr|mrs|ms|miss|mx|dr|herr|frau|sr|sra|srta') + '\\.?(?=\\s)',
  `${W('names?|gast|gäste|hu[eé]sped(?:es)?|nombre|khách|tên')}\\s*[:#]`, '(?:宿泊者|氏名|予約者|ゲスト|ผู้เข้าพัก|ชื่อ)\\s*[:#]',
].join('|'));

/** PR-D2-7c (F3): a reference label, colon optional, followed by an upper-case code. */
function isLabelledCode(t: string): boolean {
  const m = t.match(REFERENCE_LABEL);
  if (!m) return false;
  const code = m[1]!.trim();
  return (REFERENCE_CODE.test(code) && (/\d/.test(code) || /^[A-Z]{5,}$/.test(code.replace(/[ -]/g, '')))) || LOWER_REFERENCE_CODE.test(code);
}

/** PR-D2-7c: a line that is a person's name by its label, in any launch language. Pure. */
export function isNameLabel(text: string): boolean {
  return NAME_LABEL.test(detectionForm(stripUrls(text ?? '')).trim());
}

/** PR-D2-7b (a) / PR-D2-7c: this text is never looked up, echoed or logged. Pure. */
export function dropBeforeLookup(text: string): boolean {
  const t = detectionForm(stripUrls(text ?? '')).trim();
  if (!t) return false;
  return EMAIL.test(t) || LONG_DIGIT_RUN.test(t) || CARD_GROUPS.test(t) || CARD_TAIL.test(t) || PHONE.test(t)
    || LABEL_REFERENCE.test(t) || isLabelledCode(t) || BARE_CODE.test(t) || NAME_LABEL.test(t)
    || INNER_NAME_LABEL.test(t) || LABELLED_DATE.test(t); // V-D2f F-B, F-D
}

/**
 * PR-D2-7b (b): a labelled property/address value, cut at its first stop, or null
 * when nothing safe remains. PR-D2-7c (F4): an ADDRESS value with no digit is a
 * name, not an address, and is refused.
 */
export function safeLabelValue(captured: string, needsDigit = false): string | null {
  const cut = detectionForm(captured ?? '').split(VALUE_STOP)[0]!.replace(/[\s:.\-–—/·•]+$/u, '').trim();
  if (!cut || dropBeforeLookup(cut)) return null;
  if (needsDigit && !/\d/.test(cut)) return null;
  return cut;
}
