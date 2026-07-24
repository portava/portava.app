# Portava — UI handoff to your Replit agent

Everything remaining is in-app UI. Two files here:

1. **portava-fsq-mobile-service.patch** — apply this to your repo first
   (adds src/services/fsqPlaces.ts, the fail-soft client the agent's FSQ task
   calls). From the workspace root:
       git apply -p1 portava-fsq-mobile-service.patch
   (fallback: copy files/artifacts/travel-buddy/src/services/fsqPlaces.ts in.)

2. **replit-command-portava-remaining-ui.md** — hand this whole doc to your
   Replit agent. It covers ALL four remaining UI features in one pass:
     • Premium stamp rendering (thumbnails + expo-image + unified rarity)
     • Country-essentials "Good to know" card
     • Budget-FX converted display
     • FSQ places surface
   The doc pins the backend/service contracts, the fail-soft rules, the
   safety/legal text that must always render (disclaimers, FSQ attribution),
   and forbids touching the backend.

All the backends + services are already merged and tested. When the agent
finishes, export the workspace (source-only) and send it — I'll audit the UI
against these contracts, same as the showcase/admire review.
