import { useWindowDimensions } from 'react-native';
import { space } from '../../../theme/tokens.ts';

/** Shared cards need a concrete width even when their title is only one word.
 * Match the narrowest chat row (82% of the padded conversation), capped on tablets.
 */
export function useSharedCardWidth(): number {
  const { width } = useWindowDimensions();
  return Math.min(280, Math.floor(Math.max(0, width - space.lg * 2) * 0.82));
}
