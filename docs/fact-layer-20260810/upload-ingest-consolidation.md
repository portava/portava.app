# Upload Ingest Consolidation — design brief

**P0 goal, as stated by the owner:** *every upload should pass through one canonical
ingest path — sniff, decode, re-encode, strip metadata, validate, store. Never
extension → public bucket.*

**Status:** design is PROPOSAL only. Nothing here has been implemented, and no option
below has been chosen.

---

## 0. How to read this document

**This brief states no fact in its own words.** `00_VERIFIED_STATE.md` is the single
fact layer; everything factual here is a pointer to a numbered entry in it, written
**VERIFIED_STATE §N**. The wording, the provenance tag and the `file:line` anchors all
live there.

That is not a stylistic preference. The previous attempt at this document set was
quarantined because three documents restated the same facts and the three restatements
diverged. A pointer cannot diverge from its target.

Rules that follow from it:

- **A factual sentence here with no §N pointer is a defect.** Report it rather than
  believing it.
- **If this brief needs a fact that is not in VERIFIED_STATE, the fact goes there
  first** and this brief cites it. Several sections below exist only because that was
  done: §7.5–§7.23, §8.5–§8.8 and §9.13–§9.19 of the fact layer were written for this
  brief.
- **Design statements are prefixed PROPOSAL** and are this document's own. They are
  free to be wrong; they are not free to smuggle in facts.
- **Open questions are stated as questions**, with what each answer would change.

Everything in the fact layer is anchored at clone commit `13dcfe3`. The live repo is
far ahead. Re-resolve anchors by grepping the quoted text before implementing.

---

## 1. Current state: the ingest census

Read the fact layer for the detail; this is the index.

| What | Fact of record |
|---|---|
| The four processing primitives that already exist, and that the metadata strip is a side effect of re-encoding rather than an explicit call | **VERIFIED_STATE §7.5**, §7.1 |
| Which route modules import them — the map of what is covered | **§7.6** |
| Videos are not transcoded in this tier | **§7.7** |
| The eight entry points where bytes reach storage | **§7.8** |
| Bytes enter by exactly three mechanisms; no multipart handler exists | **§7.9** |
| The raw-body collectors buffer the whole body in memory | **§7.10** |
| A second class of entry point — URL *references* rather than bytes — and that its validator checks bucket and origin but not ownership | **§7.19** |
| Which buckets are public | **§8.1** |
| Where `disable_media_uploads` is and is not checked | **§7.21** |

> **PROPOSAL note.** A canonical ingest path is worth little if a URL-reference endpoint
> can attach an object that never went through it (§7.19). Any design must state what a
> reference endpoint is allowed to point at. See §5.3.

---

## 2. The three claimed bypasses

I was asked to verify these rather than accept them. All three are real, and the fact
layer carries the verified description of each. **Two of the three needed correcting
against the description in the handoff**, and both corrections are recorded in the fact
layer rather than here.

| Bypass | Fact of record | Correction to the handoff description |
|---|---|---|
| **1 — `posts.ts` HEIC fallback** | **VERIFIED_STATE §7.2b** | Confirmed as described, plus **§7.11**: the branch is reachable by choosing twelve bytes, so it is an attack shape and not only an accident. **§7.12** records that the server reports `processed: false` to the client and stores the object anyway. |
| **2 — `stampCatalog.ts` admin base64 → public bucket** | **VERIFIED_STATE §7.2c** | Confirmed. **The declared 5 MB cap is unreachable**; the real ceiling is ~190 KB of image bytes, because a global body-parser limit is installed before the router. The correction is recorded in §7.2c itself, so a reader citing the fact layer gets the corrected number. |
| **3 — `postcards.ts` signed upload** | **VERIFIED_STATE §7.2a**, sequence at **§7.13** | Confirmed, plus two findings the handoff did not mention: **§7.17** (`thumbnailPath` is client-supplied and unscoped, latent because no shipped client sends it) and **§7.18** (stored `mime_type`, object `contentType` and path extension can all disagree). |

Bypass 2 is literally the shape the P0 forbids — extension → public bucket, extension
taken from an unverified client string, bytes never inspected (§7.2c).

