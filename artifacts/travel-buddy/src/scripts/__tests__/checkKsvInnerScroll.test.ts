/**
 * Guard test — check-ksv-inner-scroll.mjs
 *
 * Verifies that the KSV nesting guard:
 *   - exits 1 and prints the expected error message when a
 *     <KeyboardSafeScrollView>…<ScrollView> nesting is found.
 *   - exits 0 and prints the ok message for a clean file.
 *
 * Strategy: each case creates a temporary directory with an `app/`
 * sub-directory (one of the SCAN_ROOTS the guard checks), writes a fixture
 * .tsx file there, then runs the guard script with that directory as cwd.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import process from 'node:process';

/** Absolute path to the guard script, resolved from the travel-buddy root. */
const GUARD_SCRIPT = join(process.cwd(), 'scripts/check-ksv-inner-scroll.mjs');

/** Violating fixture — direct <ScrollView> child of <KeyboardSafeScrollView>. */
const VIOLATING_TSX = `
import React from 'react';
import { ScrollView } from 'react-native';
import { KeyboardSafeScrollView } from 'src/components/ui/KeyboardSafeScrollView';

export default function BadScreen() {
  return (
    <KeyboardSafeScrollView>
      <ScrollView>
        <Text>hello</Text>
      </ScrollView>
    </KeyboardSafeScrollView>
  );
}
`.trimStart();

/** Clean fixture — no inner <ScrollView>. */
const CLEAN_TSX = `
import React from 'react';
import { View, Text } from 'react-native';
import { KeyboardSafeScrollView } from 'src/components/ui/KeyboardSafeScrollView';

export default function GoodScreen() {
  return (
    <KeyboardSafeScrollView>
      <View>
        <Text>hello</Text>
      </View>
    </KeyboardSafeScrollView>
  );
}
`.trimStart();

/**
 * Wrapper-component fixture — the <ScrollView> lives one JSX level further
 * away, inside a helper component (<MyList>) that is itself a direct child of
 * <KeyboardSafeScrollView>.
 *
 * The guard performs static line-by-line analysis and only flags cases where
 * the DIRECT child of <KeyboardSafeScrollView> (the first non-empty line after
 * the opening tag closes) starts with a <ScrollView element. When the
 * anti-pattern is hidden inside another component, the guard cannot see it and
 * will NOT fire — this is an acknowledged, intentional limitation of the
 * static-analysis approach.
 */
const WRAPPER_COMPONENT_TSX = `
import React from 'react';
import { ScrollView, Text } from 'react-native';
import { KeyboardSafeScrollView } from 'src/components/ui/KeyboardSafeScrollView';

// MyList hides a <ScrollView> one level deeper — the guard cannot see inside it.
function MyList() {
  return (
    <ScrollView>
      <Text>item</Text>
    </ScrollView>
  );
}

export default function WrappedScreen() {
  return (
    <KeyboardSafeScrollView>
      <MyList />
    </KeyboardSafeScrollView>
  );
}
`.trimStart();

/** Self-closing <KeyboardSafeScrollView /> — no children, must not fire. */
const SELF_CLOSING_TSX = `
import React from 'react';
import { KeyboardSafeScrollView } from 'src/components/ui/KeyboardSafeScrollView';

export default function SelfClose() {
  return <KeyboardSafeScrollView />;
}
`.trimStart();

function runGuard(cwd: string) {
  return spawnSync(process.execPath, [GUARD_SCRIPT], {
    cwd,
    encoding: 'utf8',
  });
}

function makeTmpWithApp(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'ksv-guard-'));
  mkdirSync(join(tmp, 'app'), { recursive: true });
  return tmp;
}

describe('check-ksv-inner-scroll.mjs', () => {
  const tmps: string[] = [];

  after(() => {
    for (const d of tmps) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('exits 1 and reports the violation when <ScrollView> is a direct child of <KeyboardSafeScrollView>', () => {
    const tmp = makeTmpWithApp();
    tmps.push(tmp);
    writeFileSync(join(tmp, 'app', 'BadScreen.tsx'), VIOLATING_TSX);

    const result = runGuard(tmp);

    assert.equal(result.status, 1, 'expected exit code 1 for a violating file');

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('KeyboardSafeScrollView'),
      `expected error output to mention KeyboardSafeScrollView, got:\n${output}`,
    );
    assert.ok(
      output.includes('BadScreen.tsx'),
      `expected error output to mention the violating file, got:\n${output}`,
    );
  });

  it('exits 0 and prints the ok message for a file with no inner <ScrollView>', () => {
    const tmp = makeTmpWithApp();
    tmps.push(tmp);
    writeFileSync(join(tmp, 'app', 'GoodScreen.tsx'), CLEAN_TSX);

    const result = runGuard(tmp);

    assert.equal(result.status, 0, `expected exit code 0 for a clean file; stderr:\n${result.stderr}`);

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('no KeyboardSafeScrollView+ScrollView nesting found'),
      `expected ok message, got:\n${output}`,
    );
  });

  it('exits 0 for a self-closing <KeyboardSafeScrollView /> (no children)', () => {
    const tmp = makeTmpWithApp();
    tmps.push(tmp);
    writeFileSync(join(tmp, 'app', 'SelfClose.tsx'), SELF_CLOSING_TSX);

    const result = runGuard(tmp);

    assert.equal(result.status, 0, `expected exit code 0 for self-closing tag; stderr:\n${result.stderr}`);
  });

  it('exits 1 when violation is inside src/components/ scan root', () => {
    const tmp = makeTmpWithApp();
    tmps.push(tmp);
    // create src/components/ instead of app/
    mkdirSync(join(tmp, 'src', 'components'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'components', 'BadWidget.tsx'), VIOLATING_TSX);

    const result = runGuard(tmp);

    assert.equal(result.status, 1, 'expected exit code 1 for violation in src/components/');

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('BadWidget.tsx'),
      `expected error output to mention BadWidget.tsx, got:\n${output}`,
    );
  });

  it('exits 0 (not caught) when <ScrollView> is hidden inside a wrapper component — guard only checks direct children', () => {
    // Limitation: the guard performs line-by-line static analysis. It looks at
    // the first non-empty line immediately after <KeyboardSafeScrollView> closes
    // its opening tag. When a helper component (e.g. <MyList />) is the direct
    // child and THAT component internally renders a <ScrollView>, the guard
    // cannot see the nesting and will not flag it.
    const tmp = makeTmpWithApp();
    tmps.push(tmp);
    writeFileSync(join(tmp, 'app', 'WrappedScreen.tsx'), WRAPPER_COMPONENT_TSX);

    const result = runGuard(tmp);

    assert.equal(
      result.status,
      0,
      `guard is not expected to catch a <ScrollView> nested inside a wrapper component; ` +
        `if it now exits 1, the guard's scope has expanded beyond its documented limits.\nstderr:\n${result.stderr}`,
    );

    const output = (result.stderr ?? '') + (result.stdout ?? '');
    assert.ok(
      output.includes('no KeyboardSafeScrollView+ScrollView nesting found'),
      `expected ok message for wrapper-component case, got:\n${output}`,
    );
  });

  it('exits 0 when the scan roots are empty (no .tsx files found)', () => {
    const tmp = makeTmpWithApp(); // app/ exists but is empty
    tmps.push(tmp);

    const result = runGuard(tmp);

    assert.equal(result.status, 0, `expected exit code 0 with no .tsx files; stderr:\n${result.stderr}`);
  });
});
