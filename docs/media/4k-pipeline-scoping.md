# 4K / adaptive-bitrate media pipeline — scoping

**Scoping only. Nothing built, and no option chosen** — the brief asked for
options with real tradeoffs and explicitly left the choice to the owner. §6
records what must be decided rather than deciding it.

Date: 2026-08-08. Tree: `travel-buddy-standalone`, branch `bughunt-20260805`.

`docs/app-audit.md:166` records *"Video transcoding pipeline — 🔴 Not
implemented — Postcards support video MIME types but no transcode step."*
**Verified accurate.** This is greenfield.

---

## 1. What exists today

### 1a. Images are processed. Video is not.

`artifacts/api-server/src/lib/mediaProcessing.ts` does three things, all with
`sharp`:

1. `sniffMedia()` — magic-number sniffing (the Content-Type header is
   client-declared and untrusted).
2. `processImage()` — re-encode, auto-orient from EXIF, cap the longest edge,
   strip all metadata including GPS.
3. `makeThumbnail()` — real server-side thumbnails.

Its header states the limit plainly (line 17): *"Videos are NOT transcoded here
(no ffmpeg in this tier) — they are sniffed and size-capped only; that
limitation is documented, not hidden."*

**Verified:** `artifacts/api-server/package.json` has `sharp` (^0.35.3) and no
ffmpeg binding of any kind. The only `ffmpeg` string in the API server is that
comment.

### 1b. No rendition concept exists in any of the three media tables

| Table | Shape | Rendition support |
|---|---|---|
| `post_media` | `public_url`, `storage_bucket`, `storage_path`, `thumbnail_url`, `thumbnail_storage_path`, `width`, `height`, `duration_seconds`, `file_size_bytes`, `processing_status`, `moderation_status` | **None** — one URL, one path |
| `media_assets` | `public_url`, `storage_bucket`, `storage_path`, `thumbnail_path`, `thumbnail_url`, `width`, `height`, `duration_ms`, `size_bytes`, `processing_status`, `version` | **None** — same shape |
| `messages` | `media_url`, `media_type`, `media_thumbnail_url`, `media_duration_seconds` inline on the row | **None** — see §5 |

**One row = one file, in all three.** There is nowhere to record a ladder.
`media_attachments` is only a join table (`entity_type`/`entity_id` →
`media_asset_id`), so it does not help either.

`media_assets.version` is an integer, not a rendition set — it does not solve
this, though it may be useful for cache-busting a re-encode.

### 1c. No durable job queue

Background work is in-process `setInterval` schedulers inside the API server —
`pushRetryWorker`, `inviteSlotReconciler`, `discoveryWarmup`,
`suggestionSeenCleanup`, `intelligenceGraphScheduler`. **Verified:** no BullMQ,
no pg-boss, no external worker tier in `artifacts/api-server/package.json`.

`processing_status` already exists on both `post_media` and `media_assets`, is
respected on the read path (`mediaEligibility.ts` requires
`processing_status === 'ready'`), and `adminMedia.ts` has a processing-failures
queue. **The state field for an async pipeline is in place. The pipeline is
not.**

---

## 2. What an ABR pipeline requires here

### 2a. Ingest and job durability
Uploads currently go straight to Supabase storage and the row is marked `ready`.
ABR needs upload → `queued` → durable job → `ready`, surviving API restarts and
deploys. **In-process `setInterval` cannot do this**: a transcode runs for
minutes and a deploy mid-job loses it silently, leaving a row stuck in a
non-`ready` state with nothing to retry it. This is the single largest
structural addition.

### 2b. Rendition ladder
A conventional ladder for phone-shot vertical video:

| Rendition | Resolution | H.264 bitrate | Purpose |
|---|---|---|---|
| 2160p | 3840×2160 | 16–20 Mbps | the "4K" tier |
| 1080p | 1920×1080 | 5–6 Mbps | default on wifi |
| 720p | 1280×720 | 2.5–3 Mbps | default on cellular |
| 480p | 854×480 | 1.0–1.2 Mbps | weak network |
| 360p | 640×360 | 0.6 Mbps | floor |
| audio-only | — | 64 kbps | background / very weak |

Plus HLS/DASH packaging (segments + manifest) and a poster frame per item.

**Schema implication:** a `media_renditions` table (`media_id`, `height`,
`bitrate`, `codec`, `storage_path`, `bytes`, `manifest_path`) or a JSONB column
on `post_media`/`media_assets`. Either is a migration. Note it would need to
serve both `post_media` and `media_assets`, which are separate tables with
separate ID spaces — a single rendition table needs a polymorphic key or two
tables.

