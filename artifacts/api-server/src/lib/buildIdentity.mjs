import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_FILE = "build-identity.json";
const SCHEMA = "portava-api-artifact-v1";

function artifactManifest(directory) {
  const files = [];
  function visit(relativeDirectory) {
    for (const entry of readdirSync(path.join(directory, relativeDirectory), { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (relativePath === MANIFEST_FILE) continue;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile()) {
        files.push({
          path: relativePath,
          sha256: createHash("sha256").update(readFileSync(path.join(directory, relativePath))).digest("hex"),
        });
      } else throw new Error("Artifact contains a non-regular entry");
    }
  }
  visit("");
  if (!["index.mjs", "sentry-preload.mjs"].every((required) => files.some((file) => file.path === required))) {
    throw new Error("Artifact is missing required entry points");
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const payload = { schema: SCHEMA, files };
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  return { ...payload, fingerprint };
}

export function writeBuildIdentity(directory) {
  const manifest = artifactManifest(directory);
  writeFileSync(path.join(directory, MANIFEST_FILE), JSON.stringify(manifest) + "\n", { flag: "wx" });
  return manifest.fingerprint;
}

function readBuildIdentity() {
  try {
    const entryPath = fileURLToPath(import.meta.url);
    if (path.basename(entryPath) !== "index.mjs") return "unavailable";
    const directory = path.dirname(entryPath);
    const manifestPath = path.join(directory, MANIFEST_FILE);
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 1_048_576) return "unavailable";
    const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
    const actual = artifactManifest(directory);
    return JSON.stringify(expected) === JSON.stringify(actual) ? actual.fingerprint : "unavailable";
  } catch {
    return "unavailable";
  }
}

const packaged = typeof __PORTAVA_PACKAGED_API__ !== "undefined" && __PORTAVA_PACKAGED_API__ === true;
const identity = packaged && process.env.NODE_ENV !== "development" ? readBuildIdentity() : "unavailable";

export function getBuildIdentity() {
  return identity;
}
