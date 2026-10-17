import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const port = "55433";

export const videoSegmentNativeIds = {
  owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  memory: "10000000-0000-4000-8000-000000000001",
  otherMemory: "10000000-0000-4000-8000-000000000002",
  item: "20000000-0000-4000-8000-000000000001",
  otherItem: "20000000-0000-4000-8000-000000000002",
  asset: "30000000-0000-4000-8000-000000000001",
  otherAsset: "30000000-0000-4000-8000-000000000002",
  segment: "40000000-0000-4000-8000-000000000001",
};

export class VideoSegmentNativeSession {
  private process: ChildProcessWithoutNullStreams;
  private output = "";
  private errors = "";
  private failure?: Error;
  private pending?: { marker: string; resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

  constructor(binary: string, socket: string, environment: NodeJS.ProcessEnv) {
    this.process = spawn(binary, ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
      "-h", socket, "-p", port, "-U", "postgres", "-d", "postgres"], { env: environment, stdio: "pipe" });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.output += chunk;
      const pending = this.pending;
      if (!pending) return;
      const position = this.output.indexOf(`${pending.marker}\n`);
      if (position < 0) return;
      clearTimeout(pending.timer);
      const result = this.output.slice(0, position).trim();
      this.output = this.output.slice(position + pending.marker.length + 1);
      this.pending = undefined;
      pending.resolve(result);
    });
    this.process.stderr.on("data", (chunk: string) => { this.errors = (this.errors + chunk).slice(-32000); });
    this.process.on("error", error => this.fail(error));
    this.process.on("exit", (code, signal) => this.fail(new Error(`psql exited ${code ?? signal}: ${this.errors}`)));
  }

  private fail(error: Error) {
    this.failure = error;
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }

  query(sql: string): Promise<string> {
    assert.equal(this.pending, undefined, "one command per backend at a time");
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const marker = `segments_${randomUUID().replaceAll("-", "")}`;
      const timer = setTimeout(() => {
        this.fail(new Error(`native segment command exceeded 8 seconds: ${this.errors}`));
        this.process.kill("SIGKILL");
      }, 8000);
      this.pending = { marker, resolve, reject, timer };
      this.process.stdin.write(`${sql}\n\\echo ${marker}\n`, error => { if (error) this.fail(error); });
    });
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.process.kill("SIGKILL"), 1000);
      this.process.once("exit", () => { clearTimeout(timer); resolve(); });
      this.process.stdin.end("\\q\n");
    });
  }
}

export class VideoSegmentNativeCluster {
  root = "";
  private sessions = new Set<VideoSegmentNativeSession>();
  private environment: NodeJS.ProcessEnv = {};

  constructor(private binaryDirectory: string) {}

  async start() {
    assert.ok(isAbsolute(this.binaryDirectory), "native PostgreSQL bin must be an explicit absolute path");
    for (const binary of ["postgres", "initdb", "pg_ctl", "psql"]) await access(join(this.binaryDirectory, binary), constants.X_OK);
    this.root = await realpath(await mkdtemp("/tmp/MemoryVideoSegments-pg-"));
    this.environment = { PATH: "/usr/bin:/bin", HOME: this.root, LC_ALL: "C" };
    const socket = join(this.root, "socket");
    await mkdir(socket, { mode: 0o700 });
    await run(join(this.binaryDirectory, "initdb"), ["-D", join(this.root, "data"), "-U", "postgres", "--auth-local=trust",
      "--auth-host=reject", "--no-locale", "-E", "UTF8"], { env: this.environment, timeout: 20000 });
    await run(join(this.binaryDirectory, "pg_ctl"), ["-D", join(this.root, "data"), "-l", join(this.root, "postgres.log"), "-w", "-t", "10",
      "-o", `-F -h '' -k '${socket}' -p ${port} -c unix_socket_permissions=0700 -c deadlock_timeout=200ms`, "start"],
    { env: this.environment, timeout: 15000 });
    const session = this.session();
    assert.equal(await session.query("SHOW listen_addresses;"), "");
    assert.equal(await session.query("SHOW unix_socket_directories;"), socket);
    assert.equal(await session.query("SHOW data_directory;"), join(this.root, "data"));
    assert.equal(await session.query("SELECT inet_server_addr() IS NULL;"), "t");
    const version = Number(await session.query("SHOW server_version_num;"));
    assert.ok(version >= 170000 && version < 180000, `PostgreSQL 17 required, received ${version}`);
    await session.query(await videoSegmentNativeSchema());
    assert.equal(await session.query("SELECT enabled FROM feature_flags WHERE flag = 'memory_video_segments_enabled';"), "f");
    await session.close();
  }

