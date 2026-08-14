---
name: Map store Phase 1 foundations
description: MapStoreProvider, useMapStore, actionCapabilities/detailRoute on MapEntity, stamps card in MapEntityPreviewCard.
---

## MapStoreProvider pattern
- File: `travel-buddy-standalone/src/stores/mapStore.tsx` (was `artifacts/travel-buddy/...`, archived at `bc1bef404`) (note: .tsx not .ts — JSX in provider)
- Pattern: Context + useReducer matching AttachmentStore/AvailabilityStore
- **No root provider needed** — `FullScreenMapScreen` wraps inner impl with `MapStoreProvider` via a two-component split (outer = wrapper, inner = `FullScreenMapScreenInner`)
- `initialEnabledLayers` prop seeds the correct mode preset at store init time

## actionCapabilities + detailRoute
- Stamped by `useMapEntities.ts` via `LAYER_CAPABILITIES` constant table
- buddies → book/message/report, detailRoute = `/(rent-a-buddy)/buddy/${id}`
- events → join/share/report, detailRoute = `/event/${id}`
- gems → save/share/directions, detailRoute = `/gems/${id}`
- trips → share, detailRoute = `/trip/${id}`
- friends → message/follow/report/block, detailRoute = undefined (thread resolution needed)
- stamps → no capabilities listed (Phase 2A may add), no detailRoute

## Stamps preview card
- `StampCountryCardBody` added to `MapEntityPreviewCard.tsx`; wired into `case 'stamps':`
- Renders: country name, city subtitle (top-3 joined by ` · `), stamp count chip, city count chip

## Test patterns learned
- Use `forwardRef` + `useImperativeHandle` to capture store ref and call setters via `await act(async () => { ref.current!.store.setX(...) })` — avoids RNTL React 19 press budget limit
- Wrap `render(...)` calls in `await act(async () => { render(...) })` for React 19 effect flush
- `getByText(/city/i)` matches substrings in city names (e.g. "Singapore City") — use `/^1\s+city$/i` or exact text for chip assertions

**Why:** Per RNTL React 19 renderer budget, `fireEvent.press` on `<Text onPress>` elements doesn't commit state updates; the prop-capture escape hatch (store via ref) is reliable.
