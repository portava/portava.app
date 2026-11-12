/** Owner-configured public destination. Never attach account data or credentials. */
export function publicOwnerLink(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')
      || url.hostname === 'localhost' || url.hash) return null;
    return url.toString();
  } catch { return null; }
}
