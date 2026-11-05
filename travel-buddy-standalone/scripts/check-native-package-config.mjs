#!/usr/bin/env node
/** Read-only native-build preflight. It must run against the app's own install. */
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

/** Mirror op-sqlite 17.x's iOS podspec lookup using its physical install path. */
export function verifySqlcipherManifest(appRoot, dependencyRoot) {
  const app = realpathSync(appRoot);
  const dependency = realpathSync(dependencyRoot);
  let manifest;
  if (dependency.includes('node_modules')) {
    let current = dirname(dependency);
    while (true) {
      const candidate = join(current, 'package.json');
      if (existsSync(candidate)) { manifest = candidate; break; }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } else manifest = join(dependency, 'example', 'package.json');
  requireCondition(manifest && existsSync(manifest), 'Cannot locate the app manifest read by op-sqlite iOS.');
  requireCondition(realpathSync(manifest) === realpathSync(join(app, 'package.json')),
    `op-sqlite would read another manifest: ${manifest}. Install dependencies inside this app; shared-checkout node_modules cannot certify its SQLCipher configuration.`);
  const config = json(manifest)['op-sqlite'];
  requireCondition(config?.sqlcipher === true && config?.fts5 === true,
    'Native Telegraph requires op-sqlite.sqlcipher=true and fts5=true in the resolved app manifest.');
  return { dependency, manifest: realpathSync(manifest), sqlcipher: true, fts5: true };
}

export function checkNativePackageConfig(appRoot) {
  const app = realpathSync(appRoot);
  const cli = join(app, 'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js');
  const run = (...args) => JSON.parse(execFileSync(process.execPath,
    [cli, ...args, '--project-root', app, '--json'], { cwd: app, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const checks = {};
  const expected = ['expo-openmls', 'portava-nearby-checkpoint', 'portava-on-device-speech', 'portava-video-compressor'];
  for (const platform of ['android', 'apple']) {
    const modules = run('resolve', '--platform', platform).modules;
    for (const name of [...expected, ...(platform === 'android' ? ['portava-background-upload'] : [])]) {
      const module = modules.find((value) => value.packageName === name);
      requireCondition(module, `Missing ${platform} native registration: ${name}`);
      if (name === 'expo-openmls') {
        const linked = platform === 'android' ? module.projects?.[0]?.sourceDir : module.pods?.[0]?.podspecDir;
        const target = join(app, 'vendor/expo-openmls', platform === 'android' ? 'android' : 'ios');
        requireCondition(linked && realpathSync(linked) === realpathSync(target),
          `The ${platform} build must select this checkout's patched vendored OpenMLS.`);
      }
    }
    checks[platform] = { moduleCount: modules.length, requiredModules: expected };
  }
  for (const platform of ['android', 'ios']) {
    const dependencies = run('react-native-config', '--platform', platform).dependencies;
    const sqlite = dependencies['@op-engineering/op-sqlite'];
    requireCondition(sqlite?.root && sqlite.platforms?.[platform], `Missing ${platform} op-sqlite registration.`);
    checks[`sqlcipher-${platform}`] = verifySqlcipherManifest(app, sqlite.root);
  }
  return checks;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(JSON.stringify({ ok: true, checks: checkNativePackageConfig(app) }, null, 2));
  } catch (error) {
    console.error(`check:native-config: ${error.message}`);
    process.exitCode = 1;
  }
}
