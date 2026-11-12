/** One geometry source for the floating bar and the content/layover clearance. */
export const FLOATING_TAB_BAR_HEIGHT = 64;
export const FLOATING_TAB_BAR_LABEL_HEIGHT = 13;
export const FLOATING_TAB_BAR_MAX_FONT_SCALE = 2;

export function floatingTabBarMetrics(fontScale = 1) {
  const scale = Number.isFinite(fontScale) ? Math.max(1, Math.min(FLOATING_TAB_BAR_MAX_FONT_SCALE, fontScale)) : 1;
  const labelHeight = Math.ceil(FLOATING_TAB_BAR_LABEL_HEIGHT * scale);
  const extraHeight = labelHeight - FLOATING_TAB_BAR_LABEL_HEIGHT;
  return { labelHeight, extraHeight, height: FLOATING_TAB_BAR_HEIGHT + extraHeight };
}
