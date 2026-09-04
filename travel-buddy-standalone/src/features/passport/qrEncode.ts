/**
 * qrEncode — a self-contained QR Code (Model 2) encoder used by the Passport
 * QR share sheet (spec §25). Byte mode, automatic version (1–40), automatic
 * mask selection.
 *
 * WHY VENDORED HERE (no new dependency): the client already ships
 * `react-native-svg` for drawing, but there is no QR-generation library in the
 * dependency set. Rather than add one, this is a faithful, dependency-free port
 * of Kazuhiko Arase's public-domain `qrcode-generator` algorithm (MIT). Its
 * output is byte-for-byte identical to that reference for ASCII inputs — the
 * Passport QR only ever encodes an ASCII deep-link URL — which the build-time
 * oracle in __tests__/qrEncode.oracle guards, and the committed
 * qrEncode.test.ts pins a known-good matrix so the port cannot silently drift.
 *
 * The module is PURE (no React, no I/O) so it unit-tests in Node and renders
 * the same matrix on iOS and Android. `encodeQr()` returns a boolean matrix the
 * SVG renderer turns into modules; `true` = dark.
 */

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/**
 * Two DIFFERENT numberings for the ECC level — do not conflate them:
 *   • ECC_BITS: the QR format-information value (M=0, L=1, H=2, Q=3), written
 *     into the type-info bits as `(bits << 3) | mask`.
 *   • ECC_ROW:  the POSITIONAL row within each version's 4-row RS-block group,
 *     which the reference table lays out in L, M, Q, H order (0, 1, 2, 3).
 * The reference encoder keeps these separate via a switch; we make it explicit.
 */
const ECC_BITS: Record<QrErrorCorrectionLevel, number> = { M: 0, L: 1, H: 2, Q: 3 };
const ECC_ROW: Record<QrErrorCorrectionLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

// ─────────────────────────────────────────────────────────────────────────────
// Galois field GF(256) tables
// ─────────────────────────────────────────────────────────────────────────────

const EXP_TABLE: number[] = new Array(256);
const LOG_TABLE: number[] = new Array(256);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
}
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

function gexp(n: number): number {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP_TABLE[n];
}
function glog(n: number): number {
  if (n < 1) throw new Error(`glog(${n})`);
  return LOG_TABLE[n];
}

// ─────────────────────────────────────────────────────────────────────────────
// Polynomial over GF(256)
// ─────────────────────────────────────────────────────────────────────────────

class Poly {
  readonly num: number[];
  constructor(num: number[], shift: number) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
  }
  get(index: number): number {
    return this.num[index];
  }
  get length(): number {
    return this.num.length;
  }
  multiply(e: Poly): Poly {
    const num = new Array(this.length + e.length - 1).fill(0);
    for (let i = 0; i < this.length; i++) {
      for (let j = 0; j < e.length; j++) {
        num[i + j] ^= gexp(glog(this.get(i)) + glog(e.get(j)));
      }
    }
    return new Poly(num, 0);
  }
  mod(e: Poly): Poly {
    if (this.length - e.length < 0) return this;
    const ratio = glog(this.get(0)) - glog(e.get(0));
    const num = new Array(this.length);
    for (let i = 0; i < this.length; i++) num[i] = this.get(i);
    for (let i = 0; i < e.length; i++) num[i] ^= gexp(glog(e.get(i)) + ratio);
    return new Poly(num, 0).mod(e);
  }
}

