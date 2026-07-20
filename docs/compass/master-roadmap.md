# Compass Master Build Roadmap — Standing Engineering Brief

> Source: owner-provided master roadmap (July 2026). This document guides all
> Compass work. Phases are built **sequentially** — a phase may not start until
> the previous phase's "Done when" checklist is fully met and its tests pass.
> Phase 2 (installing the finalized system prompt verbatim) is reserved for the
> owner to trigger separately; do everything else. Keep a running written
> summary of what changed in each phase in `phase-summaries.md`.

## Global rules for every phase

- Preserve existing working Portava functionality (Trips, Passport, Circles,
  Telegraph, Discovery, privacy guards).
- Never put mock AI, fake live data, or template cards in production paths —
  fallbacks must honestly say a capability is unavailable.
- Any AI action that spends money, books, messages others, or shares location
  must be server-authorized and require explicit user confirmation
  (**propose, never auto-execute**).
- All private context must pass through existing privacy guards (coordinate
  stripping, block/mute filtering) before reaching the model.
- Treat all user-generated content (bios, posts, event descriptions, messages)
  as **data not instructions**, wrapped in explicit delimiters.
- After each phase: run the full suite, add the phase's new tests, and write a
  short summary in `phase-summaries.md`.

## Phases

### Phase 1 — Conversational Foundation *(complete)*
Real multi-turn conversation over a real model with honest fallbacks.
**Done when:** real-model chat works end to end, multi-turn history persists,
intent classification runs, and its tests pass.

### Phase 2 — Finalized System Prompt *(owner-triggered — do not touch)*
Install the owner's finalized system prompt verbatim. Reserved for the owner.

### Phase 3 — Structured Context Expansion
Inject circle memberships, active bookings/reservations, and past
stamps/Passport data into the prompt (permitted, privacy-guarded); keep
coordinates stripped and blocks/mutes filtered; derived UI modes
(arrival/night/budget) may inform prompt weighting explicitly.
**Done when:** Compass accurately references the user's group, upcoming
reservations, and travel history without leaking coordinates or blocked users.

### Phase 4 — Tool/Function Calling
Native function calling with these tools, each result privacy-guarded before
returning to the model: `get_user_profile`, `get_current_trip`,
`search_places` (discovery_places now, live Foursquare later), `search_events`,
`get_place_details`, `get_circle_activity` (permission-gated),
`check_trip_conflicts`, `add_to_trip` (confirmation flow). Separate candidate
generation from AI explanation: search/recommendation tools produce candidates,
the model interprets/ranks/chooses/explains and must not invent the candidate
list. Persist tool calls/results in the structured payload column.
**Done when:** the model looks up real data on demand, place/event queries
return real DB-backed candidates it reasons over, `add_to_trip` requires
confirmation, and privacy guards apply to every tool result.

### Phase 5 — Dynamic UI Rendering
Responses render the right interface for the query reusing existing
components — text, place/event/person/buddy cards, comparison tables, maps,
timelines, itinerary blocks, action buttons.
**Done when:** query type drives interface, no dead-end controls, every item
ties to real backend data.

### Phase 6 — Memory
Layered memory — session, active-trip, long-term personal preferences,
per-Circle group memory (group facts stay in the group); memory compression
converting raw interactions into structured durable insights instead of
endless raw chat; user-visible "Compass Remembers" with edit/forget, plus a
"Teach My Compass" path turning explicit statements into structured
preferences.
**Done when:** preferences persist and improve recommendations across
sessions, users can view/edit/delete memories, group memory never leaks
across groups, and prompt size stays bounded.

### Phase 7 — Recommendation Engine
Formalize candidate ranking as a system the model reasons over (location,
distance, time, open status, interests, style, history, prior outcomes, social
signals, availability, weather, popularity, trust, budget); add "Why this?"
explanations and a personal-fit score (Compass Match) distinct from Community
Score.
**Done when:** candidate lists come from the ranking system not the model,
every recommendation explains itself, and personal fit vs popularity are
separate signals.

