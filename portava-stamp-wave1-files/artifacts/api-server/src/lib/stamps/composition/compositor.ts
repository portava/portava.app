/**
 * Stamp composition engine — Stamp Wave 1 (the pivot of the premium upgrade).
 *
 * The AI provider supplies HERO ART ONLY (no text — see buildHeroArtPrompt).
 * Every other layer is Portava-controlled vector work, so typography is never
 * garbled and rarity/edition/authenticity marks are always consistent:
 *
 *   glow halo (epic+) → perforated silhouette mask → frame material (rarity)
 *   → authenticity/edition micro-text → identity band → typography
 *   → hero art (AI image, or procedural vector fallback) → art rim
 *   → foil sheen (uncommon+)
 *
 * Five template families (spec Part 5): seal, portrait, landscape, square,
 * pennant. Rarity changes the FRAME MATERIAL only; identity (palette+motif)
 * and shape never change with rarity.
 *
 * Deliberately excluded from shared catalog artwork: per-user data (earn
 * date, edition number). Those are client-side overlay concerns — catalog
 * art is shared by every earner of the stamp.
 *
 * Output is an SVG document + a layer manifest (persisted to
 * stamp_artwork_versions.composition); rasterization lives in rasterize.ts.
 */

import type { DestinationIdentity, StampPalette } from "./identities.js";
import { heroScene } from "./heroScenes.js";

export const COMPOSITION_ENGINE_VERSION = "compose-v1";

const FONT = "Poppins";

// ── Template families ────────────────────────────────────────────────────────

export type TemplateFamily = "seal" | "portrait" | "landscape" | "square" | "pennant";

export const TEMPLATE_FAMILIES: Record<TemplateFamily, { w: number; h: number }> = {
  seal:      { w: 1000, h: 1000 },
  portrait:  { w: 780,  h: 1000 },
  landscape: { w: 1000, h: 780 },
  square:    { w: 1000, h: 1000 },
  pennant:   { w: 1000, h: 1000 },
};

/** Default family per stamp_type (definition.template_family overrides). */
export function templateFamilyForType(stampType: string | null | undefined): TemplateFamily {
  switch (stampType) {
    case "country":       return "portrait";
    case "region":        return "landscape";
    case "neighborhood":  return "square";
    case "special_event": return "pennant";
    case "hidden_gem":    return "pennant";
    case "landmark":      return "portrait";
    case "city":
    case "check_in":
    default:              return "seal";
  }
}

// ── Rarity materials ─────────────────────────────────────────────────────────

export type StampRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

const METALS: Record<string, string[]> = {
  bronze: ["#5C3A1E", "#B5793C", "#8A5526", "#E2A968", "#5C3A1E"],
  silver: ["#5B6B7C", "#E8EFF6", "#8FA0B0", "#C7D3DE", "#5B6B7C"],
  gold:   ["#8C6A1D", "#F6DE8D", "#B8860B", "#FFEDB0", "#8C6A1D"],
  royal:  ["#7A5A10", "#FFE9A0", "#D4A017", "#FFF6CE", "#9C7414"],
};

interface RarityTreatment {
  label: string;
  metal: string | null;
  glow: number;
  sheen: number;
  halo?: boolean;
}

export const RARITY_TREATMENTS: Record<StampRarity, RarityTreatment> = {
  common:    { label: "COMMON",    metal: null,     glow: 0,    sheen: 0 },
  uncommon:  { label: "UNCOMMON",  metal: "bronze", glow: 0,    sheen: 0.14 },
  rare:      { label: "RARE",      metal: "silver", glow: 0,    sheen: 0.16 },
  epic:      { label: "EPIC",      metal: "gold",   glow: 0.38, sheen: 0.2 },
  legendary: { label: "LEGENDARY", metal: "royal",  glow: 0.72, sheen: 0.26, halo: true },
};

const MICRO_INK: Record<string, string> = {
  bronze: "#F7E9D4", silver: "#26313D", gold: "#3D2E08", royal: "#3D2E08",
};

