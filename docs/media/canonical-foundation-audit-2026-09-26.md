# Media canonical foundation audit (spec §49, Phase 1)

- **Date written:** 2026-09-26.
- **Tree audited:** `claude/sensing-completion-20260925` at commit
  `396348728b76592080580fb8ac19348920c13fb1`, the output of `git rev-parse HEAD`
  when this audit was written. Every line reference below is to that commit.
- **Written by:** media lane H, for census-media row MD441 (census-media §27).
- **Spec:** `docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt`, §49,
  Phase 1: "Audit MediaAsset, attachments, upload, processing, storage,
  visibility, moderation."

## This is NOT the historical Phase-1 audit

§49 names an audit as Phase 1's deliverable. No such document was written when
Phase 1 was built, and this file does not stand in for one.
- **The build had no audit document.** The Phase 1 build is commit `286813ed5`
  (#273, 2026-08-31 13:30:32 -0400). Its subject is "Phase 1 Canonical
  Foundation — consolidate onto media_assets/media_attachments". It touched ten
  files, and none of them is a document.
- **Phase 2 started 49 minutes later.** The Phase 2 shell is `693da9448` (#279,
  14:19:37 the same day), and the Phase 2/3 endpoints are `c58f6a7d4` (#278,
  14:28:06).
- **The nearest earlier document is a Phase 0 report.** It is
  `travel-buddy-standalone/docs/media-phase0-report.md`. Its header reads
  "Generated: 2026-07-24", and its scope is the client only.
- **0191 names the audit but does not contain it.** The migration's own header
  says it is "Phase 1.5 of the media Phase 0 audit"
  (`artifacts/api-server/src/migrations/0191_media_assets.sql:3#Phase 1.5 of the media Phase 0 audit`).
  It also mislabels itself as "Migration 0190"
  (`artifacts/api-server/src/migrations/0191_media_assets.sql:1#Migration 0190`).

This audit was written 26 days after Phases 2 to 10 were built. It describes the
tree as it stands at the commit above. It does not describe what the programme
knew on 2026-08-31. It must not be cited as evidence that the foundation was
audited before Phase 2 began.

## Method

- **Tree reading.** Each "what exists" statement carries a `path:line#text`
  reference. The text after `#` is on that line at the audited commit.
- **Production.** No database was queried for this audit. Every production fact
  is quoted from a record someone else made read-only: `docs/migrations.md`
  (the 3320/3321 entry) and census-media §23.2 and §23.8.
- **Row grades.** Gaps name census-media rows by ID and give the section that
  holds each row's last statement. This audit does not grade those rows.
- **Findings.** A finding is a defect this audit found. It is recorded here and
  in census-media §27, and it is not fixed.

## 1. MediaAsset

**What exists**
- **One row per stored object.**
  - The table: `artifacts/api-server/src/migrations/0191_media_assets.sql:11#CREATE TABLE IF NOT EXISTS media_assets (`.
  - One row per object: `artifacts/api-server/src/migrations/0191_media_assets.sql:39#UNIQUE (storage_bucket, storage_path)`.
- **The §6 columns.**
  - 2250 adds them: `artifacts/api-server/src/migrations/2250_media_asset_canonical_model.sql:3#Phase 1 (Canonical Foundation)`.
  - 2470 re-issues them without 2250's flag assertion: `artifacts/api-server/src/migrations/2470_media_asset_canonical_columns_flag_agnostic.sql:3#The migration-2250 column set`.
- **A versioned aggregate.**
  - 3320's trigger bumps the version: `artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:144#CREATE TRIGGER media_assets_version_bump`.
  - Writers compare-and-set on it: `artifacts/api-server/src/lib/mediaAssets.ts:991#export async function casUpdateMediaAsset(`.
- **Media-level visibility is CHECKed** by 3320: `artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:123#ADD CONSTRAINT media_assets_visibility_check`.
- **The writer** is `artifacts/api-server/src/lib/mediaAssets.ts:309#export async function recordMediaAssetDetailed(`.
  It writes nothing while the flag is off:
  `artifacts/api-server/src/lib/mediaAssets.ts:321#if (!(await isFlagEnabled(sc, "media_canonical_enabled"))) return NONE;`.

**What the spec requires.** §6 sets the canonical contract: id, owner, type,
storage, dimensions, size, timestamps, statuses, visibility, provenance,
eligibility and version. §36 sets the moderation vocabulary, which is covered
in area 7.

**Gaps, by census row**
- **MD36, MD38.** C on the branch (§20.4). Their production state is §20.5's P1
  and P4.
- **MD37.** W (§20.6). Uploads write the legacy source `user`
  (`artifacts/api-server/src/migrations/0191_media_assets.sql:28#DEFAULT 'user'`).

**Risks**
- **Production is not written.** `media_canonical_enabled` reads FALSE in
  production (last set 2026-09-25 15:39 UTC, per §23.2 and §23.8). So no
  canonical row is written there, whatever this tree does.
- **3320 and 3321 are applied to `portava-ci` only.** This was done under owner
  decision A on 2026-09-26 and is recorded in `docs/migrations.md` ("3320 and
  3321 applied to `portava-ci` under owner decision A; NOT to production").
  Production has neither the version trigger nor the visibility CHECK.
- **An RLS policy does not speak §36.** The 20260811 policies admit an
  `authenticated` direct read only for `moderation_status = 'approved'`. After
  3321 stores `active` instead, such a read returns nothing. `docs/migrations.md`
  records this, and records that no path reads these tables as `authenticated`.
  It fails closed.

## 2. Attachments

**What exists**
- **The table.**
  - It is created at `artifacts/api-server/src/migrations/0191_media_assets.sql:45#CREATE TABLE IF NOT EXISTS media_attachments (`.
  - It holds one link per asset and entity: `artifacts/api-server/src/migrations/0191_media_assets.sql:54#UNIQUE (media_asset_id, entity_type, entity_id)`.
- **The table CHECKs its own values** (3320, portava-ci only):
  - `artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:99#ADD CONSTRAINT media_attachments_entity_type_check`, the §6.1 nine types;
  - `artifacts/api-server/src/migrations/3320_media_canonical_contract_constraints.sql:111#ADD CONSTRAINT media_attachments_visibility_override_check`.
- **The writers.**
  - The allowed types: `artifacts/api-server/src/lib/mediaAssets.ts:718#export const ATTACHMENT_ENTITY_TYPES = [`.
  - The attachment writer: `artifacts/api-server/src/lib/mediaAssets.ts:756#export async function recordMediaAttachment(`.
  - The fan-out helper: `artifacts/api-server/src/lib/mediaAssets.ts:818#export async function recordEntityMedia(`.
  - The endpoint: `artifacts/api-server/src/routes/mediaActions.ts:224#/media/:id/attachments`.
- **The canonical read** selects the override with each attachment:
  `artifacts/api-server/src/lib/media/mediaCanonicalRead.ts:219#entity_id, position, is_cover, visibility_override, media_assets(`.

**What the spec requires.** §6.1: one asset in many product objects, with
position, cover and a per-attachment visibility override.

**Gaps, by census row**
- **MD41, MD44, MD339, MD369.** C on the branch (§20.4). Their production state
  is P1 (§20.5).
- **MD255.** W (§20.6). All six audiences exist at attachment level. The
  reachable composer does not offer them.

**Risks.** Production holds 0 attachments (`docs/migrations.md`, the
3320/3321 entry). So none of this has run against production data.

## 3. Upload

**What exists**
- **The general upload** is `artifacts/api-server/src/routes/posts.ts:84#/media/upload`.
  - It authenticates the caller at `artifacts/api-server/src/routes/posts.ts:92#const auth = await requireUser(req, res);`.
  - It applies the shared kill switch and rate budget at `artifacts/api-server/src/routes/posts.ts:102#const guard = await guardUploadRequest(sc, user.id);`.
  - The bytes, not the header, decide the type: `artifacts/api-server/src/routes/posts.ts:125#const verified = verifyUploadedBytes(rawBody, declaredInfo.mediaType);`.
- **One policy covers both transports:**
  - `artifacts/api-server/src/lib/mediaPipeline.ts:108#export async function guardUploadRequest(`;
  - `artifacts/api-server/src/lib/mediaPipeline.ts:184#export function verifyUploadedBytes(`;
  - `artifacts/api-server/src/lib/mediaPipeline.ts:60#export const MEDIA_SIZE_LIMITS`.
- **Resumable postcard upload** (lane D, census-media §22):
  - `artifacts/api-server/src/routes/postcardMediaTransport.ts:212#/postcards/:id/media/:mediaId/upload-session`;
  - `artifacts/api-server/src/routes/postcardMediaTransport.ts:253#/postcards/:id/media/:mediaId/upload-session/assemble`;
  - `artifacts/api-server/src/lib/postcardMediaTransport.ts:231#export async function assembleParts(`;
  - `artifacts/api-server/src/lib/postcardMediaTransport.ts:114#export function summarizeParts(`.
  - The client ships it off: `travel-buddy-standalone/src/services/media/uploadTransportFlag.ts:19#const DEFAULT_ENABLED = false;`.
- **Poster uploads** cap their body while it is still being read:
  - `artifacts/api-server/src/routes/postcardMediaTransport.ts:136#export function collectBody(limitBytes: number) {`;
  - `artifacts/api-server/src/lib/postcardMediaTransport.ts:63#export const POSTER_MAX_BYTES = 5 * 1024 * 1024;`.

**What the spec requires.** §37 covers upload, resume and retry, and background
upload. §40 covers the client upload service.

**Gaps, by census row**
- **MD281.** C (§22.3).
- **MD284.** W (§22.5): only the in-flight part continues while the app is
  suspended.
- **MD282.** N (§22.5): no video transcoding.

**Risks**
- **Finding F1:** `/media/upload` buffers the whole body before it
  authenticates, and applies no ceiling while it reads (details under
  Findings).

## 4. Processing

**What exists**
- **Images.**
  - The bytes decide the type: `artifacts/api-server/src/lib/mediaProcessing.ts:35#export function sniffMedia(`.
  - Each image is re-encoded: `artifacts/api-server/src/lib/mediaProcessing.ts:160#export async function processImage(`.
  - Each image gets a thumbnail: `artifacts/api-server/src/lib/mediaProcessing.ts:187#export async function makeThumbnail(`.
- **Video metadata is measured** (lane D):
  - the probe: `artifacts/api-server/src/lib/videoProbe.ts:83#export function probeVideoContainer(`;
  - called on upload: `artifacts/api-server/src/routes/posts.ts:146#probeVideoContainer(rawBody)`;
  - written as the stored duration: `artifacts/api-server/src/lib/mediaVideoPoster.ts:175#export async function recordMeasuredDuration(`.
- **Video posters.**
  - The general route: `artifacts/api-server/src/routes/mediaVideoPoster.ts:46#/media/upload/poster`.
  - The postcard route: `artifacts/api-server/src/routes/postcardMediaTransport.ts:176#/postcards/:id/media/:mediaId/poster`.
  - Both record the poster on the asset: `artifacts/api-server/src/lib/mediaVideoPoster.ts:138#export async function recordPosterOnAsset(`.
- **Readiness.** A row with both dimensions is written `ready`, and one without
  them is written `processing`:
  `artifacts/api-server/src/lib/mediaAssets.ts:397#input.width != null && input.height != null ? "ready" : "processing"`.
- **The lifecycle service** is migrations 2951 to 2955 plus
  `artifacts/api-server/src/services/media/MediaLifecycleService.ts:88#export async function claimMediaProcessing(`
  and `artifacts/api-server/src/services/media/MediaLifecycleService.ts:367#export async function retryMediaProcessing(`.

**What the spec requires.** §37 covers thumbnails, duration and transcoding.
§41 requires a processing service.

**Gaps, by census row**
- **MD275, MD276.** C (§22.3).
- **MD282.** N (§22.5).
- **MD352.** C (its row in census §5).

**Risks**
- **Finding F2:** an owner's retry parks the asset in `queued`, and nothing
  claims queued work (details under Findings).
- **Unsized video.** A video the probe cannot size still has null dimensions.
  So it stays `processing`, and nothing moves it on:
  `artifacts/api-server/src/lib/mediaAssets.ts:540#export async function completeVideoTranscode(`
  has no non-test caller. §22.4 records this for the pre-probe state.

## 5. Storage

**What exists**
- **Buckets and signed URLs.**
  - Two buckets are served: `artifacts/api-server/src/routes/mediaFile.ts:29#const ALLOWED_BUCKETS = new Set(`.
  - Signed URLs last at most `artifacts/api-server/src/routes/mediaFile.ts:28#const SIGNED_TTL_SECONDS = 3600;`.
  - They are shortened only when the object has an access deadline: `artifacts/api-server/src/routes/mediaFile.ts:163#return Math.max(1, Math.min(SIGNED_TTL_SECONDS, remaining));`.
- **The byte gate.**
  - Its entry: `artifacts/api-server/src/lib/mediaAccess.ts:168#export async function authorizeMediaAccess(`.
  - It decides at `artifacts/api-server/src/lib/mediaAccess.ts:292#async function decide(`.
  - An unreferenced object is denied: `artifacts/api-server/src/lib/mediaAccess.ts:895#Nothing references it`.
- **A derived object is decided as its base.**
  - A poster is its video (§37):
    - `artifacts/api-server/src/lib/mediaAccess.ts:369#const posterOf = derivedPosterBase(path);`;
    - `artifacts/api-server/src/lib/mediaPosterPath.ts:41#export function derivedPosterBase(`.
  - A poster keeps its video's deadline: `artifacts/api-server/src/lib/mediaAccess.ts:928#a poster keeps its video's deadline`.
  - A recorded variant is its original (§23.7). The hook is
    `artifacts/api-server/src/lib/mediaAccess.ts:483#originalOfRecordedVariant(`. It runs only when no `post_media` row claims the path as an original. The pieces:
    - the name rule: `artifacts/api-server/src/lib/mediaAccess.ts:1012#export function isDerivedVariantOf(`;
    - the lookup: `artifacts/api-server/src/lib/mediaAccess.ts:1027#async function originalOfRecordedVariant(`;
    - client-writable prefixes excluded: `artifacts/api-server/src/lib/mediaAccess.ts:1033#VARIANT_CLIENT_WRITABLE_PREFIXES`;
    - a lookup error denies: `artifacts/api-server/src/lib/mediaAccess.ts:1047#if (error) return "deny";`;
    - two originals deny: `artifacts/api-server/src/lib/mediaAccess.ts:1056#if (originals.size > 1) return "deny";`;
    - the tests: `artifacts/api-server/src/test/mediaAccess.test.ts:858#derived variants (.feed.jpg / .thumb.jpg) are their original`.

**What the spec requires.** The spec lists storage among the Phase 1 audit
areas. It gives storage no requirement of its own beyond the §6 contract's
storage fields and the privacy rules §33 applies to what is served.

**Gaps, by census row**
- **No row grades storage by itself.** It appears only as a field of MD36 and,
  through the byte gate, under MD9 and MD43. This is a coverage gap in the
  census, not a defect in the code.

**Risks**
- **Finding F3:** the event/trip header mask fails open on a read error (details
  under Findings).
- **A revoked viewer keeps access for a while.** A block or an audience change
  made after a URL is signed does not shorten that URL. It stays valid for up to
  3600 s, because only an access deadline shortens it.

## 6. Visibility

**What exists**
- **The attachment override** is decided at
  `artifacts/api-server/src/lib/mediaVisibility.ts:81#export async function mayViewUnderOverride(`.
  - `inherit` and `public` do not narrow: `artifacts/api-server/src/lib/mediaVisibility.ts:93#case "inherit":`.
  - `shared_moment` means accepted members of an approved Moment: `artifacts/api-server/src/lib/mediaVisibility.ts:175#async function isSharedMomentAudience(`.
  - Any read error denies.
- **The projection's override filter.**
  - Its entry is `artifacts/api-server/src/services/media/MediaProjectionService.ts:1683#export async function prepareCanonicalRows(`.
  - It is called first on the projection path: `artifacts/api-server/src/services/media/MediaProjectionService.ts:679#rows = await prepareCanonicalRows(sc, viewer, rows);`.
  - Only attachments that carry an override are narrowed: `artifacts/api-server/src/services/media/MediaProjectionService.ts:1693#const narrowed = canonical.filter(`.
  - If one is withheld, the row's legacy branches are cleared, so the item cannot fall back to serving the same file from `post_media`: `artifacts/api-server/src/services/media/MediaProjectionService.ts:1724#out.push({ ...row, canonical_media: kept, post_media: [], media_urls: [] });`.
  - An item with nothing left is dropped.
- **The location axis** is `artifacts/api-server/src/lib/mediaLocationVisibility.ts:354#export function resolveMediaLocationWithGemProtection(`.

**What the spec requires.** §33: six audiences, plus location visibility as an
independent axis.

**Gaps, by census row**
- **MD43.** C on the branch (§20.4).
- **MD255.** W (§20.6).
- **MD257.** C (its row in census §5).

**Risks.** The projection filter acts only on `canonical_media`. That field is
filled only when `media_canonical_read_enabled` is on:
`artifacts/api-server/src/lib/media/mediaCanonicalRead.ts:162#export const MEDIA_CANONICAL_READ_FLAG`.
The flag is off in portava-ci and absent in production (§20.5, P2). So the
filter has nothing to narrow in either database today. The byte gate applies
the same override to the bytes regardless of the flag.

## 7. Moderation

**What exists**
- **The §36 state machine**, `MediaModerationService`:
  - the decision is applied at `artifacts/api-server/src/services/media/MediaModerationService.ts:122#export async function applyCanonicalModerationDecision(`;
  - transitions are checked at `artifacts/api-server/src/services/media/MediaModerationService.ts:86#export function canTransition(`;
  - `owner_deleted` is terminal: `artifacts/api-server/src/services/media/MediaModerationService.ts:83#owner_deleted: [],`;
  - the distribution predicate is `artifacts/api-server/src/services/media/MediaModerationService.ts:96#export function isDistributableModerationState(`.
- **The admin route calls it:**
  - after a post-media decision: `artifacts/api-server/src/routes/adminMedia.ts:880#canonicalOutcome = await applyCanonicalModerationDecision(sc, {`;
  - after a deletion: `artifacts/api-server/src/routes/adminMedia.ts:841#decision: "remove"`.
  - If a restrictive decision fails to reach the canonical row, the route logs at error level: `artifacts/api-server/src/routes/adminMedia.ts:888#the canonical asset did NOT follow`.
- **Migration 3321** (portava-ci only):
  - the §36 default: `artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql:73#SET DEFAULT 'processing'`;
  - a trigger that stores each legacy spelling as its §36 value: `artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql:95#CREATE TRIGGER media_assets_canonical_moderation`;
  - a precondition on the §36 CHECK: `artifacts/api-server/src/migrations/3321_media_moderation_canonical_state.sql:63#PRECONDITION FAILED`.
- **Distribution gates:**
  - `artifacts/api-server/src/lib/mediaEligibility.ts:78#export const NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES`;
  - the Wall's quick-media block: `artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1156#const QUICK_MEDIA_BLOCKED_MODERATION`.
- **The byte gate's moderation check** reads `post_media` only:
  - the deny set: `artifacts/api-server/src/lib/mediaAccess.ts:149#const UNSERVABLE_ATTACHMENT_MODERATION`;
  - where it is applied: `artifacts/api-server/src/lib/mediaAccess.ts:491#UNSERVABLE_ATTACHMENT_MODERATION.has(`.

**What the spec requires.** §36: six states, with owner deletion terminal. §41
requires a moderation service. §36 also requires a safety stage before
distribution.

**Gaps, by census row**
- **MD274, MD351.** C on the branch (§20.4). Their production state is P1 and
  P4 (§20.5).
- **MD269.** W (§20.6). `processing` is distributable, so there is no
  pre-distribution hold.

**Risks**
- **Two stores.** The admin route writes `post_media` first and the canonical
  row second, and it logs when they diverge. It does not roll back.
- **The byte gate reads only the legacy store.** It never reads
  `media_assets.moderation_status`, and the file records that as deliberate:
  `artifacts/api-server/src/lib/mediaAccess.ts:146#It is NOT widened to the §36 canonical values`.
  An object with no `post_media` row has no moderation check at the byte gate.
- **Finding F4:** a stale pointer in the eligibility module's rationale (details
  under Findings).

## §49: why this file answers MD441, and the condition under which it does not

§49 is a two-column table, "Phase" and "Deliverable". Phase 1's deliverable is
"Audit MediaAsset, attachments, upload, processing, storage, visibility,
moderation." The table does not say that Phase 1 must finish before Phase 2
starts, and it does not say that the audit must precede the build.

- **Read as deliverables, this file delivers Phase 1.** It is an audit of all
  seven areas, taken at a stated commit, and each claim can be checked against
  the tree. The census grades the sibling rows the same way: MD442 (Phase 2) is
  C with "Delivered (and dark)", and MD443 to MD450 are graded on what exists,
  not on when it was built. The census's own falsifiers for MD441 ask for "the
  audit document" (census §6) and "the audit artifact being committed" (census §14.4).
  Hence **C**.
- **Read as a sequence, this file cannot deliver it.** If the owner rules that
  §49 means the audit had to precede Phase 2, nothing written now satisfies
  it: the build and the later phases already exist (see the disclaimer). Under
  that reading MD441 is **W**, built but not in the order the spec asked for.
  It stays W permanently, because no later commit can change what happened
  first.

The census records the C grade with this condition attached (census-media §27).

## Findings that hold at this commit — recorded, not fixed

*(Addendum, 2026-09-26, later the same day. F1 and F3 were fixed on the branch after this audit: census-media §28.7 and §28.8. The citations below describe the audited SHA and are left as they were.)*

- **F1. `/media/upload` buffers the whole body before it authenticates, with no
  ceiling.**
  - Every chunk is kept: `artifacts/api-server/src/routes/posts.ts:87#req.on("data", (c: Buffer) => chunks.push(c));`.
  - Only after the stream ends does the handler run `artifacts/api-server/src/routes/posts.ts:92#const auth = await requireUser(req, res);`.
  - The size ceilings in `verifyUploadedBytes` run after that. `express.json`'s
    256 kb limit does not apply to a raw image or video body:
    `artifacts/api-server/src/app.ts:134#app.use(express.json({ limit: "256kb" }));`.
  - So an unauthenticated client can make the server hold an arbitrarily large
    body in memory. Nothing in this tree bounds it; any proxy limit in front of
    the server is outside the tree.
  - The tree already has a bounded collector, which the poster routes use:
    `artifacts/api-server/src/routes/postcardMediaTransport.ts:136#export function collectBody(limitBytes: number) {`.
- **F2. An owner's retry parks the asset in `queued`, and nothing claims queued
  work.**
  - The retry writes `artifacts/api-server/src/services/media/MediaLifecycleService.ts:382#processing_status: "queued",`.
  - Its only non-test caller is `artifacts/api-server/src/routes/mediaActions.ts:213#const result = await retryMediaProcessing(sc, id, auth.user.id);`.
  - These have no non-test caller anywhere in `artifacts/api-server/src`:
    `claimMediaProcessing`, `completeMediaProcessing`, `failMediaProcessing`,
    `recoverStaleMediaProcessing` and `softDeleteMediaAsset`.
  - census-media §20.4 moves MD338 to C partly on "lifecycle
    (MediaLifecycleService)". That row is not re-graded here.
- **F3. The event/trip header mask fails open.** On any read error, the private
  header's real image is served instead of the generic cover:
  `artifacts/api-server/src/routes/mediaFile.ts:44#Fail-OPEN: any DB error`.
- **F4. The eligibility module's rationale points 36 lines above the code it
  names.**
  - The rationale cites `artifacts/api-server/src/lib/mediaEligibility.ts:66#already blocks four of these on`.
  - The set it means is at `artifacts/api-server/src/services/wall/WallCandidateLoaders.ts:1156#const QUICK_MEDIA_BLOCKED_MODERATION`.
- **F5. Seven prose pointers into 0191 in census-media's body rows name the
  wrong line.** They carry no file extension, so no checker reads them.

  | Pointer | Named line | Right line |
  | --- | --- | --- |
  | MD37's `0191:31` | processing status | `artifacts/api-server/src/migrations/0191_media_assets.sql:28#source_type` |
  | MD269's `0191:32-34` | the processing CHECK | `artifacts/api-server/src/migrations/0191_media_assets.sql:29#moderation_status` |
  | MD40's `0191:46-58` | starts one line late | `artifacts/api-server/src/migrations/0191_media_assets.sql:45#CREATE TABLE IF NOT EXISTS media_attachments (` |
  | MD41's `0191:49` | `entity_id` | `artifacts/api-server/src/migrations/0191_media_assets.sql:48#entity_type` |
  | MD42's `0191:51-52` | `is_cover` and the override | `artifacts/api-server/src/migrations/0191_media_assets.sql:50#position` and the next line |
  | MD42's cover-index pointer, 0191 lines 60-61 | one line late | `artifacts/api-server/src/migrations/0191_media_assets.sql:59#media_attachments_cover_idx` |
  | MD43's `0191:53` | `created_at` | `artifacts/api-server/src/migrations/0191_media_assets.sql:52#visibility_override` |

## Earlier findings that do not hold at this commit

This lane's first pass was measured on `main` (`1a861c3a1`) and has been
withdrawn. Two of its findings are false here:
- **"`inherit` denies non-owners."** At this commit, `inherit` returns true
  (`artifacts/api-server/src/lib/mediaVisibility.ts:93#case "inherit":`).
- **"`shared_moment` is decided by trip-crew membership."** At this commit, it
  is decided by Moment membership
  (`artifacts/api-server/src/lib/mediaVisibility.ts:175#async function isSharedMomentAudience(`).
