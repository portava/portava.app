/**
 * "Is this migration file on the branch the apply step runs on?" — resolved
 * from git, and FAIL-CLOSED when it cannot be.
 *
 * This is the second half of the audit:schema classification (the first is
 * src/scripts/lib/migrationGapClassification.ts). It answers exactly one
 * question and refuses to guess at it.
 *
 *
 * WHY origin/main SPECIFICALLY, AND NOT github.base_ref
 * =====================================================
 * The apply step in .github/workflows/live-db.yml is gated
 * `github.ref == 'refs/heads/main'`. main is where migrations get applied, so
 * main is the only ref whose contents answer "should this already have been
 * applied?". A PR targeting some other base does not change that: a file on
 * that base and not on main has still never met the applier. Hardcoding main
 * keeps the classifier's premise identical to the workflow's gate. `--main-ref`
 * exists for an operator who has genuinely moved the apply branch, not as a way
 * to make a red run green.
 *
 *
 * SHALLOW CLONES — THE CASE THIS IS ACTUALLY WRITTEN FOR
 * ======================================================
 * actions/checkout@v4 defaults to `fetch-depth: 1`. On a pull_request event it
 * fetches only refs/pull/N/merge at depth 1, so:
 *
 *   * `origin/main` does not exist as a remote-tracking ref, and
 *   * `HEAD^1` (which on a PR merge commit IS the base commit) is unreachable,
 *     because a depth-1 clone has no parents.
 *
 * So the resolution is, in order:
 *
 *   1. `git rev-parse --verify --quiet <ref>^{commit}` — already present? Use it.
 *      (True on push-to-main runs and in any normal full clone.)
 *   2. `git fetch --no-tags --depth=1 origin +refs/heads/main:refs/remotes/origin/main`
 *      — one commit, one tree, explicit refspec so the tracking ref is written
 *      whatever remote.origin.fetch happens to be. checkout@v4 persists
 *      credentials by default, so this authenticates on a private repo.
 *   3. Re-try step 1, then FETCH_HEAD as a last resort (a fetch can succeed
 *      without updating the tracking ref if the refspec was rejected).
 *   4. Still nothing → INDETERMINATE. Not "absent", not "probably new".
 *
 * Every step's outcome is recorded in `detail` and printed by the audit, so a
 * reader can see which one answered and which ones did not.
 *
 *
 * PURE-ISH BY INJECTION
 * =====================
 * The git runner is a parameter, so the whole decision tree — including the
 * shallow-clone fetch path — is drivable from a unit test with no repository,
 * no network and no child process. Nothing here reads process.env or names a
 * credential, which is what keeps scripts/check-guard-coverage.mjs from
 * classifying it as able to reach Supabase.
 */

/** What a single `git` invocation produced. */
export interface GitRunResult {
  /** Process exit status. Use a non-zero value when git could not be spawned. */
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in the repository. Must never throw. */
export type GitRunner = (args: readonly string[]) => GitRunResult;

/** The default ref the apply step is gated on. */
export const DEFAULT_MAIN_REF = "origin/main";

export interface MainFileSet {
  /**
   * Repo-relative paths on the apply branch, or `null` when the comparison
   * could not be made. `null` is a first-class answer, not an empty set: an
   * empty set would read as "main contains no migrations", which classifies
   * every file as new-on-branch — the exact silent downgrade this avoids.
   */
  paths: ReadonlySet<string> | null;
  /** The commit-ish that answered, if any. */
  resolvedRef: string | null;
  /** Short label for the report, e.g. "origin/main" or why there is none. */
  label: string;
  /** One line per step attempted, in order. */
  detail: string[];
}

export interface ResolveMainFileSetOptions {
  run: GitRunner;
  /** Repo-relative directories to list, e.g. ["artifacts/api-server/src/migrations/"]. */
  dirs: readonly string[];
  /** Defaults to origin/main. */
  ref?: string;
  /** Set false to skip the shallow-clone fetch (tests, offline operators). */
  allowFetch?: boolean;
}

function revParse(run: GitRunner, ref: string): boolean {
  return run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
}

/**
 * Resolve the set of migration paths on the apply branch.
 *
 * Returns `paths: null` — indeterminate — for every failure mode, including a
 * `git ls-tree` that fails for only ONE of the requested directories. A
 * partially-listed tree would report files as absent from main that are merely
 * absent from the part that got listed, and absent-from-main is the one answer
 * that lets a gap exit 0.
 */
export function resolveMainFileSet(
  opts: ResolveMainFileSetOptions,
): MainFileSet {
  const ref = opts.ref ?? DEFAULT_MAIN_REF;
  const allowFetch = opts.allowFetch !== false;
  const detail: string[] = [];

  let resolved: string | null = null;

  if (revParse(opts.run, ref)) {
    resolved = ref;
    detail.push(`${ref} resolves in this checkout`);
  } else {
    detail.push(`${ref} does not resolve here (shallow clone, or no such ref)`);

    if (allowFetch) {
      const fetch = opts.run([
        "fetch",
        "--no-tags",
        "--depth=1",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
      if (fetch.status === 0) {
        detail.push("fetched refs/heads/main from origin at depth 1");
        if (revParse(opts.run, ref)) {
          resolved = ref;
          detail.push(`${ref} resolves after the fetch`);
        } else if (revParse(opts.run, "FETCH_HEAD")) {
          resolved = "FETCH_HEAD";
          detail.push(
            `${ref} still does not resolve; using FETCH_HEAD from that fetch`,
          );
        } else {
          detail.push(
            "the fetch reported success but neither the tracking ref nor FETCH_HEAD resolves",
          );
        }
      } else {
        detail.push(
          `fetch of refs/heads/main failed (git exit ${fetch.status}): ` +
            `${(fetch.stderr || fetch.stdout).trim().split("\n")[0] || "no output"}`,
        );
      }
    } else {
      detail.push("fetching is disabled for this run");
    }
  }

  if (resolved === null) {
    detail.push(
      "INDETERMINATE — no comparison against the apply branch was made; every " +
        "migration with no ledger row FAILS CLOSED",
    );
    return {
      paths: null,
      resolvedRef: null,
      label: `${ref} (UNRESOLVED — no branch comparison was possible)`,
      detail,
    };
  }

  const paths = new Set<string>();
  for (const dir of opts.dirs) {
    const listed = opts.run(["ls-tree", "--name-only", "-r", resolved, "--", dir]);
    if (listed.status !== 0) {
      detail.push(
        `ls-tree of ${dir} at ${resolved} failed (git exit ${listed.status}): ` +
          `${(listed.stderr || listed.stdout).trim().split("\n")[0] || "no output"}`,
      );
      detail.push(
        "INDETERMINATE — a partial listing would report files as absent from the " +
          "apply branch that were merely not listed, so the whole comparison is discarded",
      );
      return {
        paths: null,
        resolvedRef: resolved,
        label: `${ref} (UNRESOLVED — ${dir} could not be listed)`,
        detail,
      };
    }
    let count = 0;
    for (const line of listed.stdout.split("\n")) {
      const path = line.trim();
      if (path.length === 0) continue;
      paths.add(path);
      count++;
    }
    detail.push(`${resolved} carries ${count} path(s) under ${dir}`);
  }

  return {
    paths,
    resolvedRef: resolved,
    label: resolved === ref ? ref : `${ref} (via ${resolved})`,
    detail,
  };
}
