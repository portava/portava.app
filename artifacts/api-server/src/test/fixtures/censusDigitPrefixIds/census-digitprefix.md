# Census — the digit-suffix prefix, and the ranges that must survive it

Every row here exists to pin ONE cell shape against the real parser. The first
three are the ids `docs/architecture/reconciled-baseline-v1.md` §2.2 names —
`DSV2-04`, `DSV2-05`, `DSV2-12` — written in a VERDICT TABLE, which is the thing
census-discovery §12.3 said could not be done. Each must read as exactly ONE
requirement. The rest are cell shapes copied verbatim from real censuses, and
each must still EXPAND, because the fix for the first three is only correct if
it did not turn every genuine range into a single id.

Arithmetic anyone can check by hand:

    DSV2-04                          1   the digit-suffix prefix, N
    DSV2-05                          1   the same shape, C
    DSV2-12                          1   the same shape with a two-digit tail, N
    TR58–TR62 + TR64–TR66            8   census-trips: a compound that SKIPS TR63
    H147–H149, H152–H154, H160       7   census-highlights-memories: a comma list
    MD130–MD138                      9   census-media: a plain range
    L102–L113                       12   census-layover: a plain range
    Not an id at all, just prose      0   prose stays out
                                   ────
                                     39

| id | Requirement | V | Evidence |
|---|---|---|---|
| **DSV2-04** | the digit-suffix prefix; used to read as the forward range DSV2–DSV4 and expand into three phantom ids | **N** | `src/x.ts:1` |
| **DSV2-05** | the same shape; used to expand into four | **C** | `src/x.ts:2` |
| **DSV2-12** | the same shape with a two-digit tail; used to expand into eleven | **N** | `src/x.ts:3` |
| TR58–TR62 + TR64–TR66 | a compound range that deliberately skips TR63; must still expand to eight | **W** | `src/x.ts:4` |
| H147–H149, H152–H154, H160 | two ranges and a single, comma-joined; must still expand to seven | **C** | `src/x.ts:5` |
| MD130–MD138 | a plain range; must still expand to nine | **C** | `src/x.ts:6` |
| L102–L113 | a plain range; must still expand to twelve | **W** | `src/x.ts:7` |
| Not an id at all, just prose in the first cell | this row must parse to nothing | **C** | `src/x.ts:8` |
