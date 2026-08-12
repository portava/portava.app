# ERRATA — known defects in these three documents

**Read this before citing anything.** These documents were built, verified adversarially,
repaired, and verified again. Two rounds of verification each found real defects; the second
round found fewer. **They are useful working documents, not a settled record**, and the
remaining defects below are listed so you can route around them rather than discover them.

The one BLOCKING defect from round 2 has been fixed by hand and re-verified against the code —
see `upload-ingest-consolidation.md` §4, marked CORRECTED 2026-08-10. Everything else below
stands.

## What went wrong twice, so you can weigh the rest

Round 1: 5 blocking, 10 untagged claims, 15 citation errors, 7 contradictions.
Round 2: 1 blocking (now fixed), 9 untagged, 6 citation errors, 8 restatements.

The recurring failure is **restatement**: a fact written in two documents diverges in two
documents. `00_VERIFIED_STATE.md` exists so a fact is written once and cited by section. Where
the briefs restate instead of cite, they are listed below and the fact layer is authoritative.

## THE CLAIM YOU SHOULD TRUST LEAST

**"Supabase Management API tokens cannot be project-scoped."** I told the owner this as fact
and used it to justify why the allowlist guard checks the target. **The repo contradicts it** —
`docs/eas-runbook.md:314` describes `SUPABASE_PROJECT_TOKEN` as "Project-scoped, read-only …
Preferred" with a UI path at `:319-325`, and `docs/ci/README.md:882` says the same.

`00_VERIFIED_STATE.md` §9.9 marks this `[UNVERIFIED]` and forbids citing any credential-scoping
claim until it is settled. It cannot be settled by reading code — it needs an actual token
inspected and tested against a second project.

The guard remains worth having either way: `SUPABASE_URL` selects which project a process
contacts, and something must check it. But the *justification* I gave was built on an unverified
vendor claim.

---

## Remaining defects, round 2

### 2. [major] `00_VERIFIED_STATE.md:999-1000 (§8.4 heading)`

The bolded heading states that the policy GRANTS SELECT TO public across the bucket. The entry's last line (:1011) says whether it is among the seven live policies is [UNVERIFIED], and §2.2 is that declaration is not evidence in either direction. The heading is what gets quoted, and this is precisely the U4a/U4b split the repair introduced elsewhere. It should read "0103 declares…". Note the brief gets this right (:142 says "declares") — the fact layer is the weaker of the two.

### 3. [major] `00_VERIFIED_STATE.md:376 (§4.6)`

"Anything normalised by this column returns ≈1.0." is a derived consequence stated flatly and untagged inside a [CLONE 13dcfe3] entry. This is item 8 of the previous verify's untagged-claims list, reproduced unchanged; the repair report does not mention it. Every other item on that list was addressed.

### 4. [major] `ci-readme-addition.md:163, :200, :32-34`

Three factual claims with no §N and no fact-layer entry behind them: "each key is handed to createClient() against whatever host SUPABASE_URL names" (:163), "the token reaches whatever project SUPABASE_URL names" (:200), and the universal "for every process in this repository that reaches Supabase, SUPABASE_URL is the only input that selects which project is contacted" (:32-34). 00_VERIFIED_STATE.md contains no createClient entry at all (grep: zero hits) and §9.13 covers only the six Management-API scripts. Per both documents' own rule the fact had to be added to the layer first; instead it is stated in the brief's words. The prior round anchored this to rlsHardening.test.ts:55-57 — that anchor was dropped without moving the fact.

### 5. [minor] `00_VERIFIED_STATE.md:831-833 (§7.10)`

Entry point A's 100 MB video ceiling is anchored to routes/postcards.ts:29 (entry point D's constant). A's own constant is routes/posts.ts:56, checked at :122-123. The figure is right, the anchor names the wrong endpoint, and §7.10 is what Option A's memory/bandwidth cost bullet cites.

### 6. [minor] `upload-ingest-consolidation.md:120-122 (§3.3)`

