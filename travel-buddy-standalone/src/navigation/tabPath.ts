/** Expo pathname omits route groups; tests/deep links may still include them. */
export function normalizeTabPath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const segments = pathname.split('/').filter(segment => segment && !/^\([^/]+\)$/.test(segment));
  return `/${segments.join('/')}`;
}

export function isTabPathActive(pathname: string, matches: readonly string[]): boolean {
  const path = normalizeTabPath(pathname);
  return matches.some(match => {
    const tab = normalizeTabPath(match);
    return path === tab || (tab !== '/' && path.startsWith(`${tab}/`));
  });
}
