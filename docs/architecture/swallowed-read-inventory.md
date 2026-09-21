# Swallowed-read inventory — an error branch that returns an empty collection

**Status: a MEASUREMENT, not a verdict. Nothing here has been fixed, and this
file is not a census — no row in it grades anything.**

It exists because `census-discovery.md` §23–§25 measured a defect class while
closing sixteen instances of it in `routes/discoverySearch.ts`, and the other
thirty-one instances belong to five other lanes. A census may not grade another
census's code, and naming another lane's files inside one makes it claim them —
`check:census-scope-coverage` says so, and says it correctly. So the per-file
list lives here, where an owner can act on it and no census is put in the
position of owning it.

## The class

supabase-js RESOLVES on a read failure. An `if` on the error whose branch
returns `[]` or `{}` — where the same function returns that same empty value on
a success path — makes a failure byte-identical to a genuine empty answer. The
caller cannot tell them apart.

## The method, and what it cannot see

An `if` whose CONDITION names an `error` and whose consequent returns `[]` or
`{}`, compared against the other returns in the enclosing function, across the
949 files under the nine directories `checkUncheckedSupabaseReads` walks.

- **It over-counts.** An arrow function nested in a route handler is visited
  twice, so a site inside one is reported twice. 37 rows → **31 distinct sites**.
- **It counts `[]` and `{}` only.** `null`, `false` and `0` were excluded as
  deny/absent sentinels; that judgement dropped the count from 171 to 37, and
  nothing has re-examined the 140 it removed.
- **Its classifier is textual.** LOGGED means a `logger.`/`log.` call appears in
  the branch. A site that logs through a helper reads as SILENT; a site that
  logs something unrelated reads as LOGGED. Two of the four columns are
  evidence; two are heuristics.
- **Nothing runs it.** It was a one-off script. The count can rise tomorrow and
  no check anywhere will say so. Three census sections quoted a number from it
  and two of those numbers were wrong.

## What the 31 are

**Not one is a fail-OPEN.** Every one returns the restrictive answer. The
finding is INVISIBILITY, not danger.

| class | n | what it means |
| --- | --- | --- |
| CARRIED | 3 | the failure is recorded in a variable the RESPONSE reports. The caller is told. |
| LOGGED | 9 | a `logger.warn` fires. An operator can see it; the caller cannot. |
| COMMENTED | 2 | a comment states the posture, no log. A reader can see it; nobody at runtime can. |
| **SILENT** | **17** | **no assignment, no log, no comment. A failed read leaves no trace anywhere.** |

### CARRIED (3) — Trips
`routes/tripDecisions.ts` (twice: `failedInput`, `urgencyInputsUnread`) ·
`routes/tripStructure.ts` (`failed`)

### LOGGED (9) — Discovery, Trips, Layover, Media, Trust, Sensing
`routes/discovery.ts` · `routes/tripOffline.ts` ·
`services/airport/LayoverRecommendationService.ts` ·
`services/media/MediaProjectionService.ts` ·
`services/trust/TrustCapService.ts` · `lib/liveClaimRead.ts` (twice) ·
`lib/trustMaintenanceScheduler.ts` (twice)

### COMMENTED (2) — Map, Input Intelligence
`lib/mapTravelers.ts` · `lib/inputAssistance/duplicateDetection.ts`

### SILENT (17) — Location, Media, Wall, Input Intelligence, Passport, Trips
`services/location/GeoZoneService.ts` (three) ·
`services/media/MediaActionResolver.ts` ·
`services/media/MediaViewRequestService.ts` (two) ·
`services/ranking/MediaFeedRankingService.ts` ·
`services/wall/LiveForYouService.ts` (three) ·
`lib/canonicalLocations.ts` ·
`lib/inputAssistance/duplicateDetection.ts` (two more) ·
`lib/inputAssistance/socialIdentity.ts` (two) ·
`lib/stamps/criteria/index.ts` ·
`domain/trips/services/tripReadiness.ts` (`safeSelect`)

## The one worth reading first

`lib/canonicalLocations.ts` refuses only when BOTH of its two reads fail
(`if (prefix.error && contains.error)`), so a single-source failure silently
halves the candidate pool and the caller gets a short list that looks complete.
That is `searchAll`'s defect in miniature, inside a helper.

## What "fixing" one means, and what it does not

The nine LOGGED sites already log. Adding a `logger.warn` to the seventeen
SILENT ones would move them into that column and close nothing that owner
ruling D11 is about: **an operator seeing it is not the caller being told.** The
question each owner has to answer per site is the one `searchCities` answered —
*may the caller act on this emptiness as if it were an answer?* — and where it
may not, the fix is to say so on the wire, keeping whatever fail-closed
direction the site already has.

Three of the 31 are false positives by construction: the CARRIED column. The
measurement cannot see that a branch did something else before returning.
