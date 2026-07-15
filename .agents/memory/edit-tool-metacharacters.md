---
name: Edit-tool $ metacharacters
description: Edit new_string expands JS replace patterns ($&, $', $`, $digit, $$, $<name>) — they corrupt files
---
Rule: Never include `$&`, `$'`, `` $` ``, `$<digit>`, `$$`, or `$<name>` sequences in the Edit tool's `new_string`. Audit every `$` adjacency before submitting an Edit. `${` (template literals) is safe.

**Why:** `new_string` appears to pass through a JS `String.replace`-style substitution. A `$`-pattern once expanded to the surrounding match and duplicated ~740 lines into a test file (recovered only via git restore).

**How to apply:** Before any Edit call, scan `new_string` for `$` followed by `&`, `'`, a backtick, a digit, `<`, or another `$`. If present, use WriteFile instead (its content is written verbatim) or restructure the string to avoid the sequence. This matters most when editing shell scripts (`$$`, `$1`), regex replacements, and docs that mention these very patterns.
