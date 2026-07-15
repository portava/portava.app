# TRAVEL_BUDDY_DESIGN_LAYER_AUDIT.md

Design-system consolidation pass. Goal: add a shared primitive layer + lock tokens,
use primitives for new/incomplete sections, normalize existing screens lightly, and
migrate gradually — NOT a full app-wide refactor.

## 1. Shared primitives created
`src/components/primitives.tsx`
- TravelPageShell        — safe-area top + desktop max-width (720) centering + scroll
- TravelSectionHeader    — title + optional kicker + "View all" action
- TravelCard             — standard rounded surface (token radius/border/shadow)
- TravelChip             — chip/pill with active state
- TravelButton           — primary / secondary / ghost variants
- TravelIconButton       — circular icon button
- TravelFilterButton     — filter + active-count badge
- TravelEmptyState       — dashed container, title/sub/action
- TravelLoadingState     — spinner + label
- TravelErrorState       — alert + retry
- HorizontalScrollStrip  — standard horizontal strip

`src/components/domainCards.tsx`
- CompassCard            — AI suggestion card; honesty-first (explicit `reason`,
                           optional `provisional` -> "Based on starter city notes")
- ImageDiscoveryCard     — image-led place/experience card w/ Save + Add to Plan
- Re-exports (single import site for spec-named primitives):
  AvailabilityStatusCard (= AvailabilityCard), TrustChip, PassportStampCard,
  PassportInkStamp, PassportHeroBackdrop, PostcardTile

Already-existing primitives reused (not duplicated):
- AvailabilityCard (covers all 7 statuses via STATUS_LABEL)
- PassportStampCard / PassportStampStrip, PassportMarks (monogram/ink/backdrop)
- PostcardTile / PostcardWall, IllustratedStamp, InfoBar, PulseHeader/Fits,
  DiscoveryWall, TripPage

## 2. Tokens locked / extended
`src/theme/tokens.ts` — added WITHOUT changing existing values:
- icon   = { sm:14, md:18, lg:22, xl:26 }
- aspect = { wide:16/9, card:4/3, square:1, portrait:3/4 }
- layout = { maxWidth:720, hitSlop, pressedOpacity:0.85 }
Existing color / space / radius / type / shadow unchanged (already consistent).

## 3. Screens — status
FINISHED (prior passes, verified this pass):
- Passport/Profile      — passport hero + authenticity marks + clickable info bar +
                          Plans/Stamps/Postcards tabs + CITY·CATEGORY stamp strip +
                          postcard tiles
- Pulse (Pass 1)        — header, status row, Fits your time, When you're flexible,
                          editorial feed preserved below, wall filter chips
- Discovery (Pass 1)    — header, Compass Pick/For You (provisional labels),
                          category chips, Featured Experiences; lives under "Explore"
- Trip /trip/[id] (P1)  — hero + progress ring, Today/Next Up, Timeline, Saved Ideas
- Availability          — status card (all 7 states); full editor deferred (placeholder route)

NORMALIZED LIGHTLY (token/style only, no behavior change):
- (none required — screens already token-driven; primitives ready for migration)

INTENTIONALLY NOT MIGRATED (stable, working — avoid refactor risk):
- ai.tsx (Compass) — already uses ScreenHeader, well-structured
- circle.tsx, stamps.tsx, saved.tsx, settings, messages, notifications,
  destination/[slug], profile/[handle], post/[id], create — stable; migrate later

INCOMPLETE / DEFERRED (documented, not faked):
- Pulse Pass 2          — full card-type wall (Traveler Post/Question/Open Plan/
                          Hidden Gem/Compass/Circle Activity/City Note/Safety),
                          filter sheet, floating create menu
- Discovery Pass 2      — Hidden Gems, Neighborhoods by Vibe, Traveler Picks,
                          Saved Ideas, floating Ask Compass
- Trip Pass 2           — Plans, Trip Circle, Map Preview (approx only),
                          Compass Brief, Trip Stamps, Safety/Check-In, Trip Posts
- Availability editor    — weekly + trip-window editor (route is a safe placeholder)
- Level-2 stamp art      — illustrated SVG pipeline documented; header uses Level-1

