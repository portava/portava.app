# Media renders blank — end-to-end diagnosis

Date: 2026-08-07 · Branch: `bughunt-20260805` · Status: **diagnosis only, no code changed**

Every media surface renders blank on device: profile picture, highlights,
postcard photos and videos. This document traces capture → upload → storage →
render and names the root cause for each of the four surfaces.

**Summary: one root cause, on the render leg. Upload works. Storage works.
The file is in the bucket. The app asks for it at a URL that cannot resolve.**

Both of the two prior findings that motivated this investigation are wrong.
Details in "Prior findings" at the end.

---

## The one-line version

The two media buckets are **private**. Every upload endpoint returns a *bare
storage reference* (`post-media/<uid>/<file>.jpg`), not a loadable URL. The one
client layer that converts such a reference into something loadable
(`hydrateMediaUrls` → `batchSignUrls` → `POST /api/media/sign`) **sends no
`Authorization` header, so it gets 401 on every call** and silently falls back
to handing the bare reference straight to `<Image>` / `<Video>`. A bare
reference has no scheme and no host, so nothing loads and nothing errors
usefully.

---

## Evidence (all verified against production, read-only)

| Check | Result |
|---|---|
| `post-media` bucket `public` | **false** |
| `profile-media` bucket `public` | **false** |
| Object exists in bucket (service-role GET) | **HTTP 200** — the upload lands |
| Same object via public URL | **HTTP 400** `NoSuchBucket` |
| `POST /api/media/sign` with no auth header (live) | **HTTP 401** `Missing or malformed Authorization header` |
| Real `post_media.public_url` row | `post-media/92602b6c…/e0ffa259…/f53540bc….jpg` — bare path |
| Real `highlights.media_url` row | `post-media/5f123260…/1785413296467.jpg` — bare path |
| Real `profiles.avatar_url` row | `https://…/storage/v1/object/public/profile-media/avatars/…` — legacy public URL into a now-private bucket |
| Seeded demo rows | `picsum.photos` / `commondatastorage.googleapis.com` — **external URLs, still render** |

That last row is why this survived to device testing: every seeded fixture uses
an external URL. Only *real user uploads* produce the broken form, and only
real device testing produces real user uploads.

---

## a) Capture — camera vs library

Both go through `MediaSourceSheet` (`launchCameraAsync` / `launchImageLibraryAsync`)
and converge on the same `PickedMedia` shape and the same `uploadMedia()` call.
In `PulseCreate`, camera and library images both route through the filter editor
identically; videos skip it in both.

**There is no camera-specific path to the blank render.** Camera and library
media fail the same way, for the same reason. URI schemes are not implicated:
`uploadMedia` does `fetch(uri) → blob()` on the local `file://` URI and that
works — the proof is that the bytes reach the bucket.

EXIF/orientation is handled server-side (`processImage` strips EXIF/GPS and
auto-orients), so orientation is not implicated either.

Two **genuine camera-only defects** do exist, but they are separate bugs and
neither produces a blank box:

1. **iOS camera video is rejected client-side.** `ACCEPTED_VIDEO_TYPES` is
   `['video/mp4']` only. iOS camera capture yields `video/quicktime` (.mov).
   `validateMedia` returns `invalid_type` and the composer shows *"Unsupported
   media type: video/quicktime"*. The server's `ALLOWED_MIME` **does** accept
   `video/quicktime` — the client is stricter than the server for no reason.
   → `src/constants/mediaLimits.ts:20`
2. **HEIC round-trips undecodable.** `ACCEPTED_IMAGE_TYPES` excludes
   `image/heic`, but the server accepts it and, when libvips cannot decode it,
   *stores the original* (`routes/posts.ts:157-161`). A stored `.heic` object
   will still not render on Android after the URL bug is fixed.

I could not reproduce a distinct camera-only *blank* mode. The most likely
reason camera "feels worse" is that camera capture is the only way to guarantee
brand-new media — it can never be served from a stale image cache entry — but
that is inference, not a code finding.

---

## b) Upload — does it execute?

**Yes. Uploads work and are not gated.** Live flag values:

