/**
 * mediaTranscoder — the adaptive-playback seam (census-media §37, MD277).
 *
 * §37 "Adaptive playback" means a RENDITION LADDER — the same clip encoded at
 * several sizes and bitrates, described by an HLS master playlist or a DASH
 * MPD — and a player that chooses between the rungs as the network changes.
 * AVPlayer (iOS) and ExoPlayer (Android), which expo-av drives, already choose
 * between the rungs of a master playlist on their own; what this tree lacks is
 * the ladder. This server has no video decoder (lib/mediaProcessing.ts), so the
 * ladder has to come from a transcoder the owner chooses: a hosted service or
 * an ffmpeg worker tier.
 *
 * WHAT THIS FILE IS. The adapter contract; the refusing default; the ingestion
 * call (`submitForTranscode`, wired from lib/media/vendors/mediaVendorStages);
 * and `validateRenditionLadder`, which is what "the vendor says it transcoded
 * it" must pass before anything could be served as adaptive:
 *
 *   • an https manifest URL whose path ends in `.m3u8` (HLS) or `.mpd` (DASH),
 *     matching the protocol the adapter claims;
 *   • at least TWO renditions — one rung is a re-encode, not a ladder;
 *   • every rung a positive height and bitrate, heights distinct.
 *
 * Anything else is `invalid_answer`, and the caller keeps progressive playback.
 *
 * WHAT IT DOES NOT DO: serve a manifest to a viewer. How a private clip's
 * manifest and segments are authorised is the vendor's model — signed playback
 * URLs per viewer, a signed-cookie CDN, or segments proxied through
 * lib/mediaAccess — and the playback API and the player's source switch are
 * built against that model once it is chosen. Until then nothing reaches a
 * player, which is also the fail-closed answer.
 *
 * CANDIDATE VENDORS — named with the capability each must have; not chosen:
 *   a hosted video platform that ingests from a server-side URL, produces an
 *   HLS (or DASH) ladder of at least two rungs, and issues SIGNED playback URLs
 *   or tokens per viewer, so a private video stays private (e.g. Mux with signed
 *   playback IDs, Cloudflare Stream with signed URLs, AWS MediaConvert writing
 *   to a private bucket behind CloudFront signed cookies); or an ffmpeg worker
 *   tier (a container with ffmpeg and a queue) writing the ladder next to the
 *   original, with segments authorised by derivation like posters are.
 * Env (by name only): MEDIA_TRANSCODER selects the adapter; its credentials
 * (e.g. MUX_TOKEN_ID / MUX_TOKEN_SECRET / MUX_SIGNING_KEY_ID /
 * MUX_SIGNING_PRIVATE_KEY, or CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_STREAM_TOKEN,
 * or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION /
 * MEDIACONVERT_ROLE_ARN) are the adapter's business.
 */
import {
  callVendor,
  refused,
  selectVendor,
  type VendorAnswer,
  type VendorSelection,
} from "./vendorCommon.js";

export interface TranscodeSubject {
  assetId: string;
  bucket: string;
  path: string;
  durationMs: number | null;
}

export interface Rendition {
  height: number;
  bitrateKbps: number;
}

export interface RenditionLadder {
  protocol: "hls" | "dash";
  manifestUrl: string;
  renditions: Rendition[];
}

export interface MediaTranscoder {
  readonly name: string;
  readonly capabilities: { hls: boolean; dash: boolean; signedPlayback: boolean };
  /** Start a job for this asset. Idempotent per `assetId` on the vendor side. */
  submit(input: TranscodeSubject): Promise<VendorAnswer<{ jobId: string }>>;
  /** The finished ladder for this asset, or `unsupported` while the job is still running. */
  ladder(input: { assetId: string }): Promise<VendorAnswer<RenditionLadder>>;
}

export const REFUSING_TRANSCODER: MediaTranscoder = Object.freeze({
  name: "none",
  capabilities: Object.freeze({ hls: false, dash: false, signedPlayback: false }),
  async submit() { return refused<{ jobId: string }>("not_configured", "no transcoder is configured"); },
  async ladder() { return refused<RenditionLadder>("not_configured", "no transcoder is configured"); },
});

/** Adapters written so far. EMPTY: no vendor has been chosen. */
export const IMPLEMENTED_TRANSCODERS: Readonly<Record<string, () => MediaTranscoder>> = Object.freeze({});

let _override: MediaTranscoder | null = null;

export function _setMediaTranscoderForTest(t: MediaTranscoder | null): void {
  _override = t;
}

export function selectMediaTranscoder(env: NodeJS.ProcessEnv = process.env): VendorSelection<MediaTranscoder> {
  if (_override) return { adapter: _override, configured: _override.name, configuredButUnknown: false };
  return selectVendor(env.MEDIA_TRANSCODER, IMPLEMENTED_TRANSCODERS, REFUSING_TRANSCODER);
}

/** A ladder the seam will accept, or null. See the header for the rules. */
export function validateRenditionLadder(raw: unknown): RenditionLadder | null {
  const l = raw as Partial<RenditionLadder> | null;
  if (!l || typeof l !== "object") return null;
  if (l.protocol !== "hls" && l.protocol !== "dash") return null;
  if (typeof l.manifestUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(l.manifestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const suffix = l.protocol === "hls" ? ".m3u8" : ".mpd";
  if (!url.pathname.toLowerCase().endsWith(suffix)) return null;
  if (!Array.isArray(l.renditions) || l.renditions.length < 2) return null;
  const heights = new Set<number>();
  const renditions: Rendition[] = [];
  for (const r of l.renditions) {
    const height = (r as Rendition)?.height;
    const bitrateKbps = (r as Rendition)?.bitrateKbps;
    if (!Number.isInteger(height) || height <= 0 || height > 8640) return null;
    if (typeof bitrateKbps !== "number" || !Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return null;
    if (heights.has(height)) return null;
    heights.add(height);
    renditions.push({ height, bitrateKbps });
  }
  renditions.sort((a, b) => a.height - b.height);
  return { protocol: l.protocol, manifestUrl: url.toString(), renditions };
}

/** Ingestion: hand a stored video to the transcoder. Never throws. */
export async function submitForTranscode(t: MediaTranscoder, subject: TranscodeSubject): Promise<VendorAnswer<{ jobId: string }>> {
  if (!t.capabilities.hls && !t.capabilities.dash) {
    return t.name === REFUSING_TRANSCODER.name
      ? refused("not_configured", "no transcoder is configured")
      : refused("unsupported", `${t.name} produces no adaptive format`);
  }
  const answer = await callVendor(() => t.submit(subject));
  if (!answer.ok) return answer;
  const jobId = (answer.value as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 200) return refused("invalid_answer", "no job id");
  return { ok: true, value: { jobId } };
}

/** The ladder for an asset, validated. A refusal, a running job and a junk ladder all mean: progressive only. */
export async function adaptiveLadderFor(t: MediaTranscoder, assetId: string): Promise<VendorAnswer<RenditionLadder>> {
  if (!t.capabilities.hls && !t.capabilities.dash) {
    return t.name === REFUSING_TRANSCODER.name
      ? refused("not_configured", "no transcoder is configured")
      : refused("unsupported", `${t.name} produces no adaptive format`);
  }
  const answer = await callVendor(() => t.ladder({ assetId }));
  if (!answer.ok) return answer;
  const ladder = validateRenditionLadder(answer.value);
  return ladder ? { ok: true, value: ladder } : refused("invalid_answer", "the ladder failed validation");
}