export function normalizeRarity(value: string | null | undefined): StampRarity {
  const v = (value ?? "").toLowerCase();
  return (["common", "uncommon", "rare", "epic", "legendary"].includes(v) ? v : "common") as StampRarity;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function perfHoles(edges: number[][][], r = 11, spacing = 33): string {
  let out = "";
  for (const [[x1, y1], [x2, y2]] of edges) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out += `<circle cx="${(x1 + (x2 - x1) * t).toFixed(1)}" cy="${(y1 + (y2 - y1) * t).toFixed(1)}" r="${r}" fill="#000"/>`;
    }
  }
  return out;
}

/**
 * Hero layer for a window: AI raster (cover-fit, focus-biased) when provided,
 * procedural vector scene otherwise.
 */
function heroLayer(
  hero: string | null,
  identity: DestinationIdentity,
  wx: number, wy: number, ww: number, wh: number,
  focusY: number,
): { markup: string; kind: "ai" | "procedural" } {
  const s = Math.max(ww, wh) / 1000;
  const ox = wx - (1000 * s - ww) / 2;
  const oy = wy - (1000 * s - wh) * focusY;
  if (hero) {
    return {
      kind: "ai",
      markup: `<image href="${hero}" x="${ox.toFixed(1)}" y="${oy.toFixed(1)}" width="${(1000 * s).toFixed(1)}" height="${(1000 * s).toFixed(1)}" preserveAspectRatio="xMidYMid slice"/>`,
    };
  }
  return {
    kind: "procedural",
    markup: `<g transform="translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${s.toFixed(4)})">${heroScene(identity.motif, identity.palette)}</g>`,
  };
}

function fitFont(text: string, maxW: number, base: number): number {
  const n = [...text].length;
  return Math.min(base, maxW / (0.66 * n + 0.18 * Math.max(0, n - 1)));
}

function txt(
  text: string, x: number, y: number,
  o: { fs: number; fill: string; weight?: number; ls?: number; opacity?: number },
): string {
  const ls = o.ls ?? 0;
  return `<text x="${x + ls / 2}" y="${y}" font-family="${FONT}" font-size="${o.fs.toFixed(1)}" font-weight="${o.weight ?? 700}" letter-spacing="${ls}" fill="${o.fill}" opacity="${o.opacity ?? 1}" text-anchor="middle">${esc(text)}</text>`;
}

function arcLetters(
  text: string,
  o: { cx: number; cy: number; r: number; centerDeg: number; fontSize: number; fill: string; weight?: number; invert?: boolean; opacity?: number; maxSpread?: number },
): string {
  const chars = [...text];
  if (!chars.length) return "";
  const maxSpread = o.maxSpread ?? 150;
  let step = ((o.fontSize * 1.12) / o.r) * (180 / Math.PI);
  if ((chars.length - 1) * step > maxSpread) step = maxSpread / (chars.length - 1);
  const spread = (chars.length - 1) * step;
  const dir = o.invert ? -1 : 1;
  const start = o.centerDeg - dir * (spread / 2);
  const dy = o.fontSize * 0.35;
  let out = `<g font-family="${FONT}" font-size="${o.fontSize}" font-weight="${o.weight ?? 700}" fill="${o.fill}" opacity="${o.opacity ?? 1}" text-anchor="middle">`;
  chars.forEach((ch, i) => {
    if (ch === " ") return;
    const a = start + dir * i * step;
    const rad = (a * Math.PI) / 180;
    const x = o.cx + o.r * Math.cos(rad);
    const y = o.cy + o.r * Math.sin(rad);
    const rot = o.invert ? a - 90 : a + 90;
    out += `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${esc(ch)}</text>`;
  });
  return out + `</g>`;
}

function cornerDiamond(x: number, y: number, size: number, fill: string): string {
  return `<rect x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" transform="translate(${x} ${y}) rotate(45)" fill="${fill}"/>`;
}

