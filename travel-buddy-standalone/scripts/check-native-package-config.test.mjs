import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySqlcipherManifest } from './check-native-package-config.mjs';

test('native SQLCipher guard binds the actual podspec manifest and fails closed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'portava-native-config-'));
  try {
    const app = join(temp, 'app'); const other = join(temp, 'other-app');
    const dependency = join(app, 'node_modules/@op-engineering/op-sqlite');
    mkdirSync(dependency, { recursive: true }); mkdirSync(other);
    const config = { 'op-sqlite': { sqlcipher: true, fts5: true } };
    writeFileSync(join(app, 'package.json'), JSON.stringify(config));
    writeFileSync(join(other, 'package.json'), JSON.stringify(config));
    assert.equal(verifySqlcipherManifest(app, dependency).sqlcipher, true);
    symlinkSync(join(app, 'node_modules'), join(other, 'node_modules'), 'dir');
    assert.throws(() => verifySqlcipherManifest(other, join(other, 'node_modules/@op-engineering/op-sqlite')), /another manifest/);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ 'op-sqlite': { sqlcipher: false, fts5: true } }));
    assert.throws(() => verifySqlcipherManifest(app, dependency), /sqlcipher=true/);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ 'op-sqlite': { sqlcipher: true, fts5: false } }));
    assert.throws(() => verifySqlcipherManifest(app, dependency), /fts5=true/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