Restates §7.3's census numbers as a fact of record without carrying that §7.3's tag is [DB 2026-08-10 · project not recorded] — void under the fact layer's own rule at :31 and listed for re-run in §10.3. The brief warns about the non-ready population (U3) but not about the void project attribution, which is the stronger caveat: a census of the non-production project says nothing about production's corpus.

### 7. [minor] `upload-ingest-consolidation.md:458-459 (§8 item 4)`

"⚠ Per §7.2a and §10.4, 'permanently' is not established". §10.4:1378-1379 states that any document using the word must cite that bullet, "not §7.2a and not §7.15". The brief cites §7.2a alongside it — the one hook the fact layer closed.

### 8. [minor] `ci-readme-addition.md:24 (section heading)`

"SUPABASE_URL alone decides which database is reached" overstates the body. The body says SUPABASE_URL selects which project is CONTACTED (:33-34) and concedes at :94-96 that a scoped credential would still be pointed by the same URL. Under the project-scoped reading the open question leaves live (:103-132), the credential also bounds which database is REACHED. A heading in docs/ci/README.md is quoted without its body — the same failure shape as the last round, one word narrower.

### 9. [minor] `00_VERIFIED_STATE.md:1030-1031 (§8.7)`

"Every signed URL is issued behind it (routes/mediaFile.ts:23-24)" anchors a claim about call ordering to two import statements. The header at :11-12 ("Authorization runs before signing in both routes") is the evidence and is already cited in the same entry; :23-24 should be dropped or replaced with the call sites.

### 10. [minor] `00_VERIFIED_STATE.md:876-877 (§7.15)`

"every .storage.from(...).remove(...) call in the server tree (eleven, excluding tests)" — the enumeration that follows lists ten calls and then identifies lib/storagePath.ts:41 as a doc comment, not a call. I reproduced the grep: 11 non-test hits, 10 calls. The count in the parenthesis is the grep hit count, not the call count, in the entry that carries the whole no-sweeper argument.

### 11. [minor] `00_VERIFIED_STATE.md:1241-1242 (§9.19)`

":6 and :18 both name https://github.com/<repo>/settings/secrets/actions". Only :18 holds that URL; :6 is a breadcrumb ("GitHub → Settings → Secrets and variables → Actions"). The substance holds at both lines; the citation as written does not.

### 12. [minor] `upload-ingest-consolidation.md:101-102 (§3.2 item 1)`

"The same follows from an app kill, a lost network, or a backgrounded app after the PUT" is an untagged inference in a document whose §0 rule (:25) says a factual sentence with no §N pointer is a defect. Either add it to §7.14 or mark it as inference.


## Untagged claims — 9

- 00_VERIFIED_STATE.md:376 (§4.6) — "Anything normalised by this column returns ≈1.0." Still untagged, inside a [CLONE 13dcfe3] paragraph. This is verify-output untaggedClaims/8 verbatim; the repair round did not touch it.

- 00_VERIFIED_STATE.md:239-241 (§3.4) — "Cohort or percentage targeting is expressible in metadata with no schema change." Carries no tag of any kind; leans on §3.1 by cross-reference only.

- 00_VERIFIED_STATE.md:999-1000 (§8.4) — HEADING asserts: "post_media_storage_public_read GRANTS SELECT TO public across the whole post-media bucket." Present tense, not "0103 declares". The entry's own closing line (:1011) says whether it is live is [UNVERIFIED].

- ci-readme-addition.md:24 — HEADING asserts "SUPABASE_URL alone decides which database is reached", strictly stronger than the body's careful "selects which project is contacted" (:33-34, :93-96) and than anything §9.13 supports.

- ci-readme-addition.md:163 — "each key is handed to createClient() against whatever host SUPABASE_URL names". No §N, no tag. grep for createClient in 00_VERIFIED_STATE.md returns nothing: the fact layer has no entry for the non-Management-API clients.