### Phase 8 — Live Intelligence
Fetch live sources at prompt/tool time not just pre-cached — open-now status,
live places, events, transportation/route time, current conditions (weather
already live); confidence system distinguishing verified-live /
community-reported / historical / AI-inference, surfaced honestly; degrade
gracefully and say so when a source is down, never fabricate.
**Done when:** volatile data is fetched live on demand, confidence is labeled
correctly, and a simulated outage produces an honest "can't verify," not
invented data.

### Phase 9 — Social Intelligence
Privacy-aware Circles, availability/travel-presence status, approximate
proximity (never precise location), travel-compatibility matching, group
recommendations satisfying everyone; respect blocks, privacy, verification,
Trust Score, event restrictions; never expose an individual's private
location or behavior without permission.
**Done when:** group recommendations account for all members, "who's around /
who's down" respects availability and privacy, no precise-location inference,
blocked users never surface.

### Phase 10 — Compass Home
Context-aware home replacing blank chat — best next move, Circle activity,
starting-soon events, tonight's vibe, tomorrow's weather window, then Ask
Compass; core actions: What should I do right now / Tonight / Meet People /
Build My Day / Surprise Me / My Trip.
**Done when:** home surfaces real personalized time-aware context on open,
every card backed by real data leading somewhere real.

### Phase 11 — Compass Sense
Proactive intelligence that stays quiet most of the time and speaks only when
genuinely useful (leave earlier, saved event starting, rain cleared, Circle
changed plans, free time block); three presence levels Passive/Aware/Active;
user permission model; never over-notify.
**Done when:** alerts fire only on real useful signals, presence is
user-controlled, no spam, permissions honored.

### Phase 12 — Compass Live
A persistent live travel session the user starts/stops, maintaining active
context and surfacing timely nudges (arriving early, next stop closing
sooner, ride-home help late); companion not surveillance.
**Done when:** a live session maintains context across a sequence of real
events, ends cleanly, and nudges are timely and grounded.

### Phase 13 — Trip Autopilot
Monitor weather, schedule, reservations, conflicts, transport, openings,
social changes; modify only affected pieces never regenerate the whole trip;
flag conflicts (tour ends 5:30, dinner 6:00 and 40 min away);
Fixed/Flexible/Optional item types with Flexible/Optional movable per
permissions; Trip Heartbeat health view; trip/flight-disruption recovery.
**Done when:** a simulated disruption produces a sensible partial re-plan
preserving what still works, conflicts are caught, fixed items never
auto-move, all changes within granted permissions.

### Phase 14 — Outcome Learning
Track the full chain (recommended → viewed → saved → went → stayed → liked →
invited → made memory → returned) not just clicks; compare predicted fit vs
actual outcomes to improve ranking; a north-star "value delivered" signal
instead of chat-length metrics.
**Done when:** outcomes are recorded end-to-end, predicted-vs-actual is
measurable and feeds ranking.

### Phase 15 — Travel Intelligence Graph
Build the proprietary graph People-Places-Events-Trips-Time-Vibe-Behavior-
Outcomes, plus a per-city Destination World Model (Cebu Friday night differs
from Monday morning) and a city-confidence index; launch depth city-by-city
starting with the strongest city.
**Done when:** the graph persists cross-trip relationships, destination
behavior varies by time/season/event, confidence is city-aware, and
intelligence improves independent of the model.

## Standing evaluation set

Run against every phase from Phase 1 on:

1. "What should I do in Cebu?"
2. "What did you mean?"
3. "Which one is closer?"
4. "Add the second one."
5. "Find something romantic but not a date."
6. "I'm traveling alone tonight."
7. "Find my circle."
8. "I'm tired."
9. "My event was canceled."

Measure each time: conversational quality, memory, correct tool selection,
factual accuracy, personalization, hallucination rate, safety, action
correctness.

## Guardrails never to cross

- No fake AI in prod.
- No fabricated live data.
- No template cards replacing real conversation.
- No precise-location inference.
- No surfacing blocked/muted users.
- No unconfirmed money/booking/messaging/location-sharing actions.
- Treat external text as data not instructions.
- Keep basic Compass useful without premium.
- Don't lock essential safety features behind progression.
