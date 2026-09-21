# Census — the id grammar, one cell per shape

Every row here exists to pin ONE shape of id cell against the real parser.
If a shape regresses, the row count below changes and this file's test fails.

| id | Requirement | V | Evidence |
|---|---|---|---|
| GR-01 | a plain numbered id | C | `src/x.ts:1` |
| GR-02 | a second plain id | W | `src/x.ts:2` |
| GRV2-01 | a DIGIT-BEARING prefix — the shape that used to parse as the range GRV2–GRV1 and silently vanish | C | `src/x.ts:3` |
| GRV2-11 | the same shape with a two-digit tail — this one used to expand into ten invented ids | W | `src/x.ts:4` |
| G1-07 | a one-letter prefix ending in a digit; used to collapse every G1-nn row onto a single id | C | `src/x.ts:5` |
| GR-P1 | a LETTERED series member, no digit straight after the prefix | C | `src/x.ts:6` |
| GR-P5 | the last of the lettered series | N | `src/x.ts:7` |
| GR-EVAL | a NAMED id carrying no digits at all | W | `src/x.ts:8` |
| GR-10–GR-12 | a GENUINE range, which must still expand to three ids | C | `src/x.ts:9` |
| GR-20, GR-21 | a comma list, which must still expand to two | C | `src/x.ts:10` |
| Not an id at all, just prose in the first cell | this row must parse to nothing | C | `src/x.ts:11` |