function errorCorrectPolynomial(ecLength: number): Poly {
  let a = new Poly([1], 0);
  for (let i = 0; i < ecLength; i++) a = a.multiply(new Poly([1, gexp(i)], 0));
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bit buffer
// ─────────────────────────────────────────────────────────────────────────────

class BitBuffer {
  buffer: number[] = [];
  length = 0;
  put(num: number, len: number): void {
    for (let i = 0; i < len; i++) this.putBit(((num >>> (len - i - 1)) & 1) === 1);
  }
  putBit(bit: boolean): void {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex] |= 0x80 >>> this.length % 8;
    this.length++;
  }
  get lengthInBits(): number {
    return this.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RS block + alignment-pattern tables (Arase, all 40 versions × 4 ECC levels)
// ─────────────────────────────────────────────────────────────────────────────

// prettier-ignore
const RS_BLOCK_TABLE: number[][] = [
  [1,26,19],[1,26,16],[1,26,13],[1,26,9],
  [1,44,34],[1,44,28],[1,44,22],[1,44,16],
  [1,70,55],[1,70,44],[2,35,17],[2,35,13],
  [1,100,80],[2,50,32],[2,50,24],[4,25,9],
  [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
  [2,86,68],[4,43,27],[4,43,19],[4,43,15],
  [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
  [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
  [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
  [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
  [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
  [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
  [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
  [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
  [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12],
  [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
  [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
  [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
  [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
  [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
  [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],
  [2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
  [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
  [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
  [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
  [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
  [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
  [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
  [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
  [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
  [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
  [17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
  [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
  [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
  [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
  [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
  [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
  [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
  [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
  [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16],
];

// prettier-ignore
const PATTERN_POSITION_TABLE: number[][] = [
  [],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],
  [6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],
  [6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],
  [6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],
  [6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],
  [6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],
  [6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170],
];

interface RSBlock {
  totalCount: number;
  dataCount: number;
}

function getRSBlocks(typeNumber: number, eccRow: number): RSBlock[] {
  const row = RS_BLOCK_TABLE[(typeNumber - 1) * 4 + eccRow];
  if (!row) throw new Error(`bad rs block @ type:${typeNumber}/eccRow:${eccRow}`);
  const blocks: RSBlock[] = [];
  for (let i = 0; i < row.length / 3; i++) {
    const count = row[i * 3 + 0];
    const totalCount = row[i * 3 + 1];
    const dataCount = row[i * 3 + 2];
    for (let j = 0; j < count; j++) blocks.push({ totalCount, dataCount });
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// BCH type-info / type-number
// ─────────────────────────────────────────────────────────────────────────────

const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

function bchDigit(data: number): number {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}
function bchTypeInfo(data: number): number {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}
function bchTypeNumber(data: number): number {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mask
// ─────────────────────────────────────────────────────────────────────────────

function maskFn(pattern: number, i: number, j: number): boolean {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`bad maskPattern:${pattern}`);
  }
}

function lengthInBits(type: number): number {
  // Byte mode only.
  if (type < 10) return 8;
  return 16;
}

// UTF-8 encode a string to a byte array. For the ASCII deep-link URLs the QR
// carries this equals charCodeAt, so the output matches the Arase reference.
function toBytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const c2 = text.charCodeAt(i + 1);
      c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      i++;
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

const PAD0 = 0xec;
const PAD1 = 0x11;

function createData(typeNumber: number, eccRow: number, bytes: number[]): number[] {
  const rsBlocks = getRSBlocks(typeNumber, eccRow);
  const buffer = new BitBuffer();
  // Mode indicator (byte = 0b0100) + char-count + data.
  buffer.put(1 << 2, 4);
  buffer.put(bytes.length, lengthInBits(typeNumber));
  for (const b of bytes) buffer.put(b, 8);

  let totalDataCount = 0;
  for (const b of rsBlocks) totalDataCount += b.dataCount;

  if (buffer.lengthInBits > totalDataCount * 8) {
    throw new Error(`code length overflow (${buffer.lengthInBits}>${totalDataCount * 8})`);
  }
  if (buffer.lengthInBits + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.lengthInBits % 8 !== 0) buffer.putBit(false);
  for (;;) {
    if (buffer.lengthInBits >= totalDataCount * 8) break;
    buffer.put(PAD0, 8);
    if (buffer.lengthInBits >= totalDataCount * 8) break;
    buffer.put(PAD1, 8);
  }
  return createBytes(buffer, rsBlocks);
}

function createBytes(buffer: BitBuffer, rsBlocks: RSBlock[]): number[] {
  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcdata: number[][] = new Array(rsBlocks.length);
  const ecdata: number[][] = new Array(rsBlocks.length);

  for (let r = 0; r < rsBlocks.length; r++) {
    const dcCount = rsBlocks[r].dataCount;
    const ecCount = rsBlocks[r].totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);

    dcdata[r] = new Array(dcCount);
    for (let i = 0; i < dcCount; i++) dcdata[r][i] = 0xff & buffer.buffer[i + offset];
    offset += dcCount;

    const rsPoly = errorCorrectPolynomial(ecCount);
    const rawPoly = new Poly(dcdata[r], rsPoly.length - 1);
    const modPoly = rawPoly.mod(rsPoly);
    ecdata[r] = new Array(rsPoly.length - 1);
    for (let i = 0; i < ecdata[r].length; i++) {
      const modIndex = i + modPoly.length - ecdata[r].length;
      ecdata[r][i] = modIndex >= 0 ? modPoly.get(modIndex) : 0;
    }
  }

  let totalCodeCount = 0;
  for (const b of rsBlocks) totalCodeCount += b.totalCount;

  const data: number[] = new Array(totalCodeCount);
  let index = 0;
  for (let i = 0; i < maxDcCount; i++) {
    for (let r = 0; r < rsBlocks.length; r++) if (i < dcdata[r].length) data[index++] = dcdata[r][i];
  }
  for (let i = 0; i < maxEcCount; i++) {
    for (let r = 0; r < rsBlocks.length; r++) if (i < ecdata[r].length) data[index++] = ecdata[r][i];
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matrix assembly
// ─────────────────────────────────────────────────────────────────────────────

type Cell = boolean | null;

function makeImpl(
  modules: Cell[][],
  moduleCount: number,
  typeNumber: number,
  eccBits: number,
  test: boolean,
  maskPattern: number,
  data: number[],
): void {
  for (let row = 0; row < moduleCount; row++) {
    modules[row] = new Array(moduleCount).fill(null);
  }
  setupProbe(modules, moduleCount, 0, 0);
  setupProbe(modules, moduleCount, moduleCount - 7, 0);
  setupProbe(modules, moduleCount, 0, moduleCount - 7);
  setupAdjust(modules, typeNumber);
  setupTiming(modules, moduleCount);
  setupTypeInfo(modules, moduleCount, eccBits, test, maskPattern);
  if (typeNumber >= 7) setupTypeNumber(modules, moduleCount, typeNumber, test);
  mapData(modules, moduleCount, data, maskPattern);
}

function setupProbe(modules: Cell[][], moduleCount: number, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    if (row + r <= -1 || moduleCount <= row + r) continue;
    for (let c = -1; c <= 7; c++) {
      if (col + c <= -1 || moduleCount <= col + c) continue;
      const dark =
        (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
        (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
        (2 <= r && r <= 4 && 2 <= c && c <= 4);
      modules[row + r][col + c] = dark;
    }
  }
}

function setupTiming(modules: Cell[][], moduleCount: number): void {
  for (let r = 8; r < moduleCount - 8; r++) {
    if (modules[r][6] !== null) continue;
    modules[r][6] = r % 2 === 0;
  }
  for (let c = 8; c < moduleCount - 8; c++) {
    if (modules[6][c] !== null) continue;
    modules[6][c] = c % 2 === 0;
  }
}

function setupAdjust(modules: Cell[][], typeNumber: number): void {
  const pos = PATTERN_POSITION_TABLE[typeNumber - 1];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const row = pos[i];
      const col = pos[j];
      if (modules[row][col] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r][col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
        }
      }
    }
  }
}

function setupTypeNumber(modules: Cell[][], moduleCount: number, typeNumber: number, test: boolean): void {
  const bits = bchTypeNumber(typeNumber);
  for (let i = 0; i < 18; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    modules[Math.floor(i / 3)][(i % 3) + moduleCount - 8 - 3] = mod;
  }
  for (let i = 0; i < 18; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    modules[(i % 3) + moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
  }
}

function setupTypeInfo(
  modules: Cell[][],
  moduleCount: number,
  eccBits: number,
  test: boolean,
  maskPattern: number,
): void {
  const data = (eccBits << 3) | maskPattern;
  const bits = bchTypeInfo(data);
  for (let v = 0; v < 15; v++) {
    const mod = !test && ((bits >> v) & 1) === 1;
    if (v < 6) modules[v][8] = mod;
    else if (v < 8) modules[v + 1][8] = mod;
    else modules[moduleCount - 15 + v][8] = mod;
  }
  for (let h = 0; h < 15; h++) {
    const mod = !test && ((bits >> h) & 1) === 1;
    if (h < 8) modules[8][moduleCount - h - 1] = mod;
    else if (h < 9) modules[8][15 - h - 1 + 1] = mod;
    else modules[8][15 - h - 1] = mod;
  }
  modules[moduleCount - 8][8] = !test;
}

function mapData(modules: Cell[][], moduleCount: number, data: number[], maskPattern: number): void {
  let inc = -1;
  let row = moduleCount - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = moduleCount - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (modules[row][col - c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          if (maskFn(maskPattern, row, col - c)) dark = !dark;
          modules[row][col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || moduleCount <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

function isDark(modules: Cell[][], row: number, col: number): boolean {
  return modules[row][col] === true;
}

function lostPoint(modules: Cell[][], moduleCount: number): number {
  let lost = 0;
  // LEVEL 1
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      let sameCount = 0;
      const dark = isDark(modules, row, col);
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || moduleCount <= row + r) continue;
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || moduleCount <= col + c) continue;
          if (r === 0 && c === 0) continue;
          if (dark === isDark(modules, row + r, col + c)) sameCount++;
        }
      }
      if (sameCount > 5) lost += 3 + sameCount - 5;
    }
  }
  // LEVEL 2
  for (let row = 0; row < moduleCount - 1; row++) {
    for (let col = 0; col < moduleCount - 1; col++) {
      let count = 0;
      if (isDark(modules, row, col)) count++;
      if (isDark(modules, row + 1, col)) count++;
      if (isDark(modules, row, col + 1)) count++;
      if (isDark(modules, row + 1, col + 1)) count++;
      if (count === 0 || count === 4) lost += 3;
    }
  }
  // LEVEL 3
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount - 6; col++) {
      if (
        isDark(modules, row, col) &&
        !isDark(modules, row, col + 1) &&
        isDark(modules, row, col + 2) &&
        isDark(modules, row, col + 3) &&
        isDark(modules, row, col + 4) &&
        !isDark(modules, row, col + 5) &&
        isDark(modules, row, col + 6)
      ) {
        lost += 40;
      }
    }
  }
  for (let col = 0; col < moduleCount; col++) {
    for (let row = 0; row < moduleCount - 6; row++) {
      if (
        isDark(modules, row, col) &&
        !isDark(modules, row + 1, col) &&
        isDark(modules, row + 2, col) &&
        isDark(modules, row + 3, col) &&
        isDark(modules, row + 4, col) &&
        !isDark(modules, row + 5, col) &&
        isDark(modules, row + 6, col)
      ) {
        lost += 40;
      }
    }
  }
  // LEVEL 4
  let darkCount = 0;
  for (let col = 0; col < moduleCount; col++) {
    for (let row = 0; row < moduleCount; row++) if (isDark(modules, row, col)) darkCount++;
  }
  const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
  lost += ratio * 10;
  return lost;
}

/** Smallest version (1–40) whose data capacity fits `byteLen` at `eccRow`. */
function chooseType(byteLen: number, eccRow: number): number {
  for (let type = 1; type < 40; type++) {
    const rsBlocks = getRSBlocks(type, eccRow);
    let totalDataCount = 0;
    for (const b of rsBlocks) totalDataCount += b.dataCount;
    // 4-bit mode + char-count + 8·byteLen data bits.
    const needBits = 4 + lengthInBits(type) + byteLen * 8;
    if (needBits <= totalDataCount * 8) return type;
  }
  return 40;
}

export interface QrMatrix {
  /** Module count per side (21 for version 1, +4 per version). */
  size: number;
  /** `modules[row][col] === true` ⇒ dark module. */
  modules: boolean[][];
}

/**
 * Encode `text` into a QR matrix. `text` is expected to be a short ASCII URL;
 * non-ASCII is UTF-8 encoded. Throws only for inputs too large for version 40.
 */
export function encodeQr(text: string, ecc: QrErrorCorrectionLevel = 'M'): QrMatrix {
  const eccBits = ECC_BITS[ecc];
  const eccRow = ECC_ROW[ecc];
  const bytes = toBytes(text);
  const typeNumber = chooseType(bytes.length, eccRow);
  const moduleCount = typeNumber * 4 + 17;
  const data = createData(typeNumber, eccRow, bytes);

  // Pick the best mask by trying all 8 (test=true suppresses format bits so the
  // penalty score is comparable across patterns), then render the winner.
  let bestPattern = 0;
  let minLost = Infinity;
  for (let pattern = 0; pattern < 8; pattern++) {
    const probe: Cell[][] = new Array(moduleCount);
    makeImpl(probe, moduleCount, typeNumber, eccBits, true, pattern, data);
    const lost = lostPoint(probe, moduleCount);
    if (pattern === 0 || lost < minLost) {
      minLost = lost;
      bestPattern = pattern;
    }
  }

  const cells: Cell[][] = new Array(moduleCount);
  makeImpl(cells, moduleCount, typeNumber, eccBits, false, bestPattern, data);

  const modules: boolean[][] = cells.map((r) => r.map((c) => c === true));
  return { size: moduleCount, modules };
}
