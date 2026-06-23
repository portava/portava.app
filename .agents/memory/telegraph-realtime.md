---
name: Telegraph realtime (SSE) architecture
description: Durable constraints/decisions for the Telegraph realtime delivery layer — event bus scope, mobile transport choice, polling-fallback contract.
---

# Telegraph realtime delivery

The realtime layer (api-server `telegraphEvents.ts` + `telegraphStream.ts`, mobile
`telegraphRealtimeService.ts`) is an **enhancement on top of polling, not a
replacement**. Every messaging hook keeps its poll loop alive regardless of
realtime state.

## Constraints / decisions

- **In-memory event bus is single-instance only.** `telegraphEvents.ts` holds
  subscribers in process memory. If the API server is ever scaled to >1 instance
  (or moved to a serverless/multi-replica deploy), SSE clients on instance A will
  miss events published on instance B. Moving to multi-instance requires an
  external fan-out (Redis pub/sub, Postgres LISTEN/NOTIFY, etc.).
  **Why:** simplest correct design for the current single API server; do not
  assume cross-instance delivery works.

- **Mobile uses XHR, not EventSource, for SSE.** React Native has no built-in
  EventSource and its `fetch` lacks streaming. The client reads the incrementally
  growing `xhr.responseText` during readyState 3. This lets it send an
  `Authorization` header (EventSource cannot).
  **Why:** avoids adding `react-native-sse` (firewall/tarball risk). Don't swap to
  EventSource on mobile — you'd lose header auth and fall back to `?token=` in URL.

- **SSE auth accepts header OR `?token=` query.** Header is preferred (mobile uses
  it). `?token=` exists only for browser EventSource compatibility and leaks the
  bearer token into proxy/access logs — a known tradeoff. If web EventSource is
  not actually needed, drop the query path.

- **Optimistic send reconciles by `clientId`.** Client generates a `clientId`,
  appends an optimistic message, sends it, and the server echoes `clientId` back.
  Reconciliation must dedupe against the real message possibly already arriving via
  poll/realtime before the HTTP response. `Message.clientId` / `deliveryStatus`
  are optional local-only fields (absent on server-loaded messages).

## Pitfall fixed once already

- Realtime event handlers publish to a field that must be **selected** from the
  DB row first. The decline route originally selected only `id, recipient_id,
  status` but published to `sender_id` → `request.declined` silently never fired.
  **How to apply:** when wiring a new emission, confirm every field referenced in
  the `publishToUsers([...])` call is in the row's `.select(...)`.
