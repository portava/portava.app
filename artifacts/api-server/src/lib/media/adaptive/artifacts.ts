import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { ADAPTIVE_LIMITS, validAssetId, validFile, validVersion, type AdaptiveOutput, type AdaptiveSource } from "./types.js";

const ROOT_MARKER = ".portava-adaptive-root";
const ROOT_MARKER_CONTENT = "portava-adaptive-root:v1\n";

async function optionalStat(filename: string) {
  try { return await lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class AdaptiveArtifacts {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) === "/") throw new Error("dedicated absolute adaptive root required");
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    if (!(await optionalStat(this.root))) await mkdir(this.root, { mode: 0o700, recursive: true });
    if (!(await lstat(this.root)).isDirectory()) throw new Error("unsafe adaptive directory");
    const marker = join(this.root, ROOT_MARKER);
    if (!(await optionalStat(marker))) {
      const entries = await opendir(this.root);
      try {
        if (await entries.read()) throw new Error("refusing nonempty unmarked adaptive root");
      } finally { await entries.close(); }
      let handle;
      try { handle = await open(marker, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (handle) {
        try { await handle.writeFile(ROOT_MARKER_CONTENT); await handle.sync(); }
        finally { await handle.close(); }
      }
    }
    await this.assertMarkedRoot();
    for (const directory of [this.root, join(this.root, "staging"), join(this.root, "outputs")]) {
      if (!(await optionalStat(directory))) await mkdir(directory, { mode: 0o700 });
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { await handle.chmod(0o700); } finally { await handle.close(); }
    }
  }

  private async assertMarkedRoot(): Promise<void> {
    if (!(await lstat(this.root)).isDirectory()) throw new Error("unsafe adaptive directory");
    const marker = join(this.root, ROOT_MARKER);
    const stat = await lstat(marker);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(ROOT_MARKER_CONTENT)) throw new Error("invalid adaptive root marker");
    const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== stat.size) throw new Error("invalid adaptive root marker");
      const buffer = Buffer.alloc(stat.size);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead !== buffer.length || buffer.toString() !== ROOT_MARKER_CONTENT) throw new Error("invalid adaptive root marker");
    } finally { await handle.close(); }
    for (const name of ["staging", "outputs"]) {
      const stat = await optionalStat(join(this.root, name));
      if (stat && !stat.isDirectory()) throw new Error("unsafe adaptive directory");
    }
  }

  async assertCleanupRoot(): Promise<void> {
    await this.assertMarkedRoot();
    if (await realpath(this.root) !== this.root) throw new Error("unsafe adaptive cleanup root");
    for (const directory of [this.root, join(this.root, "staging"), join(this.root, "outputs")]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe adaptive cleanup permissions");
    }
  }

  async workspace(source: AdaptiveSource): Promise<string> {
    if (!validAssetId(source.assetId) || !validVersion(source.sourceVersion)) throw new Error("invalid adaptive source");
    await this.initialize();
    const directory = await mkdtemp(join(this.root, "staging", `${source.assetId}-${source.sourceVersion}-`));
    await mkdir(join(directory, "out"), { mode: 0o700 });
    return directory;
  }

  async commit(workspace: string, source: AdaptiveSource, token: string): Promise<string> {
    if (!validAssetId(source.assetId) || !validVersion(source.sourceVersion)) throw new Error("invalid adaptive source");
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(token)) throw new Error("unsafe lease token");
    await this.assertMarkedRoot();
    const directory = `${source.assetId}-${source.sourceVersion}-${token}`;
    for (const name of await readdir(join(workspace, "out"))) {
      if (!validFile(name)) throw new Error("unexpected publication file");
      const handle = await open(join(workspace, "out", name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await rename(join(workspace, "out"), join(this.root, "outputs", directory));
    const handle = await open(join(this.root, "outputs"), constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
    return directory;
  }

  outputPath(directory: string): string {
    if (!/^[0-9a-f-]{36}-[1-9]\d{0,15}-[a-zA-Z0-9-]{1,80}$/i.test(directory)) throw new Error("unsafe output reference");
    return join(this.root, "outputs", directory);
  }

  async read(output: AdaptiveOutput, filename: string): Promise<Buffer | null> {
    if (!validFile(filename) || !Object.hasOwn(output.files, filename)) return null;
    const expected = output.files[filename];
    if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || expected.bytes > ADAPTIVE_LIMITS.fileBytes) return null;
    await this.assertMarkedRoot();
    const directory = this.outputPath(output.directory);
    if (!(await lstat(directory)).isDirectory()) return null;
    const handle = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.bytes) return null;
      const bytes = Buffer.alloc(expected.bytes);
      let position = 0;
      while (position < bytes.length) {
        const result = await handle.read(bytes, position, bytes.length - position, position);
        if (!result.bytesRead) return null;
        position += result.bytesRead;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) return null;
      return bytes;
    } finally { await handle.close(); }
  }

  async erase(assetId: string): Promise<void> {
    if (!validAssetId(assetId)) throw new Error("invalid asset id");
    await this.initialize();
    for (const parent of ["staging", "outputs"]) {
      for (const name of await readdir(join(this.root, parent))) {
        if (!name.toLowerCase().startsWith(`${assetId.toLowerCase()}-`)) continue;
        const suffix = /^([1-9]\d{0,15})-[a-zA-Z0-9-]{1,80}$/.exec(name.slice(assetId.length + 1));
        if (suffix && validVersion(Number(suffix[1]))) await rm(join(this.root, parent, name), { recursive: true, force: true });
      }
    }
  }

  async removeOutput(directory: string): Promise<void> {
    const output = this.outputPath(directory);
    await this.assertMarkedRoot();
    await rm(output, { recursive: true, force: true });
  }

  async withinBudget(workspace: string): Promise<boolean> {
    let total = 0;
    let count = 0;
    for (const directory of [workspace, join(workspace, "out")]) {
      for (const name of await readdir(directory)) {
        const stat = await lstat(join(directory, name));
        if (directory === workspace && name === "out" && stat.isDirectory()) continue;
        if (!stat.isFile()) return false;
        total += stat.size;
        count++;
      }
    }
    return count <= ADAPTIVE_LIMITS.files + 1 && total <= ADAPTIVE_LIMITS.inputBytes + ADAPTIVE_LIMITS.outputBytes;
  }
}
