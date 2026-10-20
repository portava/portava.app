import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cp, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const apiDir = fileURLToPath(new URL("../../", import.meta.url));
const healthPath = path.join(apiDir, "src/routes/health.ts");
const temporaryDirectories: string[] = [];
const originalNodeEnv = process.env.NODE_ENV;
const header = "x-portava-build";
let importSequence = 0;

afterEach(async () => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "api-build-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixture() {
  process.env.NODE_ENV = "production";
  const directory = await temporaryDirectory();
  await build({
    stdin: {
      contents: `import router from ${JSON.stringify(healthPath)};
        export function probe() {
          const layer = router.stack.find((entry) => entry.route?.path === "/healthz");
          const response = {
            headers: {}, body: null,
            set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
            json(body) { this.body = body; return this; }
          };
          layer.route.stack[0].handle({}, response);
          return response;
        }`,
      resolveDir: apiDir,
      sourcefile: "health-fixture.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(directory, "index.mjs"),
    sourcemap: "linked",
    define: { __PORTAVA_PACKAGED_API__: "true" },
    logLevel: "silent",
    plugins: [{
      name: "isolated-health-dependencies",
      setup(plugin) {
        plugin.onResolve({ filter: /^express$/ }, () => ({ path: require.resolve("express"), external: true }));
        plugin.onResolve({ filter: /^@workspace\/api-zod$/ }, () => ({ path: path.resolve(apiDir, "../../lib/api-zod/src/index.ts") }));
        plugin.onResolve({ filter: /^\.\.?\// }, (args) => {
          if (args.importer === healthPath && args.path !== "../lib/buildIdentity.mjs") {
            return { path: args.path, namespace: "inert-health-dependency" };
          }
          return undefined;
        });
        plugin.onLoad({ filter: /.*/, namespace: "inert-health-dependency" }, () => ({
          contents: 'module.exports = { asyncHandler: (handler) => handler };',
          loader: "js",
        }));
      },
    }],
  });
  await build({
    stdin: { contents: 'export const fixturePreload = "inert";', sourcefile: "preload-fixture.ts" },
    platform: "node",
    format: "esm",
    outfile: path.join(directory, "sentry-preload.mjs"),
    sourcemap: "linked",
    logLevel: "silent",
  });
  await writeFile(path.join(directory, "worker.mjs"), 'export const worker = "inert";\n');
  return directory;
}

async function seal(directory: string): Promise<string> {
  const { writeBuildIdentity } = await import("../lib/buildIdentity.mjs");
  return writeBuildIdentity(directory);
}

async function load(directory: string) {
  const url = pathToFileURL(path.join(directory, "index.mjs"));
  url.searchParams.set("instance", String(++importSequence));
  return import(url.href) as Promise<{ probe(): { headers: Record<string, string>; body: unknown } }>;
}

describe("API packaged build identity", () => {
  it("preserves the health body and marks an unsealed artifact unavailable", async () => {
    const result = (await load(await fixture())).probe();
    assert.deepEqual(result.body, { status: "ok" });
    assert.equal(result.headers[header], "unavailable");
    assert.equal(result.headers["cache-control"], "no-store");
  });

  it("serves only the sealed artifact digest, without metadata in the status body", async () => {
    const directory = await fixture();
    const expected = await seal(directory);
    const result = (await load(directory)).probe();
    assert.match(expected, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.headers[header], expected);
    assert.deepEqual(result.body, { status: "ok" });
    assert.deepEqual(Object.keys(result.headers).sort(), ["cache-control", header]);
  });

  it("does not trust runtime SHA variables or identify an unbundled source import", async () => {
    const directory = await fixture();
    const expected = await seal(directory);
    const previous = process.env.BUILD_SHA;
    process.env.BUILD_SHA = "secret-customer-data/not-a-packaged-build";
    try {
      assert.equal((await load(directory)).probe().headers[header], expected);
      const { getBuildIdentity } = await import("../lib/buildIdentity.mjs");
      assert.equal(getBuildIdentity(), "unavailable");
    } finally {
      if (previous === undefined) delete process.env.BUILD_SHA;
      else process.env.BUILD_SHA = previous;
    }
  });

  it("reports unavailable in development even for a sealed bundle", async () => {
    const directory = await fixture();
    await seal(directory);
    process.env.NODE_ENV = "development";
    assert.equal((await load(directory)).probe().headers[header], "unavailable");
  });

  it("is content-addressed, independent of build location and file timestamps", async () => {
    const original = await fixture();
    const relocated = await temporaryDirectory();
    await cp(original, relocated, { recursive: true });
    await utimes(path.join(relocated, "index.mjs"), new Date(0), new Date(0));
    assert.equal(await seal(original), await seal(relocated));
    assert.equal((await load(original)).probe().headers[header], (await load(relocated)).probe().headers[header]);
  });

  for (const file of ["index.mjs", "sentry-preload.mjs", "worker.mjs", "index.mjs.map"]) {
    it(`refuses changed packaged bytes in ${file}`, async () => {
      const directory = await fixture();
      await seal(directory);
      await writeFile(path.join(directory, file), "\n", { flag: "a" });
      assert.equal((await load(directory)).probe().headers[header], "unavailable");
    });
  }

  it("refuses an omitted packaged file or an unexpected added file", async () => {
    const directory = await fixture();
    await seal(directory);
    const worker = await readFile(path.join(directory, "worker.mjs"));
    await rm(path.join(directory, "worker.mjs"));
    assert.equal((await load(directory)).probe().headers[header], "unavailable");
    await writeFile(path.join(directory, "worker.mjs"), worker);
    await writeFile(path.join(directory, "unexpected.mjs"), "export const unexpected = true;");
    assert.equal((await load(directory)).probe().headers[header], "unavailable");
  });

  it("refuses malformed, forged, and path-traversing identity sidecars without exposing their contents", async () => {
    const directory = await fixture();
    await seal(directory);
    for (const contents of ["not json", '{"fingerprint":"secret"}', '{"files":[{"path":"../../secret","sha256":"fake"}]}']) {
      await writeFile(path.join(directory, "build-identity.json"), contents);
      const result = (await load(directory)).probe();
      assert.equal(result.headers[header], "unavailable");
      assert.deepEqual(result.body, { status: "ok" });
    }
  });

  it("rejects symlinks both when sealing and when verifying a package", async () => {
    const directory = await fixture();
    await seal(directory);
    const externalDirectory = await temporaryDirectory();
    const external = path.join(externalDirectory, "worker.mjs");
    await writeFile(external, 'export const worker = "inert";\n');
    await rm(path.join(directory, "worker.mjs"));
    await symlink(external, path.join(directory, "worker.mjs"));
    assert.equal((await load(directory)).probe().headers[header], "unavailable");
    await rm(path.join(directory, "build-identity.json"));
    await assert.rejects(seal(directory), /non-regular/);
  });

  it("pins identity at module initialization rather than relabeling a running instance", async () => {
    const directory = await fixture();
    const expected = await seal(directory);
    const running = await load(directory);
    await rm(path.join(directory, "build-identity.json"));
    await writeFile(path.join(directory, "worker.mjs"), 'export const worker = "changed";\n');
    const replacement = await seal(directory);
    assert.notEqual(expected, replacement);
    assert.equal(running.probe().headers[header], expected);
    assert.equal((await load(directory)).probe().headers[header], replacement);
  });

  it("does not finalize an incomplete package or silently reseal an existing identity", async () => {
    const directory = await fixture();
    await seal(directory);
    await assert.rejects(seal(directory), /EEXIST/);
    await rm(path.join(directory, "build-identity.json"));
    await rm(path.join(directory, "sentry-preload.mjs"));
    await assert.rejects(seal(directory), /required entry points/);
  });

  it("finalizes the real build only after both bundle calls, with the packaged marker on main", async () => {
    const source = await readFile(path.join(apiDir, "build.mjs"), "utf8");
    assert.match(source, /import \{ writeBuildIdentity \} from "\.\/src\/lib\/buildIdentity\.mjs"/);
    assert.match(source, /define: \{ __PORTAVA_PACKAGED_API__: "true" \}/);
    assert.ok(source.indexOf("writeBuildIdentity(distDir)") > source.lastIndexOf("await esbuild({"));
  });
});
