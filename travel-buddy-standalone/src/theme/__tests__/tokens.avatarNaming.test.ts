// Guards the s<N> naming invariant across every circular/dot sizing token
// family: for each entry, the key's numeric suffix must equal the value.
// This is what keeps the tier-letter scheme (xs/sm/mdLg/xxxxxl/...) from
// silently creeping back in — a key that doesn't state its own value can
// drift from that value with no signal.
//
// Auto-discovered by scripts/run-node-tests.mjs (glob: src/**/*.test.ts,
// excluding *.component.test.* and src/test/**) and run as part of
// `pnpm test`, which `pnpm run check:all` invokes. No manual run step or
// separate package.json script entry is needed — this file already runs
// under check:all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { avatar, icon, dot } from '../tokens.ts';

const FAMILIES: Record<string, Record<string, number>> = { avatar, icon, dot };

describe('s<N> sizing token naming invariant', () => {
  for (const [familyName, tokens] of Object.entries(FAMILIES)) {
    it(`every ${familyName}.s<N> key resolves to the value N`, () => {
      const keys = Object.keys(tokens);
      assert.ok(keys.length > 0, `${familyName} has no keys to check`);
      for (const [key, value] of Object.entries(tokens)) {
        const match = /^s(\d+)$/.exec(key);
        assert.ok(
          match,
          `${familyName}.${key} does not match the required s<N> key shape`,
        );
        const n = Number(match![1]);
        assert.equal(
          value,
          n,
          `${familyName}.${key} should equal ${n} (from its own key), got ${value}`,
        );
      }
    });
  }
});
