/**
 * Image generation provider abstraction.
 *
 * StampImageProvider is a thin interface so the generation worker can be
 * tested against a PlaceholderProvider without hitting real AI APIs.
 *
 * Factory: getStampImageProvider() returns DalleProvider when the OpenAI
 * integration env vars are set; PlaceholderProvider otherwise.
 */

import { openai } from "../openai.js";
import { CANDIDATE_COUNT } from "./artDirection.js";

export interface GeneratedImage {
  url: string;
  metadata: Record<string, unknown>;
}

export interface StampImageProvider {
  generate(prompt: string, n?: number): Promise<GeneratedImage[]>;
}

// ── Provider error classification ─────────────────────────────────────────────
// Error-message prefix used when the provider outright rejects the request in a
// way that can never succeed on retry (content-policy refusal or any other
// invalid-request 4xx). The generation worker treats errors starting with this
// prefix as permanent (no retries). 429 (rate limit) and 5xx stay retryable.
export const PROVIDER_REJECTED_PREFIX = "provider_rejected";

/**
 * True when an image-provider error is a non-retryable rejection:
 * a 4xx response other than 429, or an explicit content-policy violation.
 * Exported for tests.
 */
export function isNonRetryableProviderError(err: any): boolean {
  const status = Number(err?.status ?? err?.response?.status ?? NaN);
  if (Number.isFinite(status)) {
    return status >= 400 && status < 500 && status !== 429;
  }
  const code = String(err?.code ?? err?.error?.code ?? "");
  return code === "content_policy_violation" || code === "invalid_request_error";
}

// ── OpenAI image provider (gpt-image-1 family) ───────────────────────────────
// Model is env-configurable via STAMP_IMAGE_MODEL (default "gpt-image-1" —
// dall-e-3 was deprecated by OpenAI in 2026 and is rejected by the AI proxy).
// gpt-image-1 returns base64 image data (b64_json) rather than temporary URLs,
// and supports transparent backgrounds natively — which the stamp prompt
// requires. We normalize b64 responses into data: URLs so the worker's
// existing fetch()-based download path works unchanged (Node fetch supports
// data: URLs). Some proxies may still return `url`; both shapes are accepted.
// The API supports n>1, but we keep one image per call and fire
// CANDIDATE_COUNT calls in parallel so a single rejection doesn't sink the
// whole batch.

export const STAMP_IMAGE_MODEL =
  process.env.STAMP_IMAGE_MODEL?.trim() || "gpt-image-1";
export const STAMP_IMAGE_QUALITY =
  process.env.STAMP_IMAGE_QUALITY?.trim() || "high";

export class DalleProvider implements StampImageProvider {
  async generate(prompt: string, n = CANDIDATE_COUNT): Promise<GeneratedImage[]> {
    const rejections: string[] = [];
    const calls = Array.from({ length: n }, async (_, i): Promise<GeneratedImage | null> => {
      try {
        const response = await openai.images.generate({
          model:      STAMP_IMAGE_MODEL,
          prompt,
          n:          1,
          size:       "1024x1024",
          quality:    STAMP_IMAGE_QUALITY,
          background: "transparent",
        } as any);

        const item = response.data?.[0] as
          | { url?: string; b64_json?: string; revised_prompt?: string }
          | undefined;
        const url = item?.url
          ?? (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : null);
        if (!url) return null;

        return {
          url,
          metadata: {
            model:          STAMP_IMAGE_MODEL,
            quality:        STAMP_IMAGE_QUALITY,
            size:           "1024x1024",
            background:     "transparent",
            revised_prompt: item?.revised_prompt ?? null,
            candidate_index: i,
          },
        };
      } catch (err: any) {
        const permanent = isNonRetryableProviderError(err);
        if (permanent) rejections.push(err?.message ?? String(err));
        console.error(
          JSON.stringify({
            event:     "stamp.generation.provider_error",
            provider:  STAMP_IMAGE_MODEL,
            candidate: i,
            permanent,
            error:     err?.message ?? String(err),
          })
        );
        return null;
      }
    });

    const results = await Promise.all(calls);
    const images = results.filter((r): r is GeneratedImage => r !== null);

    // If nothing succeeded and at least one call was a non-retryable provider
    // rejection (content policy / invalid request 4xx), surface a prefixed
    // error so the worker classifies the job as permanently failed instead of
    // burning retry rounds on a prompt that can never succeed.
    if (images.length === 0 && rejections.length > 0) {
      throw new Error(`${PROVIDER_REJECTED_PREFIX}: ${rejections[0]}`);
    }

    return images;
  }
}

// ── Placeholder provider ──────────────────────────────────────────────────────
// Returns a data-URL SVG placeholder for use in dev/test when no API key is set.

export class PlaceholderProvider implements StampImageProvider {
  async generate(_prompt: string, n = CANDIDATE_COUNT): Promise<GeneratedImage[]> {
    return Array.from({ length: n }, (_, i) => ({
      url: `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">` +
        `<circle cx="512" cy="512" r="480" fill="#0A3D4A" stroke="#fff" stroke-width="8"/>` +
        `<text x="512" y="540" text-anchor="middle" font-size="80" fill="#fff" font-family="sans-serif">STAMP</text>` +
        `<text x="512" y="640" text-anchor="middle" font-size="48" fill="#88BBCC" font-family="sans-serif">placeholder #${i + 1}</text>` +
        `</svg>`
      )}`,
      metadata: {
        model:          "placeholder",
        candidate_index: i,
      },
    }));
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _cachedProvider: StampImageProvider | null = null;

export function getStampImageProvider(): StampImageProvider {
  if (_cachedProvider) return _cachedProvider;

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

  if (baseUrl && apiKey && apiKey !== "not-configured") {
    _cachedProvider = new DalleProvider();
  } else {
    console.warn("[stamps] No OpenAI API key configured — using PlaceholderProvider for stamp artwork");
    _cachedProvider = new PlaceholderProvider();
  }

  return _cachedProvider;
}

/** Reset the cached provider (for testing). */
export function _resetProviderCache(): void {
  _cachedProvider = null;
}

/**
 * Test-only hook — inject a fake provider so the generation worker can be
 * driven end-to-end without real image APIs. Pass null to restore the factory.
 */
export function _setTestStampImageProvider(provider: StampImageProvider | null): void {
  _cachedProvider = provider;
}
