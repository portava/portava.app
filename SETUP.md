# Travel Buddy — shell setup

Built on Expo SDK 54 (Expo Router, file-based). Frontend shell with mock Cebu data.

## Install (run in your Replit travel-buddy-v2 folder)

These deps go beyond the default template. From the project root:

    npx expo install expo-router expo-linear-gradient expo-linking expo-constants \
      react-native-safe-area-context react-native-screens react-native-gesture-handler \
      react-native-svg lucide-react-native

`expo install` picks SDK-54-correct versions automatically (don't pin by hand).

## Important: main entry changed

package.json "main" is now "expo-router/entry" (not index.ts).
If an old index.ts exists from the template, it's no longer the entry — Expo Router
owns routing via the app/ folder. Safe to leave or delete index.ts.

## Run

    npx expo start --tunnel --clear

Open the exp://...exp.direct URL in Expo Go (SDK 54).

## What's here

app/
  _layout.tsx              root stack
  index.tsx                redirect -> tabs
  (tabs)/                  Pulse, Discovery, +stamp, Trips, Passport, AI (off-tab)
  (auth)/onboarding.tsx    interests + travel style
  create.tsx               new post modal
  post/[id], destination/[slug], profile/[handle], trip/[id], trip/new
  messages/, notifications, saved, settings
src/
  theme/tokens.ts          color, type, spacing, the stamp device
  types/models.ts          typed contracts (User, Post, Trip, AiRecommendation, ...)
  data/cebu.ts             mock Cebu seed (all 4 card kinds)
  components/              PostCard (hero/standard/question/itinerary), ui, ActionBar, ScreenHeader

## Card system (per your spec)
- hero      = full-bleed image + scrim overlay; auto-falls back to standard if image too bright
- standard  = image-first, caption below
- question  = no image, Ask AI / Answer
- itinerary = cover + day count + Add to Trip
