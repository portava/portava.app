# Finding 14 — the E2EE plaintext guard is bypassed by the media endpoint

**Severity: high. Confidentiality gap in the E2EE design, not a build problem.**
Found 2026-08-08 by reading the DM send paths while scoping the media pipeline.
**Not fixed** — the fix is a product decision. See §4.

---

## 1. The invariant, as built

`POST /api/threads/:threadId/messages` is fail-closed for encrypted threads
(`artifacts/api-server/src/routes/messaging.ts`):

```js
if (isE2ee) {
  // E2EE thread: ciphertext required, body must be absent.
  if (!ciphertext) { sendError(res, 'invalid_payload',
    'E2EE thread requires ciphertext; plaintext body not accepted'); return; }
  body = null; // server NEVER stores plaintext for E2EE messages
}
```

Seven references to `is_e2ee`/`isE2ee` in that handler. This is the invariant
the whole workstream rests on, and on this path it holds.

## 2. The bypass

`POST /api/threads/:threadId/media` — same table, same thread — contains
**zero** references to `is_e2ee`. Its insert:

```js
.insert({
  thread_id: threadId,
  sender_id: user.id,
  body: body ?? '',            // <- plaintext, up to 4000 chars
  msg_type: 'media',
  media_url: mediaUrl,         // <- plaintext app-storage URL
  media_type: mediaTypeRaw,
  media_thumbnail_url: thumbnailUrl,
  media_duration_seconds: durationSeconds,
})
```

`body` is read straight from the request:
`req.body?.body.trim().slice(0, 4000)`.

So on a thread with `is_e2ee = true`:

- **the image or video is stored as a plaintext URL** the server can resolve;
- **the thumbnail is stored as a plaintext URL**;
- **the caption text is stored in `messages.body` in plaintext**, which is the
  exact thing the other endpoint refuses to do.

The text guard is not bypassed by an attacker crafting requests. It is bypassed
by the app's own normal flow.

## 3. The client takes this path by default

`travel-buddy-standalone/app/messages/[id].tsx`, `handleSend()`:

```js
// ── Media send path ──────────────────────────────────────────────
if (mediaPicker.media !== null && id) {
  ...
  const res = await sendMediaMessage(id, {
    mediaUrl: uploadRes.url,
    ...
    body: text || undefined,     // <- the caption goes with it
  });
```

The media branch is taken **before** any encryption handling and has no
`isE2ee` check, even though the screen already holds `isE2ee` in state (fetched
at line ~1272 and used to render the encryption indicator at ~1643).

So: a user on an encrypted thread attaches a photo, types a caption, hits send —
and both the photo and the caption are stored in plaintext, under a thread the
UI is telling them is end-to-end encrypted. That last part is what makes this
high severity rather than merely incomplete: the product asserts a guarantee it
is not providing.

## 4. Why this is not fixed here

Two viable fixes, and choosing between them is a product decision:

**Option A — fail closed. Reject media on E2EE threads.**
Add the `is_e2ee` check to the media endpoint and return the same error shape as
the text path; hide or disable the attachment control when `isE2ee`.
- Consistent with the design's stated posture, and small.
- **Removes a working feature** from encrypted threads. Users who can send
  photos in a DM today would stop being able to once that thread is encrypted.

**Option B — encrypt attachments.**
Encrypt the media bytes client-side under a per-message key, upload the
ciphertext blob, put the key in the encrypted payload, decrypt on fetch.
- Preserves the feature and is what the guarantee implies.
- Substantially more work: a new upload path, key handling, client-side
  decrypt-then-render, thumbnail generation moved client-side, and a cache
  story. It also permanently forecloses server-side transcoding for DM media
  (see `docs/media/4k-pipeline-scoping.md`).

**Interim mitigation, if neither lands soon:** stop claiming encryption on
threads where it does not hold — the verification UI is already gated off
behind `E2EE_VERIFICATION_UI_ENABLED`, and the same reasoning applies to the
encryption indicator while this bypass exists.

I did not pick one. Option A is a user-visible feature removal and Option B is
a design programme; neither is mine to choose, and the owner's standing
instruction is to stop crypto-layer work rather than fix forward while the FFI
question is unresolved.

## 5. How this was missed

The same shape as the other thirteen. The send path was made fail-closed, tests
were written for it, and the guard was verified — on **one** of the two
endpoints that write to `messages`. Nothing enumerated the writers of that
table. `msg_type: 'media'` was simply never in scope when "the send path" was
hardened.

A cheap durable guard: a test that enumerates every insert into `messages` and
asserts each one either sets `body: null` or is unreachable when
`is_e2ee = true`. That is the media-feed `getSession.bypassGuard` pattern
applied to encryption, and it would have caught this before the endpoint
existed.

## 6. Verification

- Guard reference counts: text handler 7, media handler 0 (`grep -c` over the
  respective line ranges).
- Insert field list read directly from the handler.
- Client call site read directly; the media branch has no `isE2ee` condition.
- `messages` has both `ciphertext` and `media_url`/`media_type`/
  `media_thumbnail_url`/`media_duration_seconds` columns.

Not verified: whether any production thread currently has `is_e2ee = true`.
E2EE has never run on a device, so the practical exposure today is probably
nil — but the code path is live and would take effect the moment it does.
