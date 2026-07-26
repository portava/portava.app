/**
 * OpenAI image generation provider.
 *
 * Reuses the shared `openai` client (lib/openai.ts) — which reads
 * AI_INTEGRATIONS_OPENAI_API_KEY / AI_INTEGRATIONS_OPENAI_BASE_URL — exactly like
 * the existing stamp image provider. Image model defaults to gpt-image-1 (the same
 * model the stamp system uses), overridable via AI_IMAGE_MODEL.
 */
import { openai } from "../../openai.js";
import type {
  ImageGenerationInput,
  ImageGenerationProvider,
  ImageGenerationResult,
  ProviderHealth,
} from "../types.js";

export const AI_IMAGE_MODEL =
  process.env.AI_IMAGE_MODEL?.trim() ||
  process.env.STAMP_IMAGE_MODEL?.trim() ||
  "gpt-image-1";

const AI_IMAGE_QUALITY = process.env.AI_IMAGE_QUALITY?.trim() || "high";

// Rough per-image cost estimate (USD) for observability/budgeting only. Not billing.
const COST_ESTIMATE = Number(process.env.AI_IMAGE_COST_ESTIMATE ?? "0.04") || 0.04;

/** Landscape size closest to a 16:9 header that gpt-image-1 supports. */
const IMAGE_SIZE = "1536x1024";

/** Errors that indicate a policy/moderation rejection — never retried. */
function isPolicyRejection(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  const code = String(err?.code ?? err?.error?.code ?? "").toLowerCase();
  return (
    code.includes("moderation") ||
    code.includes("content_policy") ||
    msg.includes("safety system") ||
    msg.includes("content policy") ||
    msg.includes("rejected as a result of our safety")
  );
}

export class OpenAIImageProvider implements ImageGenerationProvider {
  readonly name = "openai";

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    try {
      const response = await openai.images.generate({
        model: AI_IMAGE_MODEL,
        prompt: input.finalPrompt,
        n: 1,
        size: IMAGE_SIZE as any,
        quality: AI_IMAGE_QUALITY as any,
      } as any);

      const item = (response as any)?.data?.[0] as
        | { url?: string; b64_json?: string }
        | undefined;
      const dataUrl =
        item?.url ?? (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : null);

      if (!dataUrl) {
        return {
          ok: false,
          provider: this.name,
          model: AI_IMAGE_MODEL,
          failureCode: "invalid_output",
          failureMessage: "Provider returned no image data",
        };
      }
      return {
        ok: true,
        provider: this.name,
        model: AI_IMAGE_MODEL,
        imageDataUrl: dataUrl,
        costEstimate: COST_ESTIMATE,
      };
    } catch (err: any) {
      const policy = isPolicyRejection(err);
      return {
        ok: false,
        provider: this.name,
        model: AI_IMAGE_MODEL,
        failureCode: policy ? "provider_rejected" : "provider_error",
        failureMessage: policy ? "Blocked by provider safety policy" : String(err?.message ?? err),
        nonRetryable: policy,
      };
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim();
    if (!key || key === "not-configured") return { status: "missing" };
    return { status: "present" };
  }
}
