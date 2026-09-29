/**
 * app/passport/recaps.tsx
 *
 * Route wrapper for Personal Recaps and "On this day" (§5, testing-mode WP-12,
 * COMP-F17). The screen lives in src/features/passport/MemoryRecapsScreen.tsx
 * and draws its own header. Not to be confused with app/recaps/[id].tsx, the
 * place-recap archive (a different system).
 */
import React from 'react';
import MemoryRecapsScreen from '../../src/features/passport/MemoryRecapsScreen.tsx';

export default function PassportRecapsRoute() {
  return <MemoryRecapsScreen />;
}
