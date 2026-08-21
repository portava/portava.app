/**
 * OwnerActionMenu — backward-compatibility re-export.
 *
 * The canonical implementation lives in
 * `src/components/passport/PassportOwnerMenuSheet.tsx`.
 * This file keeps the `OwnerActionMenu` named export so existing call sites
 * and test mocks that reference `src/components/OwnerActionMenu` keep working
 * without any path changes.
 */
import React from 'react';
import { Share } from 'react-native';
import {
  PassportOwnerMenuSheet,
  type PassportOwnerMenuSheetProps,
} from './passport/PassportOwnerMenuSheet.tsx';

// ── Legacy props interface (kept for backward compatibility) ──────────────────
export interface OwnerActionMenuProps {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  onEditProfile: () => void;
  onSettings: () => void;
  onViewAsPublic: () => void;
  onArrangeSections?: () => void;
  onArrangeTabs?: () => void;
  onCreatePress?: () => void;
}

/**
 * Thin wrapper that maps the legacy flat-prop interface onto
 * `PassportOwnerMenuSheet`. Any call site still using the old props will
 * continue to compile and render correctly.
 */
export function OwnerActionMenu({
  visible,
  onClose,
  username,
  onEditProfile,
  onSettings,
  onViewAsPublic,
  onArrangeSections,
  onArrangeTabs,
}: OwnerActionMenuProps) {
  return (
    <PassportOwnerMenuSheet
      visible={visible}
      onClose={onClose}
      username={username}
      onEditProfile={onEditProfile}
      onSettings={onSettings}
      onViewAsPublic={onViewAsPublic}
      onArrangeSections={onArrangeSections}
      onArrangeTabs={onArrangeTabs}
    />
  );
}

// Re-export the new component so consumers can upgrade to the direct import.
export { PassportOwnerMenuSheet };
export type { PassportOwnerMenuSheetProps };