  session(): VideoSegmentNativeSession {
    assert.ok(this.root, "start the isolated cluster first");
    const session = new VideoSegmentNativeSession(join(this.binaryDirectory, "psql"), join(this.root, "socket"), this.environment);
    this.sessions.add(session);
    return session;
  }

  async close() {
    await Promise.all([...this.sessions].map(session => session.close()));
    if (!this.root) return;
    if (await access(join(this.root, "data", "postmaster.pid")).then(() => true, () => false)) {
      await run(join(this.binaryDirectory, "pg_ctl"), ["-D", join(this.root, "data"), "-m", "immediate", "-w", "-t", "10", "stop"],
        { env: this.environment, timeout: 15000 });
    }
    await rm(this.root, { recursive: true, force: true });
  }
}

async function videoSegmentNativeSchema(): Promise<string> {
  const migration = await readFile(new URL("../migrations/3991_memory_video_segments.sql", import.meta.url), "utf8");
  const canonical = await readFile(new URL("../migrations/3320_media_canonical_contract_constraints.sql", import.meta.url), "utf8");
  const start = canonical.indexOf("CREATE OR REPLACE FUNCTION public.media_assets_bump_version()");
  const end = canonical.indexOf("-- ── Postconditions", start);
  assert.ok(start >= 0 && end > start, "the actual canonical version trigger must be present");
  return `
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
    INSERT INTO public.feature_flags (flag, enabled) VALUES ('memory_kernel_enabled', false);
    CREATE TABLE public.memories (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, state text, caption text);
    CREATE TABLE public.memory_items (id uuid PRIMARY KEY, memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE, media_url text, caption text);
    CREATE TABLE public.media_assets (
      id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      storage_bucket text NOT NULL, storage_path text NOT NULL, media_type text NOT NULL,
      version integer NOT NULL DEFAULT 1, duration_ms integer, processing_status text, moderation_status text, deleted_at timestamptz,
      UNIQUE (storage_bucket, storage_path)
    );
    ${canonical.slice(start, end)}
    ${migration}
  `;
}

export function videoSegmentNativeSeed(): string {
  const { owner, other, memory, otherMemory, item, otherItem, asset, otherAsset } = videoSegmentNativeIds;
  return `
    TRUNCATE auth.users CASCADE;
    UPDATE public.feature_flags SET enabled = true WHERE flag IN ('memory_kernel_enabled', 'memory_video_segments_enabled');
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    INSERT INTO public.memories (id, owner_id, state) VALUES ('${memory}', '${owner}', 'published'), ('${otherMemory}', '${other}', 'published');
    INSERT INTO public.memory_items (id, memory_id, media_url) VALUES
      ('${item}', '${memory}', 'post-media/${owner}/original.mp4'), ('${otherItem}', '${otherMemory}', 'post-media/${other}/original.mp4');
    INSERT INTO public.media_assets (id, owner_user_id, storage_bucket, storage_path, media_type, version, duration_ms, processing_status, moderation_status) VALUES
      ('${asset}', '${owner}', 'post-media', '${owner}/original.mp4', 'video', 3, 4000, 'ready', 'active'),
      ('${otherAsset}', '${other}', 'post-media', '${other}/original.mp4', 'video', 3, 4000, 'ready', 'active');
  `;
}
