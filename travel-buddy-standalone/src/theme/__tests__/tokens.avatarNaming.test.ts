// Guards the dot.sN naming invariant: key N must equal value N. (`avatar`
// uses tier-letter keys, not sN, so it isn't covered by this shape of test.)
// Run: node --import tsx/esm --test src/theme/__tests__/tokens.avatarNaming.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dot } from '../tokens.ts';

describe('dot sizing tokens', () => {
  it('every s<N> key resolves to the value N', () => {
    for (const [key, value] of Object.entries(dot)) {
      const n = Number(key.replace(/^s/, ''));
      assert.equal(value, n, `dot.${key} should equal ${n}, got ${value}`);
    }
  });
});