## 4. Navigation / routing — VERIFIED
- Bottom tabs: Explore(discovery) · Pulse(index) · ✛create · Trips · Passport · (AI)
- Passport tabs: Plans / Stamps / Postcards ✓
- Info bar: Stamps→Stamps tab ✓  Circle→/circle ✓  Plans→Plans tab ✓  Cities→/trips ✓
- Trips tab → /trip/[id] ✓ (existing link preserved)
- Discovery under Explore ✓   Pulse under Pulse ✓
- Saved → /saved via mini-button (NOT a Passport tab) ✓
- Compass AI → mini-button + /(tabs)/ai (NOT a Passport tab) ✓
- All referenced routes exist on disk ✓ (circle, stamps, saved, availability, trip/[id], etc.)
- NOTE: AI still appears as a bottom tab AND a mini-button. Spec prefers floating/
  contextual; keeping the tab is harmless but flagged as a future cleanup.

## 5. Data-truth compliance
- City knowledge seed (knowledge.ts) + discovery seed (discovery.ts): every record
  source:'seed' status:'provisional' verified:false. UI labels: "Starter city note",
  "Often associated with", "Popular travel theme", "Saved by N travelers".
- Compass cards take explicit `reason`; `provisional` -> cautious wording. No fake score.
- Recommendation scoring fields exist as optional/null (RecommendationScore): location/
  time/interest/trust/social/final + recommendationReason — present, unused, honest.
- Editorial feed cards are NOT labeled as live activity.
- Trip data (tripDetail.ts) is a clearly-labeled MOCK seam; dates never fabricated
  (missing -> LOCKED/EARNED). Map Preview will be approximate-only (Pass 2).

## 6. Quality checks
Static checks RUN here (this environment, no RN toolchain):
- Escaped-backtick scan across app/ + src/ : CLEAN
- Import/identifier audit across all .tsx  : 0 files with missing imports
- Brace/paren/bracket balance on new files : balanced
- Route existence check                    : all present
- Fixed earlier this session: two missing-import crashes on Passport
  (Sparkles/Lock, then CITY_ART/IllustratedStamp) + made LucideIcon type imports safe.

Checks to RUN ON DEVICE (cannot run here — need your Mac's node_modules/RN):
    npx tsc --noEmit                 # typecheck
    npx eslint . --ext .ts,.tsx      # lint (if configured)
    npx expo start --clear           # build/bundle; press w
    npm test                         # if tests exist
Document results after running; this report marks them PENDING-ON-DEVICE.

## 7. Files changed this pass
- src/theme/tokens.ts                 (added icon/aspect/layout; existing unchanged)
- src/components/primitives.tsx        (NEW — shared primitive library)
- src/components/domainCards.tsx       (NEW — CompassCard/ImageDiscoveryCard + re-exports)
- TRAVEL_BUDDY_DESIGN_LAYER_AUDIT.md   (this report)

## 8. Remaining issues / migration candidates
- Migrate stable screens to primitives over time (circle, stamps, saved, settings,
  messages, notifications, destination, profile, create) — low priority, low risk.
- Build Pass-2 sections for Pulse / Discovery / Trip using the new primitives.
- Build the Availability editor; wire AI to floating assistant or drop the duplicate tab.
- Replace mock seams (tripDetail, discovery, knowledge) with backend + attribution.
- Level-2 illustrated stamp pipeline.

## 9. Plain-English summary
The app already had all four hero surfaces built (Passport, Pulse, Discovery, Trip).
This pass added the missing foundation: one shared set of building blocks (cards,
headers, chips, buttons, filter buttons, empty/loading/error states, page shell,
horizontal strips) plus Compass/Discovery/availability/trust/stamp/postcard cards,
and locked the sizing tokens (icon sizes, image ratios, desktop max-width, press
states). Per the agreed low-risk approach, stable screens were left working and will
adopt the primitives gradually; nothing was rebuilt or broken. Navigation and all
clickable info-bar items were verified. Data-truth rules hold: seeded city data stays
provisional, Compass never fakes ranking, editorial cards aren't passed off as live,
and trip data is a labeled mock. On-device lint/typecheck/build still need to run on
your Mac — commands are listed above.
