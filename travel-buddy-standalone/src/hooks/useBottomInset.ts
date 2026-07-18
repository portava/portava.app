/**
 * useBottomInset — returns the total bottom clearance required to keep
 * scroll content fully visible above the floating tab bar.
 *
 * Calculation:
 *   NAV_BAR_FILLER_HEIGHT (64 pill + 12 offset + 20 clearance = 96)
 *   + insets.bottom (iOS home indicator / Android nav bar)
 *
 * Usage:
 *   const bottomInset = useBottomInset();
 *   <FlatList contentContainerStyle={{ paddingBottom: bottomInset }} ... />
 *   <ScrollView contentContainerStyle={{ paddingBottom: bottomInset }} ... />
 *
 * On desktop (sidebar layout) insets.bottom is typically 0 and the
 * tab bar is hidden, so the returned value is still safe to use — it
 * just adds the standard 96 px clearance with no safe-area addition.
 */
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NAV_BAR_FILLER_HEIGHT } from './useNavBarCollapse.ts';

export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  return NAV_BAR_FILLER_HEIGHT + insets.bottom;
}
