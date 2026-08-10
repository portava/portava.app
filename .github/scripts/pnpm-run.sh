#!/usr/bin/env bash
#
# pnpm-run.sh <package-dir> <expected-package-name> <script-name> [extra args...]
#
# THE ONLY SANCTIONED WAY TO RUN A PACKAGE SCRIPT IN THIS CI.
#
# WHY THIS EXISTS
#
# `pnpm <flag> <pkg> run <script>` — the workspace-selector form — EXITS 0 WHEN
# IT MATCHES NOTHING. Reproduced against pnpm 10.26.1:
#
#   * a selector that matches no package prints "No projects matched the
#     filters" and exits 0;
#   * a selector that matches a package which has no such script also exits 0.
#
# So a workflow step written that way reports SUCCESS when the package name is
# misspelled, when a package is renamed or moved, and when the script it names
# is renamed or deleted. Every one of those is the exact failure this whole CI
# effort exists to eliminate: a check that did not run, reporting success.
#
# WHAT THIS SCRIPT GUARANTEES
#
# The guarantee does NOT depend on pnpm's exit-code semantics at all. Every
# assertion below is made by this script, from package.json on disk, BEFORE
# pnpm is invoked:
#
#   (a) WRONG PACKAGE / WRONG DIRECTORY -> exit 1.
#       The directory must exist, must contain a package.json, and that
#       package.json's "name" must equal <expected-package-name> exactly.
#       A rename, a move, or a typo all fail here, named.
#   (b) WRONG SCRIPT NAME -> exit 1.
#       <script-name> must be present in that package.json's "scripts" and must
#       be a non-empty string. A renamed or deleted script fails here, named.
#   (c) Only if (a) and (b) hold is the script run — as a plain `pnpm run` from
#       inside the package directory, via exec, so the script's own exit code is
#       this process's exit code with nothing in between.
#
# The same three arguments are re-asserted ahead of every job by
# .github/scripts/assert-ci-scripts.mjs, which scans this directory for every
# invocation. That is a fail-fast duplicate of (a) and (b), not a replacement:
# this script must remain safe when invoked on its own.

set -euo pipefail

usage() {
  echo "usage: pnpm-run.sh <package-dir> <expected-package-name> <script-name> [args...]" >&2
}

if [ "$#" -lt 3 ]; then
  usage
  echo "::error::pnpm-run.sh called with $# argument(s); it requires at least 3. Every CI invocation must name the directory, the expected package name, and the script, so all three can be verified before anything runs."
  exit 1
fi

DIR="$1"
EXPECTED_NAME="$2"
SCRIPT="$3"
shift 3

fail() {
  echo "::error::$*"
  exit 1
}

# ── (a) the package must be where and what we say it is ──────────────────────
[ -d "$DIR" ] || fail "pnpm-run.sh: package directory '$DIR' does not exist. The workflow names a package location that is not in this checkout. This is a hard failure, NOT a no-op: a selector-based invocation would have exited 0 here."

[ -f "$DIR/package.json" ] || fail "pnpm-run.sh: '$DIR' exists but has no package.json, so '$EXPECTED_NAME' cannot be the package there."

ACTUAL_NAME="$(node -e '
  const fs = require("node:fs");
  const dir = process.argv[1];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
  } catch (err) {
    console.error("unparseable package.json in " + dir + ": " + err.message);
    process.exit(1);
  }
  process.stdout.write(String(pkg.name ?? ""));
' "$DIR")" || fail "pnpm-run.sh: could not read $DIR/package.json."

if [ "$ACTUAL_NAME" != "$EXPECTED_NAME" ]; then
  fail "pnpm-run.sh: package-name mismatch. $DIR/package.json declares name '$ACTUAL_NAME', but this CI step expects '$EXPECTED_NAME'. Either the package was renamed and the workflow was not updated, or the workflow names a package that no longer exists. Failing instead of running the wrong thing — or, as the old selector form did, running nothing and exiting 0."
fi

# ── (b) the script must exist ────────────────────────────────────────────────
node -e '
  const fs = require("node:fs");
  const [dir, script] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
  const scripts = pkg.scripts ?? {};
  const body = scripts[script];
  if (typeof body !== "string" || body.trim() === "") {
    console.error(
      "Script \"" + script + "\" is not defined in " + dir + "/package.json.\n" +
      "Defined scripts (" + Object.keys(scripts).length + "):\n" +
      Object.keys(scripts).sort().map((s) => "  - " + s).join("\n"),
    );
    process.exit(1);
  }
  console.log("pnpm-run.sh: " + (pkg.name ?? dir) + " -> " + script + ": " + body);
' "$DIR" "$SCRIPT" || fail "pnpm-run.sh: script '$SCRIPT' does not exist in package '$EXPECTED_NAME' ($DIR). It was renamed or deleted and this workflow was not updated. A selector-based invocation would have exited 0 here and this check would have silently stopped running."

# ── (c) run it, from the package directory, exit code passed straight through ─
cd "$DIR"
exec pnpm run "$SCRIPT" "$@"