One unproven aside on bypass 2, kept because it changes how the endpoint fails:
`Buffer.from(str, "base64")` is lenient and discards non-base64 characters rather than
throwing, so a malformed payload produces *some* buffer which is then stored.
**[UNVERIFIED]** — standard Node behaviour, not executed here, and not in the fact
layer for that reason. It does not change any recommendation below.

---

## 3. The hard part: the signed-upload window

Everything in bypass 1 and bypass 2 is a small, local fix. This is not.

### 3.1 The window

The sequence, with anchors for `t0`/`t1`/`t2`, is **VERIFIED_STATE §7.13**. Between
`t1` and `t2` an un-stripped original sits in `post-media`.

### 3.2 Why "it's only a few seconds" is the wrong frame

Three facts, taken together, are the argument:

1. **`t2` is bounded by whether the client finishes, not by latency.** On a failed
   completion the canonical composer sets an error, returns to the picker, and returns
   — no cleanup, no retry, no delete. **VERIFIED_STATE §7.14.** The same follows from an
   app kill, a lost network, or a backgrounded app after the PUT.
2. **Nothing on the server sweeps storage objects by media state.**
   **VERIFIED_STATE §7.15**, which enumerates every storage-remove call site and what
   triggers each. ⚠ Note §7.2a's own **CORRECTION** block: an earlier revision supported
   this conclusion with a grep result that is false. The conclusion survives; the
   evidence for it is §7.15 and nothing else. Do not cite the retracted grep.
3. **The failure mode is invisible to the one tool built to find lost media.**
   **VERIFIED_STATE §7.16**: an abandoned pre-completion object is neither a dangling
   row nor an unreferenced orphan, so neither of `checkMediaObjects.ts`'s two
   reconciliations sees it. That, more than the window's duration, is why this is the
   hard part.

The related, already-measured failure — 116 rows reading `ready` while 114 pointed at
objects that do not exist — is **VERIFIED_STATE §7.4**. It is a *different* failure on
the same blind spot, and the fact layer keeps them separate deliberately.

### 3.3 What is known to sit in the window

The EXIF/GPS census is **VERIFIED_STATE §7.3**: 293 image objects, 9 with EXIF, zero
with GPS.

Read that carefully, and note what §7.3's own ⚠ says about not conflating it with §7.4.
The census says the *current corpus* is clean of GPS. It does not say the window is
harmless — it says the window has not been observed to leak GPS in that corpus. Whether
the census covered rows in a non-`ready` processing state is **[UNVERIFIED]** and is
U3 below. **Nothing in this brief claims the window has leaked GPS.**

---

## 4. Open question: `post_media_storage_public_read`

**This is an open question, not a finding, and it is the one that decides how severe §3
is. It is two questions, and the second is moot until the first is answered.**
The canonical statement is **VERIFIED_STATE §10.4, first item**; U4a/U4b below are the
same split, carried into this brief's numbering.

### The facts it rests on

| What | Fact of record |
|---|---|
| `0103` declares a `SELECT TO public` policy over the whole `post-media` bucket, with no path or owner predicate | **VERIFIED_STATE §8.4** |
| A migration file is not evidence of application in either direction | **§2.2** |
| Production has seven `storage.objects` policies; `0103` declares three; the other four are declared by no migration, and their names were not reported | **§8.3** |
| Whether *this* policy is among the seven live | **§8.4** — **[UNVERIFIED]** |
| `post-media` is `public=false` | **§8.1** |
| The declared intent of `0103`'s policy block | **§8.5** |
| Storage paths are guessable by construction | **§8.6** |
| `mediaAccess.ts` is the only place blocks, visibility and moderation gate a read | **§8.7** |

### The two questions

**U4a — is the policy live at all?** Everything below is conditional on this, and §8.4
says it is unverified. A probe designed for U4b that runs without answering U4a may be
probing a policy that does not exist, and would return "no access" for the wrong
reason.

**U4b — if it is live, what does `SELECT TO public` on `storage.objects` grant when the
bucket has `public = false`?** I cannot answer this from the clone and will not guess.
Two candidate readings, two very different worlds:

- **Reading 1 — the bucket flag is the outer gate.** `public=false` makes Storage refuse
  unauthenticated `/object/public/...` requests before RLS is consulted, so the policy is
  inert for anonymous callers and only ever mattered for authenticated direct-API access.
  Under this reading §3's window is a **privacy** problem — an un-stripped original
  exists — but not an **exposure** problem.
