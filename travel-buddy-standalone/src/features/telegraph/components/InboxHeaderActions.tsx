/**
 * Telegraph inbox header actions — WP-08 (TEL-F08, TEL-F23).
 *
 * Saved messages and Message settings had no way in: the list and the settings
 * `canMessage` actually enforces existed only as routes. They sit beside New
 * Telegraph, which is unchanged. A component of its own so the inbox screen —
 * which census-telegraph cites by line — mounts it without moving any line.
 */
import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Bookmark, Settings2 } from 'lucide-react-native';
import { color } from '../../../theme/tokens.ts';

export interface InboxHeaderActionsProps {
  composeStyle: StyleProp<ViewStyle>;
  composeIcon: React.ReactNode;
  onCompose: () => void;
  onSaved: () => void;
  onSettings: () => void;
}

export function InboxHeaderActions({ composeStyle, composeIcon, onCompose, onSaved, onSettings }: InboxHeaderActionsProps) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Pressable style={composeStyle} onPress={onSaved} accessibilityRole="button" accessibilityLabel="Saved messages" testID="telegraph-inbox-saved" hitSlop={8}>
        <Bookmark size={19} color={color.mute} />
      </Pressable>
      <Pressable style={composeStyle} onPress={onSettings} accessibilityRole="button" accessibilityLabel="Message settings" testID="telegraph-inbox-settings" hitSlop={8}>
        <Settings2 size={19} color={color.mute} />
      </Pressable>
      <Pressable style={composeStyle} onPress={onCompose} accessibilityRole="button" accessibilityLabel="New Telegraph" hitSlop={8}>
        {composeIcon}
      </Pressable>
    </View>
  );
}

export default InboxHeaderActions;
