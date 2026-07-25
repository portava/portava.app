# REPLIT AGENT COMMAND — Client media hydration (SEC-02 gate)

The server is about to make the `post-media` and `profile-media` storage buckets
**private** (audit SEC-02) so private post/story/DM media stops being world-readable
by raw URL. Before that flip, the client must stop rendering raw public storage
URLs and instead render **signed URLs** obtained from the server. This is the
prerequisite that gates the whole cutover — until it ships, buckets stay public.
`artifacts/travel-buddy` only; no api-server / migrations / SQL.

## The two server endpoints (already live)
- `POST /api/media/sign` — batch. Body `{ urls: string[] }` (1–50 app media URLs).
  Returns `{ signed: { [originalUrl]: string | null }, ttlSeconds: 3600 }`.
  `null` = not authorized / not an app URL → render the fallback, not the raw URL.
- `GET /api/media/file/:bucket/*path` — single. 302-redirects to the authorized
  URL. Send the user's auth token. Handy for `<Image>` where you have bucket+path.

Both **authorize the viewer** (block + visibility rules) in every mode, and both
return **public** URLs today (flag OFF) and **signed** URLs after the flip — so
migrating now is safe and has zero visible change until the flip.

## Tasks
1. **Central resolver** `src/services/mediaUrl.ts` → `hydrateMediaUrls(urls: string[]): Promise<Record<string,string|null>>`
   that calls `POST /api/media/sign` (chunk to ≤50), with a short in-memory cache
   keyed by URL and an expiry timestamp (`ttlSeconds`). Expose
   `useHydratedMedia(urls)` hook returning resolved URLs + loading state.
2. **Route ALL `post-media` / `profile-media` rendering through it** — every place
   that currently binds a raw `…/storage/v1/object/public/(post-media|profile-media)/…`
   URL to an `<Image source>`: feed posts + thumbnails, post detail, comments media,
   profile avatar + cover, passport header, stories, message attachments, event
   covers that use these buckets. Use the existing `DisplayMediaImage` resolver if
   there is one — add the hydration there so every surface inherits it.
3. **Expiry / failure handling:** signed URLs live 3600s. On image `onError` or a
   403, re-hydrate that URL once and retry; if it comes back `null`, show the
   designed fallback (never the raw URL).
4. **Do NOT hydrate** buckets that stay public (`stamp-artwork`, category artwork,
   provider images) — only `post-media` and `profile-media` go private. Passing a
   non-app URL to `/media/sign` returns `null`; guard against that.
5. Tests: resolver chunks >50, caches, re-hydrates on expiry; a component renders
   the signed URL and falls back on `null`.

## Acceptance
With the flag OFF (today): no visible change — hydration returns public URLs.
After the server flips the flag ON and buckets private: all feed/profile/message
media still loads (via signed URLs), and nothing in the app renders a raw
`/object/public/(post-media|profile-media)/…` URL. Confirm by grepping the client
for direct `object/public/post-media` / `object/public/profile-media` bindings —
there should be none left on an `<Image>`.

## Out of scope
The bucket flip itself, the feature flag, api-server changes, non-media buckets.
