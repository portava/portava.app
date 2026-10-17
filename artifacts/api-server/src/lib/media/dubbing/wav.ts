import { DUBBING_LIMITS, DubbingError, type PcmAudio } from "./contracts.js";

export function validatePcm(audio: PcmAudio): void {
  if (!Number.isInteger(audio.sampleRate) || audio.sampleRate < 8_000 || audio.sampleRate > 48_000 || !Buffer.isBuffer(audio.samples) || audio.samples.length < 2 || audio.samples.length % 2 !== 0 || audio.samples.length > 2 * audio.sampleRate * DUBBING_LIMITS.durationMs / 1000) throw new DubbingError("invalid_audio");
}

export function encodeWave(audio: PcmAudio): Buffer {
  validatePcm(audio);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + audio.samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(audio.sampleRate, 24);
  header.writeUInt32LE(audio.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(audio.samples.length, 40);
  return Buffer.concat([header, audio.samples]);
}

export function decodeWave(bytes: Buffer): PcmAudio {
  if (bytes.length < 44 || bytes.length > 48_000 * 2 * DUBBING_LIMITS.durationMs / 1000 + 8192 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) !== bytes.length - 8) throw new DubbingError("invalid_audio");
  let sampleRate: number | undefined;
  let samples: Buffer | undefined;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new DubbingError("invalid_audio");
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end + size % 2 > bytes.length) throw new DubbingError("invalid_audio");
    if (kind === "fmt ") {
      if (sampleRate !== undefined || size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1 || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw new DubbingError("invalid_audio");
      sampleRate = bytes.readUInt32LE(start + 4);
      if (bytes.readUInt32LE(start + 8) !== sampleRate * 2) throw new DubbingError("invalid_audio");
    } else if (kind === "data") {
      if (samples) throw new DubbingError("invalid_audio");
      samples = Buffer.from(bytes.subarray(start, end));
    }
    offset = end + size % 2;
  }
  if (sampleRate === undefined || !samples) throw new DubbingError("invalid_audio");
  const audio = { sampleRate, samples };
  validatePcm(audio);
  return audio;
}

export function resamplePcm(audio: PcmAudio, sampleRate: number): Buffer {
  validatePcm(audio);
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) throw new DubbingError("invalid_audio");
  if (audio.sampleRate === sampleRate) return Buffer.from(audio.samples);
  const inputCount = audio.samples.length / 2;
  const count = Math.round(inputCount * sampleRate / audio.sampleRate);
  const result = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++) {
    const position = index * audio.sampleRate / sampleRate;
    const lower = Math.min(Math.floor(position), inputCount - 1);
    const upper = Math.min(lower + 1, inputCount - 1);
    const value = audio.samples.readInt16LE(lower * 2) * (1 - (position - lower)) + audio.samples.readInt16LE(upper * 2) * (position - lower);
    result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2);
  }
  return result;
}
