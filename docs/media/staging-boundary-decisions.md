# Upload staging boundary — decisions of record

Source packet: artifact "Upload Staging Boundary" (Unit 3, 2026-08-12), design
only. This file records the rulings so they survive a workspace restart. It
changes no behaviour.

The invariant the boundary serves, verbatim from the packet:

> No client-controlled or abandoned upload can leave a permanently retrievable
> original that bypasses the canonical processing/privacy pipeline.

## Rulings

| # | Decision | Ruling | Ruled by |
|---|----------|--------|----------|
| D1 | Separate bucket vs reserved prefix | **A — separate bucket `media-staging`** | Was forced by the `post_media` read-policy hold. **That hold ended 2026-08-14 (see below); the ruling stands but is no longer forced.** |
| D2 | Postcard upload path | **A — signed upload URL into staging, then server-side promote** | User, 2026-08-12 |
| D3 | How the durable namespace is made unwritable | **A — drop the two `memories/stories` policies, leave the owner policies** | Packet's closable-today subset; 3B still needs the delete-path trace. |
| D5 | The 28 existing orphans | **B — quarantine first, sweep after a defined window** | User, 2026-08-12 |
| D6a | HEIC store-raw fallback (V4) | **Add the decoder** | User, 2026-08-12 |
| D6b | Video (V5) | **Promotion strips container metadata without a full transcode** | User, 2026-08-12 |
| D7 | The six `absolute_storage_PUBLIC` rows | Procedural: Unit A's rewrite lands before boundary work | Packet |

### What D2=A implies

The client keeps its XHR PUT and its progress bar; only the destination
changes, from `post-media` to `media-staging`. A `complete` call triggers
promotion. The costs the packet attaches to this choice are accepted:

- The server reads the object back to process it — a download / process /
  upload round trip per item, on the API tier, with the memory profile of the
  raw-body collectors.
- Staging receives **raw client bytes**. The boundary therefore depends on the
  sweeper actually running, which makes step 04 (wire the sweeper) load-bearing
  rather than hygienic.

### What D5=B implies

Quarantine needs a window length, and the packet notes the `content_stamps`
retention question is already held open pending an explicit restore window.
One window defined once should cover both. `content_stamps` retention is on the
hold list and is not touched here; the point is only that the window should be
chosen with both in view.

### What D6a and D6b imply

- **D6a — add the decoder.** A build/deploy change. The store-raw fallback stops
  being reachable rather than being handled; the `processed: false` path should
  become unreachable, not merely reported.
- **D6b — strip on promote.** Video is in scope for the boundary. Promotion
  strips container metadata without a full transcode. No transcode tier is
  required by this ruling.

## Held — do not touch

- ~~`post_media_storage_public_read` (the read policy).~~ **No longer held — the
  policy was REVOKED in production on 2026-08-14** by
  `artifacts/api-server/src/migrations/2089_revoke_post_media_public_read.sql:101`
  (evidence: `docs/media/post-media-public-read-revocation-evidence.md`). The
  sentence that followed still holds and is why nothing here changes: the
  boundary was designed to hold whether or not the policy changed, and it does.
  See the note under D1 — the ruling is unchanged, only its justification moved.
- `content_stamps` retention.

## Sequence (packet section 06)

01. Close the armed `memories/stories` INSERT grant (D3A) — **own PR, nothing else in it.**
02. Bucket-walking orphan census, reporting only.
03. Create staging; make promotion the only writer (D1, D2).
04. Wire the sweeper.
05. Give `/api/media/upload` a lifecycle record (fixes V1, the largest violation).
06. Quarantine the existing 28 (D5).
07. Delete the frozen violators under `artifacts/travel-buddy/`. — DONE 2026-08-14: satisfied wholesale by archiving the tree (`bc1bef404`), not by individual edits.

## Note added 2026-08-14 — the D1 premise is un-forced

`post_media_storage_public_read` was revoked in production on 2026-08-14
(`2089_revoke_post_media_public_read.sql:101`). D1 was recorded as **forced**:
option B required editing a held policy, so it "is not available". That
constraint no longer exists, and B is now available.

**The ruling is unchanged.** D1 stays **A — separate bucket `media-staging`**
until the owner revisits it. This note records only that A is now a *choice*
rather than a *consequence*, so that anyone re-reading the table does not treat
a lapsed constraint as a live one. Nothing in the sequence below changes, and no
step is reopened by this note.

Every red-proof asserts an **absence** — no durable object, no row, no EXIF.
Absence tests pass vacuously when the thing under test never ran. So each red-
proof pairs with a **positive control in the same file**: the promoted case
producing exactly the object and row expected.

## Step 01 gate

Step 01 does not land until, against live production:

- objects under `memories/` and `stories/` prefixes in `post-media` = 0
  (packet measured 0);
- the exact live definitions of `post_media_storage_memories_stories_insert`
  and `post_media_memories_stories_delete` are captured verbatim, so the
  migration's rollback is a proven re-CREATE rather than a reconstruction;
- no shipping caller remains (repo-side; see the repo evidence section of the
  Step 01 PR).