function rarityDefs(uid: string, t: RarityTreatment, P: StampPalette, rarity: StampRarity, W: number, H: number): string {
  let defs = "";
  if (t.metal) {
    const stops = METALS[t.metal]
      .map((c, i, a) => `<stop offset="${(i / (a.length - 1)).toFixed(2)}" stop-color="${c}"/>`)
      .join("");
    defs += `<linearGradient id="ring-${uid}" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>`;
  }
  if (t.sheen > 0) {
    const s = t.sheen;
    const span = Math.max(W, H) * 1.02;
    defs += `<linearGradient id="sheen-${uid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${span}" y2="0" gradientTransform="rotate(-22 ${W / 2} ${H / 2})">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.3" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.4" stop-color="#fff" stop-opacity="${s}"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.56" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.61" stop-color="#fff" stop-opacity="${(s * 0.55).toFixed(3)}"/>
      <stop offset="0.67" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>`;
  }
  if (t.glow > 0) {
    defs += `<filter id="gblur-${uid}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="18"/></filter>`;
  }
  return defs;
}

function glowColorFor(rarity: StampRarity, P: StampPalette): string {
  return rarity === "legendary" ? P.accent : "#F3D77C";
}

// ── Compose options / result ─────────────────────────────────────────────────

export interface ComposeOptions {
  identity: DestinationIdentity;
  /** Uppercased headline (city or stamp display name). */
  title: string;
  /** Secondary line (country). Empty string → subtitle band still renders, text omitted. */
  subtitle: string;
  family?: TemplateFamily;
  rarity?: StampRarity;
  /** data:image/png;base64,… hero art. Null → procedural vector fallback. */
  heroImageDataUrl?: string | null;
  /** Edition line: from stamp_definitions (is_limited + edition_size). */
  isLimited?: boolean;
  editionSize?: number | null;
  /** Unique id prefix so multiple stamps can share one SVG doc. */
  uid?: string;
}

export interface CompositionManifest {
  engine: string;
  family: TemplateFamily;
  rarity: StampRarity;
  identity_key: string;
  identity_source: string;
  motif: string;
  hero: "ai" | "procedural";
  edition: string;
  fonts: string[];
  layers: string[];
}

export interface ComposedStamp {
  svg: string;
  width: number;
  height: number;
  manifest: CompositionManifest;
}

function editionLine(o: ComposeOptions, t: RarityTreatment): string {
  if (o.isLimited && o.editionSize && o.editionSize > 0) {
    return `LIMITED EDITION OF ${o.editionSize} • ${t.label}`;
  }
  return `OPEN EDITION • ${t.label}`;
}

// ── Seal ─────────────────────────────────────────────────────────────────────