| Flag | Live value | What it actually gates |
|---|---|---|
| `MEDIA_UPLOAD_ENABLED` | **true** | Only the two picker buttons in `AddGemForm.tsx:107,109`. Nothing else — this is its *only* reference in the entire client. |
| `MEDIA_UPLOAD_PHOTO_ENABLED` | true | (unreferenced in client) |
| `MEDIA_UPLOAD_VIDEO_ENABLED` | false | (unreferenced in client) |
| `disable_media_uploads` | **false** | The real kill switch. Checked by `/media/upload`, `/me/avatar/upload`, `/me/cover/upload`, postcards. Not blocking. |
| `media_private_buckets_enabled` | **true** | Client-side gate on signed-URL hydration. See (d). |

Failures on this leg are **loud**, not silent: `uploadMedia` returns a typed
`errorKind` and `HighlightComposer` / `useMediaComposer` render the message
(`HighlightComposer.tsx:119,175`). The user reports *no* error, which is itself
evidence that upload is succeeding.

---

## c) Storage — does the file land, and is it readable?

**Lands: yes. Readable: no.**

A service-role GET of a real uploaded object returns HTTP 200 — the bytes are
there. The same object via the public URL returns HTTP 400 `NoSuchBucket`,
which is what Supabase returns for a private bucket on the public path.

Both buckets were flipped private and `mediaFile.ts` was updated accordingly —
its header says the gating flag *"has been retired — signed URLs are always
issued."* The **client was never updated to match**. This is the seam the bug
lives in.

So: written-but-unreadable, exactly as suspected. Not an RLS misconfiguration —
the bucket privacy is intentional and the server-side relay for it is correct
and complete. Only the client half is missing.

---

## d) Render — root cause per surface

### The shared mechanism

```
uploadMedia() → server returns  "post-media/<uid>/<file>.jpg"     (bare ref)
              → persisted verbatim to post_media.public_url / highlights.media_url / profiles.avatar_url
              → read back by the feed
              → hydrateMediaUrls()  ── extractBucket() says "private bucket"
                 → _resolveMediaFlag() → media_private_buckets_enabled = TRUE → proceed
                 → batchSignUrls() → POST /api/media/sign   ← NO Authorization header
                                   → 401 → throw → catch → result.set(url, url)
                 → hydrateMediaUrls sees signed === original → returns null
              → <Image source={{uri: "post-media/…"}}>  → nothing loads
```

`batchSignMedia.ts:170-175` builds the request with only
`Content-Type: application/json`. The server's `requireUser` rejects it before
doing any work. Verified live: HTTP 401.

Note this is **double-broken**: even if the auth header were added, the flag
gate at `batchSignMedia.ts:147` and `mediaUrl.ts:83` would still short-circuit
whenever `media_private_buckets_enabled` is off — but that flag is now
meaningless, since the server signs unconditionally. Fixing only one of the two
leaves the bug.

And separately: **nothing in the client ever calls `GET /api/media/file/:bucket/*`**,
the relay endpoint built for exactly this. Its only appearance in the client is
a string literal in a test fixture.

### Per surface

| Surface | Component | Failure |
|---|---|---|
| **Cover / avatar** | `AvatarImage` (`DisplayMediaImage.tsx:318`) | Hydration returns null → `imgError` → falls back to **initials chip**. Degrades correctly, but the photo never appears. Legacy `avatar_url` rows hold full public URLs into the now-private bucket → HTTP 400. |
| **Highlight** | `StoryViewer` (uses `DisplayMediaImage`) | Hydration returns null → `phase='error'` → `MediaFallback`: a grey box with a small dot and **no label**. Reads as blank whitespace. |
| **Postcard photo** | `PostDetailCard` → `DisplayMediaImage` (`app/post/[id].tsx:174`) | Same as highlight — grey box, no label. |
| **Postcard video** | `SharedVideoPlayer` (`app/post/[id].tsx:165`) | **Worst case.** Takes `uri` raw and passes it to `<Video source={{uri}}>` with **no hydration at all** — its header comment assumes "signed URLs are self-authenticating", which was true only under the old design. The poster is a bare RN `<Image>` with no `onError`. `hasError` only fires if expo-av reports a load error; an unparseable relative URI may never report one, leaving a **truly blank box**. |

