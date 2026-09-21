# Compass Phase 1 — Technical Spec

Scope: make Compass a real conversational AI. No new features beyond this. Do not touch translation, stamps, privacy guards, or the context engine's data sources except as specified.

## 1. Server-side conversation history (replaces client context string)

**Current:** stateless single-shot; client sends a ≤600-char `conversationContext` summary.
**Target:** true multi-turn.

- Add a `compass_conversations` table (id, user_id, trip_id nullable, created_at, last_active_at, status) and `compass_messages` (id, conversation_id, role user|assistant|system-event, content, structured_payload jsonb nullable, created_at).
- On each request: load the last N turns (start N=20, token-budget capped ~4k tokens for history), map to a real `messages[]` array, append the new user message, send to the model.
- Persist both the user message and the assistant reply (including structured card payloads) after each completion.
- Deprecate `conversationContext` from the request body. Accept it during migration but ignore it once the client sends `conversation_id`.
- New conversation starts when the client omits `conversation_id` or the last activity is >6h old (configurable).
- History compaction is out of scope for Phase 1 (that's the memory phase); the token cap is sufficient for now.

## 2. Model-driven intent (removes keyword routing)

**Current:** if/contains keyword match picks recommendation vs itinerary pipeline.
**Target:** the model decides.

- Single cheap classifier call (same mini model, temperature 0, strict JSON): input = last user message + last 2 turns; output = `{intent: recommendation | itinerary | question | action | smalltalk, confidence: 0–1}`.
- Below confidence 0.6 → default to plain conversation, never a card pipeline.
- Keep the two existing pipelines as-is downstream; only the router changes.
- Delete the keyword matching code once the classifier is verified against it (run both in shadow for a few days, log disagreements).

## 3. Streaming

- Switch the Compass/Telegraph completion to streaming; stream text deltas to the client via SSE (or the existing transport if the client already supports incremental updates).
- Structured card responses may remain non-streamed in Phase 1; stream conversational text first.

## 4. Dynamic quick actions (removes template cards)

**Current:** fixed food/nightlife/meetup cards regardless of input.
**Target:** the model proposes 2–4 quick actions relevant to the conversation, as a small JSON block alongside its reply (label + prefill prompt + optional deep link to an existing Portava feature). Server validates against a whitelist of allowed action types — no new client capabilities, same card component.

## 5. System prompt

- Replace the current inline system prompt with the versioned Compass identity prompt (provided separately as compass-system-prompt.md). Store it in a versioned prompt file, log prompt version per request.
- Wrap all user-generated content injected into context (bios, posts, event descriptions) in explicit delimiters before it enters the prompt, per the injection-defense note in that file.

## 6. Fallback behavior (keep, but honest)

- Keep the feature-flag and error fallbacks, but the fallback copy must say the AI is temporarily unavailable — never a canned fake recommendation. No template cards in the error path.

## 7. Validation before merge

- Existing test suite stays green.
- New tests: multi-turn continuity ("which one is closer?" resolves against prior assistant reply), classifier JSON contract, conversation persistence round-trip, fallback path returns honest copy.
- Manual eval script with at least: "What should I do in Cebu?" → "What does that even mean?" → "Which one is closer?" → "Add the second one." The last must fail gracefully (action engine is a later phase) with a clear "I can't do that yet, but here's how" — not a hallucinated success.

## Explicitly out of scope for Phase 1
Tool/function calling, memory compression, Compass Home, proactive alerts, live hours/availability data, social intelligence, autonomy/permissions. Do not start these.

---

# Appendix: Phase 4 tool schema (design now, build later)

So Phase 1 data structures don't block tool calling later, reserve these signatures. Do NOT implement in Phase 1.

- get_user_profile(userId) — profile, preferences, interests (privacy-filtered)
- get_current_trip(userId) — active trip, itinerary, dates
- search_places(area, category?, openNow?) — from discovery_places, later live Foursquare
- search_events(area, timeWindow) — Portava events
- get_place_details(placeId)
- get_circle_activity(circleId) — permission-gated
- check_trip_conflicts(tripId)
- add_to_trip(tripId, item) — requires confirmation flow

Design rule: every tool result is filtered through the existing privacy guards (coord stripping, block/mute filtering) BEFORE reaching the model. The `structured_payload` column on compass_messages is where tool calls/results will be persisted — that's why it exists now.