function buildSeal(o: ComposeOptions, uid: string): { body: string; hero: "ai" | "procedural" } {
  const P = o.identity.palette;
  const rarity = o.rarity ?? "common";
  const t = RARITY_TREATMENTS[rarity];
  const CX = 500, CY = 500;
  const R_EDGE = 478, R_RING_IN = 434, R_BAND_OUT = 426, R_BAND_IN = 330, R_ART = 322, R_TEXT = 378, R_MICRO = 456;
  const ringFill = t.metal ? `url(#ring-${uid})` : P.border;
  const microInk = t.metal ? MICRO_INK[t.metal] : P.paper;

  const holes: string[] = [];
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 * Math.PI) / 180;
    holes.push(`<circle cx="${(CX + R_EDGE * Math.cos(a)).toFixed(1)}" cy="${(CY + R_EDGE * Math.sin(a)).toFixed(1)}" r="12" fill="#000"/>`);
  }

  const hero = heroLayer(o.heroImageDataUrl ?? null, o.identity, CX - R_ART, CY - R_ART, R_ART * 2, R_ART * 2, 0.48);
  const glow = t.glow > 0
    ? `<g filter="url(#gblur-${uid})"><circle cx="${CX}" cy="${CY}" r="${R_EDGE + 4}" fill="none" stroke="${glowColorFor(rarity, P)}" stroke-width="30" opacity="${Math.min(1, t.glow * 0.85).toFixed(2)}"/></g>` +
      (t.halo ? `<circle cx="${CX}" cy="${CY}" r="${R_EDGE + 16}" fill="none" stroke="#F6DE8D" stroke-width="3" opacity="0.55"/>` : "")
    : "";
  const sheen = t.sheen > 0 ? `<rect x="0" y="0" width="1000" height="1000" fill="url(#sheen-${uid})"/>` : "";

  const body = `<g>
    <defs>
      <mask id="perf-${uid}" maskUnits="userSpaceOnUse" x="-40" y="-40" width="1080" height="1080">
        <circle cx="${CX}" cy="${CY}" r="${R_EDGE}" fill="#fff"/>${holes.join("")}
      </mask>
      <clipPath id="art-${uid}"><circle cx="${CX}" cy="${CY}" r="${R_ART}"/></clipPath>
      ${rarityDefs(uid, t, P, rarity, 1000, 1000)}
    </defs>
    ${glow}
    <g mask="url(#perf-${uid})">
      <circle cx="${CX}" cy="${CY}" r="${R_EDGE}" fill="${ringFill}"/>
      <circle cx="${CX}" cy="${CY}" r="470" fill="none" stroke="${microInk}" stroke-width="1.5" opacity="0.5" stroke-dasharray="2 6"/>
      ${arcLetters("• PORTAVA AUTHENTIC •", { cx: CX, cy: CY, r: R_MICRO, centerDeg: -90, fontSize: 19, fill: microInk, weight: 600, opacity: 0.92 })}
      ${arcLetters(editionLine(o, t), { cx: CX, cy: CY, r: R_MICRO, centerDeg: 90, fontSize: 19, fill: microInk, weight: 600, opacity: 0.92, invert: true })}
      <circle cx="${CX}" cy="${CY}" r="${R_RING_IN}" fill="${P.paper}"/>
      <circle cx="${CX}" cy="${CY}" r="${R_BAND_OUT}" fill="${P.primary}"/>
      ${arcLetters(o.title, { cx: CX, cy: CY, r: R_TEXT, centerDeg: -90, fontSize: 62, fill: P.paper })}
      ${o.subtitle ? arcLetters(o.subtitle, { cx: CX, cy: CY, r: R_TEXT, centerDeg: 90, fontSize: 36, fill: P.paper, weight: 600, opacity: 0.95, invert: true }) : ""}
      ${cornerDiamond(CX - R_TEXT, CY, 18, P.accent)}
      ${cornerDiamond(CX + R_TEXT, CY, 18, P.accent)}
      <circle cx="${CX}" cy="${CY}" r="${R_BAND_IN}" fill="${P.paper}"/>
      <g clip-path="url(#art-${uid})">${hero.markup}</g>
      <circle cx="${CX}" cy="${CY}" r="${R_ART}" fill="none" stroke="${P.primary}" stroke-width="7"/>
      <circle cx="${CX}" cy="${CY}" r="${R_ART + 6}" fill="none" stroke="${P.paper}" stroke-width="2.5"/>
      ${sheen}
    </g>
  </g>`;
  return { body, hero: hero.kind };
}

// ── Rect family (portrait / landscape / square) ──────────────────────────────

