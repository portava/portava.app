import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Packages that must remain external in EVERY bundle so they are loaded from
 * node_modules at runtime rather than inlined by esbuild.
 *
 * @sentry/node is externalised so that the sentry-preload entry point and the
 * main bundle share the same runtime module instance.  This is required for
 * the `--import ./dist/sentry-preload.mjs` trick to work: the preload calls
 * Sentry.init() before Express loads, and the main bundle's lib/sentry.ts
 * detects the already-initialised SDK via Sentry.getClient() and skips a
 * second init.  If @sentry/node were bundled into both entry points they would
 * be separate instances and the preload's init would be invisible to the main
 * bundle.
 */
const SHARED_EXTERNAL = [
  "@sentry/node",
  "@sentry/core",
  // express must be external so OTel can wrap it via Node's module-load hooks.
  // When express is bundled (inlined), OTel's require-hook interception never
  // fires and Sentry emits "express is not instrumented".  Keeping it external
  // lets Node load it through require() at runtime where OTel can patch it.
  "express",
];

/**
 * Full external list — packages that either cannot be bundled or must be
 * loaded from node_modules at runtime.
 */
const EXTERNAL = [
  ...SHARED_EXTERNAL,
  "*.node",
  "sharp",
  "better-sqlite3",
  "sqlite3",
  "canvas",
  "bcrypt",
  "argon2",
  "fsevents",
  "re2",
  "farmhash",
  "xxhash-addon",
  "bufferutil",
  "utf-8-validate",
  "ssh2",
  "cpu-features",
  "dtrace-provider",
  "isolated-vm",
  "lightningcss",
  "pg-native",
  "oracledb",
  "mongodb-client-encryption",
  "nodemailer",
  "handlebars",
  "knex",
  "typeorm",
  "protobufjs",
  "onnxruntime-node",
  "@tensorflow/*",
  "@prisma/client",
  "@mikro-orm/*",
  "@grpc/*",
  "@swc/*",
  "@aws-sdk/*",
  "@azure/*",
  "@opentelemetry/*",
  "@google-cloud/*",
  "@google/*",
  "googleapis",
  "firebase-admin",
  "@parcel/watcher",
  "@sentry/profiling-node",
  "@tree-sitter/*",
  "aws-sdk",
  "classic-level",
  "dd-trace",
  "ffi-napi",
  "grpc",
  "hiredis",
  "kerberos",
  "leveldown",
  "miniflare",
  "mysql2",
  "newrelic",
  "odbc",
  "piscina",
  "realm",
  "ref-napi",
  "rocksdb",
  "sass-embedded",
  "sequelize",
  "serialport",
  "snappy",
  "tinypool",
  "usb",
  "workerd",
  "wrangler",
  "zeromq",
  "zeromq-prebuilt",
  "playwright",
  "puppeteer",
  "puppeteer-core",
  "electron",
];

// Make sure packages that are cjs only (e.g. express) but are bundled continue
// to work in our esm output file.
const CJS_BANNER = {
  js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
  `,
};

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  // ── sentry-preload: tiny bootstrap loaded via `node --import` ────────────────
  // Must be built as a separate entry point (not inlined into the main bundle)
  // so it can be loaded before the main bundle via `node --import`.  This
  // guarantees Sentry.init() runs — and OTel instrumentation hooks are
  // registered — before Express is first require()'d by the main bundle.
  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/sentry-preload.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    sourcemap: "linked",
    external: EXTERNAL,
    banner: CJS_BANNER,
  });

  // ── main application bundle ──────────────────────────────────────────────────
  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    sourcemap: "linked",
    external: EXTERNAL,
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    banner: CJS_BANNER,
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
