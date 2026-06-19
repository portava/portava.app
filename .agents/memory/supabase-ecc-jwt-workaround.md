---
name: Supabase ECC JWT workaround
description: When Supabase rotates JWT signing from HS256 to ECC P-256, PostgREST can't verify tokens → auth.uid() returns NULL → RLS violations. Route writes through the Express API server instead.
---

## The rule
When `auth.uid()` returns NULL in PostgREST (causing 42501 RLS violations) despite a valid user session, and the Supabase JWT Keys page shows ECC (P-256) as the current key, PostgREST hasn't picked up the new key. Fix from the code side by routing writes through the API server.

**Why:** Supabase Auth can verify ECC-signed tokens; PostgREST may not (depends on project version). `supabase.auth.getUser(token)` on the server side calls Auth directly and always works.

**How to apply:**
1. API server creates a Supabase client with the `service_role` key (bypasses RLS entirely).
2. For each write endpoint: extract `Authorization: Bearer <token>` from the request, call `serviceClient.auth.getUser(token)` to verify identity and get `user.id`, then insert with the service role client setting `owner_id = user.id`.
3. Client app calls the API server URL (`EXPO_PUBLIC_API_BASE_URL`) instead of Supabase PostgREST directly.
4. Store `SUPABASE_SERVICE_ROLE_KEY` in `artifacts/api-server/.env`; load with `node --env-file-if-exists=.env`.

**Long-term fix (Supabase side):** Click "Finish update" in Supabase dashboard if visible, or restart project services so PostgREST reloads the ECC public key. Once fixed, direct Supabase client calls from the app will work again.