function buildRect(o: ComposeOptions, uid: string, W: number, H: number): { body: string; hero: "ai" | "procedural" } {
  const P = o.identity.palette;
  const rarity = o.rarity ?? "common";
  const t = RARITY_TREATMENTS[rarity];
  const ringFill = t.metal ? `url(#ring-${uid})` : P.border;
  const M = 22, F = 30, IN = M + F + 14;
  const topBandH = 92, bottomBandH = 100;
  const cw = W - 2 * IN;
  const artY0 = IN + topBandH + 8;
  const artY1 = H - IN - bottomBandH - 8;
  const artH = artY1 - artY0;
  const focusY = cw / artH > 1.4 ? o.identity.wideFocus : 0.48;

  const edges = [[[0, 0], [W, 0]], [[W, 0], [W, H]], [[W, H], [0, H]], [[0, H], [0, 0]]];
  const titleFs = fitFont(o.title, cw - 60, 56);
  const microLine = `PORTAVA AUTHENTIC  •  ${editionLine(o, t)}`;

  const hero = heroLayer(o.heroImageDataUrl ?? null, o.identity, IN, artY0, cw, artH, focusY);
  const glow = t.glow > 0
    ? `<g filter="url(#gblur-${uid})"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="none" stroke="${glowColorFor(rarity, P)}" stroke-width="30" opacity="${Math.min(1, t.glow * 0.85).toFixed(2)}"/></g>` +
      (t.halo ? `<rect x="-8" y="-8" width="${W + 16}" height="${H + 16}" rx="20" fill="none" stroke="#F6DE8D" stroke-width="3" opacity="0.55"/>` : "")
    : "";
  const sheen = t.sheen > 0 ? `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#sheen-${uid})"/>` : "";

  const body = `<g>
    <defs>
      <mask id="perf-${uid}" maskUnits="userSpaceOnUse" x="-40" y="-40" width="${W + 80}" height="${H + 80}">
        <rect x="0" y="0" width="${W}" height="${H}" rx="6" fill="#fff"/>${perfHoles(edges)}
      </mask>
      <clipPath id="art-${uid}"><rect x="${IN}" y="${artY0}" width="${cw}" height="${artH}" rx="10"/></clipPath>
      ${rarityDefs(uid, t, P, rarity, W, H)}
    </defs>
    ${glow}
    <g mask="url(#perf-${uid})">
      <rect x="0" y="0" width="${W}" height="${H}" fill="${P.paper}"/>
      <rect x="${M + F / 2}" y="${M + F / 2}" width="${W - 2 * M - F}" height="${H - 2 * M - F}" rx="12" fill="none" stroke="${ringFill}" stroke-width="${F}"/>
      <rect x="${M + F + 5}" y="${M + F + 5}" width="${W - 2 * (M + F + 5)}" height="${H - 2 * (M + F + 5)}" rx="8" fill="none" stroke="${P.primary}" stroke-width="2.5" opacity="0.55"/>
      ${cornerDiamond(M + F / 2, M + F / 2, 17, P.accent)}
      ${cornerDiamond(W - M - F / 2, M + F / 2, 17, P.accent)}
      ${cornerDiamond(M + F / 2, H - M - F / 2, 17, P.accent)}
      ${cornerDiamond(W - M - F / 2, H - M - F / 2, 17, P.accent)}
      <rect x="${IN}" y="${IN}" width="${cw}" height="${topBandH}" rx="10" fill="${P.primary}"/>
      ${txt(o.title, W / 2, IN + topBandH / 2 + titleFs * 0.36, { fs: titleFs, fill: P.paper, ls: titleFs * 0.22 })}
      ${cornerDiamond(IN + 34, IN + topBandH / 2, 14, P.accent)}
      ${cornerDiamond(W - IN - 34, IN + topBandH / 2, 14, P.accent)}
      <g clip-path="url(#art-${uid})">${hero.markup}</g>
      <rect x="${IN}" y="${artY0}" width="${cw}" height="${artH}" rx="10" fill="none" stroke="${P.primary}" stroke-width="6"/>
      <rect x="${IN + 4}" y="${artY0 + 4}" width="${cw - 8}" height="${artH - 8}" rx="8" fill="none" stroke="${P.paper}" stroke-width="2" opacity="0.9"/>
      <rect x="${IN}" y="${H - IN - bottomBandH}" width="${cw}" height="${bottomBandH}" rx="10" fill="${P.primary}"/>
      ${o.subtitle ? txt(o.subtitle, W / 2, H - IN - bottomBandH + 44, { fs: 33, fill: P.paper, weight: 600, ls: 7 }) : ""}
      ${txt(microLine, W / 2, H - IN - bottomBandH + 78, { fs: 15.5, fill: P.paper, weight: 500, ls: 1.5, opacity: 0.85 })}
      ${sheen}
    </g>
  </g>`;
  return { body, hero: hero.kind };
}

// ── Pennant (triangle) ───────────────────────────────────────────────────────

function trianglePath(pts: number[][]): string {
  return `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]} L${pts[2][0]} ${pts[2][1]} Z`;
}

