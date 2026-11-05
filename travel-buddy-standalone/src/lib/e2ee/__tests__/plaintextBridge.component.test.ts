import { encodeBridgePlaintext, decodeBridgePlaintext } from '../../../../vendor/expo-openmls/src/plaintextBridge.ts';

describe('native plaintext bridge envelope', () => {
  it.each(['', 'ordinary text', 'before\u0000after', '🌍 Việt Nam العربية', '\n\r\t\b\f', 'literal \\u0000 and "quotes"'])('preserves exact text %#', value => {
    const encoded = encodeBridgePlaintext(value);
    expect(encoded).not.toContain('\u0000');
    expect(decodeBridgePlaintext(encoded)).toBe(value);
  });
  it.each(['null', '[]', '[1]', '["a","b"]', '{}', 'broken'])('refuses malformed native output %s', value => {
    expect(() => decodeBridgePlaintext(value)).toThrow();
  });
});
