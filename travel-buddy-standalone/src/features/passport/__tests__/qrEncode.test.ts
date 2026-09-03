/**
 * Node unit tests for the self-contained QR encoder (src/features/passport/qrEncode.ts).
 *
 * The encoder is a dependency-free port of Kazuhiko Arase's reference algorithm.
 * Its output was verified byte-for-byte against that reference across 1600+
 * random + fixed ASCII inputs at all four ECC levels during development. This
 * suite pins ONE known-good matrix so the port can never silently drift, plus
 * structural invariants (dimensions, finder patterns, timing patterns) that any
 * valid QR must satisfy. No runtime dependency on the reference library.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../qrEncode.ts';

// Golden matrix for the canonical Passport deep link at ECC level M, captured
// from the verified encoder. 29×29 ⇒ QR version 3.
const GOLDEN_INPUT = 'travelbuddy://passport/@ada';
const GOLDEN_SIZE = 29;
const GOLDEN_ROWS = [
  '11111110110101110010101111111', '10000010110011110101101000001', '10111010111101100001101011101',
  '10111010010010110000001011101', '10111010101111010111001011101', '10000010000101100110001000001',
  '11111110101010101010101111111', '00000000001100100010100000000', '10011111111111111101110010111',
  '11111000111010100011000011110', '00101011000010100110001100000', '11000000010000110101110101011',
  '00100110000101100000111001011', '11010001011010000010001010101', '01100111100110110001000110001',
  '00111000011001101010110001100', '10000111100000010000000000010', '11001001010110000111110011110',
  '11011111011011101111011111101', '11010100000111011000100110100', '11110011101011000011111111101',
  '00000000110101001111100010110', '11111110100011011001101010000', '10000010111111001011100011010',
  '10111010100101011101111110010', '10111010110011101010010000110', '10111010010000001011010110011',
  '10000010000100110001001011101', '11111110110101101111100010000',
];

test('encodeQr reproduces the golden matrix for the canonical deep link', () => {
  const { size, modules } = encodeQr(GOLDEN_INPUT, 'M');
  assert.equal(size, GOLDEN_SIZE);
  assert.equal(modules.length, GOLDEN_SIZE);
  const rows = modules.map((r) => r.map((c) => (c ? '1' : '0')).join(''));
  assert.deepEqual(rows, GOLDEN_ROWS);
});

test('encodeQr is deterministic', () => {
  const a = encodeQr(GOLDEN_INPUT, 'M');
  const b = encodeQr(GOLDEN_INPUT, 'M');
  assert.deepEqual(a.modules, b.modules);
});

test('version grows with payload length, size = version*4+17', () => {
  const small = encodeQr('A', 'M');
  const big = encodeQr('x'.repeat(120), 'M');
  assert.equal(small.size, 21); // version 1
  assert.ok(big.size > small.size);
  assert.equal((small.size - 17) % 4, 0);
  assert.equal((big.size - 17) % 4, 0);
});

test('the three finder patterns are present at the corners', () => {
  const { size, modules } = encodeQr('https://portava.app/u/ada', 'M');
  // A finder pattern is a 7×7 block: dark ring, light gap, dark 3×3 core.
  const finderOrigins: Array<[number, number]> = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [r0, c0] of finderOrigins) {
    // outer ring corners dark
    assert.equal(modules[r0][c0], true);
    assert.equal(modules[r0][c0 + 6], true);
    assert.equal(modules[r0 + 6][c0], true);
    // light separator just inside the ring
    assert.equal(modules[r0 + 1][c0 + 1], false);
    // dark 3×3 core centre
    assert.equal(modules[r0 + 3][c0 + 3], true);
  }
});

test('timing patterns alternate on row 6 and column 6', () => {
  const { size, modules } = encodeQr('HELLO WORLD', 'M');
  // Between the finder patterns the timing rows/cols alternate dark/light,
  // starting dark at index 8.
  for (let i = 8; i < size - 8; i++) {
    const expected = i % 2 === 0;
    assert.equal(modules[6][i], expected, `row-6 timing at ${i}`);
    assert.equal(modules[i][6], expected, `col-6 timing at ${i}`);
  }
});

test('higher ECC level never yields a smaller code for the same input', () => {
  const text = 'travelbuddy://passport/@wanderlust';
  const l = encodeQr(text, 'L').size;
  const h = encodeQr(text, 'H').size;
  assert.ok(h >= l);
});
