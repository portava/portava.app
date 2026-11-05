/** A transport envelope, not an MLS payload format. Escapes embedded control
 * characters before Expo/JSI conversion without changing actual message bytes. */
export function encodeBridgePlaintext(text: string): string {
  if (typeof text !== 'string') throw new TypeError('Invalid plaintext.');
  return JSON.stringify([text]);
}

export function decodeBridgePlaintext(encoded: string): string {
  const values: unknown = JSON.parse(encoded);
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
    throw new TypeError('Invalid encoded plaintext.');
  }
  return values[0];
}
