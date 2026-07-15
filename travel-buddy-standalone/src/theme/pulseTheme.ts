/**
 * pulseTheme — Portava Pulse screen palette (approved dark-navy concept).
 *
 * The Pulse screen runs a premium dark-navy look while the rest of the app
 * keeps the ivory/passport direction, so these tokens live in their own file
 * instead of the global `tokens.ts`. Accents reuse the Portava brand set:
 * teal, coral (the existing `color.signal` vermilion family), and orange.
 */
export const pv = {
  /* Surfaces */
  navy: '#0B1424',        // page background
  navyRaised: '#121F35',  // raised cards / banner surfaces
  navyEdge: 'rgba(255,255,255,0.08)',   // hairline borders on navy
  navySoft: 'rgba(255,255,255,0.06)',   // soft fills (chips, icon buttons)

  /* Text on navy */
  text: '#F4F7FB',
  textMute: 'rgba(244,247,251,0.66)',
  textFaint: 'rgba(244,247,251,0.42)',

  /* Portava accents */
  teal: '#2EC4B6',
  tealDim: 'rgba(46,196,182,0.16)',
  coral: '#FF4D2E',       // matches color.signal — primary action stays consistent
  coralDim: 'rgba(255,77,46,0.16)',
  orange: '#FF9F45',
  orangeDim: 'rgba(255,159,69,0.16)',
} as const;
