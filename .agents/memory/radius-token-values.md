---
name: radius token values
description: The radius design token only has sm/md/lg/pill — xl does not exist and throws TS2339.
---

The `radius` object from `../theme/tokens.ts` has exactly four keys: `sm`, `md`, `lg`, `pill`.

**Why:** `radius.xl` was inferred from HighlightViewersSheet which hard-codes `24` — that is not a token.

**How to apply:** For bottom-sheet corner radii use `borderTopLeftRadius: 24, borderTopRightRadius: 24` (hard-coded) or `radius.lg` (20). Never `radius.xl`.
