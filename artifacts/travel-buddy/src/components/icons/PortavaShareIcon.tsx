/**
 * PortavaShareIcon — the single custom Portava symbol for genuine
 * content-share actions (posts, media, trips, events, places, stamps, etc.).
 *
 * "Modern Open Connected": an almost-complete circular loop with a lower-right
 * opening, whose inner curve flows directly into a tapered arrow pointing
 * upper-right — sharing, forward movement, and passing content to someone
 * else. This is an original Portava vector, not a stock icon-library glyph;
 * it must not be composed from a generic circle + arrow + external-link icon.
 *
 * Keep the `d` path in sync with assets/icons/portava-share.svg and the web
 * counterpart (components/icons/PortavaShareIcon.web equivalent) — do not
 * duplicate or fork the path elsewhere.
 *
 * Use PortavaShareIcon directly only when you need bespoke layout control;
 * for a standard tappable share affordance, prefer
 * `components/share/PortavaShareButton.tsx`, which wraps this icon with the
 * shared touch target, pressed feedback, and accessibility props.
 */
import React from 'react';
import { Platform } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export const PORTAVA_SHARE_PATH =
  'M17.58,18.71 A8.7,8.7 0 1,0 14.19,20.67 A1,1 0 1,1 13.61,18.76 A6.7,6.7 0 1,1 16.22,17.25 A1,1 0 1,1 17.58,18.71 Z ' +
  'M6.57,16.8 L7.04,15.75 L7.54,14.76 L8.09,13.81 L8.69,12.92 L9.33,12.08 L10.01,11.3 L10.75,10.57 L11.52,9.9 L12.35,9.29 L11.94,8.66 Q15.1,9.16 13.99,11.86 L13.59,11.23 L12.86,11.69 L12.16,12.21 L11.5,12.78 L10.86,13.42 L10.25,14.11 L9.67,14.87 L9.13,15.68 L8.61,16.56 L8.13,17.5 A0.85,0.85 0 1,1 6.57,16.8 Z';

export interface PortavaShareIconProps {
  size?: number;
  color?: string;
  /**
   * Only set this when the icon is rendered standalone (no enclosing
   * Pressable/button already carrying the label) — otherwise the button
   * should own the accessible label and this should stay unset so the icon
   * remains a decorative child.
   */
  accessibilityLabel?: string;
  testID?: string;
}

function PortavaShareIconComponent({
  size = 24,
  color = '#11110F',
  accessibilityLabel,
  testID,
}: PortavaShareIconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      testID={testID}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
      {...(Platform.OS !== 'web'
        ? { importantForAccessibility: accessibilityLabel ? 'yes' : 'no-hide-descendants' }
        : null)}
    >
      <Path
        d={PORTAVA_SHARE_PATH}
        fill={color}
        fillRule="nonzero"
        clipRule="nonzero"
      />
    </Svg>
  );
}

export const PortavaShareIcon = React.memo(PortavaShareIconComponent);