function shrinkTri(pts: number[][], k: number): number[][] {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

function buildPennant(o: ComposeOptions, uid: string): { body: string; hero: "ai" | "procedural" } {
  const P = o.identity.palette;
  const rarity = o.rarity ?? "common";
  const t = RARITY_TREATMENTS[rarity];
  const ringFill = t.metal ? `url(#ring-${uid})` : P.border;
  const T = [[500, 64], [946, 892], [54, 892]];
  const frameT = shrinkTri(T, 0.94);
  const pinT = shrinkTri(T, 0.875);
  const artT = [[500, 168], [812, 748], [188, 748]];
  const titleFs = fitFont(o.title, 520, 46);

  const hero = heroLayer(o.heroImageDataUrl ?? null, o.identity, 188, 168, 624, 580, 0.42);
  const glow = t.glow > 0
    ? `<g filter="url(#gblur-${uid})"><path d="${trianglePath(T)}" fill="none" stroke="${glowColorFor(rarity, P)}" stroke-width="30" stroke-linejoin="round" opacity="${Math.min(1, t.glow * 0.85).toFixed(2)}"/></g>` +
      (t.halo ? `<path d="${trianglePath(shrinkTri(T, 1.015))}" fill="none" stroke="#F6DE8D" stroke-width="3" opacity="0.55" stroke-linejoin="round"/>` : "")
    : "";
  const sheen = t.sheen > 0 ? `<rect x="0" y="0" width="1000" height="1000" fill="url(#sheen-${uid})"/>` : "";
  const edges = [[T[0], T[1]], [T[1], T[2]], [T[2], T[0]]];

  const body = `<g>
    <defs>
      <mask id="perf-${uid}" maskUnits="userSpaceOnUse" x="-40" y="-40" width="1080" height="1080">
        <path d="${trianglePath(T)}" fill="#fff"/>${perfHoles(edges)}
      </mask>
      <clipPath id="art-${uid}"><path d="${trianglePath(artT)}"/></clipPath>
      ${rarityDefs(uid, t, P, rarity, 1000, 1000)}
    </defs>
    ${glow}
    <g mask="url(#perf-${uid})">
      <path d="${trianglePath(T)}" fill="${P.paper}"/>
      <path d="${trianglePath(frameT)}" fill="none" stroke="${ringFill}" stroke-width="26" stroke-linejoin="round"/>
      <path d="${trianglePath(pinT)}" fill="none" stroke="${P.primary}" stroke-width="2.5" opacity="0.55" stroke-linejoin="round"/>
      <g clip-path="url(#art-${uid})">${hero.markup}</g>
      <path d="${trianglePath(artT)}" fill="none" stroke="${P.primary}" stroke-width="6" stroke-linejoin="round"/>
      ${txt(o.title, 500, 788 + titleFs * 0.36, { fs: titleFs, fill: P.primary, ls: titleFs * 0.2 })}
      ${txt(`${o.subtitle ? o.subtitle + "  •  " : ""}${editionLine(o, t)}`, 500, 846, { fs: 19, fill: P.primary, weight: 600, ls: 2, opacity: 0.85 })}
      ${sheen}
    </g>
  </g>`;
  return { body, hero: hero.kind };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function composeStamp(o: ComposeOptions): ComposedStamp {
  const family = o.family ?? "seal";
  const dims = TEMPLATE_FAMILIES[family];
  if (!dims) throw new Error(`unknown template family: ${family}`);
  const rarity = o.rarity ?? "common";
  const t = RARITY_TREATMENTS[rarity];
  const uid = (o.uid ?? "s0").replace(/[^a-zA-Z0-9_-]/g, "");

  let built: { body: string; hero: "ai" | "procedural" };
  if (family === "seal") built = buildSeal(o, uid);
  else if (family === "pennant") built = buildPennant(o, uid);
  else built = buildRect(o, uid, dims.w, dims.h);

  // Pad so glow/halo fades inside the canvas instead of clipping.
  const PAD = 64;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dims.w + PAD * 2}" height="${dims.h + PAD * 2}" viewBox="${-PAD} ${-PAD} ${dims.w + PAD * 2} ${dims.h + PAD * 2}">${built.body}</svg>`;

  const layers = [
    ...(t.glow > 0 ? ["glow"] : []),
    "perforation-mask",
    "frame-material",
    "micro-text",
    "identity-band",
    "typography",
    `hero:${built.hero}`,
    "art-rim",
    ...(t.sheen > 0 ? ["foil-sheen"] : []),
  ];

  return {
    svg,
    width: dims.w + PAD * 2,
    height: dims.h + PAD * 2,
    manifest: {
      engine: COMPOSITION_ENGINE_VERSION,
      family,
      rarity,
      identity_key: o.identity.identityKey,
      identity_source: o.identity.source,
      motif: o.identity.motif,
      hero: built.hero,
      edition: editionLine(o, t),
      fonts: [FONT],
      layers,
    },
  };
}
