/**
 * CompassIntentClassifier
 *
 * Classifies a user message into one of five intent buckets using a
 * temperature-zero LLM call (gpt-5-mini, ~60 tokens).
 *
 * Phase-1 shadow mode: runs alongside the legacy keyword router.
 * Disagreements are logged by the caller; the classifier result does not yet
 * change recommendation-vs-itinerary routing.
 *
 * Exception: 'action' intent at confidence ≥ 0.6 is always acted on immediately
 * (returns a graceful explanation instead of routing to the card pipeline).
 *
 * Intent types:
 *   recommendation — user wants a place or activity suggestion
 *   itinerary      — user wants a multi-day or day-by-day plan
 *   question       — factual question about a place, route, or app feature
 *   action         — user wants Compass to DO something (add, save, book, delete)
 *   smalltalk      — greeting, thanks, chitchat, or off-topic message
 *
 * Returns null on any error (OpenAI unavailable, malformed JSON, etc.).
 * Callers must treat null as "classifier unavailable" and fall back gracefully.
 */

import { getOpenAI } from "../../lib/openai.js";

export type IntentType =
  | "recommendation"
  | "itinerary"
  | "question"
  | "action"
  | "smalltalk";

export interface IntentClassification {
  intent:     IntentType;
  confidence: number;
}

const VALID_INTENTS = new Set<IntentType>([
  "recommendation",
  "itinerary",
  "question",
  "action",
  "smalltalk",
]);

const CLASSIFIER_SYSTEM = `\
You are an intent classifier for a travel AI assistant. Classify the user message into exactly one intent:
  recommendation — they want a place or activity suggestion
  itinerary      — they want a multi-day or day-by-day plan
  question       — a factual question about a place, timing, route, or app feature
  action         — they want the assistant to DO something (add, save, book, delete, create)
  smalltalk      — greeting, thanks, chitchat, or off-topic

Return ONLY valid JSON with this exact shape and nothing else — no prose, no fences:
{"intent":"<one of the five>","confidence":<number 0.0 to 1.0>}`;

export async function classify(
  message: string,
): Promise<IntentClassification | null> {
  try {
    const oai = getOpenAI();
    const completion = await oai.chat.completions.create({
      model:                 "gpt-5-mini",
      temperature:           0,
      max_completion_tokens: 60,
      // Without this, gpt-5-mini can spend the whole token budget on hidden
      // reasoning and return empty content, silently failing classification
      // on every call (caught by the try/catch below, but wastes a full
      // model round trip on every single Compass message).
      reasoning_effort:      "minimal" as const,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        { role: "user",   content: message.slice(0, 400) },
      ],
    });

    const raw        = (completion.choices[0]?.message?.content ?? "").trim();
    const cleanedRaw = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "");
    const parsed     = JSON.parse(cleanedRaw) as { intent: unknown; confidence: unknown };

    const intent     = parsed.intent as IntentType;
    const confidence = Number(parsed.confidence ?? 0);

    if (!VALID_INTENTS.has(intent) || confidence < 0 || confidence > 1) {
      return null;
    }

    return { intent, confidence };
  } catch {
    return null;
  }
}
