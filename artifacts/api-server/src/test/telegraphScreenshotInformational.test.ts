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
  SCREEN_CAPTURE_MENTIONS,
  isScreenshotGuarantee,
  mentionsScreenCapture,
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


/* ══════════════════════════════════════════════════════════════════════════
 * HARDENING (lane T, mission 4, 2026-10-07) — census-telegraph §45c: "A
 * deny-list a paraphrase gets past is not C … an Expo config plugin injecting
 * FLAG_SECURE would sit outside the scan." Each hole is shown on synthetic input
 * first (the old check misses it, the new one does not), then the trees.
 * ════════════════════════════════════════════════════════════════════════ */

const collapse = (t: string) => t.replace(/\s+/g, " ").trim();

/** Every text file of a tree that can ship, any extension a build reads. */
function walkAll(dir: string, exts: RegExp, skip: ReadonlySet<string>, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkAll(p, exts, skip, out);
    else if (exts.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const NATIVE_AND_CODE = /\.(?:[cm]?[jt]sx?|json|xml|plist|gradle|kts|kt|java|swift|mm?|h|properties|html|hbs|ejs|txt)$/;
const SKIP = new Set(["node_modules", "__tests__", "__mocks__", ".expo", "dist", "build", "docs"]);
/** The whole mobile package: config, config plugins, native and vendored code, server templates — not only src/ and app/. */
const mobileAll = walkAll(CLIENT, NATIVE_AND_CODE, SKIP).filter((f) => !f.endsWith("pnpm-lock.yaml"));
/** The server package's files that are not TypeScript sources the older scan already read. */
const serverOther = walkAll(PKG, /\.(?:mjs|cjs|js|mts|html|hbs|ejs|txt)$/, new Set([...SKIP, "test", "baseline"]));

/** String literals (single-line, any quote) and JSX text, of comment-stripped code. */
function userFacingStrings(code: string): string[] {
  const out = stringLiterals(code);
  for (const m of code.matchAll(/>([^<>{}=]+)</g)) {
    const t = m[1]!.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}

/** Every string in `files` that mentions screen capture, collapsed. */
function mentionsIn(files: readonly string[]): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    const code = /\.(?:json|html|hbs|ejs|txt|xml|plist)$/.test(f) ? raw : stripComments(raw);
    for (const t of userFacingStrings(code)) if (mentionsScreenCapture(t)) out.push({ file: relative(REPO, f), text: collapse(t) });
  }
  return out;
}

const SHIPPED_CLIENT = ["src", "app", "components", "hooks", "constants", "plugins", "server"]
  .flatMap((d) => walkAll(join(CLIENT, d), NATIVE_AND_CODE, SKIP))
  .concat([join(CLIENT, "app.json")].filter(existsSync));

describe("T408 hardening — the two holes §45c named, shown on synthetic input", () => {
  it("the paraphrases §45c quoted pass the deny-list — and are caught as MENTIONS not on the closed list", () => {
    const listed = new Set(SCREEN_CAPTURE_MENTIONS.map((m) => m.text));
    for (const s of ["Screenshots aren't allowed in this chat", "Screen capture is disabled for this conversation", "Screen recording is turned off here"]) {
      assert.equal(isScreenshotGuarantee(s), false, `the deny-list now catches "${s}" — fine, but this case pins the gap the closed list closes`);
      assert.equal(mentionsScreenCapture(s), true, s);
      assert.equal(listed.has(collapse(s)), false);
    }
    // JSX text is user-facing too, and is not a string literal.
    assert.deepEqual(userFacingStrings("<Text>Screen capture is disabled</Text>").filter(mentionsScreenCapture), ["Screen capture is disabled"]);
    // A different word for the same thing: not a mention, so not a guarantee either.
    assert.equal(mentionsScreenCapture("Offscreen capture target"), false);
  });

  it("an Expo config plugin that sets FLAG_SECURE is seen, as are .js and native sources", () => {
    const plugin = "module.exports = (config) => withMainActivity(config, (c) => { c.modResults.contents += 'getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);'; return c; });";
    assert.ok(screenshotApisIn(plugin).includes("FLAG_SECURE"));
    assert.ok(NATIVE_AND_CODE.test("withSecure.js") && NATIVE_AND_CODE.test("MainActivity.kt") && NATIVE_AND_CODE.test("AppDelegate.mm") && NATIVE_AND_CODE.test("app.json"));
    assert.ok(mobileAll.some((f) => f.endsWith("plugins/withPortavaNSE.js")), "config plugins are not scanned");
    assert.ok(mobileAll.some((f) => f.endsWith("app.json")), "the Expo app config is not scanned");
    assert.ok(mobileAll.some((f) => f.includes(`${join("server", "templates")}`)), "the mobile package's server templates are not scanned");
  });
});

describe("T408 hardening — the trees, read whole", () => {
  it("no file of the mobile package, nor any non-TypeScript server file, uses or names a capture API", () => {
    assert.ok(mobileAll.length > clientFiles.length, `the wide scan read ${mobileAll.length} files, the old one ${clientFiles.length}`);
    const hits: string[] = [];
    for (const f of [...mobileAll, ...serverOther]) {
      if (allowedSites.has(f)) continue;
      const raw = readFileSync(f, "utf8");
      const apis = screenshotApisIn(/\.(?:json|xml|plist|html|hbs|ejs|txt)$/.test(f) ? raw : stripComments(raw));
      if (apis.length > 0) hits.push(`${relative(REPO, f)}: ${apis.join(", ")}`);
    }
    assert.deepEqual(hits, []);
  });

  it("the Expo config names no capture plugin", () => {
    const expo = JSON.parse(readFileSync(join(CLIENT, "app.json"), "utf8")).expo ?? {};
    const plugins = ((expo.plugins ?? []) as unknown[]).map((p) => (Array.isArray(p) ? String(p[0]) : String(p)));
    assert.ok(plugins.length > 0, "no plugins read — the check would be vacuous");
    assert.deepEqual(plugins.filter((p) => screenshotApisIn(p).length > 0 || /screen|secure/i.test(p)), []);
  });

  it("every string in either tree that mentions screen capture is on the closed list, and every listed one is informational and still present", () => {
    const listed = new Map(SCREEN_CAPTURE_MENTIONS.map((m) => [`${m.tree}:${m.text}`, m]));
    const found = [
      ...mentionsIn(SHIPPED_CLIENT).map((m) => ({ ...m, tree: "client" as const })),
      ...mentionsIn([...serverFiles, ...serverOther]).map((m) => ({ ...m, tree: "server" as const })),
    ];
    const unlisted = found.filter((m) => !listed.has(`${m.tree}:${m.text}`)).map((m) => `${m.file}: ${m.text}`);
    assert.deepEqual(unlisted, [], "§30A.9: a string that talks about screen capture must be reviewed onto SCREEN_CAPTURE_MENTIONS " +
      "with why it is informational. It may say someone took one; it may never say the app stops it.");
    const seen = new Set(found.map((m) => `${m.tree}:${m.text}`));
    for (const [key, m] of listed) {
      assert.ok(seen.has(key), `${key} is listed and no longer appears — remove it`);
      assert.equal(isScreenshotGuarantee(m.text), false, `${key} reads as a guarantee`);
      assert.ok(m.why.length > 20);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * WAVE 5 (2026-10-17) — census-telegraph T408: an ALLOWLIST of approved copy.
 * The latest statement keeps T408 W because the copy check is a keyword
 * pattern a paraphrase passes ("No one can capture this chat", "Snapshots are
 * blocked in this conversation", "This chat is capture-protected"). At a
 * detection site, copy is now an exact allowlist; elsewhere, a wider
 * claim-shaped net with a closed reviewed list.
 * ════════════════════════════════════════════════════════════════════════ */

const w5 = await import("../domain/telegraph/policies/screenshotSignal.js");
const { TEMPLATES } = await import("../services/notifications/NotificationTemplateService.js");
const VERIFIER_PARAPHRASES = ["No one can capture this chat", "Snapshots are blocked in this conversation", "This chat is capture-protected"];

/** Every claim-shaped user-facing string in `files`, collapsed. */
function claimsIn(files: readonly string[]): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const f of files) {
    const raw = readFileSync(f, "utf8");
    const code = /\.(?:json|html|hbs|ejs|txt|xml|plist)$/.test(f) ? raw : stripComments(raw);
    for (const t of userFacingStrings(code)) if (w5.claimsCaptureProtection(t)) out.push({ file: relative(REPO, f), text: collapse(t) });
  }
  return out;
}

describe("T408 wave 5 — at a detection site, copy is an exact allowlist (any wording not on it is red)", () => {
  it("the three paraphrases the verifier named passed BOTH old checks; at a site, each is unapproved copy", () => {
    for (const s of VERIFIER_PARAPHRASES) {
      assert.equal(isScreenshotGuarantee(s), false, `the old deny-list now catches "${s}" — this case pins the gap`);
      assert.equal(mentionsScreenCapture(s), false, `the old mention pattern now catches "${s}" — this case pins the gap`);
      const site = `import * as SC from "expo-screen-capture";\nexport function Banner() { SC.addScreenshotListener(() => undefined); return <Text>${s}</Text>; }`;
      assert.deepEqual(w5.unapprovedSiteCopy(site), [s], s);
    }
  });

  it("a site that shows only approved sentences is clean; specifiers and identifiers are not copy", () => {
    const [took, informational] = w5.APPROVED_SCREEN_CAPTURE_COPY.map((c) => c.text);
    const site = `import * as SC from "expo-screen-capture"; import { x } from "../lib/y";\nconst a = "${took}"; const b = '${informational}'; const k = "took_screenshot"; style={{ align: "flex-start" }}`;
    assert.deepEqual(w5.unapprovedSiteCopy(site), []);
    assert.deepEqual(w5.unapprovedSiteCopy(`const t = "Protected";`), ["Protected"], "a one-word claim is copy too");
  });

  it("every approved sentence is informational: not a guarantee, by the deny-list or by a reviewer's reason", () => {
    assert.ok(w5.APPROVED_SCREEN_CAPTURE_COPY.length > 0);
    const keys = new Set<string>();
    for (const c of w5.APPROVED_SCREEN_CAPTURE_COPY) {
      assert.equal(isScreenshotGuarantee(c.text), false, c.text);
      assert.ok(c.why.length > 40, `${c.key}: a reason, not a label`);
      assert.ok(!keys.has(c.key), `${c.key} twice`);
      keys.add(c.key);
    }
  });

  it("every declared site (none today) shows only approved copy", () => {
    for (const s of SCREENSHOT_SIGNAL_SITES) {
      assert.deepEqual(w5.unapprovedSiteCopy(stripComments(readFileSync(join(REPO, s.file), "utf8"))), [], `${s.file} shows copy that is not approved`);
    }
  });
});

describe("T408 wave 5 — everywhere else, a wider net with a closed reviewed list", () => {
  it("the claim shape catches the verifier's paraphrases and their kin, and not the signal itself", () => {
    for (const s of [...VERIFIER_PARAPHRASES, "Messages here can't be copied", "We stop screenshots", "Screen recording is off for this chat", "Your chats are secure from capture"]) {
      assert.equal(w5.claimsCaptureProtection(s), true, s);
    }
    for (const s of ["Alex took a screenshot", "A transferred screenshot is not a ticket.", "Copy link", "Blocked users"]) {
      assert.equal(w5.claimsCaptureProtection(s), false, s);
    }
  });

  it("every claim-shaped string in the client's shipped copy and the rendered notification templates is reviewed, and every reviewed one is still there", () => {
    const params = { actor: "Alex", name: "Alex", preview: "See you at 8", act: "is on the way", threadId: "t", title: "Dinner", location: "Pier", tripTitle: "Hue" };
    const found = [
      ...claimsIn(SHIPPED_CLIENT),
      ...TEMPLATES.flatMap((t) => [t.title(params), t.body(params)].filter((x) => w5.claimsCaptureProtection(x)).map((x) => ({ file: `template:${t.eventType}`, text: collapse(x) }))),
    ];
    const reviewed = new Map(w5.REVIEWED_CLAIM_SHAPED_COPY.map((r) => [r.text, r]));
    const unreviewed = found.filter((f) => !reviewed.has(f.text)).map((f) => `${f.file}: ${f.text}`);
    assert.deepEqual(unreviewed, [], "§30A.9: a string pairing a protection word with a copying word must be reviewed onto REVIEWED_CLAIM_SHAPED_COPY with why it is not a promise that capture is stopped");
    const seen = new Set(found.map((f) => f.text));
    for (const r of w5.REVIEWED_CLAIM_SHAPED_COPY) {
      assert.ok(seen.has(r.text), `"${r.text}" is reviewed and no longer appears — remove it`);
      assert.equal(isScreenshotGuarantee(r.text), false, r.text);
      assert.ok(r.why.length > 30, r.text);
    }
  });
});
