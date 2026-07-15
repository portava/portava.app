/**
 * Passport palette — cream ivory paper, dark green ink, vermilion seal.
 * Used exclusively within Passport screen components.
 */
import type { TextStyle } from 'react-native';

export const PP = {
  paper:        '#F8F3E8',
  paperDeep:    '#EDE8D8',
  paperShadow:  '#D4CEBC',
  ink:          '#1A3A2A',
  inkLight:     '#2D5F3F',
  inkMuted:     '#4A6B58',
  inkFaint:     'rgba(26,58,42,0.12)' as const,
  seal:         '#C41E3A',
  sealLight:    '#F9E8EB',
  gold:         '#B89A0C',
  goldLight:    '#FBF5DC',
  securityLine: 'rgba(26,58,42,0.055)' as const,
  border:       'rgba(26,58,42,0.18)' as const,
  borderLight:  'rgba(26,58,42,0.09)' as const,
} as const;

/** Small-caps official field label: PP.inkMuted */
export const PP_LABEL: TextStyle = {
  fontSize: 9,
  letterSpacing: 1.8,
  fontWeight: '700',
  textTransform: 'uppercase',
  color: PP.inkMuted,
  fontFamily: 'Courier',
};

/** Document field value: PP.ink */
export const PP_VALUE: TextStyle = {
  fontSize: 14,
  fontWeight: '600',
  color: PP.ink,
  lineHeight: 18,
};

/** Returns a deterministic 8-char alphanumeric "passport number" from a user id. */
export function passportNumber(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  const n = Math.abs(h).toString(36).toUpperCase().padStart(8, '0');
  return n.slice(0, 3) + ' ' + n.slice(3, 6) + ' ' + n.slice(6, 8);
}

/** Country name → ISO 3166-1 alpha-2 code lookup (common countries). */
const COUNTRY_CODES: Record<string, string> = {
  'Philippines': 'PH', 'United States': 'US', 'USA': 'US', 'United Kingdom': 'GB',
  'UK': 'GB', 'Japan': 'JP', 'South Korea': 'KR', 'Korea': 'KR', 'Singapore': 'SG',
  'Thailand': 'TH', 'Vietnam': 'VN', 'Indonesia': 'ID', 'Malaysia': 'MY',
  'Australia': 'AU', 'New Zealand': 'NZ', 'India': 'IN', 'China': 'CN',
  'Hong Kong': 'HK', 'Taiwan': 'TW', 'Germany': 'DE', 'France': 'FR',
  'Spain': 'ES', 'Italy': 'IT', 'Netherlands': 'NL', 'Portugal': 'PT',
  'Canada': 'CA', 'Mexico': 'MX', 'Brazil': 'BR', 'Argentina': 'AR',
  'Colombia': 'CO', 'Peru': 'PE', 'Chile': 'CL', 'UAE': 'AE',
  'United Arab Emirates': 'AE', 'Saudi Arabia': 'SA', 'Turkey': 'TR',
  'Greece': 'GR', 'Switzerland': 'CH', 'Sweden': 'SE', 'Norway': 'NO',
  'Denmark': 'DK', 'Finland': 'FI', 'Poland': 'PL', 'Czech Republic': 'CZ',
  'Hungary': 'HU', 'Romania': 'RO', 'Egypt': 'EG', 'Morocco': 'MA',
  'South Africa': 'ZA', 'Kenya': 'KE', 'Ethiopia': 'ET', 'Nigeria': 'NG',
  'Cambodia': 'KH', 'Myanmar': 'MM', 'Laos': 'LA', 'Sri Lanka': 'LK',
  'Bangladesh': 'BD', 'Pakistan': 'PK', 'Nepal': 'NP', 'Maldives': 'MV',
};

/** Returns a flag emoji + ISO code string for a country name, or null. */
export function countryFlag(countryName: string | null | undefined): { flag: string; code: string } | null {
  if (!countryName) return null;
  const code = COUNTRY_CODES[countryName];
  if (!code) return null;
  const flag = code
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('');
  return { flag, code };
}

/** Format ISO date string to short month+year, e.g. "Jun 2024". */
export function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}