- **Reading 2 — RLS is the gate that matters** for `/object/authenticated/...`, or for
  any caller holding an anon key. Then any authenticated caller, and possibly anon, can
  read any object in `post-media` by path, bypassing §8.7 entirely.

### Why the question is sharper than it looks

Under Reading 2 the paths are guessable by construction rather than random (§8.6), and
one of the two shapes carries roughly millisecond entropy scoped to a known user id.

**CORRECTED 2026-08-10 — the moderation gate does NOT contain a pending object.**
An earlier draft of this paragraph asserted that an object with `moderation_status:
'pending'` would be refused by the access gate. That is false, and the correction
strengthens the case for a staging boundary rather than weakening it.

Verified directly in the clone this session `[CLONE 13dcfe3]`:

- `lib/mediaAccess.ts:220-224` refuses **only** `moderation_status === "rejected"` or
  `=== "flagged"`. `'pending'` is not a refusal ground; it falls through to the
  parent-post check.
- `lib/mediaAccess.ts:87-95` (`postVisible`) denies only when `post.status !== "active"`,
  when `post.post_status` is set and `!== "published"`, or when visibility is private.
  A null `post_status` short-circuits that clause entirely.
- `routes/postcards.ts:274` creates the parent post with `status: 'active'`.

So an object attached to an active, public parent is served through the AUTHORIZED path
regardless of its moderation state. Moderation status is not a containment boundary, and
neither is the bucket's public flag on its own. **The only mechanism that keeps an
un-processed original out of reach is not putting it in the durable namespace in the
first place** — the staging boundary this brief proposes. This correction is the
strongest single argument for it.

### A related, separate question

`ensureStorageBucket` creates buckets with `public: true` and runs on every avatar and
cover upload — **VERIFIED_STATE §7.20**. It is a no-op today because the bucket exists.
In any fresh project — a new CI project, a restore, a DR environment — the first avatar
upload creates `profile-media` **public**. That is a latent, environment-dependent
privacy inversion, and **PROPOSAL:** it is worth fixing in the same pass even though it
is not strictly an ingest concern.

---

## 5. PROPOSAL — the design

Everything from here is proposal. Nothing has been decided.

### 5.1 PROPOSAL: the canonical ingest contract

**PROPOSAL.** Define one module — call it `lib/mediaIngest.ts` — exposing a single
function every entry point must call, and make "did these bytes go through `ingest()`?"
a mechanically checkable property rather than a convention.

**PROPOSAL.** The contract, in order:

1. **Sniff the bytes.** The primitive exists (§7.5). The declared `Content-Type` /
   `mimeType` becomes an input to *nothing* except an early cheap reject; the sniff
   result is the only thing that may determine extension, stored `mime_type`, or
   `contentType`.
2. **Reject on sniff failure.** No format gets a fallback that stores raw bytes. This
   deletes bypass 1 (§7.2b, §7.11).
3. **Decode and re-encode.** Where a decode genuinely cannot be done, the correct
   outcome is **reject with an actionable error**, not store-raw. See the HEIC decision.
4. **Validate post-decode:** dimensions, size, and — PROPOSAL — an explicit metadata
   assertion rather than reliance on a library default (see U1).
5. **Store** at a path whose extension is derived from the **sniffed** format, with
   `contentType` from the same source, returning a single record that is the only thing
   callers may persist — so the three-way divergence at §7.18 becomes unrepresentable.

**PROPOSAL.** The function returns a branded/opaque `IngestedObject`, and the
storage-write helper accepts *only* that type. Then "upload without ingest" is a
typecheck error rather than a code-review question. This mirrors a pattern the repo
already uses for a different invariant (**§7.22**).

**Cost:** low for A/B/C — they already hold the bytes; this is a refactor plus the type.
High for D — that is §5.2. Non-trivial for E specifically, because its real capacity is
~190 KB (§7.2c), so fixing it properly means changing how admins upload at all (raw body
like A/B/C, or a signed URL like D). That is a second decision, not a detail.

