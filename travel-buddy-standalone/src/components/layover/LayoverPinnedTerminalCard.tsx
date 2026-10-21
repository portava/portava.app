/**
 * LayoverPinnedTerminalCard — spec §15 "At CONNECTION_AT_RISK … terminal/gate
 * context is pinned", and §13 "When RETURN_NOW is active … prioritize airport
 * route/gate" (census-layover L143, L120). LAYOVER 165, lane B2-CURATE.
 *
 * The server publishes `airport.terminalInfo` ONLY when the airport has a
 * PUBLISHED, UNEXPIRED, curator-validated terminal topology (migration 3874,
 * AirportProfileService). This card pins it while the certified posture says
 * the traveller is on the way back (`returnRoutePrimary`): the terminals, the
 * gates each serves, the checkpoints, and the links between terminals, exactly
 * as curated — nothing here is inferred, defaulted or re-derived.
 *
 * With no checked topology it says so in one line rather than drawing an empty
 * map: "no checked terminal details" is the honest state of every uncurated
 * airport, and a blank panel would look like data.
 *
 * Text colours: `ink` / `mute` on `paperRaised` only.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MapPin } from 'lucide-react-native';
import { color, radius, space, typography as t } from '../../theme/tokens.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

export interface PinnedTerminalLine {
  key: string;
  text: string;
}

/**
 * The lines the card draws, from the curated topology. Pure, so the copy is
 * tested without rendering. Unknown or malformed entries are skipped, never
 * guessed into a line.
 */
export function pinnedTerminalLines(terminalInfo: unknown): PinnedTerminalLine[] {
  if (!isObj(terminalInfo)) return [];
  const names = new Map<string, string>();
  const lines: PinnedTerminalLine[] = [];
  for (const term of list(terminalInfo.terminals)) {
    const id = text(term.id);
    const name = text(term.name) ?? id;
    if (!id || !name) continue;
    names.set(id, name);
    const serves = Array.isArray(term.serves) ? term.serves.filter((s): s is string => typeof s === 'string') : [];
    lines.push({ key: `t:${id}`, text: serves.length > 0 ? `${name} — ${serves.join(' and ')} flights` : name });
  }
  const nameOf = (id: unknown) => (typeof id === 'string' ? names.get(id) ?? null : null);
  for (const [i, g] of list(terminalInfo.gates).entries()) {
    const where = nameOf(g.terminalId);
    const label = text(g.label);
    if (where && label) lines.push({ key: `g:${i}`, text: `${label} — ${where}` });
  }
  for (const [i, c] of list(terminalInfo.checkpoints).entries()) {
    const where = nameOf(c.terminalId);
    const kind = c.kind === 'security' || c.kind === 'immigration' || c.kind === 'customs' ? c.kind : null;
    if (where && kind) lines.push({ key: `c:${i}`, text: `${kind[0]!.toUpperCase()}${kind.slice(1)} check — ${where}` });
  }
  for (const [i, l] of list(terminalInfo.walkingLinks).entries()) {
    const from = nameOf(l.fromTerminalId);
    const to = nameOf(l.toTerminalId);
    const minutes = typeof l.minutes === 'number' && Number.isFinite(l.minutes) && l.minutes > 0 ? Math.round(l.minutes) : null;
    const mode = l.mode === 'walk' || l.mode === 'train' || l.mode === 'bus' || l.mode === 'shuttle' ? l.mode : null;
    if (from && to) lines.push({ key: `l:${i}`, text: `${from} → ${to}${mode ? ` by ${mode}` : ''}${minutes ? `, about ${minutes} min` : ''}` });
  }
  return lines;
}

export const NO_CHECKED_TERMINAL =
  "We don't have checked terminal details for this airport — follow the airport's signs to your gate.";

export function LayoverPinnedTerminalCard({ terminalInfo, airportCode }: { terminalInfo: unknown; airportCode: string | null }) {
  const lines = pinnedTerminalLines(terminalInfo);
  return (
    <View style={styles.card} testID="layover-pinned-terminal" accessibilityRole="summary">
      <View style={styles.head}>
        <MapPin size={16} color={color.ink} />
        <Text style={styles.title}>{airportCode ? `${airportCode} terminals` : 'Terminals'}</Text>
      </View>
      {lines.length === 0 ? (
        <Text style={styles.mute} testID="layover-pinned-terminal-none">{NO_CHECKED_TERMINAL}</Text>
      ) : (
        <>
          {lines.map((l) => (
            <Text key={l.key} style={styles.line} testID={`layover-pinned-terminal-${l.key}`}>{l.text}</Text>
          ))}
          <Text style={styles.mute}>From the airport's official information, checked by Portava.</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, gap: space.xs, marginTop: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  title: { ...t.cardTitle, color: color.ink },
  line: { ...t.body, color: color.ink },
  mute: { ...t.caption, color: color.mute },
});