**They share one root cause.** The differences above are only in how gracefully
each surface degrades — none of them shows a real error state, and two of them
show nothing at all.

### Additional bare-`<Image>` sites (secondary, real)

These bypass hydration *and* have no error state, so they are blank boxes
independent of the fix above:

- `app/post/[id].tsx:142` — post author avatar (bare `<Image>`, no `onError`)
- `SharedVideoPlayer.tsx:125` — video poster
- `PostCardMessage.tsx:94,115` — Telegraph card avatar + thumbnail
- `DiscoveryCardMessage.tsx:103` — Telegraph card thumbnail
- `Avatar.tsx:75` — the new 16c primitive uses a bare `<Image>`
- `CachedImage.tsx` — no hydration; used by `ShareEntityPreview`

Only 8 components in the app hydrate at all. That is the structural problem:
hydration is opt-in per call site, so every new surface starts out broken.

---

## Prior findings — both wrong

**1. "`MEDIA_UPLOAD_ENABLED` is OFF and gates all media upload."**
Wrong on both counts. It is **`true`** in the live `feature_flags` table
(updated 2026-07-26). And it gates nothing app-wide: its only two references in
the entire codebase are the picker-button guards in `AddGemForm.tsx:107,109`.
It does not touch avatars, covers, posts or highlights. The flag that *would*
block uploads app-wide is `disable_media_uploads`, which is **false**.

**No production flag needs to change. Nothing to approve.** The fix is entirely
code.

**2. "`PostDetailCard` renders media with a bare `<Image>`."**
Not as of current code — post media already uses `DisplayMediaImage`
(`app/post/[id].tsx:174`). The bare `<Image>` in that file is the **author
avatar** (line 142), which is a real blank-box bug but not the reported one.
The correct version of this finding is the row above about `SharedVideoPlayer`,
which genuinely has no hydration and no reliable error state.

The finding's *reasoning* was right, though: the reason the failure reads as
"blank rather than broken" is that the degraded states are undesigned —
`MediaFallback` with no label is a grey rectangle, and the un-hydrated surfaces
show nothing.

---

## Proposed fix

Not applied — for review first.

**1. Make the bare storage reference resolvable in one place.**
Add a resolver that maps `<bucket>/<path>` → `${API_BASE}/api/media/file/<bucket>/<path>`
and route *all* media through it. The relay endpoint already exists, already
authorizes, and already 302s to a signed URL. This also fixes legacy full
public URLs, which can be rewritten to the same relay form.

**2. Send the bearer token from `batchSignUrls`.**
`POST /api/media/sign` requires auth; add `Authorization: Bearer <token>` via
the same `freshToken()` used by every other authenticated client call. Without
this the batch path stays 401-on-every-call.

**3. Delete the client-side `media_private_buckets_enabled` gate.**
The server retired it and signs unconditionally. Leaving a client gate that can
silently disable the only working URL path is how this bug survived.
(`batchSignMedia.ts:40-54,147`, `mediaUrl.ts:83-89`)

**4. Give `SharedVideoPlayer` the same treatment.**
Hydrate `uri` and `poster`, and drive the poster through `DisplayMediaImage`
instead of a bare `<Image>`.

**5. Replace the remaining bare `<Image>` media sites with `DisplayMediaImage` /
`AvatarImage`** (the six listed above). Per the standing constraint: use the
existing resilient component, do not hand-roll error states.

**6. Give `MediaFallback` a default label.** Today a fallback with no
`fallbackLabel` is a grey box with a dot — indistinguishable from dead
whitespace. Every media surface must show a *visible* error or empty state.

**7. (Separate, camera) Accept `video/quicktime` and `image/heic` client-side**
to match the server's `ALLOWED_MIME`, and decide deliberately what to do with
HEIC that libvips cannot decode rather than storing an undecodable object.

### Regression test that would have caught this

An end-to-end assertion that the string handed to `<Image source>` is an
absolute URL with a scheme — asserted against the *actual* shape upload
endpoints return (`post-media/…`), not against a seeded `https://picsum.photos`
fixture. Every existing fixture uses the external-URL form, which is precisely
why the suite is green while the app is blank.