**PROPOSAL — the HEIC decision, which the owner should make explicitly.** Removing the
fallback (§7.2b) rejects HEIC uploads outright wherever the image library lacks HEIF
support. Three options, none free:

| Option | What it costs |
|---|---|
| Reject HEIC when undecodable | Some iOS users cannot post. Honest, immediate, visible. The in-code comment at the fallback suggests the blast radius may be near zero (§7.11 quotes its rationale), but that comment is an assertion, not a measurement — see U2. |
| Guarantee HEIF in the deployment image | Makes the fallback dead code and lets it be deleted. Costs a build/deploy change plus a startup assertion, so a silent regression cannot reintroduce the hole. |
| Client-side transcode before upload | Moves work to the app, needs a client release, and leaves old clients on the old path — so the server-side reject is still required. |

Both inputs to that decision are unmeasured (U2), and both change the answer.

### 5.2 PROPOSAL: the signed-upload path — three options, evaluated

The requirement: **no un-ingested object may exist at a path anything else can read, at
any time, including forever.**

---

#### Option A — Ingest through the server; retire the signed-upload path

**PROPOSAL.** Postcard media uploads become a raw-body POST to the API server, exactly
like entry point A (§7.8), and the object is written only after ingest.

**What it buys.** The window ceases to exist — not shortened, *removed*. One code path
for all user media. The class of bug disappears rather than being monitored.

**What it costs.**

- **The server becomes the data plane for every byte of user media, including video.**
  And the existing raw-body collectors buffer the entire body in memory before the
  handler runs (**§7.10**) — which is worth noticing on its own, because it is already
  true of entry point A today.
- **Loss of byte-level upload progress and resumability.** The canonical client gets
  progress from XHR against the signed URL (**§7.23**). Reproducing that through the API
  server is possible but is new work on both sides.
- Client release required. Old clients keep using the signed-upload endpoint until they
  update, so the old path cannot be deleted the day it is replaced.
- Video still is not transcoded (**§7.7**), so for video this buys sniff-and-cap only,
  at full bandwidth cost.

**Verdict, PROPOSAL:** the only option that actually satisfies the stated P0 for images.
Its cost is real and concentrated in video.

---

#### Option B — Quarantine: the signed upload targets a staging bucket

**PROPOSAL.** Mint the signed URL against a separate bucket (e.g. `media-staging`) that
no read policy covers and no relay accepts. `complete` downloads from staging, ingests,
writes the result to `post-media`, deletes the staging object.

**What it buys.**

- Keeps direct-to-storage upload: progress, resumability, and server bandwidth all
  unchanged.
- The un-ingested object still exists, but somewhere nothing can read — so the window
  becomes a storage-lifecycle problem rather than an exposure problem.
- Fits the existing architecture: the relay and both reference validators hard-code the
  same two buckets (**§8.8**), so a new bucket is *already* unreachable through them —
  **provided nobody adds it to those three sets.**

**What it costs.**

- **Its entire value rests on §4, and specifically on U4a before U4b.** If Reading 2
  holds, the four production policies that no migration declares (§8.3) are the thing to
  worry about, and a new bucket is safe only if we can state positively that no policy
  covers it. Creating a bucket does not create a policy, so a bucket with no policy
  *should* be unreadable — but "should be" is precisely the reasoning that produced the
  policy in §8.4. **Do not adopt Option B before §4 is answered.**
- Doubles the storage write and adds a download-plus-upload round trip inside `complete`,
  already the slowest step (§7.13).
- **Does not solve abandonment.** An abandoned upload leaves a staging object forever.
  A *safer* forever — but Option B without Option C is a slow leak.
- Deploy sequencing: the bucket must exist before the first client uses it, and in-flight
  uploads at deploy time straddle two buckets.

**Verdict, PROPOSAL:** cheapest option that changes the security shape, contingent on
§4, and incomplete without Option C.

---

#### Option C — Sweeper for orphaned pre-completion objects

**PROPOSAL.** A scheduled job that finds `post_media` rows still in a pending processing
state past a TTL and deletes both the object and the row.

**What it buys.**

- Bounds the *forever* case, which is what makes §3 severe.
- Cheap to build: the scheduler shape is well-worn in this tree, with five existing
  `*Sweeper` jobs to copy (§7.15 names where the scheduler list lives).
