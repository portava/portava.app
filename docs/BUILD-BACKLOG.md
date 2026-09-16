# Build backlog

Non-blocking defects found while building. Append; do not reorder or delete.
Format: `- [lane] file:line — what is wrong, and what the user sees.`


## telegraph lane — 2026-09-16

- [telegraph] `artifacts/api-server/src/lib/mediaProcessing.ts:62` — `sniffMedia`
  classifies ANY ISO-BMFF `ftyp` box that is not HEIC or QuickTime as
  `video/mp4`, including an audio-only `M4A `/`M4B ` file. Nothing reaches that
  today (the general allowlist admits no audio MIME, so an m4a can only be
  declared as `video/mp4`, and `verifyUploadedBytes` then agrees with the lie
  rather than catching it). The user-visible consequence if it is ever reached:
  an audio file stored as a post/memory/story VIDEO, rendering as a black frame.
  Not fixed here because narrowing `sniffMedia` touches every media surface and
  this lane owns none of them. The fix is now cheap and does not need inventing:
  `isoTrackHandlers` (same file, added for voice) returns every track's handler
  type, so `sniffMedia`'s MP4 branch can answer `image`/`video`/neither from the
  tracks instead of from the `ftyp` brand.
- [telegraph] `artifacts/api-server/src/domain/telegraph/projections/projectionRegistry.ts:119`
  — PRJ-06's note says the content drawer is "dead-coded behind a literal
  false". It is NOT, at HEAD: `travel-buddy-standalone/app/messages/[id].tsx:1964`
  mounts an unconditional `onPress={() => setShowContentDrawer(true)}` on the
  header, and `GET /threads/:id/drawer` serves it. The registry's `status:
  "absent"` and census-telegraph T294's evidence are both stale on that clause.
  NOT changed here: flipping PRJ-06 would move an absent-projection count that
  `scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json:9` pins at 4, which is a
  ratchet the lead owns, and re-grading T294 is a census verdict this lane does
  not move.
- [telegraph] `travel-buddy-standalone/src/features/telegraph/voice/voiceApi.ts`
  — a voice upload that succeeds followed by a send that fails leaves the
  uploaded audio object in `post-media`, unreferenced by any message. This is
  the SAME behaviour the photo/video path has had since it was built
  (`POST /api/media/upload` then `POST /threads/:id/media`), so voice inherits a
  defect rather than introducing one; it is recorded rather than quietly
  matched. A fix needs an orphan sweep keyed on storage path, which no surface
  in this repository has.
- [telegraph] §6.3's "optional transcript/translation" for VOICE is NOT built,
  and the blocker is an owner/infrastructure decision, not code: there is no
  speech-to-text provider configured in or reachable from this tree. A nullable
  `transcript` field was deliberately NOT added to `VoicePayload`
  (`artifacts/api-server/src/services/telegraph/voice.ts`) because nothing would
  ever write it. Consequence today: a voice note is not findable by §6.4's
  object-aware search, and `searchableTextOf` returns null for it — which is
  correct, and is asserted, rather than indexing a URL.
- [telegraph] The VOICE upload endpoint's TRANSPORT has no test —
  `artifacts/api-server/src/routes/telegraphVoice.ts`'s bounded body reader, its
  `guardUploadRequest` call and its storage write. Its POLICY is fully tested in
  `src/test/telegraphVoice.test.ts`. Found by a mutation that survived: bypassing
  the upload route's `if (!guard.ok)` leaves the suite at 38/38.
- [telegraph] `artifacts/api-server/src/routes/telegraphKinds.ts#toDrawerRow` — a
  VOICE row reaches §6.4's VOICE drawer tab and is counted there, but its `title`
  is null, so the drawer draws the literal `voice` as the row's label. The cause
  is that `toDrawerRow` derives the DISPLAY title from `searchableTextOf`, which
  for a voice note is correctly null (no transcript; indexing its URL would make
  a search for "m4a" return conversations). Display text and search text are two
  different questions and one function is answering both. The fix is a display
  title for VOICE — its duration as `m:ss` — taken from `media_duration_seconds`
  rather than from the search predicate. Cosmetic: the tab, the counts and the
  asset all work.
