# post-media public-read revocation — evidence

Migration `2089_revoke_post_media_public_read.sql`, applied to production
`ajrurzioarfkagpuxfnb` on **2026-08-14**.

Captured by `pnpm run audit:post-media-public-read` in `artifacts/api-server`,
read-only against production through `ciProdReadOnlyAuditGuard`. Reproduce with:

```
PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production' \
KNOWN_PROD_PROJECT_REF='ajrurzioarfkagpuxfnb' \
pnpm run audit:post-media-public-read
```

**Result: ✅ applied and verified. Exit 3 (AFTER state), all three controls green.
Live media sweep clean.**

---

## What was revoked

```sql
CREATE POLICY "post_media_storage_public_read" ON storage.objects
  AS PERMISSIVE FOR SELECT TO public
  USING ((bucket_id = 'post-media'::text));
```

Declared by `0103_post_media.sql`, whose comment calls these policies
"defence-in-depth for clients that attempt direct bucket access". That was
accurate while the bucket was public. On 2026-08-06
`20260806_media_private_buckets.sql` + `set-media-buckets-private.ts` set
`public=false` and moved rendering onto the signed-URL relay. **The cutover
closed `/object/public/`. It did not drop this policy.**

Same shape as the memories/stories grant closed by Step 01
(`20260815_close_memories_stories_grant.sql`): the caller was fixed, the door was
left open. A read boundary enforced by "we stopped emitting that URL" is bypassed
by a GRANT, not by a bug.

## The transition, measured on production

Both GETs were **origin-served, not cached** — `MISS` before, `BYPASS` after — so
each is the origin's own answer rather than Cloudflare's. That distinction is not
pedantry; see "The cache confound" below.

| probe | BEFORE | AFTER |
|---|---|---|
| `post-media` anon GET | **HTTP 200** (`cf-cache-status: MISS`) | **HTTP 400** (`cf-cache-status: BYPASS`) |
| `post-media` anon LIST | **9 entries**, real user-UUID prefixes | **0 entries** |
| `profile-media` anon GET — *negative control* | 400 | 400 |
| `stamp-artwork` public GET — *positive control* | 200 | 200 |
| `profile-media` signed URL — *signing control* | 200 | **200** |

Every probe used only `EXPO_PUBLIC_SUPABASE_ANON_KEY` — the publishable key that
ships inside the mobile client and is not a secret.

**The signing control returning 200 after the drop is the load-bearing result:**
the relay is unaffected. Signing is service-role (bypasses RLS) and the signed
fetch validates a token rather than consulting RLS.

`post-media` now behaves exactly like `profile-media`, which has run with **zero**
`storage.objects` policies in production all along while its entire avatar and
cover surface rendered normally. That bucket was the natural experiment, and it
is why "no outage" was an observation rather than a prediction.

## Live media sweep — independent verification

Run by the second agent immediately after the apply, as the outage check.
Verdict, verbatim:

> No surface is broken by the storage policy change; everything with real media
> renders through the signed path; the one Image-unavailable case is the
> pre-existing empty-media data already tracked separately, not a regression from
> the revocation.

The sweep **self-caught a false alarm before reporting**: a mis-built test session
token that the app correctly rejected at an account-verification gate. That was
verified server-side and the sweep re-run clean. The clean table is therefore a
measurement, not an absence of looking — which is the only reason it is worth
recording here.

## The cache confound — read this before re-testing

Supabase serves storage objects through Cloudflare with
`cache-control: public, max-age=3600`.

**Revoking the policy closes the ORIGIN immediately. It does not evict the edge.**
Any `post-media` object fetched in the preceding hour stays retrievable from
Cloudflare for the remainder of its `max-age`. The revocation is not instantaneous
for already-fetched objects; it decays over up to an hour.

