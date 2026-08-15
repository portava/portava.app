#!/usr/bin/env node
/**
 * check-dev-proxy-not-shipped.mjs
 *
 * Fails if the dev-only same-origin API proxy becomes reachable from shipped
 * code.
 *
 * WHY THIS IS A GUARD AND NOT A COMMENT
 * -------------------------------------
 * `scripts/dev-same-origin-proxy.mjs` forwards browser traffic to a configured
 * API target, and during the Phase B3 probe that target is PRODUCTION. It is
 * safe only because it is unreachable from anything that ships: not in the
 * Metro module graph, not imported by the app, not invoked by the production
 * serve path.
 *
 * That is a property of the current file layout, and file layouts change. A
 * single `import` from `src/` would put a production-pointing proxy into the
 * app bundle, and nothing else in this repo would notice.
 *
 * The comment in the proxy claims it cannot ship. THIS FILE IS WHAT MAKES THAT
 * CLAIM CHECKABLE. Without it the claim is exactly the kind of safety property
 * that stops being true with nothing detecting the drift — the failure mode
 * already recorded against `app.ts:48`, whose comment asserts REPLIT_DEV_DOMAIN
 * is never present in deployed production while production has it set.
 *
 * WHAT IT CHECKS
 * --------------
 * No file under `src/`, `app/`, or `server/`, and neither build config
 * (`metro.config.js`, `babel.config.js`), may reference the proxy module.
 *
 * `scripts/` is deliberately NOT scanned: dev tooling referring to dev tooling
 * is the intended arrangement, and package.json scripts must be able to name it.
 *
 * IF THIS FAILS
 * -------------
 * Do not allowlist around it. The proxy is a local development tool; if
 * application code needs it, the requirement has changed and that change needs
 * its own review rather than an exception here.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The module this guard protects. Basename is enough — any path form matches. */
const PROXY_BASENAME = "dev-same-origin-proxy";

/** Trees that ship, or that feed the bundle graph. */
const SCAN_DIRS = ["src", "app", "server"];
const SCAN_FILES = ["metro.config.js", "babel.config.js"];

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXT.test(name)) out.push(full);
  }
  return out;
}

const targets = [];
for (const d of SCAN_DIRS) targets.push(...walk(join(ROOT, d)));
for (const f of SCAN_FILES) {
  const p = join(ROOT, f);
  if (existsSync(p)) targets.push(p);
}

// VACUITY GUARD. A check that examines nothing passes, and would keep passing
// after a rename or a restructure that moved every scanned tree. That is the
// failure this repo has already paid for more than once, so the floor is
// asserted rather than assumed.
const MIN_FILES = 50;
if (targets.length < MIN_FILES) {
  console.error(
    `✘ check-dev-proxy-not-shipped: scanned only ${targets.length} file(s), ` +
      `expected at least ${MIN_FILES}.\n` +
      `  This check examined almost nothing and would have passed regardless of ` +
      `what the code does.\n` +
      `  Scanned: ${SCAN_DIRS.join(", ")} + ${SCAN_FILES.join(", ")} under ${ROOT}\n` +
      `  Either a scanned tree was renamed or moved, or this guard is pointed at ` +
      `the wrong root. Fix the guard — do not lower the floor.`,
  );
  process.exit(1);
}

const violations = [];
for (const file of targets) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes(PROXY_BASENAME)) continue;

  text.split("\n").forEach((line, i) => {
    if (line.includes(PROXY_BASENAME)) {
      violations.push({ file: relative(ROOT, file), line: i + 1, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `✘ check-dev-proxy-not-shipped: the DEV-ONLY API proxy is referenced from ` +
      `shipped code.\n`,
  );
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}\n      ${v.text}`);
  }
  console.error(
    `\n  scripts/${PROXY_BASENAME}.mjs forwards browser traffic to a configured API\n` +
      `  target, and during the B3 probe that target is PRODUCTION. It is safe only\n` +
      `  because it is unreachable from anything that ships.\n\n` +
      `  Do NOT allowlist around this. If application code genuinely needs this\n` +
      `  behaviour, the requirement has changed and that change needs its own\n` +
      `  review.`,
  );
  process.exit(1);
}

console.log(
  `✅ check-dev-proxy-not-shipped: ${targets.length} shipped file(s) scanned ` +
    `(${SCAN_DIRS.join(", ")}, ${SCAN_FILES.join(", ")}); ` +
    `no reference to scripts/${PROXY_BASENAME}.mjs.`,
);