### 2c. Codec choice
H.264/AAC is universally decodable and the safe baseline. HEVC and AV1 cut
bandwidth 30–50% at equal quality but fragment device support and raise
transcode CPU substantially. H.264 for every rendition initially, with HEVC as
a later *additive* tier rather than a replacement, keeps the decision
reversible.

### 2d. Delivery
Supabase storage is object storage, not a CDN with range-request tuning and
edge caching for segmented video. ABR at any scale needs a CDN in front. Second
structural addition, and it carries a recurring cost.

### 2e. Poster generation
Thumbnails today are `sharp` output for images; video has no server-side poster
(`thumbnail_url` for video is client-declared). Poster extraction is an ffmpeg
frame-grab — trivial once ffmpeg exists, impossible without it.

### 2f. Client quality selection
`expo-av` is the current player. HLS ABR works on both platforms via the native
players, so automatic selection is largely free once manifests exist. Manual
override ("Auto / 1080p / 720p / Data saver") is a settings surface plus a
per-user preference. A "data saver" default on cellular is a retention lever as
much as a cost one.

---

## 3. Cost multipliers — the shape before committing

### Storage

Multipliers are against the stored original, assuming a 4K source.

| Kept | Multiplier | Note |
|---|---|---|
| Original only (today) | **1.0×** | current state |
| Original + 1080/720/480/360 | **≈ 1.3×** | sub-1080p rungs are cheap in aggregate |
| Original + full ladder incl. 2160p | **≈ 2.0–2.3×** | the 2160p rendition is nearly all of the increase |
| Full ladder, original discarded | **≈ 1.1–1.3×** | saves ~45%, but forecloses re-encoding to a better codec later |

Discarding the original is the one storage saving that is hard to undo. Keeping
it in cold / infrequent-access storage retains the option at a fraction of hot
cost.

### Bandwidth — this is the one that bites

Today one file is served at whatever it was uploaded at. With ABR, **egress
scales with engagement, not with upload volume.** A popular 4K clip can serve
20 Mbps × viewers; a viral one is unbounded. Feed autoplay multiplies it,
because autoplay spends bandwidth on views the user never chose.

Levers that matter more than codec choice:

- cap autoplay at 480p/720p, fetch higher only on explicit fullscreen;
- preload one segment, never the whole file;
- default cellular to 720p.

**A 2160p rung with uncapped autoplay is the worst case in this document.** The
autoplay cap is a bigger cost decision than whether 2160p exists at all.

### Compute

A 60-second 4K clip is roughly 2–6 minutes of CPU for the full ladder on a
general-purpose core. At any volume this needs a dedicated worker tier or a
managed service — it cannot share the API process.

---

## 4. Options

Three, with real tradeoffs. **Not ranked. The choice is the owner's.**

### Option 1 — Managed service (Mux, Cloudflare Stream, api.video)
Upload → service → HLS manifest + poster back.

- **For:** no ffmpeg, no queue, no CDN, no worker tier. Poster and ladder come
  free. Fastest credible route to 4K, and the least new operational surface.
- **Against:** per-minute encoding *and* per-minute delivery pricing that scales
  with engagement — the cost grows exactly where §3's bandwidth risk is; a third
  party holds user video; migrating off later is a hard dependency to unwind.
- **Cost shape:** low fixed, high variable. Cheapest at low volume, most
  expensive at high volume.

### Option 2 — Self-hosted ffmpeg worker + CDN
pg-boss on the existing Postgres, a worker process with ffmpeg, renditions to
Supabase storage, CDN in front.

- **For:** no per-minute vendor fee; full control of ladder and codecs; media
  stays in existing infrastructure.
- **Against:** builds and operates a queue, a worker tier, a retry/poison-job
  story, and a CDN configuration. `processing_status` exists but everything
  behind it must be written. Highest engineering cost and highest ongoing
  operational burden.
- **Cost shape:** high fixed, low variable. Crosses over Option 1 at some
  volume; where that crossover sits is the deciding question and needs real
  upload/view numbers to answer.

### Option 3 — ABR ladder, explicitly not 4K
Cap ingest at 1080p, transcode to a 3-rung ladder (1080/720/480), no 2160p.
Deliverable via either Option 1 or Option 2 — it is a scope choice, not an
infrastructure one, and composes with both.

