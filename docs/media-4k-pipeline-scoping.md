# 4K / adaptive-bitrate media pipeline — scoping

**Scoping only. Nothing built.** Requested explicitly as investigation.
Date: 2026-08-08.

`docs/app-audit.md:166` records *"Video transcoding pipeline — 🔴 Not
implemented — Postcards support video MIME types but no transcode step."*
That is accurate. This is greenfield.

---

## 1. What exists today

**Images are processed. Video is not.**

`artifacts/api-server/src/lib/mediaProcessing.ts` does three things, all with
`sharp`:
1. `sniffMedia()` — magic-number sniffing (the Content-Type header is
   client-declared and untrusted).
2. `processImage()` — re-encode, auto-orient from EXIF, cap the longest edge,
   and strip all metadata including GPS.
3. `makeThumbnail()` — real server-side thumbnails.

Its own header says it plainly: *"Videos are NOT transcoded here (no ffmpeg in
this tier) — they are sniffed and size-capped only; that limitation is
documented, not hidden."*

**There is no rendition concept in the schema.** `post_media` columns:

```
id user_id post_id media_type mime_type
public_url storage_bucket storage_path
thumbnail_url thumbnail_storage_path
width height duration_seconds file_size_bytes
processing_status moderation_status phash dedup_processed
canonical_place_id stamp_overlay sort_order created_at updated_at
```

One URL, one storage path, one thumbnail. **One row = one file.** There is
nowhere to record a ladder.

**There is no durable job queue.** Background work is in-process
`setInterval` schedulers inside the API server — `pushRetryWorker`,
`inviteSlotReconciler`, `discoveryWarmup`, `suggestionSeenCleanup`,
`intelligenceGraphScheduler`. No BullMQ, no pg-boss, no external worker tier.
The only media-relevant dependency is `sharp`. **No ffmpeg anywhere.**

`processing_status` already exists and is respected by the read path
(`mediaEligibility.ts` requires `processing_status === 'ready'`), and
`adminMedia.ts` has a processing-failures queue. So the *state field* for an
async pipeline is in place; the pipeline is not.

## 2. What an adaptive-bitrate pipeline actually requires here

### 2a. Ingest and job durability
Uploads currently go straight to Supabase storage and the row is marked
`ready`. ABR needs upload → `queued` → durable job → `ready`, surviving API
restarts and deploys. **In-process `setInterval` cannot do this**: a transcode
is minutes long and a deploy mid-job loses it silently. This is the single
biggest structural addition — either a real queue (pg-boss on the existing
Postgres is the cheapest credible option) or an external service that owns the
job.

### 2b. Rendition ladder
A conventional ladder for phone-shot vertical video:

| Rendition | Height | Bitrate (H.264) | Purpose |
|---|---|---|---|
| 2160p | 3840×2160 | 35–45 Mbps source, 16–20 Mbps out | "4K" tier |
| 1080p | 1920×1080 | 5–6 Mbps | default on wifi |
| 720p | 1280×720 | 2.5–3 Mbps | default on cellular |
| 480p | 854×480 | 1.0–1.2 Mbps | weak network |
| 360p | 640×360 | 0.6 Mbps | floor |
| audio-only | — | 64 kbps | background/very weak |

Plus HLS/DASH packaging (segments + manifest), and a poster frame per item.

**Schema implication:** a `media_renditions` table
(`media_id`, `height`, `bitrate`, `codec`, `storage_path`, `bytes`,
`manifest_path`) — or a JSONB column on `post_media`. Either is a schema
change and needs approval.

### 2c. Codec choice
H.264/AAC is universally decodable and the safe baseline. HEVC and AV1 cut
bandwidth 30–50% at equal quality but fragment device support and raise
transcode CPU substantially. Recommend H.264 for every rendition initially,
with HEVC as a later additive tier — never as a replacement.

### 2d. Delivery
Supabase storage is object storage, not a CDN with range-request tuning and
edge caching for segmented video. ABR at any scale needs a CDN in front. This
is the second structural addition and it has a recurring cost.

### 2e. Poster generation
Currently thumbnails are `sharp` output for images; video has no server-side
poster (`thumbnail_url` for video is client-declared today). Poster extraction
is an ffmpeg frame-grab — trivial once ffmpeg exists, impossible without it.

### 2f. Client quality selection
`expo-av` is the current player. HLS ABR works on both platforms via the native
players, so automatic selection is mostly free once manifests exist. Manual
override ("Auto / 1080p / 720p / Data saver") is a settings surface plus a
per-user preference. Add a "data saver" default on cellular — this is a
retention as much as a cost lever.

## 3. Cost multipliers — be explicit