A 200 on a recently-viewed object after the apply is **the CDN, not a failed
revocation**. `cf-cache-status: HIT` distinguishes the two. A `?cb=<random>` query
does NOT bust it — the cache key ignores the query string on this route, verified
rather than assumed.

This cost three CI rehearsal runs. The probe twice reported "the policy is GONE
but an anonymous caller can still read — there is another grant". There was no
other grant: the before-proof had warmed the cache on the exact object the
after-proof then read. The tell was visible both times and read past — anonymous
LIST fell to 0 while GET stayed 200, and LIST is a POST that is not edge-cached,
so LIST was reporting the origin while GET reported Cloudflare.

Two fixes, both about refusing to conclude from a cached response:

* `anonRead` returns `cf-cache-status`; a cached 200 is excluded from the exposure
  verdict and gets its own explicit "says nothing either way" outcome, because
  reporting a phantom grant is its own kind of wrong answer.
* the CI rehearsal's apply phase uploads a **post-apply canary** under a UUID name,
  and the probe samples the newest object. A URL that has never existed cannot be
  in any cache.

## Controls, and why they are not decoration

| control | requirement | purpose |
|---|---|---|
| positive — `stamp-artwork` | must read 200 | if it ever denies, the probe cannot tell "denied" from "broken" and **every other result in the run is worthless** |
| negative — `profile-media` | must deny | the target state, observable before the change |
| signing — `profile-media` signed URL | must fetch 200 | the safety argument for the whole change |

The controls earned their place. The first CI rehearsal failed because the CI
project has no storage objects, and the script refused to report a pass on
`no objects in post-media — the exposure probe has nothing to read, so neither a
pass nor a fail here would mean anything`. A probe that treated "nothing to read"
as "nothing bad found" would have gone green while measuring nothing, and the
production apply would have been the first real test.

## Interactions found along the way

* **`audit:schema` goes red on any deliberate drop.** `auditMigrationsVsLive.ts`
  asks "does every object a migration claims exist live" — right for a create-only
  history, wrong the moment a later migration deliberately drops an earlier
  declaration. `0103` declares this policy; `2089` revokes it. Not a CI artifact:
  it would have gone red against production too. Allowlisted as
  `policy:objects.post_media_storage_public_read` with the reason written down, per
  that file's own convention that an entry means the object does not exist.
* **CI's bucket config differed from production's.** CI's `post-media` was
  `public=true` while production's is `false`, and a public bucket is served
  without consulting RLS. The rehearsal seed now asserts and corrects the flag,
  because a rehearsal whose config differs from production is not rehearsing
  production — and the error direction was the dangerous one: had the flag
  differed the other way, the run would have gone green while proving nothing.

## Rollback

Captured verbatim from `pg_policies` before the apply. One paste, no
reconstruction:

```sql
CREATE POLICY "post_media_storage_public_read" ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((bucket_id = 'post-media'::text));
```

Restoring it restores unauthenticated read **and enumeration** of every object in
`post-media`. It is the correct emergency action if media rendering breaks — and
it should be followed by finding out *why* rendering depended on it, because per
the evidence above nothing in the current render path does.

## Render paths this was checked against

| path | mechanism | authorizes |
|---|---|---|
| `GET /api/media/file/:bucket/*path` | server proxy → 302 signed URL | `requireUser` + `mediaAccess.ts` |
| `POST /api/media/sign` | batch signed hydration | `requireUser` + `mediaAccess.ts` |
| `services/mediaUrl.ts` | `hydrateMediaUrls` / `useHydratedMedia` | server-side |
| `components/CachedImage.tsx:114` | hydrates internally — covers every surface built on it transitively | — |

The client constructs **no** raw public URLs; every `object/public` hit there is a
parser. The server has exactly one constructor — `lib/mediaFeedItem.ts:664`, for
public posts — and that URL has been inert since 2026-08-06; the client exchanges
it for a signed URL rather than binding it. Carrier format, not a working URL,
unchanged in either direction by this migration.
