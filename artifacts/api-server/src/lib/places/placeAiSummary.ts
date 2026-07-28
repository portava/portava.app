/**
 * placeAiSummary — AI-generated community summaries for the Living Destination Page.
 *
 * generateAiSummary(placeId, topPosts, officialInfo):
 *   • Returns null when < 3 posts exist (not enough signal).
 *   • Reads from place_ai_summaries (24 h cache) when fresh.
 *   • Otherwise calls the OpenAI API with a grounded prompt (top-10 post
 *     captions + FSQ data only — no fabrication).
 *   • Stores the result in place_ai_summaries with the post IDs used.
 *   • Any error returns null; caller must treat the result as optional.
 *
 * The prompt is explicitly grounded so the model only summarises the provided
 * community observations. The disclaimer is mandatory on every non-null result.
 */

import { getOpenAI } from "../openai.js";
import { getServiceClient } from "../supabase.js";
import type { SupabaseClient } from "@supabase/supabase-js";

export const AI_SUMMARY_MIN_POSTS = 3;
const AI_SUMMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours
const MAX_CAPTION_CHARS = 200;
const TOP_POST_LIMIT = 10;

export interface AiSummaryPost {
  id: string;
  caption: string | null;
}

export interface AiSummary {
  text: string;
  groundedOn: "community+official";
  generatedAt: string;
  disclaimer: string;
}

/** Truncate a caption to MAX_CAPTION_CHARS. */
function truncate(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > MAX_CAPTION_CHARS ? s.slice(0, MAX_CAPTION_CHARS) + "…" : s;
}

/**
 * Build the grounded prompt for the AI model.
 * Only uses the provided community captions and official info — no external
 * knowledge is invoked.
 */
function buildPrompt(
  placeName: string,
  posts: AiSummaryPost[],
  officialInfo: {
    address?: string | null;
    description?: string | null;
    category?: string | null;
  } | null,
): string {
  const communityLines = posts
    .slice(0, TOP_POST_LIMIT)
    .filter((p) => p.caption)
    .map((p, i) => `${i + 1}. "${truncate(p.caption)}"`)
    .join("\n");

  const officialLines = [
    officialInfo?.category   ? `Category: ${officialInfo.category}` : null,
    officialInfo?.address    ? `Address: ${officialInfo.address}` : null,
    officialInfo?.description ? `Official description: ${officialInfo.description}` : null,
  ].filter(Boolean).join("\n");

  return [
    `You are summarizing what travelers say about "${placeName}".`,
    `Only use the community observations and official information below — do not add any knowledge beyond what is provided.`,
    "",
    officialLines ? `Official information:\n${officialLines}\n` : null,
    `Community observations (${posts.length} posts):\n${communityLines}`,
    "",
    `Write a concise 2–3 sentence summary of what visitors say about this place. ` +
      `Focus on common themes, highlights, and practical insights. ` +
      `Do not include specific traveler names, usernames, or personal details.`,
  ].filter((l) => l !== null).join("\n");
}

/**
 * Generate (or return cached) an AI summary for a place.
 *
 * @param placeId     Canonical place UUID.
 * @param placeName   Display name for the place (used in the prompt).
 * @param posts       Top posts for this place (at least MIN_POSTS required).
 * @param officialInfo Optional FSQ/official data injected into the prompt.
 * @param sc          Optional Supabase client (defaults to service client).
 * @returns           AiSummary or null.
 */
export async function generateAiSummary(
  placeId: string,
  placeName: string,
  posts: AiSummaryPost[],
  officialInfo: {
    address?: string | null;
    description?: string | null;
    category?: string | null;
  } | null,
  sc?: SupabaseClient,
): Promise<AiSummary | null> {
  if (posts.length < AI_SUMMARY_MIN_POSTS) return null;

  const nowMs = Date.now();
  const client = sc ?? getServiceClient();

  // Check cache
  if (client) {
    const { data: cached } = await client
      .from("place_ai_summaries")
      .select("text, generated_at")
      .eq("place_id", placeId)
      .maybeSingle();

    if (cached) {
      const ageMs = Date.now() - new Date((cached as any).generated_at).getTime();
      if (ageMs < AI_SUMMARY_CACHE_TTL_MS) {
        return {
          text:         (cached as any).text as string,
          groundedOn:   "community+official",
          generatedAt:  (cached as any).generated_at as string,
          disclaimer:   "AI-generated summary based on community posts and official information. May not reflect current conditions.",
        };
      }
    }
  }

  // Generate fresh summary
  try {
    const topPosts = posts.slice(0, TOP_POST_LIMIT);
    const prompt = buildPrompt(placeName, topPosts, officialInfo);

    const response = await getOpenAI().chat.completions.create({
      model:       "gpt-4o-mini",
      messages:    [{ role: "user", content: prompt }],
      max_tokens:  200,
      temperature: 0.3,
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return null;

    const generatedAt = new Date(nowMs).toISOString();
    const postIdsUsed = topPosts.map((p) => p.id);

    // Cache the result (best-effort)
    if (client) {
      await client
        .from("place_ai_summaries")
        .upsert(
          {
            place_id:      placeId,
            text,
            generated_at:  generatedAt,
            post_ids_used: postIdsUsed,
          },
          { onConflict: "place_id" },
        )
        .then(({ error }) => {
          if (error) console.warn("placeAiSummary: cache upsert failed:", error.message);
        });
    }

    return {
      text,
      groundedOn:  "community+official",
      generatedAt,
      disclaimer:  "AI-generated summary based on community posts and official information. May not reflect current conditions.",
    };
  } catch (err) {
    console.warn("placeAiSummary: AI generation failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
