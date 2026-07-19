# Calling parity status (standalone vs artifacts/travel-buddy)

Last verified: 2026-07-19 (Task: bring standalone up to date with 1:1 and crew calling).

The standalone tree is at full client-side calling parity with the main app:

- **Phase 1–2 (1:1 voice/video):** `CallContext.tsx`, `services/calls.ts`, and all
  `components/calls/` surfaces (CallSurface, Incoming/Outgoing screens, controls,
  pill, history message, realtime binding) — identical to the main tree.
- **Phase 3 (RAB call entry gating):** `components/calls/callEntryGating.ts`
  (+ tests) — identical. As in the main tree, the gating helpers are exercised by
  tests; screens consume them when the thread call buttons are wired in.
- **Phase 4 (Trip Crew group voice):** `GroupCallScreen.tsx`,
  `tripCrew/CrewCallCard.tsx` (rendered from `CrewMapSection`), CallContext group
  actions (`startCrewCall`, roster poll, active speakers), calls service group
  endpoints (`startGroupCall`, `getCall`, `getCrewCall`, `leaveCall`), and the
  telegraph `call.group_started` / `call.group_ended` event types — identical.

How to re-verify after future changes to the main tree:

```sh
diff -rq artifacts/travel-buddy/src/components/calls travel-buddy-standalone/src/components/calls
diff -q artifacts/travel-buddy/src/context/CallContext.tsx travel-buddy-standalone/src/context/CallContext.tsx
diff -q artifacts/travel-buddy/src/services/calls.ts travel-buddy-standalone/src/services/calls.ts
diff -q artifacts/travel-buddy/src/components/tripCrew/CrewCallCard.tsx travel-buddy-standalone/src/components/tripCrew/CrewCallCard.tsx
```

The trees are a divergent fork elsewhere — diff before copying any file; port
edits into divergent screens by hand (see repo memory notes on standalone parity).
