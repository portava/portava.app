import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdaptiveArtifacts } from "../lib/media/adaptive/artifacts.js";

const ASSET = "aa000000-0000-4000-8000-000000000001";
const OTHER = "bb000000-0000-4000-8000-000000000001";
const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "adaptive-root-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("nonempty unmarked configuration root is refused without chmod or new children", async () => {
  const root = await temporaryRoot();
  await chmod(root, 0o750);
  await writeFile(join(root, "unrelated.txt"), "preserve unrelated contents", { mode: 0o640 });
  const rootMode = (await lstat(root)).mode;
  const fileMode = (await lstat(join(root, "unrelated.txt"))).mode;
  await assert.rejects(new AdaptiveArtifacts(root).initialize(), /unmarked/);
  assert.equal((await lstat(root)).mode, rootMode);
  assert.equal((await lstat(join(root, "unrelated.txt"))).mode, fileMode);
  assert.deepEqual(await readdir(root), ["unrelated.txt"]);
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "preserve unrelated contents");
});

test("an unmarked root containing staging or outputs is not adopted or erased", async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, "outputs"), { mode: 0o750 });
  const output = join(root, "outputs", `${ASSET}-7-lease`);
  await mkdir(output);
  await writeFile(join(output, "sentinel"), "not adopted");
  const mode = (await lstat(join(root, "outputs"))).mode;
  await assert.rejects(new AdaptiveArtifacts(root).erase(ASSET), /unmarked/);
  assert.equal((await lstat(join(root, "outputs"))).mode, mode);
  assert.equal(await readFile(join(output, "sentinel"), "utf8"), "not adopted");
});

test("invalid erasure IDs fail before initialization or scanning", async () => {
  const root = await temporaryRoot();
  const store = new AdaptiveArtifacts(root);
  for (const assetId of ["", "aa000000", "../", "not-a-uuid"]) await assert.rejects(store.erase(assetId), /asset id/);
  assert.deepEqual(await readdir(root), []);
});

test("empty dedicated root gains a verified marker, supports repeat initialization and rejects marker tampering", async () => {
  const root = await temporaryRoot();
  const store = new AdaptiveArtifacts(root);
  await store.initialize();
  assert.equal(await readFile(join(root, ".portava-adaptive-root"), "utf8"), "portava-adaptive-root:v1\n");
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  await store.initialize();
  await writeFile(join(root, ".portava-adaptive-root"), "wrong marker\n");
  await chmod(root, 0o750);
  await assert.rejects(store.initialize(), /marker/);
  assert.equal((await lstat(root)).mode & 0o777, 0o750);
});

test("symlinked marker or owned subdirectory is refused without changing its target", async () => {
  const outside = await temporaryRoot();
  const root = await temporaryRoot();
  const target = join(outside, "marker");
  await writeFile(target, "portava-adaptive-root:v1\n", { mode: 0o640 });
  await symlink(target, join(root, ".portava-adaptive-root"));
  await assert.rejects(new AdaptiveArtifacts(root).initialize());
  assert.equal((await lstat(target)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(root), [".portava-adaptive-root"]);
  await rm(join(root, ".portava-adaptive-root"));
  await new AdaptiveArtifacts(root).initialize();
  await rm(join(root, "outputs"), { recursive: true });
  await chmod(outside, 0o750);
  await chmod(root, 0o750);
  await symlink(outside, join(root, "outputs"));
  await assert.rejects(new AdaptiveArtifacts(root).initialize());
  assert.equal((await lstat(root)).mode & 0o777, 0o750);
  assert.equal((await lstat(outside)).mode & 0o777, 0o750);
});

test("output removal cannot bypass marker or symlinked-parent checks", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  const directory = `${ASSET}-7-lease`;
  await mkdir(join(outside, directory));
  await writeFile(join(outside, directory, "sentinel"), "outside root");
  const store = new AdaptiveArtifacts(root);
  await store.initialize();
  await rm(join(root, "outputs"), { recursive: true });
  await symlink(outside, join(root, "outputs"));
  await assert.rejects(store.removeOutput(directory));
  assert.equal(await readFile(join(outside, directory, "sentinel"), "utf8"), "outside root");
  await rm(join(root, "outputs"));
  await mkdir(join(root, "outputs"));
  await mkdir(join(root, "outputs", directory));
  await rm(join(root, ".portava-adaptive-root"));
  await assert.rejects(store.removeOutput(directory));
  assert.ok((await lstat(join(root, "outputs", directory))).isDirectory());
});

test("erasure is restricted to this UUID's well-formed artifact directories", async () => {
  const root = await temporaryRoot();
  const store = new AdaptiveArtifacts(root);
  await store.initialize();
  for (const parent of ["staging", "outputs"]) {
    for (const name of [`${ASSET}-7-lease`, `${OTHER}-7-lease`, `${ASSET}-unrelated`]) {
      await mkdir(join(root, parent, name));
      await writeFile(join(root, parent, name, "sentinel"), name);
    }
  }
  await store.erase(ASSET);
  for (const parent of ["staging", "outputs"]) {
    assert.deepEqual((await readdir(join(root, parent))).sort(), [`${ASSET}-unrelated`, `${OTHER}-7-lease`].sort());
  }
});
