/**
 * AirportEssentialsCard — quick-reference card shown on the layover dashboard.
 *
 * Covers: local currency, primary language, tipping custom, and a general
 * in-airport safety tip. Static curated data keyed on ISO-2 country code.
 * Gracefully omits itself when the country isn't in the dataset.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Banknote, Languages, ShieldCheck, Info } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface AirportEssential {
  currency: string;
  currencyCode: string;
  language: string;
  tipping: string;
  safetyTip: string;
}

const ESSENTIALS: Record<string, AirportEssential> = {
  US: { currency: 'US Dollar', currencyCode: 'USD', language: 'English', tipping: 'Expected at restaurants & taxis (15–20%)', safetyTip: 'Keep your bag in front of you in crowded terminals.' },
  GB: { currency: 'Pound Sterling', currencyCode: 'GBP', language: 'English', tipping: 'Customary at restaurants (10–15%)', safetyTip: 'Mind the gap — follow platform safety signs on the Tube.' },
  FR: { currency: 'Euro', currencyCode: 'EUR', language: 'French', tipping: 'Service included; round up to be polite', safetyTip: 'Pickpocketing is common at CDG — use front pockets and zipped bags.' },
  DE: { currency: 'Euro', currencyCode: 'EUR', language: 'German', tipping: 'Round up the bill (5–10%)', safetyTip: 'FRA/MUC are efficient — allow 90 min for long-haul connections.' },
  ES: { currency: 'Euro', currencyCode: 'EUR', language: 'Spanish', tipping: 'Not expected; €1–2 for good service', safetyTip: 'Barcelona airport: watch your bags at security lanes.' },
  IT: { currency: 'Euro', currencyCode: 'EUR', language: 'Italian', tipping: 'Small change left on the table', safetyTip: 'FCO terminals are spread out — allow 30 min to walk between them.' },
  NL: { currency: 'Euro', currencyCode: 'EUR', language: 'Dutch', tipping: 'Round up or 10% for great service', safetyTip: 'Schiphol has a quiet zone — good for rest during long layovers.' },
  JP: { currency: 'Japanese Yen', currencyCode: 'JPY', language: 'Japanese', tipping: 'Tipping is not customary — do not tip', safetyTip: 'Narita & Haneda: follow gate signs carefully — terminals are very large.' },
  KR: { currency: 'South Korean Won', currencyCode: 'KRW', language: 'Korean', tipping: 'Not customary in airports', safetyTip: 'ICN has a free transit hotel and shower facilities — ask at the transfer desk.' },
  SG: { currency: 'Singapore Dollar', currencyCode: 'SGD', language: 'English / Mandarin / Malay / Tamil', tipping: 'Not customary; service charge included', safetyTip: 'Changi is very safe — relax, explore the gardens and rooftop pool.' },
  TH: { currency: 'Thai Baht', currencyCode: 'THB', language: 'Thai', tipping: 'Small tip appreciated at restaurants (20–50 THB)', safetyTip: 'BKK Suvarnabhumi: immigration queues can be long — arrive early.' },
  ID: { currency: 'Indonesian Rupiah', currencyCode: 'IDR', language: 'Indonesian (Bahasa)', tipping: 'Not customary; appreciated at tourist spots', safetyTip: 'Bali airport (DPS): use official taxis from the fixed-fare booth inside arrivals.' },
  MY: { currency: 'Malaysian Ringgit', currencyCode: 'MYR', language: 'Malay / English', tipping: 'Not expected; service charge often added', safetyTip: 'KLIA2 is a separate terminal — check which one your onward flight uses.' },
  IN: { currency: 'Indian Rupee', currencyCode: 'INR', language: 'Hindi / English (official)', tipping: '10–15% at restaurants; round up for taxis', safetyTip: 'Use pre-paid taxis from the official desk inside arrivals — avoid touts.' },
  AE: { currency: 'UAE Dirham', currencyCode: 'AED', language: 'Arabic / English', tipping: '10–15% if no service charge', safetyTip: 'DXB is huge — allow 45–60 min to transit between concourses.' },
  AU: { currency: 'Australian Dollar', currencyCode: 'AUD', language: 'English', tipping: 'Not expected; round up if service was great', safetyTip: 'Declare all food items at biosecurity — fines are steep.' },
  CA: { currency: 'Canadian Dollar', currencyCode: 'CAD', language: 'English / French', tipping: 'Expected at restaurants (15–20%)', safetyTip: 'YYZ: domestic-to-international connections need a security re-screen.' },
  BR: { currency: 'Brazilian Real', currencyCode: 'BRL', language: 'Portuguese', tipping: '10% service charge usually included', safetyTip: 'GRU: use accredited taxis or apps — avoid unlicensed drivers.' },
  MX: { currency: 'Mexican Peso', currencyCode: 'MXN', language: 'Spanish', tipping: '10–15% at restaurants', safetyTip: 'CDMX airport: use official airport taxi vouchers purchased inside.' },
  ZA: { currency: 'South African Rand', currencyCode: 'ZAR', language: 'Zulu / Xhosa / Afrikaans / English', tipping: '10–15% at restaurants; R5–20 for helpers', safetyTip: 'JNB: use official transport; be aware of surroundings outside the terminal.' },
  HK: { currency: 'Hong Kong Dollar', currencyCode: 'HKD', language: 'Cantonese / English', tipping: 'Not expected; small change appreciated', safetyTip: 'HKIA: free transit hotel available for connections over 6 hours — ask at transfer desk.' },
  CN: { currency: 'Chinese Yuan (Renminbi)', currencyCode: 'CNY', language: 'Mandarin', tipping: 'Not customary', safetyTip: 'PEK/PVG: VPN may be needed for internet access — download content before you land.' },
  VN: { currency: 'Vietnamese Dong', currencyCode: 'VND', language: 'Vietnamese', tipping: 'Not expected; rounding up is appreciated', safetyTip: 'SGN/HAN: use fixed-price taxis from inside arrivals; avoid street touts.' },
  GR: { currency: 'Euro', currencyCode: 'EUR', language: 'Greek', tipping: 'Round up or leave 5–10%', safetyTip: 'ATH: pickpocketing can occur in transit — keep valuables secure.' },
  TR: { currency: 'Turkish Lira', currencyCode: 'TRY', language: 'Turkish', tipping: '10–15% at restaurants', safetyTip: 'IST is one of the world\'s busiest — follow signs early to avoid missing gates.' },
  PH: { currency: 'Philippine Peso', currencyCode: 'PHP', language: 'Filipino / English', tipping: '10% if no service charge', safetyTip: 'MNL: keep receipts for all purchases — needed at security exit.' },
};

interface Props {
  countryCode: string | null;
  countryName?: string;
}

export function AirportEssentialsCard({ countryCode, countryName }: Props) {
  const code = countryCode?.toUpperCase() ?? '';
  const data = ESSENTIALS[code];
  if (!data) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Airport essentials</Text>
      {countryName ? <Text style={styles.subhead}>{countryName}</Text> : null}

      <View style={styles.grid}>
        <Row icon={<Banknote size={14} color={color.deep} />} label="Currency" value={`${data.currency} (${data.currencyCode})`} />
        <Row icon={<Languages size={14} color={color.deep} />} label="Language" value={data.language} />
        <Row icon={<Info size={14} color={color.deep} />} label="Tipping" value={data.tipping} />
      </View>

      <View style={styles.safetyRow}>
        <ShieldCheck size={13} color={color.success} />
        <Text style={styles.safetyText}>{data.safetyTip}</Text>
      </View>
    </View>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>{icon}</View>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  heading: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  subhead: {
    ...t.small,
    color: color.mute,
    marginTop: -space.xs,
  },
  grid: {
    gap: space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  rowIcon: {
    width: 22,
    alignItems: 'center',
    marginTop: 1,
  },
  rowBody: {
    flex: 1,
    gap: 1,
  },
  rowLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    ...t.small,
    color: color.ink,
    lineHeight: 17,
  },
  safetyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    backgroundColor: 'rgba(52,168,83,0.07)',
    borderRadius: radius.sm,
    padding: space.sm,
    marginTop: space.xs,
  },
  safetyText: {
    ...t.small,
    color: color.ink,
    flex: 1,
    lineHeight: 17,
  },
});
