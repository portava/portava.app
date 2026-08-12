# Reconciling `main` with `bughunt-20260805`

**Status: PLAN. Design only, for review before any execution.** Nothing here has
been run. No merge, no push, no ruleset change was made in writing it.

**Audience:** whoever decides what `main` is. Steps marked **[OPERATOR]** need a
human with repository-admin rights.

---

## 0. The fact that shapes everything

```
git merge-base origin/main origin/bughunt-20260805
→ (nothing)
```

**The two branches have no common ancestor.** Measured 2026-08-12:

| | |
|---|---|
| `origin/main` | `2376e86f5` |
| `origin/bughunt-20260805` | `d0cd1cdde` |
| Commits on `bughunt` not in `main` | **3331** |
| Commits on `main` not in `bughunt` | **1672** |
| Merge base | **none** |

These are two unrelated histories that happen to describe the same product.
Git will refuse to merge them without `--allow-unrelated-histories`, and that
refusal is a safety feature doing its job. **The whole risk of this task is that
the flag which silences the refusal is easy to type.**

`main` is the repository's default branch. `bughunt-20260805` is the line all
current work lands on and the only branch with a ruleset.

---

## 1. What must not happen

Stated first because each of these is a plausible shortcut that destroys
information irrecoverably.

- **No blind merge.** `git merge --allow-unrelated-histories` across 3331 and
  1672 divergent commits produces a conflict set nobody can review honestly, and
  a resolution nobody can audit afterwards. The flag is not the plan.
- **No force-push to `main`.** `git push --force origin bughunt:main` would
  produce the right *tree* in one command. It also discards 1672 commits of
  history with no record of what was discarded, and no way to answer "what was
  on main?" later.
- **No default-branch switch before the checks pass.** Making `bughunt` the
  default while it is unverified against `main`'s required checks moves the
  problem rather than solving it.
- **No ruleset deletion "temporarily."** The current ruleset is the only branch
  protection in the repository.

---

## 2. Establish ancestry deliberately

The unrelated histories are a fact to be *recorded*, not repaired. Two shapes;
the choice is the owner's and is the single decision this plan exists to
surface.

### Option A — `main` becomes `bughunt`'s history, with the old `main` preserved

1. **[OPERATOR]** Tag the current `main` — `archive/main-pre-reconcile-20260812`
   at `2376e86f5`. This is the step that makes everything after it reversible,
   and it costs nothing.
2. Create the reconciliation as an explicit **merge commit with two parents**,
   `bughunt` as first parent and old `main` as second, resolving *entirely* in
   favour of the `bughunt` tree.

   The point is not the tree — it is that the commit **records** that old `main`
   is an ancestor. `git log` can then answer "what was on main?" forever, and
   nothing is discarded.
3. The resulting tree must be **byte-identical to `bughunt-20260805`**. That is
   checkable rather than trusted:
   ```
   git diff --stat <reconciled> origin/bughunt-20260805    # must be empty
   ```
   An empty diff is the whole verification. If it is not empty, the resolution
   was not what was intended and the merge should be thrown away.

**Cost:** one merge commit whose diff against the second parent is enormous and
unreviewable. That is honest — it *is* an enormous change — and the empty-diff
check is what substitutes for reading it.

### Option B — `main` is retired, `bughunt` is promoted

1. **[OPERATOR]** Tag current `main` as above.
2. **[OPERATOR]** Make `bughunt-20260805` the default branch.
3. Leave `main` in place, unchanged, as a dead branch pointing at the tag.

**Cost:** the default branch is named `bughunt-20260805`, which describes a task
and not a trunk. Renaming it later is its own operation. No merge commit and no
unreviewable diff.

**The trade:** A keeps the name `main` and pays with one unreviewable merge
commit. B keeps history perfectly clean and pays with a branch name that will
confuse every future reader until it is renamed. Both preserve the old `main`
via the tag, which is the part that actually matters.

---

## 3. Full required checks on the reconciled state

Whichever option, the reconciled state runs the **complete** required set before
it becomes default or protected — not a subset, and not the results inherited
from `bughunt`'s last green run.

The three required contexts on the existing ruleset are verdict aggregators:

```
CI · verdict (skipped or cancelled is not a pass)
live DB · verdict (cancelled or skipped is not a pass)
unwired · verdict (skipped or cancelled is not a pass)
```

Their names encode the property that matters and it is worth not undoing: **a
skipped or cancelled job is not a pass.** Reconciliation is exactly the
situation where a workflow might not trigger — different paths, different
branch filters — and inherit a green tick from nothing having run.

- Open the reconciliation as a **pull request**, so the checks run on the merge
  result rather than on either parent.
- Require all three to pass on that PR. Do not `--admin` merge it. The admin
  bypass exists for routine unit-of-work merges; using it on the one commit that
  redefines the trunk removes the only evidence that the trunk is sound.
- If a workflow does not trigger at all on the reconciled branch, treat that as
  a failure and fix the trigger. That is precisely what the verdict jobs are
  named for.

---

## 4. Default and protect, last

Only after §3 is green:

1. **[OPERATOR]** Set the default branch.
2. **[OPERATOR]** Create a ruleset targeting it, copying the existing one:
   `deletion`, `non_fast_forward`, `pull_request`, and the same three required
   status checks. The existing ruleset (id `20680634`) is the template — copy it
   rather than re-deriving it, so the required contexts match exactly.
3. Keep or retire the `bughunt-20260805` ruleset deliberately. Under Option B it
   *is* the new default's ruleset and stays. Under Option A, `bughunt` becomes a
   historical branch and its ruleset should be retired only once nothing targets
   it.

**Bypass:** the current ruleset allows `RepositoryRole` bypass, which is what
has made `gh pr merge --admin` work throughout this effort. Carrying that
forward is a deliberate choice, not a default — it is the mechanism that let
every merge so far skip the queue, and on a real trunk it is worth deciding
again rather than inheriting.

---

## 5. Verification checklist

Each item is checkable, not a judgement:

- [ ] `archive/main-pre-reconcile-20260812` exists and points at `2376e86f5`
- [ ] `git diff --stat <new default> origin/bughunt-20260805` is **empty**
- [ ] Under Option A: `git merge-base --is-ancestor 2376e86f5 <new default>` succeeds
- [ ] All three verdict checks are green **on the reconciliation PR itself**
- [ ] No check was skipped or cancelled
- [ ] The new default has a ruleset with all three required contexts, spelled identically
- [ ] `git log --oneline -1 origin/main` on the *old* main still resolves via the tag

---

## 6. What this plan does not decide

- **Which option.** A and B are genuinely different trades and the choice is the
  owner's.
- **What the 1672 commits on `main` contain.** This plan preserves them and does
  not read them. If any is work that should survive into the trunk, that is a
  separate salvage exercise and neither option performs it — both treat `main`'s
  tree as superseded wholesale.
- **The branch name.** Under B, whether and when to rename `bughunt-20260805`.
