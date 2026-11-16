/** Capture metadata from the selected photo, never the upload/file modification clock.
 * A timezone-free EXIF wall clock is not an instant. Do not infer the phone's
 * current timezone for an old travel photo. No GPS or other EXIF is forwarded.
 */
export function photoCaptureTime(exif: Record<string, unknown> | null | undefined): string | null {
  const raw = exif?.DateTimeOriginal;
  const offset = exif?.OffsetTimeOriginal;
  if (typeof raw !== 'string' || typeof offset !== 'string') return null;
  if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) || !/^[+-]\d{2}:\d{2}$/.test(offset)) return null;
  const wall = raw.slice(0, 10).replace(/:/g, '-') + 'T' + raw.slice(11);
  const local = Date.parse(wall + 'Z');
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== wall) return null;
  const hours = Number(offset.slice(1, 3)), minutes = Number(offset.slice(4));
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  const direction = offset[0] === '+' ? 1 : -1;
  return new Date(local - direction * (hours * 60 + minutes) * 60_000).toISOString();
}
