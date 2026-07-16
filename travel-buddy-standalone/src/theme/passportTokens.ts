/**
 * Passport palette — clean white/cream paper, black ink, red seal.
 * Minimalist, Instagram-calm profile style.
 */
import type { TextStyle } from 'react-native';

export const PP = {
  paper:        '#FFFFFF',
  paperDeep:    '#F7F7F5',
  paperShadow:  '#EBEBE8',
  ink:          '#1C1C1A',
  inkLight:     '#4A4A48',
  inkMuted:     '#828280',
  inkFaint:     'rgba(28,28,26,0.06)',
  seal:         '#D32F2F',
  sealLight:    '#FCEEED',
  gold:         '#D4AF37',
  goldLight:    '#FDF8E7',
  securityLine: 'rgba(28,28,26,0.03)',
  border:       'rgba(28,28,26,0.12)',
  borderLight:  'rgba(28,28,26,0.06)',
} as const;

export const PP_LABEL: TextStyle = {
  fontSize: 10,
  letterSpacing: 1.2,
  fontWeight: '600',
  textTransform: 'uppercase',
  color: PP.inkMuted,
  fontFamily: 'System', // clean sans-serif label
};

export const PP_VALUE: TextStyle = {
  fontSize: 14,
  fontWeight: '500',
  color: PP.ink,
  lineHeight: 18,
};

export function passportNumber(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  const n = Math.abs(h).toString(36).toUpperCase().padStart(8, '0');
  return n.slice(0, 3) + ' ' + n.slice(3, 6) + ' ' + n.slice(6, 8);
}

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

export function countryFlag(countryName: string | null | undefined): { flag: string; code: string } | null {
  if (!countryName) return null;
  const code = COUNTRY_CODES[countryName];
  if (!code) return null;
  // Fallback to empty string for flag since we can't use emojis
  return { flag: '', code };
}

export function fmtMonthYear(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}
