import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./repair-disposable-pgdg-source.sh', import.meta.url));
const official = 'https://apt-archive.postgresql.org/pub/repos/apt';

function fixture(source, os = 'ID=debian\nVERSION_CODENAME=bullseye\n') {
  const root = mkdtempSync(join(tmpdir(), 'disposable-pgdg-'));
  mkdirSync(join(root, 'apt/sources.list.d'), { recursive: true });
  const path = join(root, 'apt/sources.list.d/pgdg.list');
  if (os !== null) writeFileSync(join(root, 'os-release'), os);
  if (source !== null) writeFileSync(path, source);
  return {
    run: () => spawnSync('sh', [script, root], { encoding: 'utf8' }),
    read: () => readFileSync(path, 'utf8'),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('repairs the legacy Bullseye source and preserves signing options', () => {
  const source = 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt/ bullseye-pgdg main 16\n';
  const f = fixture(source);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(f.read(), source.replace('http://apt.postgresql.org/pub/repos/apt', official));
    assert.equal(f.run().status, 0);
    assert.equal(f.read(), source.replace('http://apt.postgresql.org/pub/repos/apt', official), 'idempotent');
  } finally { f.close(); }
});

test('changes only active Bullseye URI lines, including HTTPS and deb-src', () => {
  const unchanged = '# deb https://apt.postgresql.org/pub/repos/apt bullseye-pgdg main\n'
    + 'deb https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main\n';
  const source = 'deb-src https://apt.postgresql.org/pub/repos/apt bullseye-pgdg main\n';
  const f = fixture(unchanged + source);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(f.read(), unchanged + source.replace('https://apt.postgresql.org/pub/repos/apt', official));
  } finally { f.close(); }
});

test('leaves other operating systems and distributions unchanged', () => {
  const source = 'deb https://apt.postgresql.org/pub/repos/apt bullseye-pgdg main\n';
  for (const os of ['ID=debian\nVERSION_CODENAME=bookworm\n', 'ID=ubuntu\nVERSION_CODENAME=bullseye\n']) {
    const f = fixture(source, os);
    try { assert.equal(f.run().status, 0); assert.equal(f.read(), source); }
    finally { f.close(); }
  }
});

test('refuses missing or unsupported source shapes without modifying them', () => {
  for (const source of [null, '# deb https://apt.postgresql.org/pub/repos/apt bullseye-pgdg main\n',
    'deb https://apt.postgresql.org.example/pub/repos/apt bullseye-pgdg main\n',
    'deb https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main\n']) {
    const f = fixture(source);
    try { assert.notEqual(f.run().status, 0); if (source !== null) assert.equal(f.read(), source); }
    finally { f.close(); }
  }
  const f = fixture('unchanged\n', null);
  try { assert.notEqual(f.run().status, 0); assert.equal(f.read(), 'unchanged\n'); }
  finally { f.close(); }
});