- Unlike a storage-listing sweep, it can run **entirely off `post_media`** — the pending
  row is inserted *before* the signed URL is issued (**§7.13**), so every pre-completion
  object has a row pointing at it. No bucket enumeration needed.

**What it costs.**

- **It does not shrink the window; it caps it.** Between `t1` and the TTL the object is
  exactly as exposed as today. If §4 resolves to Reading 2, a TTL of hours is not a fix.
- **The TTL is a correctness parameter with a race in it.** Too short and it deletes an
  object a slow client is about to complete — and completion then fails with the
  image-could-not-be-processed error (§7.13's `t2` path), which is the *wrong* error for
  "we deleted your file". Too long and the exposure persists. Needs U7.
- **It must not become the thing that hides the problem.** A sweeper driven off the
  processing-status column inherits exactly the blindness §7.16 describes: it will
  happily delete a row whose object it never confirmed, and report success.
  **PROPOSAL: delete the object first, then the row, and count the two outcomes
  separately** — otherwise it manufactures the orphan class it exists to remove.

**Verdict, PROPOSAL:** necessary regardless of which of A or B is chosen, because
abandonment is a client behaviour (§7.14) and no server-side ingest design eliminates
it. Not sufficient alone.

---

#### PROPOSAL: recommended combination

**PROPOSAL, contingent on §4 being answered first:**

- **Answer §4 before anything else** — U4a, then U4b. It re-orders everything below.
- **B + C as the near-term change.** Preserves the client upload experience, removes the
  exposure if §4 permits, and bounds the forever case.
- **A as the direction of travel for images**, taken when a client release is scheduled
  anyway. Images are small; the bandwidth objection is almost entirely a video objection.
- **Keep the in-place re-encode at completion** regardless — it is already written,
  already fail-closed for images (§7.13), and costs nothing to keep.

**PROPOSAL, and this is the part most likely to be skipped:** whichever combination is
chosen, extend `checkMediaObjects.ts` with a third reconciliation — *pending rows older
than the TTL* — so the failure mode that is currently invisible to both halves (§7.16)
becomes visible to one. A design that closes the window but leaves the blind spot fails
the same way next time.

### 5.3 PROPOSAL: the reference endpoints

**PROPOSAL.** Since the reference validator checks bucket and origin but not ownership
(**§7.19**), and since after this work every legitimate object will have a row,
reference endpoints should require that the referenced path **resolves to a row owned by
the caller and in a completed state**. That is strictly stronger than a path-prefix
check and does not depend on the path convention staying stable — which matters given
§8.6.

**Cost:** one extra query per reference-attach, on endpoints that already do several.
Also requires deciding what happens to historical references that predate the rows: the
reference refinement explicitly accepts three legacy shapes "during migration" (§7.19),
so a strict check rejects real existing data unless it is grandfathered.

**SCOPE OF THE LEGACY POPULATION — MEASURED 2026-08-10, AND IT IS SMALL.**
This document was written assuming the historical corpus was an open-ended
migration of unknown size. **It is not, and that assumption was never listed as
an unknown — no U-item covers it, so it went unexamined rather than tracked.**

`VERIFIED_STATE §7.24` **[DB 2026-08-10 · production `ajrurzioarfkagpuxfnb`]**:
across `events.cover_url`, `trips.cover_url`, `post_media.public_url`,
`post_media.feed_url` and `unnest(posts.media_urls)`, **six** rows in total hold
an absolute public storage URL. (The per-column split is not yet recorded; only
the total is citable — see the ⚠ in §7.24.)

The work is therefore **known and bounded**, and it is not where this document
implied:

1. **Two writers** — `lib/visuals/service.ts:429`, which writes `getPublicUrl()`
   output into `events`/`trips.cover_url`, and the client `memories.ts` /
   `stories.ts` uploaders. These are the only things still minting the shape.
2. **A six-row backfill.** A one-off `UPDATE`, not a programme. It needs no
   staged rollout, no rate limiting and no failure accounting, which is what an
   open-ended legacy migration would have needed.
3. **Three routes that do not hydrate — THIS IS THE ACTUAL WORK.**
   `routes/og.ts` (unauthenticated, emits `cover_url` verbatim as `og:image` to
   link-preview scrapers), `routes/featured.ts` (unauthenticated) and
   `routes/placeLiving.ts` (unauthenticated). None calls
   `POST /api/media/sign`, so none benefits from the client hydrator that
   rescues every authenticated surface.

**Six rows is a one-off UPDATE; a route that does not hydrate keeps producing
the dependency.** Fixing the rows without fixing the three routes leaves the
class intact — the next row that acquires the shape is served raw to an
anonymous caller, and the surfaces that do it are precisely the ones with no
logged-in user to notice. Order the work routes-first; the backfill is a
footnote to it.

---

## 6. Adjacent facts that constrain the implementation

Each of these has bitten an implementation before. All are pointers; none is restated.

- **The `disable_media_uploads` kill switch covers A, B, C and D, and not E** —
  **VERIFIED_STATE §7.21**. **PROPOSAL:** whatever ingest path E moves to should inherit
  the switch.
- **In the clone that switch fails in the disengaging direction on a DB error** —
  **§6.7**. It was reported converted in the live tree; **§6.8** carries that report,
  its tag, and what must be re-read to confirm it. **Re-verify before writing anything
  that depends on the failure direction.**
- **Flag loaders differ in what they can read** — **§6.2**, **§6.4**, **§6.5**. If
  ingest is to be rolled out progressively, the loader that can read `metadata` (§6.4,
  row 2) is the one that can express it; the plain boolean reader cannot. The column
  itself is §3.1/§3.4.
- **Migrations are not replayable and there is no runner** — **§2.1**, consequence at
  **§2.2**, live drift at **§2.7**. **PROPOSAL:** any storage-policy change in this work
  must be treated as a hand-applied production change with its own verification, not as
  "add a migration file".
- **`0103`'s policy block assumes declaration equals existence**, the same assumption
  that misfired at §2.9. Production has seven storage policies where `0103` declares
  three (**§8.3**). **PROPOSAL: enumerate the live seven before adding or removing any
  policy.** Changing a policy set you have not read is how the four undeclared ones came
  to exist.
- **CI credential scope — do not build on this.** Both live probes this brief asks for
  (§4, and the U-items below) must run through the read-only production front door
  (**§9.4**) rather than an ad-hoc script. That is the operative constraint and it is
  settled. What is **not** settled is whether `SUPABASE_PROJECT_TOKEN` is
  project-scoped: **§9.9** records the divergence, both readings, and the fact that the
  tree documents a project-scoped token as preferred (**§9.17**, **§9.18**). §9.9 states
  that no claim about credential scoping may be cited until it is resolved, so **this
  brief makes none**, and nothing in §4, §5 or §7 depends on the answer.

---

## 7. What must be established before implementation

The governing rule is that no P1 architecture work may use an unverified factual claim
as a prerequisite. These are the unverified claims this brief depends on. Each is cheap
to resolve, and each changes a design decision.

| # | Claim | Why it matters | How to settle it |
|---|---|---|---|
| **U1** | Whether the installed image library strips **all** EXIF/XMP/ICC — including GPS — on re-encode. Asserted only in a comment; there is no explicit strip call and no assertion (**§7.5**). | The entire privacy claim of the ingest path rests on a library default. If it is wrong, or changes on upgrade, every "stripped" object is not. | Add a test that re-encodes a fixture with known GPS EXIF and asserts none survives — so the guarantee is **enforced**, not documented. |
| **U2** | Whether the deployed image library has HEIF support, and what share of uploads declare HEIC. | Decides which of the three HEIC options in §5.1 is viable, and the size of the user-facing regression. | Probe the deploy image; count stored `mime_type` by value. |
| **U3** | Whether the census at **§7.3** covered rows in a non-`ready` processing state, and the current count and age distribution of such rows. | Sizes both the live exposure and the sweeper TTL in Option C. | Re-run the census scoped to non-`ready` rows, with age buckets. |
| **U4a** | **Is `post_media_storage_public_read` live at all?** **§8.4** verifies only that `0103` declares it; **§2.2** is that declaration is not evidence. | U4b is meaningless until this is answered, and a probe run without it can return "no access" for the wrong reason. | Enumerate `pg_policies` for `storage.objects` in production, read-only, through §9.4. Settles U5 in the same query. |
| **U4b** | **If live — what does `SELECT TO public` grant when the bucket is `public=false`?** | Decides whether §3 is a privacy problem or an exposure problem, and whether Option B buys isolation or theatre. **Highest priority after U4a.** | Live probe: anonymous and authenticated direct reads of a known `post-media` path, with and without the relay. |
| **U5** | The names of the seven live storage policies, including the four no migration declares (**§8.3**). | Any policy change made without reading them repeats the mistake that created them. | Same query as U4a. |
| **U6** | The orphan-object count, which the check computes and deliberately does not fail on (**§7.16**). | Establishes the current size of the leak Option C would bound. | Run the media-objects check through the read-only front door and record the number. |
| **U7** | The production `t1`→`t2` latency distribution (**§7.13** for what those are). | The sweeper TTL is a correctness parameter with a race; picking it without this is guessing. | Derive from row timestamps on completed rows. |
| **U8** | Whether signed upload URLs are path-scoped, and their TTL. Strongly implied by the call shape (**§7.8**, row D) but the SDK source was not readable from the clone. | If the URL is not path-scoped, the window is not the only problem on that path. | Read the installed SDK, or its docs for the pinned version. |
| **U9** | ~~Whether the emergency-stop conversion reported in the live tree changed the failure direction of `disable_media_uploads` (**§6.8**).~~ **ANSWERED 2026-08-10 — §6.8 is now SETTLED [LIVE c89f09a77]: it did. All six `disable_media_uploads` sites now read through `isKillSwitchEngaged`, which ENGAGES on a query error and does NOT engage on a missing row.** | Determines whether the kill switch actually stops uploads when the DB is unhealthy. | Re-read the flag reader and the four call sites at the live commit, as §6.8 instructs. |

**PROPOSAL:** answer **U4a then U4b** first and alone. They are the only items whose
answers re-order the rest of the plan, and one read-only query answers U4a and U5
together.

Two of these are owner decisions rather than lookups: **which HEIC option** (§5.1) is a
deliberate user-facing tradeoff, not a bug fix; and **whether to adopt B+C now or wait
and do A** is choosing a mitigation over the stated goal, which should be chosen
knowingly.

---

## 8. Summary of what is defective today

Pointers only. Every item is verified at its anchor in the fact layer; nothing here is
restated, and nothing here is new.

1. **HEIC decode failure stores raw client bytes**, reachable by choosing a twelve-byte
   header — **§7.2b**, **§7.11**, **§7.12**.
2. **Admin base64 image stored with no sniff and no re-encode**, extension from a
   client-declared MIME, into the public bucket — **§7.2c**, **§8.1**. This is the exact
   "extension → public bucket" the P0 names.
3. **That endpoint's declared 5 MB limit is unreachable**; the real ceiling is ~190 KB —
   **§7.2c** (⚠ block).
4. **The signed-upload window**: an un-stripped original exists between PUT and
   completion — **§7.13** — and completion may never come, with nothing on the
   server removing it and nothing able to see it: **§7.14**, **§7.15**, **§7.16**.
   ⚠ Per §7.2a and §10.4, **"permanently" is not established**; how long such an
   object actually survives needs U6.
5. **`thumbnailPath` is client-supplied, unscoped and never sniffed** — **§7.17**.
   Latent: no shipped client sends it.
6. **Stored `mime_type`, object `contentType` and path extension can all disagree** —
   **§7.18**.
7. **`ensureStorageBucket` would create `profile-media` as public** in any environment
   where it does not already exist — **§7.20**.
8. **Reference endpoints validate bucket and origin but not ownership**, while the
   module header implies otherwise — **§7.19**.
9. **The `disable_media_uploads` emergency stop disengages on DB error** in the clone —
   **§6.7**; reported converted at **§6.8**, re-verify.
10. **Entry point E checks no kill switch at all** — **§7.21**.
11. **OPEN QUESTION, not a defect.** The `SELECT TO public` policy over `post-media`
    (**§8.4**) — *whether it is live* is unverified (U4a), and *what it would grant if
    live* is unverified (U4b). It governs how severe item 4 is. **§10.4** of the fact
    layer is the canonical statement. Listing it here is not a claim that either half
    is established.