**Storage.** Keeping the original plus five renditions runs **≈ 2.0–2.3× the
original**, because the ladder below 1080p is cheap and the 2160p rendition is
the bulk. Dropping the 2160p tier drops it to ≈ 1.3×. Discarding the original
after transcode saves ~45% but forecloses ever re-encoding to a better codec —
**not recommended**; keep the original in cold/infrequent-access storage.

**Bandwidth.** This is the one that bites. Today one file is served at whatever
it was uploaded at. With ABR, egress rises with *engagement*, not with upload
volume — a popular 4K clip can serve 20 Mbps × viewers. Feed autoplay makes it
worse. Mitigations that matter more than codec choice:
- cap autoplay to 480p/720p and only fetch higher on explicit fullscreen;
- preload one segment, never the whole file;
- cellular default at 720p.

**Compute.** A 60-second 4K clip is roughly 2–6 minutes of CPU transcode for
the full ladder on a general-purpose core. At any volume this needs either a
dedicated worker tier or a managed service.

## 4. Options

### Option 1 — Managed service (Mux, Cloudflare Stream, api.video)
Upload → service → HLS manifest + poster back.
- **For:** no ffmpeg, no queue, no CDN, no worker tier. Weeks of work removed.
  Poster and ladder come free. Fastest credible route to 4K.
- **Against:** per-minute encoding + per-minute delivery pricing that scales
  with engagement; a third party holds user video; a hard dependency to migrate
  off later.
- **Best when** video is a growing but not yet dominant share of content.

### Option 2 — Self-hosted ffmpeg worker + CDN
pg-boss on the existing Postgres, a worker process with ffmpeg, renditions to
Supabase storage, CDN in front.
- **For:** no per-minute vendor fee; full control; media stays in existing
  infrastructure.
- **Against:** builds and operates a queue, a worker tier, a retry/poison-job
  story, and a CDN configuration. The `processing_status` field exists but
  everything behind it must be written. Highest engineering cost.

### Option 3 — Tiered, and explicitly not 4K yet
Cap ingest at 1080p, transcode to a 3-rung ladder (1080/720/480), no 2160p.
- **For:** ~1.3× storage, dramatically lower egress, one codec, and it removes
  the hardest cost question while still delivering ABR — which is what actually
  fixes playback on poor networks. Most phone video is viewed on a phone.
- **Against:** does not deliver "4K" as asked.
- **This is the recommended first step**, because the ABR machinery is the same
  and the 2160p rung can be added later by adding one ladder entry.

## 5. The DM constraint — verified, and worse than assumed

The brief notes that DM attachments can never be server-transcoded once
encrypted. **That is correct in principle, and the current state is different
from what was assumed — see `docs/security/e2ee-finding-14-media-bypass.md`.**

Today DM media is **not encrypted at all**. `messages` carries `media_url`,
`media_type`, `media_thumbnail_url`, `media_duration_seconds` as plaintext
columns, and `POST /threads/:threadId/media` writes them with no `is_e2ee`
check. So DM video today *could* be transcoded server-side — because the
encryption guarantee is not actually being applied to it.

Once finding 14 is resolved:

- **If Option B (encrypt attachments):** the server sees ciphertext only.
  No transcode, no ladder, no server poster, no CDN-level optimisation. DM
  video is permanently whatever the sender's device produced, and the *client*
  must downscale before encrypting if quality is to be controlled at all.
  Client-side pre-encrypt transcode is the only lever, and it costs battery and
  upload time on the sender's phone.
- **If Option A (reject media on E2EE threads):** DM media keeps the normal
  pipeline, but only on unencrypted threads.

Either way, **feed media and DM media need separate quality stories, and the
product should say so rather than implying parity.** This asymmetry is
inherent to end-to-end encryption, not a shortcoming of the implementation —
Signal and WhatsApp have exactly the same constraint and solve it with
client-side compression before encryption.

## 6. Recommendation

1. Resolve finding 14 first — it determines whether DM media is in scope at all.
2. Start with **Option 3** (ABR ladder to 1080p, no 2160p) delivered via
   **Option 1** (managed service) to avoid building a queue and CDN before the
   volume justifies them. Revisit self-hosting when per-minute cost exceeds the
   cost of operating the worker tier.
3. Add the 2160p rung only behind an explicit product decision about egress,
   with autoplay capped well below it.
4. Client-side compression before upload is worth doing regardless of option —
   it reduces storage, egress and transcode cost simultaneously, and it is the
   *only* lever available for encrypted DM media.

## 7. Decisions needed

- Managed service vs self-hosted (§4).
- Is 2160p actually required at launch, or is 1080p ABR the real goal?
- Retain originals after transcode? (Recommend yes, cold storage.)
- Autoplay quality cap and cellular default.
- Whether DM media quality parity is promised to users at all (§5).
