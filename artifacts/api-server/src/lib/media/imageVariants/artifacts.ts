import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, rm, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { abortable, IMAGE_VARIANTS_LIMITS, UUID, validSource, validManifest, variantMime, type ImageVariantSource, type EncodedImageVariants, type PublishedImageVariants } from "./contracts.js";

const MARKER = "portava-private-image-variants:v1\n";
export interface ImageVariantArtifactCandidate { assetId: string; sourceVersion: number; token: string }
export interface ImageVariantArtifactSnapshot extends ImageVariantArtifactCandidate { fingerprint: string; files: number; bytes: number }
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
const stamp = (stat: Stats) => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}:${stat.nlink}`;
function validCandidate(candidate: ImageVariantArtifactCandidate) {
  return UUID.test(candidate.assetId) && UUID.test(candidate.token) && Number.isSafeInteger(candidate.sourceVersion) && candidate.sourceVersion > 0 && candidate.sourceVersion <= 2147483647;
}
async function statOrNull(filename: string) {
  try { return await lstat(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function directory(filename: string) {
  await mkdir(filename, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(filename);
  if (!stat.isDirectory() || stat.mode & 0o077) throw new Error("private image directory required");
}
async function syncDirectory(filename: string) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writePrivate(filename: string, bytes: Buffer) {
  const handle = await open(filename, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class ImageVariantArtifacts {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) === "/") throw new Error("dedicated image artifact root required");
    this.root = resolve(root);
  }
  async initialize() {
    await directory(this.root);
    const marker = join(this.root, ".image-variants-root");
    if (!await statOrNull(marker)) {
      if ((await readdir(this.root)).length) throw new Error("unmarked image artifact root");
      await writePrivate(marker, Buffer.from(MARKER));
    }
    const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(MARKER) || (await handle.readFile()).toString() !== MARKER) throw new Error("invalid image root marker");
    } finally { await handle.close(); }
    for (const name of ["assets", "locks", "revoked"]) await directory(join(this.root, name));
    await syncDirectory(this.root);
  }
  async revoked(assetId: string): Promise<boolean> {
    if (!UUID.test(assetId)) throw new Error("invalid image asset");
    await this.initialize();
    return !!await statOrNull(join(this.root, "revoked", assetId));
  }
  private location(source: ImageVariantSource, token: string): string {
    if (!validSource(source) || !UUID.test(token)) throw new Error("invalid image lease identity");
    return join(this.root, "assets", source.assetId, String(source.sourceVersion), token);
  }
  private async locked<Value>(assetId: string, operation: () => Promise<Value>, signal?: AbortSignal): Promise<Value> {
    if (!UUID.test(assetId)) throw new Error("invalid image asset");
    signal?.throwIfAborted();
    await this.initialize();
    const lock = join(this.root, "locks", assetId);
    const deadline = Date.now() + 5000;
    while (true) {
      signal?.throwIfAborted();
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new Error("image artifact lock unavailable");
        await delay(20, undefined, { signal });
      }
    }
    try { return await operation(); } finally { await rm(lock, { recursive: true }); }
  }
  async write(source: ImageVariantSource, token: string, encoded: EncodedImageVariants, current: () => Promise<void>): Promise<void> {
    const destination = this.location(source, token);
    if (!validManifest(encoded.manifest)) throw new Error("invalid image manifest");
    await this.locked(source.assetId, async () => {
      await current();
      if (await this.revoked(source.assetId)) throw new Error("image artifacts revoked");
      const assetDirectory = join(this.root, "assets", source.assetId);
      const versionDirectory = join(assetDirectory, String(source.sourceVersion));
      await directory(assetDirectory); await directory(versionDirectory);
      await mkdir(destination, { mode: 0o700 });
      try {
        for (const [filename, file] of Object.entries(encoded.manifest.files)) {
          const bytes = encoded.buffers[filename];
          if (!bytes || bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("image artifact integrity mismatch");
          await writePrivate(join(destination, filename), bytes);
          await current();
          if (await this.revoked(source.assetId)) throw new Error("image artifacts revoked");
        }
        await syncDirectory(destination); await syncDirectory(versionDirectory); await syncDirectory(assetDirectory); await syncDirectory(join(this.root, "assets"));
      } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
    });
  }
  async read(output: PublishedImageVariants, filename: string): Promise<Buffer | null> {
    if (!validManifest(output) || !variantMime(filename) || !Object.hasOwn(output.files, filename) || await this.revoked(output.source.assetId)) return null;
    const destination = this.location(output.source, output.token);
    for (const part of [join(this.root, "assets", output.source.assetId), join(this.root, "assets", output.source.assetId, String(output.source.sourceVersion)), destination]) {
      if (!(await statOrNull(part))?.isDirectory()) return null;
    }
    const expected = output.files[filename];
    const handle = await open(join(destination, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.bytes) return null;
      const bytes = Buffer.alloc(expected.bytes);
      let position = 0;
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position);
        if (!result.bytesRead) return null;
        position += result.bytesRead;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256 || await this.revoked(output.source.assetId)) { bytes.fill(0); return null; }
      return bytes;
    } finally { await handle.close(); }
  }
  async discard(source: ImageVariantSource, token: string) {
    const destination = this.location(source, token);
    await this.locked(source.assetId, async () => {
      for (const ancestor of [join(this.root, "assets", source.assetId), join(this.root, "assets", source.assetId, String(source.sourceVersion))]) {
        const stat = await statOrNull(ancestor);
        if (!stat) return;
        if (!stat.isDirectory()) throw new Error("unsafe image cleanup directory");
      }
      await rm(destination, { recursive: true, force: true });
    });
  }
  async erase(assetId: string, cancel: () => Promise<void>): Promise<void> {
    if (!UUID.test(assetId)) throw new Error("invalid image asset");
    await this.initialize();
    const tombstone = join(this.root, "revoked", assetId);
    await writePrivate(tombstone, Buffer.from("revoked\n")).catch(error => { if (error.code !== "EEXIST") throw error; });
    await syncDirectory(join(this.root, "revoked"));
    await this.locked(assetId, async () => {
      await cancel();
      await rm(join(this.root, "assets", assetId), { recursive: true, force: true });
      await syncDirectory(join(this.root, "assets"));
      if (await statOrNull(join(this.root, "assets", assetId))) throw new Error("image artifact erasure incomplete");
    });
  }
  async assertCleanupRoot(): Promise<void> {
    for (const path of [this.root, ...["assets", "locks", "revoked"].map(name => join(this.root, name))]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.mode & 0o077) throw new Error("unsafe image cleanup root");
    }
    const handle = await open(join(this.root, ".image-variants-root"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size !== Buffer.byteLength(MARKER) || (await handle.readFile()).toString() !== MARKER) throw new Error("unsafe image cleanup marker");
    } finally { await handle.close(); }
  }
  async *inventory(signal: AbortSignal): AsyncGenerator<ImageVariantArtifactCandidate> {
    signal.throwIfAborted();
    await this.assertCleanupRoot();
    const assets = await opendir(join(this.root, "assets"));
    for await (const asset of assets) {
      signal.throwIfAborted();
      if (!UUID.test(asset.name) || !asset.isDirectory()) throw new Error("unsafe image inventory asset");
      const versions = await opendir(join(this.root, "assets", asset.name));
      for await (const version of versions) {
        signal.throwIfAborted();
        const sourceVersion = Number(version.name);
        if (!/^[1-9]\d*$/.test(version.name) || !Number.isSafeInteger(sourceVersion) || sourceVersion > 2147483647 || !version.isDirectory()) throw new Error("unsafe image inventory generation");
        const leases = await opendir(join(this.root, "assets", asset.name, version.name));
        for await (const lease of leases) {
          signal.throwIfAborted();
          if (!UUID.test(lease.name) || !lease.isDirectory()) throw new Error("unsafe image inventory lease");
          yield { assetId: asset.name, sourceVersion, token: lease.name };
        }
      }
    }
  }
  private async cleanupSnapshot(candidate: ImageVariantArtifactCandidate, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!validCandidate(candidate)) throw new Error("invalid image orphan identity");
    await this.assertCleanupRoot();
    const asset = join(this.root, "assets", candidate.assetId);
    const version = join(asset, String(candidate.sourceVersion));
    const path = join(version, candidate.token);
    const directories: Array<{ path: string; identity: string }> = [];
    let directoryStamp = "";
    for (const directory of [asset, version, path]) {
      signal.throwIfAborted();
      const stat = await statOrNull(directory);
      if (!stat) return null;
      if (!stat.isDirectory() || stat.mode & 0o077) throw new Error("unsafe image orphan directory");
      directories.push({ path: directory, identity: identity(stat) });
      directoryStamp = stamp(stat);
    }
    const files: Array<{ name: string; stamp: string }> = [];
    let bytes = 0;
    const listing = await opendir(path);
    for await (const entry of listing) {
      signal.throwIfAborted();
      const stat = await lstat(join(path, entry.name));
      if (!variantMime(entry.name) || !stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > IMAGE_VARIANTS_LIMITS.fileBytes) throw new Error("unsafe image orphan file");
      bytes += stat.size;
      files.push({ name: entry.name, stamp: stamp(stat) });
      if (files.length > IMAGE_VARIANTS_LIMITS.files || bytes > IMAGE_VARIANTS_LIMITS.outputBytes) throw new Error("unsafe image orphan bounds");
    }
    if (stamp(await lstat(path)) !== directoryStamp) throw new Error("image orphan changed while inspecting");
    files.sort((left, right) => left.name.localeCompare(right.name));
    const fingerprint = createHash("sha256").update(JSON.stringify([directories, directoryStamp, files])).digest("hex");
    return { path, directories, files, bytes, fingerprint };
  }
  async inspect(candidate: ImageVariantArtifactCandidate, signal: AbortSignal): Promise<ImageVariantArtifactSnapshot | null> {
    const snapshot = await this.cleanupSnapshot(candidate, signal);
    return snapshot ? { assetId: candidate.assetId, sourceVersion: candidate.sourceVersion, token: candidate.token,
      fingerprint: snapshot.fingerprint, files: snapshot.files.length, bytes: snapshot.bytes } : null;
  }
  async eraseOrphan(snapshot: ImageVariantArtifactSnapshot,
    canErase: (candidate: ImageVariantArtifactCandidate, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (!validCandidate(snapshot) || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint)) throw new Error("invalid image orphan snapshot");
    await this.assertCleanupRoot();
    return this.locked(snapshot.assetId, async () => {
      const before = await this.cleanupSnapshot(snapshot, signal);
      if (!before || before.fingerprint !== snapshot.fingerprint) return false;
      const candidate = { assetId: snapshot.assetId, sourceVersion: snapshot.sourceVersion, token: snapshot.token };
      if (await abortable(canErase(candidate, signal), signal) !== true) return false;
      const current = await this.cleanupSnapshot(candidate, signal);
      if (!current || current.fingerprint !== before.fingerprint) return false;
      signal.throwIfAborted();
      await writePrivate(join(this.root, "revoked", candidate.assetId), Buffer.from("revoked\n")).catch(error => { if (error.code !== "EEXIST") throw error; });
      await syncDirectory(join(this.root, "revoked"));
      for (const file of current.files) {
        signal.throwIfAborted();
        await this.assertCleanupRoot();
        for (const directory of current.directories) {
          const stat = await lstat(directory.path);
          if (!stat.isDirectory() || identity(stat) !== directory.identity) throw new Error("image orphan directory changed during erasure");
        }
        const path = join(current.path, file.name);
        if (stamp(await lstat(path)) !== file.stamp) throw new Error("image orphan file changed during erasure");
        await unlink(path);
      }
      signal.throwIfAborted();
      await rmdir(current.path);
      for (const directory of current.directories.slice(0, 2).reverse()) {
        const stat = await lstat(directory.path);
        if (!stat.isDirectory() || identity(stat) !== directory.identity) throw new Error("image orphan parent changed during erasure");
        await rmdir(directory.path).catch(error => { if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
      }
      await syncDirectory(join(this.root, "assets"));
      return true;
    }, signal);
  }
}
