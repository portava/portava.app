/**
 * Rasterization + QC for the stamp composition engine (sharp/libvips).
 *
 * - rasterizeStamp: composed SVG → full PNG (1024w) + thumbnail PNG (256w).
 * - validateHeroBuffer: QC gate on AI hero art BEFORE composition
 *   (dimensions, alpha, decodable, format).
 * - validateComposedPng: sanity gate on the composed output.
 *
 * Font handling: librsvg (inside libvips) resolves fonts through fontconfig.
 * If the host has no Poppins, ensureFontconfig() points FONTCONFIG_PATH at
 * the repo's bundled assets/fonts (Poppins Regular/Medium/Bold + fonts.conf)
 * so stamp typography renders identically everywhere. Called lazily before
 * the first rasterization; a host with Poppins already installed wins.
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const FULL_WIDTH = 1024;
const THUMB_WIDTH = 256;

let fontconfigEnsured = false;

/** Repo-bundled fonts dir (artifacts/api-server/assets/fonts). */
export function bundledFontsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/lib/stamps/composition → ../../../../assets/fonts
  return path.resolve(here, "../../../../assets/fonts");
}

function hostHasPoppins(): boolean {
  try {
    const out = execFileSync("fc-list", [":family"], { timeout: 3000 }).toString();
    return /poppins/i.test(out);
  } catch {
    return false; // no fc-list → assume no usable fontconfig
  }
}

export function ensureFontconfig(): void {
  if (fontconfigEnsured) return;
  fontconfigEnsured = true;
  if (process.env.FONTCONFIG_PATH) return; // operator override wins
  if (hostHasPoppins()) return;
  const dir = bundledFontsDir();
  if (existsSync(path.join(dir, "fonts.conf"))) {
    process.env.FONTCONFIG_PATH = dir;
    console.log(JSON.stringify({ event: "stamp.compose.fontconfig", dir }));
  }
}

export interface RasterizedStamp {
  full: Buffer;       // PNG, FULL_WIDTH wide
  thumbnail: Buffer;  // PNG, THUMB_WIDTH wide
  width: number;
  height: number;
}

/** Render a composed SVG to the dual PNG assets (full + thumbnail). */
export async function rasterizeStamp(svg: string): Promise<RasterizedStamp> {
  ensureFontconfig();
  const input = Buffer.from(svg);
  const full = await sharp(input, { density: 96 })
    .resize({ width: FULL_WIDTH })
    .png()
    .toBuffer();
  const meta = await sharp(full).metadata();
  const thumbnail = await sharp(input, { density: 96 })
    .resize({ width: THUMB_WIDTH })
    .png()
    .toBuffer();
  return { full, thumbnail, width: meta.width ?? FULL_WIDTH, height: meta.height ?? FULL_WIDTH };
}

// ── QC ───────────────────────────────────────────────────────────────────────

export interface QcResult {
  passed: boolean;
  checks: Record<string, boolean>;
  width: number | null;
  height: number | null;
  format: string | null;
  reason: string | null;
}

/**
 * QC gate for AI hero art before composition. Rejects candidates that are
 * undecodable, tiny, or non-square-ish; admins never see garbage candidates.
 */
export async function validateHeroBuffer(buffer: Buffer): Promise<QcResult> {
  const checks: Record<string, boolean> = {};
  let width: number | null = null;
  let height: number | null = null;
  let format: string | null = null;
  try {
    const meta = await sharp(buffer).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    format = meta.format ?? null;
    checks.decodable = true;
    checks.format_supported = ["png", "webp", "jpeg", "jpg"].includes(meta.format ?? "");
    checks.min_size = (meta.width ?? 0) >= 512 && (meta.height ?? 0) >= 512;
    const ratio = (meta.width ?? 1) / Math.max(1, meta.height ?? 1);
    checks.aspect_square = ratio > 0.8 && ratio < 1.25;
  } catch {
    checks.decodable = false;
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    passed: failed.length === 0,
    checks,
    width,
    height,
    format,
    reason: failed.length ? `hero_qc_failed: ${failed.join(",")}` : null,
  };
}

/** Sanity gate on the composed PNG (decodable, expected width, has alpha). */
export async function validateComposedPng(buffer: Buffer): Promise<QcResult> {
  const checks: Record<string, boolean> = {};
  let width: number | null = null;
  let height: number | null = null;
  let format: string | null = null;
  try {
    const meta = await sharp(buffer).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    format = meta.format ?? null;
    checks.decodable = true;
    checks.is_png = meta.format === "png";
    checks.full_width = (meta.width ?? 0) === FULL_WIDTH;
    checks.has_alpha = meta.hasAlpha === true;
  } catch {
    checks.decodable = false;
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    passed: failed.length === 0,
    checks,
    width,
    height,
    format,
    reason: failed.length ? `composed_qc_failed: ${failed.join(",")}` : null,
  };
}
