/**
 * census-telegraph T408 — §30A.9: "Screenshot detection, if later supported by a
 * platform, is informational only and is never presented as a guarantee against
 * copying."
 *
 * The row was an UNGUARDED ABSENCE. Guarded now, on T19's precedent, by the
 * closed lists in `domain/telegraph/policies/screenshotSignal.ts`:
 *
 *   1. The detectors fire on synthetic input (a guard that cannot fail is not one).
 *   2. No capture-detection or capture-prevention API is used, or depended on, in
 *      either tree outside `SCREENSHOT_SIGNAL_SITES` — which is empty.
 *   3. No user-facing copy in the client presents screen capture as blocked,
 *      prevented or impossible; nor does any server-side string (notification
 *      templates and API messages are user-facing too).
 *
 * SHOWN RED (recorded in the T2 lane report): `addScreenshotListener` added to
 * `travel-buddy-standalone/src/features/telegraph/lib/requestOriginLabel.ts` turns
 * test 2 red naming that file; the string "Screenshots are blocked in this chat"
 * added to a Telegraph component turns test 3 red. Both reverted, green.
 *
 * Run: node --import tsx/esm --test src/test/telegraphScreenshotInformational.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCREENSHOT_CAPTURE_APIS,
  SCREENSHOT_SIGNAL_SITES,
  isScreenshotGuarantee,
  screenshotApisIn,
} from "../domain/telegraph/policies/screenshotSignal.js";
import { stripComments } from "../domain/telegraph/policies/conversationMemoryBoundary.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");
const CLIENT = join(REPO, "travel-buddy-standalone");

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "__tests__" || name === "test") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const clientFiles = [...walk(join(CLIENT, "src"), /\.tsx?$/), ...walk(join(CLIENT, "app"), /\.tsx?$/)];
const serverFiles = walk(join(PKG, "src"), /\.ts$/).filter(
  (f) => !f.endsWith("domain/telegraph/policies/screenshotSignal.ts"),
);
const allowedSites = new Set(SCREENSHOT_SIGNAL_SITES.map((s) => join(REPO, s.file)));

/** Single-line string literals of comment-stripped code. */
function stringLiterals(code: string): string[] {
  return [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]!);
}

describe("T408 — the detectors can fire", () => {
  it("guarantee copy is recognised; informational copy is not", () => {
    for (const s of [
      "Screenshots are blocked in this chat",
      "This conversation can't be screenshotted",
      "Screenshot-proof messages",
      "We prevent screenshots of your photos",
      "Protected from screenshots",
      "No one can take a screenshot here",
    ]) assert.equal(isScreenshotGuarantee(s), true, s);
    for (const s of [
      "Alex took a screenshot",
      "A transferred screenshot is not a ticket.",
      "what a support screenshot needs",
      "Screenshot detection is informational only",
    ]) assert.equal(isScreenshotGuarantee(s), false, s);
  });

  it("capture APIs are recognised by name", () => {
    assert.deepEqual(
      screenshotApisIn("import * as ScreenCapture from 'expo-screen-capture'; ScreenCapture.addScreenshotListener(f);"),
      ["expo-screen-capture", "addScreenshotListener"],
    );
    assert.deepEqual(screenshotApisIn("const x = 1;"), []);
  });
});

describe("T408 — no capture detection outside the (empty) informational list", () => {
  it("the scan is not vacuous", () => {
    assert.ok(clientFiles.length > 300, `client files: ${clientFiles.length}`);
    assert.ok(serverFiles.length > 500, `server files: ${serverFiles.length}`);
    assert.ok(SCREENSHOT_CAPTURE_APIS.length >= 8);
  });

  it("no module in either tree uses a capture API unless it is a declared informational site", () => {
    const hits: string[] = [];
    for (const f of [...clientFiles, ...serverFiles]) {
      if (allowedSites.has(f)) continue;
      const apis = screenshotApisIn(stripComments(readFileSync(f, "utf8")));
      if (apis.length > 0) hits.push(`${relative(REPO, f)}: ${apis.join(", ")}`);
    }
    assert.deepEqual(
      hits,
      [],
      "§30A.9: screenshot detection is informational only. Add the module to SCREENSHOT_SIGNAL_SITES " +
        "with presentation: 'informational' — and never present it as a guarantee.",
    );
  });

  it("no package in either manifest provides capture detection or prevention", () => {
    for (const manifest of [join(CLIENT, "package.json"), join(PKG, "package.json"), join(REPO, "package.json")]) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const found = Object.keys(deps).filter((d) => (SCREENSHOT_CAPTURE_APIS as readonly string[]).includes(d));
      assert.deepEqual(found, [], `${relative(REPO, manifest)} depends on ${found.join(", ")}`);
    }
  });

  it("every declared site (none today) is informational and exists", () => {
    for (const s of SCREENSHOT_SIGNAL_SITES) {
      assert.equal(s.presentation, "informational");
      assert.ok(existsSync(join(REPO, s.file)), `${s.file} is declared and missing`);
    }
  });
});

describe("T408 — nothing tells a person screen capture is prevented", () => {
  it("no client copy presents screenshotting as blocked, prevented or impossible", () => {
    const hits: string[] = [];
    for (const f of clientFiles) {
      const code = stripComments(readFileSync(f, "utf8"));
      for (const line of code.split("\n")) {
        if (isScreenshotGuarantee(line)) hits.push(`${relative(REPO, f)}: ${line.trim().slice(0, 140)}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  it("no server string (templates, API messages) presents it as a guarantee either", () => {
    const hits: string[] = [];
    for (const f of serverFiles) {
      for (const s of stringLiterals(stripComments(readFileSync(f, "utf8")))) {
        if (isScreenshotGuarantee(s)) hits.push(`${relative(REPO, f)}: ${s.slice(0, 140)}`);
      }
    }
    assert.deepEqual(hits, []);
  });
});