- ci-readme-addition.md:200 — "the token reaches whatever project SUPABASE_URL names". No §N.

- ci-readme-addition.md:227-228 — "CI_SUPABASE_PROJECT_REF is operator-supplied and fails closed when empty". No §N (facts are §9.7 and §9.6); anchored only to a README section link.

- upload-ingest-consolidation.md:101-102 — "The same follows from an app kill, a lost network, or a backgrounded app after the PUT." No §N, in a document whose §0 rule (:25) declares that a defect.

- upload-ingest-consolidation.md:176-177 — "a parent post that may be a draft" attributed to §7.13, which records only processing_status/moderation_status.


## Citation errors — 6

- 00_VERIFIED_STATE.md:831-833 (§7.10) — "Entry point A's declared video ceiling is 100 MB (routes/postcards.ts:29 for the postcard path's constant)." A's ceiling is declared at routes/posts.ts:56 (MAX_UPLOAD_VIDEO_BYTES) and enforced at :122-123; postcards.ts:29 is entry point D's constant. The number coincides; the anchor is the wrong entry point, and §7.10 is what Option A's cost bullet cites.

- 00_VERIFIED_STATE.md:1030-1031 (§8.7) — "Every signed URL is issued behind it (routes/mediaFile.ts:23-24)." Those two lines are the import statements for appStorageUrlInfo and authorizeMediaAccess. The supporting evidence is the header at :11-12 ("Authorization runs before signing in both routes"); an import is not evidence of call ordering.

- 00_VERIFIED_STATE.md:876-877 (§7.15) — "enumerating every .storage.from(...).remove(...) call in the server tree (eleven, excluding tests)", then lists ten calls plus lib/storagePath.ts:41, which the same sentence identifies as a doc comment. I reproduced it: 11 non-test grep hits, 10 calls.

- 00_VERIFIED_STATE.md:1241-1242 (§9.19) — ":6 and :18 both name https://github.com/<repo>/settings/secrets/actions". :18 holds that URL; :6 is a breadcrumb comment ("GitHub → Settings → Secrets and variables → Actions"), not the URL.

- 00_VERIFIED_STATE.md:908-909 (§7.16) — the dangling-row reconciliation is cited :118-135; the query runs :123-135, and :118 is a field inside the DanglingRow interface. The orphan half (:137-146) is exact.

- upload-ingest-consolidation.md:176-177 — "(§7.13)" cited for a claim about the parent post's draft state that §7.13 does not contain.


## Restatements (cite the fact layer instead) — 8

- upload-ingest-consolidation.md:120-122 (§3.3) — restates §7.3's five census numbers in its own words ("293 image objects, 9 with EXIF, zero with GPS") and presents them as a fact of record. §7.3's tag is [DB 2026-08-10 · project not recorded], which the fact layer's own rule (:31) declares VOID. The brief carries the non-ready caveat (U3) but not the void-tag caveat.

- upload-ingest-consolidation.md:99-102 (§3.2 item 1) — restates §7.14's content ("sets an error, returns to the picker, and returns — no cleanup, no retry, no delete") rather than pointing. Currently identical to the source; the divergence risk is structural, not present.

- upload-ingest-consolidation.md:114-116 — restates §7.4's "116 rows / 114 objects" numbers.

- upload-ingest-consolidation.md:173-174 — restates §8.6's "roughly millisecond entropy scoped to a known user id" verbatim.

- upload-ingest-consolidation.md:183-187 (§4) — restates §7.20 in full ("creates buckets with public: true and runs on every avatar and cover upload… the first avatar upload creates profile-media public").

- upload-ingest-consolidation.md:421 (U1) — restates §7.5 ("Asserted only in a comment; there is no explicit strip call and no assertion").

- ci-readme-addition.md:112-115 — restates §9.17's inventory (thirteen files, twenty-one lines, three call it read-only, five-step dashboard path, this README is two of them).

- ci-readme-addition.md:169-171, :181 — restates §9.16's exception and quotes the vars/secrets expression.