- **For:** ≈1.3× storage, dramatically lower egress, one codec. Delivers ABR,
  which is what actually fixes playback on poor networks; most phone video is
  watched on a phone, where 2160p is largely invisible. The 2160p rung can be
  added later as one more ladder entry.
- **Against:** does not deliver "4K" as asked. If 4K is a marketing or
  creator-acquisition commitment rather than a playback-quality goal, this
  option does not satisfy it.
- **Cost shape:** materially cheaper than either full-4K path on both storage
  and egress.

---

## 5. The DM constraint — resolved during this session

The brief notes that DM attachments can never be server-transcoded once
encrypted. **Correct in principle, and the situation changed while this document
was being written.**

**What the schema shows:** `messages` carries `media_url`, `media_type`,
`media_thumbnail_url` and `media_duration_seconds` as **plaintext columns**,
alongside a `ciphertext` column — so the storage shape still permits plaintext
DM media. That was finding 14
(`docs/security/e2ee-finding-14-media-bypass.md`): the media endpoint wrote
those columns with no `is_e2ee` check, so E2EE threads accepted plaintext media.

**Finding 14 was fixed in commit `9b1f49bdc` (concurrent work, this session),
and it was resolved by rejecting media on encrypted threads** —
`POST /threads/:threadId/media` now looks up `message_threads.is_e2ee` and
fails closed with `e2ee_thread` when it is true. Its own comment states the
reasoning: *"This endpoint has no attachment-encryption path yet, so fail
closed."*

The media consequences follow directly:

- **E2EE threads have no media at all today.** Not lower-quality media —
  none. There is nothing to transcode and no ladder to build.
- **Non-E2EE threads keep the normal pipeline**, and are in scope for anything
  in §4 that applies to `messages` media.
- **If attachment encryption is built later**, the permanent constraint in the
  brief takes effect: the server sees ciphertext only, so no transcode, no
  ladder, no server poster, no CDN-level optimisation. DM video becomes whatever
  the sender's device produced, and the **client** must downscale before
  encrypting if quality is to be controlled at all — costing battery and upload
  time on the sender's phone.

**Feed media and DM media need separate quality stories under every one of
those three states, and the product should say so rather than implying parity.**
The asymmetry is inherent to end-to-end encryption, not a shortcoming of the
implementation — Signal and WhatsApp have the same constraint and solve it with
client-side compression before encryption.

**Client-side compression before upload is the one measure that helps under
every option**: it reduces storage, egress and transcode cost simultaneously,
and it is the *only* lever that would be available for encrypted DM media.

---

## 6. Decisions needed

Recorded rather than blocked on, per instruction. Roughly in the order they
gate the others.

1. **Is 2160p actually required, or is 1080p ABR the real goal?** This is the
   fork between Option 3 and the rest, and it drives every cost number in §3.
   Worth asking whether "4K" means playback quality or a creator-facing claim.
2. **Managed service vs self-hosted** (§4). Answerable only with real upload
   and view volume — the crossover point is the whole argument.
3. **Autoplay quality cap and cellular default.** Per §3 this is a larger
   bandwidth decision than the ladder itself.
4. **Retain originals after transcode?** Discarding saves ~45% of storage and
   forecloses re-encoding to a better codec later.
5. **Is DM media quality parity promised to users at all?** (§5)
6. **Should encrypted threads ever support media?** Finding 14 was closed by
   rejecting it (§5). Building attachment encryption later reopens the
   permanent no-transcode constraint; leaving it closed means E2EE threads stay
   text-only. This is a product decision, not a media-pipeline one.
7. **One rendition table or two?** `post_media` and `media_assets` are separate
   tables with separate ID spaces (§2b).

---

## 7. Verification note

- `app-audit.md:166`, the `mediaProcessing.ts` header, the absence of ffmpeg and
  of any queue library, and the column lists for `post_media`, `media_assets`,
  `media_attachments` and `messages` were all read directly.
- Column lists come from `artifacts/api-server/src/lib/database.types.ts`
  (generated from live), not from migration files.
- **Not verified:** the bitrate, storage-multiplier and CPU figures in §2b and
  §3 are industry-standard planning numbers, not measurements from this
  codebase or its content. Real numbers require encoding a representative
  sample of actual Portava uploads, which needs ffmpeg — not available in this
  tier and not installable under this session's constraints. Treat the
  multipliers as the *shape* of the cost, which is what the brief asked for, and
  re-measure before committing budget.
- **Not verified:** current upload volume, average clip length and view
  distribution. Decision 2 cannot be answered without them.
