# Compass live place and event search — owner setup

*Lead ruling CPH-08-ADAPT, 2026-10-07. The code is in `artifacts/api-server/src/compass/CompassLiveSearch.ts`
and migration `3704_compass_live_search_quota.sql`. Census: census-compass CPH-08, §52.*

## What it does

When Compass searches places (`search_places`) or events (`search_events`), it always searches the Portava
catalog first. With this feature on, it can also ask a live provider:

- **Places:** Foursquare Places.
- **Events:** Ticketmaster Discovery.

The provider results are shown alongside the catalog results.

- **Daily limit:** each person gets **5 live searches per day** (UTC), shared between places and events.
  After that, Compass uses the catalog only for the rest of the day.
- **"Verified live" labels:** a provider result is labelled *Verified live* **only** if it matches a
  Portava place: the same name after normalisation, **and** no more than 150 m from that place
  (lead ruling D-67). Every other provider result is shown as a provider listing labelled *not verified
  live*. Ticketmaster events are never labelled live.
- **Fallback:** if the flag is off, a key is missing, the daily limit is reached, the quota cannot be
  read, or the provider fails, Compass silently uses the catalog only. The traveller never sees an
  error.
- **Attribution:** every Foursquare listing carries "Powered by Foursquare", as the Foursquare licence
  requires.

## Nothing is spent until you do both of these

1. You supply the keys.
2. You turn the flag on.

**Turning the flag on is your spend decision.** Until then, no request is sent to either provider from
Compass. That holds even if a key is already configured for other features. For example,
`FOURSQUARE_API_KEY` may already serve venue autocomplete and open-now checks; those features are
separate from this one.

## Setup

1. **Apply migration 3704** to the target database: the beta project first, production later. It creates:
   - `compass_live_search_usage`, the per-person daily count. RLS is on, it has no policies, and anon and
     authenticated have no access.
   - `compass_live_search_take()`, the function that takes one unit of the daily limit atomically. It is
     SECURITY INVOKER, and only service_role can execute it.
   - The flag `compass_live_search_enabled`, **seeded FALSE**.

   The migration checks its own postconditions. To roll it back, use
   `db/rollback/2026-10-07-3704-compass-live-search-quota-rollback.sql`, which refuses to run while the
   flag is on.
2. **Set the provider keys** on the API server environment:
   - **Places:** `FSQ_API_KEY_PROD` in production or `FSQ_API_KEY_DEV` in development. If neither is
     set, `FOURSQUARE_API_KEY` is used. The selection logic is in `lib/foursquareApiKey.ts`.
   - **Events:** `TICKETMASTER_API_KEY`.
   - You can set just one of these. A provider with no key is simply skipped.
3. **Check your provider budgets.** At most 5 calls per active person per day reach a provider; each
   search makes one call. Foursquare and Ticketmaster each enforce their own account quotas, and the
   code also stops when a provider answers "quota exhausted".
4. **Turn it on** by setting `compass_live_search_enabled` to TRUE through the admin feature-flag screen
   or with SQL. This is the spend decision.
5. **To turn it off,** set the flag to FALSE. It takes effect on the next search; nothing needs
   redeploying.

## What is recorded

- Per person, per UTC day, only the number of live searches: `compass_live_search_usage.calls`.
- No query text or results are stored.
- The rows are removed when the account is deleted (`ON DELETE CASCADE`, listed in
  `lib/deletionDispositions.ts`).
