/**
 * LayoverCompassService
 *
 * Extends the Compass AI pipeline for layover-context prompts.
 * Returns buffer-aware, privacy-safe answers. Never exposes exact GPS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { openai } from "../../lib/openai.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { computeBuffer, safetyLabel } from "./LayoverSafetyEngine.js";
import { sanitizeCompassAnswer } from "./LayoverPrivacyGuard.js";

export interface CompassLayoverInput {
  question: string;
  session: LayoverSession;
  airport: AirportProfile;
  /** Max chars for the AI answer */
  maxLength?: number;
}

export interface CompassLayoverAnswer {
  answer: string;
  safetyNote: string | null;
  hardReturnTime: string | null;
  bufferMinutes: number;
  /** Whether the question involves leaving the airport */
  involvesLeaving: boolean;
}

const LEAVING_PATTERNS = [
  /leave\s+the\s+airport/i, /go\s+outside/i, /exit\s+the\s+terminal/i,
  /get\s+out/i, /city\s+(tour|trip|visit)/i, /explore\s+(the\s+city|outside)/i,
  /can\s+i\s+(leave|go|exit)/i,
];

function detectLeavingIntent(question: string): boolean {
  return LEAVING_PATTERNS.some((p) => p.test(question));
}

export async function answerLayoverQuestion(
  _db: SupabaseClient,
  input: CompassLayoverInput,
): Promise<CompassLayoverAnswer> {
  const { question, session, airport, maxLength = 400 } = input;

  const now    = new Date();
  const cutoff = session.boardingTime ?? session.departureTime;
  const availMin = Math.max(0, Math.round((new Date(cutoff).getTime() - now.getTime()) / 60000));

  const breakdown = computeBuffer(airport, session, new Date(session.departureTime));
  const bufferMin = breakdown.totalBuffer;
  const usableMin = Math.max(0, availMin - bufferMin);
  const hardReturnTime = new Date(new Date(cutoff).getTime() - bufferMin * 60000);

  const involvesLeaving = detectLeavingIntent(question);

  // Build context for AI — city-level only, no exact coords
  const contextLines = [
    `Airport: ${airport.name} (${airport.iataCode}), ${airport.city}, ${airport.country}`,
    `Flight type: ${session.flightType}`,
    `Time available: ${availMin} minutes (usable after buffer: ${usableMin} minutes)`,
    `Required return buffer: ${bufferMin} min (base ${breakdown.baseBuffer}${breakdown.immigrationExtra ? ` + immigration ${breakdown.immigrationExtra}` : ""}${breakdown.bagsExtra ? ` + bags ${breakdown.bagsExtra}` : ""} + traffic ${breakdown.trafficExtra})`,
    `Hard return deadline: ${hardReturnTime.toISOString()} (NEVER reveal exact coordinates — city-level only)`,
    `Immigration required: ${session.immigrationRequired ? "Yes" : "No"}`,
    `Checked bags: ${session.checkedBags ? "Yes" : "No"}`,
    `Comfort level: ${session.comfortLevel}`,
    `Wants to leave airport: ${session.wantsToLeave ? "Yes" : "No"}`,
  ];

  const systemPrompt = `You are Compass, the safety-aware layover advisor inside Travel Buddy.
Rules you MUST follow:
- NEVER suggest risky plans if the user has less than ${bufferMin} minutes of usable time.
- NEVER expose exact GPS coordinates, precise addresses, or real-time traffic data.
- Always recommend buffer time (at least ${bufferMin} minutes before departure).
- For leaving-the-airport questions: only recommend it if usable time (${usableMin} min) is enough for round-trip + activity.
- Keep answers concise, practical, and reassuring.
- If the question involves leaving and usable time is under 30 minutes, advise staying in the airport.
- Return ONLY your answer text — no JSON, no markdown headers.`;

  const userPrompt = `Layover context:
${contextLines.join("\n")}

Traveler's question: "${question}"

Answer (max ${maxLength} characters):`;

  let answer: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    });
    answer = (completion.choices[0]?.message?.content ?? "").trim().slice(0, maxLength);
  } catch {
    // Graceful fallback
    if (involvesLeaving && usableMin < 30) {
      answer = `With only ${usableMin} minutes of usable time after your ${bufferMin}-minute return buffer, I'd recommend staying inside the airport for this one. Grab a meal, relax in a lounge, or browse the shops.`;
    } else if (involvesLeaving) {
      answer = `You have about ${usableMin} minutes of usable time. You can leave the airport — but make sure you're back at security by ${hardReturnTime.toLocaleTimeString()} to catch your flight safely.`;
    } else {
      answer = `You have about ${availMin} minutes until boarding. Your required return buffer is ${bufferMin} minutes, giving you ${usableMin} usable minutes.`;
    }
  }

  // Strip any coordinates that might have slipped through
  const safeAnswer = sanitizeCompassAnswer(answer);

  let safetyNote: string | null = null;
  if (involvesLeaving) {
    if (usableMin < 30) {
      safetyNote = safetyLabel("not_recommended");
    } else if (usableMin < 60) {
      safetyNote = safetyLabel("possible_but_risky");
    } else {
      safetyNote = safetyLabel("safe");
    }
  }

  return {
    answer:         safeAnswer,
    safetyNote,
    hardReturnTime: hardReturnTime.toISOString(),
    bufferMinutes:  bufferMin,
    involvesLeaving,
  };
}
