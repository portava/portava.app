/**
 * StampAnimationContext — screen-level traveling stamp animation.
 *
 * Architecture
 * ─────────────
 * StampAnimationProvider renders an absolutely-positioned overlay at the
 * root of the navigation tree. StampButton measures its own screen position
 * and calls triggerStamp() to launch the animation. For double-tap, content
 * wrappers call triggerStamp() with the tap coordinates as launchX/launchY.
 *
 * Animation sequence (full motion)
 * ──────────────────────────────────
 *  1. Stamp icon APPEARS at button position (24 px)
 *  2. GROWS while traveling to content center (24 → 160 px, 400 ms)
 *  3. ROTATES naturally: 0 → −12 → −22 → −30° during travel
 *  4. Dynamic SHADOW sharpens as stamp descends (soft far → tight contact)
 *  5. SLAMS into content center — squash + heavy haptic
 *  6. Passport ink impression FLASHES in at the content center
 *  7. `onImpact` fires → button fills hollow→filled, count increments
 *  8. Stamp REBOUNDS (spring) and RETURNS to button position (200 ms)
 *  9. Ink impression FADES (600–900 ms after impact)
 *
 * Reduced-motion: skips travel/shadow/rotation — keeps haptic, ink flash,
 * hollow→filled transition, and count update (all fire immediately).
 */
import React, {
  createContext,
  useContext,
  useCallback,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { StyleSheet, Dimensions, Platform } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withSequence,
  withDelay,
  runOnJS,
  useReducedMotion,
  Easing,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { PortavaInkStamp, type StampTheme } from '../components/stamps/PortavaInkStamp.tsx';
import { StampIcon } from '../components/stamps/StampIcon.tsx';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Full diameter of the traveling stamp at peak (matches ink seal size). */
const STAMP_FULL_SIZE = 160;

/** Stamp icon size at rest on the button — sets the launch scale. */
const BUTTON_SIZE = 24;

/** Scale factor: button icon → full seal. */
const LAUNCH_SCALE = BUTTON_SIZE / STAMP_FULL_SIZE; // ≈ 0.15

/** Shadow ellipse dimensions. */
const SHADOW_W = 120;
const SHADOW_H = 20;

// ── Timing (milliseconds) ───────────────────────────────────────────────────
/** Duration of the travel phase: button → content center. */
const TRAVEL_MS = 400;

/** Duration of the impact squash. */
const SQUASH_MS = 65;

/** Hold at content center before returning (ms). */
const HOLD_MS = 200;

/**
 * Delay before return journey starts, measured from impact.
 * Accounts for squash duration + spring rebound/settle + hold.
 */
const RETURN_DELAY_MS = SQUASH_MS + 260 + HOLD_MS; // ≈ 525 ms

/** Duration of the return journey. */
const RETURN_MS = 180;

/** Time from impact until ink starts fading. */
const INK_HOLD_MS = 620;

/** Duration of ink fade-out. */
const INK_FADE_MS = 380;

/** Whether running on web (constant for safe use inside worklets). */
const IS_WEB = Platform.OS === 'web';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StampTriggerParams {
  /** Center of the stamp icon in screen coordinates. */
  launchX: number;
  launchY: number;
  /** Center of the content area to stamp (defaults to screen center). */
  contentX?: number;
  contentY?: number;
  /** Visual theme for the ink seal. */
  theme?: StampTheme;
  /**
   * Fired at the moment of impact — change button to filled and
   * increment the count here.
   */
  onImpact: () => void;
  /** Fired after the full animation (stamp returned, ink fading). */
  onComplete?: () => void;
}

interface StampAnimationContextValue {
  /**
   * Launch the stamp animation.
   * Ignored while another animation is running (no queueing).
   */
  triggerStamp: (params: StampTriggerParams) => void;
  /** True while a stamp animation sequence is in progress. */
  isAnimating: boolean;
}

const StampAnimationContext = createContext<StampAnimationContextValue | null>(null);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** No-op fallback returned when the hook is called outside the provider. */
const NOOP_CONTEXT: StampAnimationContextValue = {
  triggerStamp: () => {},
  isAnimating: false,
};

export function useStampAnimationContext(): StampAnimationContextValue {
  // Return the real context when the provider is present (always the case in
  // the running app via _layout.tsx).  Fall back to a no-op so that isolated
  // component tests that don't wrap their tree still compile and render.
  return useContext(StampAnimationContext) ?? NOOP_CONTEXT;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function StampAnimationProvider({ children }: PropsWithChildren) {
  const prefersReducedMotion = useReducedMotion();
  const isAnimatingRef = useRef(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [overlayTheme, setOverlayTheme] = useState<StampTheme>('Default');

  // ── Shared values ─────────────────────────────────────────────────────────

  // Traveling stamp (rubber stamp icon)
  const stampX        = useSharedValue(0);
  const stampY        = useSharedValue(0);
  const stampScale    = useSharedValue(0);
  const stampOpacity  = useSharedValue(0);
  const stampRotation = useSharedValue(0); // degrees

  // Ink impression (passport seal — stays at content center)
  const inkX          = useSharedValue(0);
  const inkY          = useSharedValue(0);
  const inkOpacity    = useSharedValue(0);

  // Shadow ellipse beneath the traveling stamp
  const shadowOpacity = useSharedValue(0);

  // ── Animated styles ───────────────────────────────────────────────────────

  /** The rubber stamp icon that flies from button to content center. */
  const travelingStampStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    width: STAMP_FULL_SIZE,
    height: STAMP_FULL_SIZE,
    left: 0,
    top: 0,
    opacity: stampOpacity.value,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    transform: [
      { translateX: stampX.value - STAMP_FULL_SIZE / 2 },
      { translateY: stampY.value - STAMP_FULL_SIZE / 2 },
      { scale: stampScale.value },
      { rotate: `${stampRotation.value}deg` },
    ],
  }));

  /** Ink impression — positioned at content center, fades after impact. */
  const inkContainerStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    width: STAMP_FULL_SIZE,
    height: STAMP_FULL_SIZE,
    left: 0,
    top: 0,
    opacity: inkOpacity.value,
    transform: [
      { translateX: inkX.value - STAMP_FULL_SIZE / 2 },
      { translateY: inkY.value - STAMP_FULL_SIZE / 2 },
    ],
  }));

  /**
   * Shadow ellipse: soft and large when stamp is high, tight and dark at
   * contact. Blur is simulated on native via opacity; true CSS blur on web.
   */
  const shadowStyle = useAnimatedStyle(() => {
    const s = stampScale.value;
    // Vertical offset shrinks as stamp approaches surface
    const offsetY = 14 * (1 - s) + 5;
    const blurPx  = 9 * (1 - s) + 2;

    return {
      position: 'absolute',
      width: SHADOW_W,
      height: SHADOW_H,
      left: 0,
      top: 0,
      borderRadius: SHADOW_H,
      backgroundColor: 'rgba(0,0,0,0.55)',
      opacity: shadowOpacity.value,
      ...(IS_WEB ? { filter: `blur(${blurPx}px)` } : {}),
      transform: [
        { translateX: stampX.value - SHADOW_W / 2 },
        { translateY: stampY.value + offsetY },
        { scaleX: 0.45 + 0.55 * s },   // wider as stamp nears surface
        { scaleY: 0.12 + 0.12 * s },   // flat contact shadow
      ],
    };
  });

  // ── triggerStamp ──────────────────────────────────────────────────────────

  const triggerStamp = useCallback(
    (params: StampTriggerParams) => {
      if (isAnimatingRef.current) return;
      isAnimatingRef.current = true;
      setIsAnimating(true);

      const {
        launchX,
        launchY,
        theme = 'Default',
        onImpact,
        onComplete,
      } = params;

      const { width: W, height: H } = Dimensions.get('window');
      const contentX = params.contentX ?? W / 2;
      const contentY = params.contentY ?? H * 0.42;

      setOverlayTheme(theme);

      // ── JS-thread helpers (called via runOnJS from UI worklets) ───────────
      const fireHaptic = () => {
        if (Platform.OS !== 'web') {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        }
      };
      const fireImpact = () => {
        fireHaptic();
        onImpact();
      };
      const fireComplete = () => {
        isAnimatingRef.current = false;
        setIsAnimating(false);
        onComplete?.();
      };

      // ── Reduced-motion path ───────────────────────────────────────────────
      if (prefersReducedMotion) {
        inkX.value = contentX;
        inkY.value = contentY;
        stampOpacity.value = 0;
        shadowOpacity.value = 0;
        inkOpacity.value = withSequence(
          withTiming(1, { duration: 60 }),
          withDelay(350, withTiming(0, { duration: 300 })),
        );
        fireImpact();
        setTimeout(fireComplete, 750);
        return;
      }

      // ── Full animation ────────────────────────────────────────────────────

      // Position ink impression at content center (stays there; doesn't return).
      inkX.value = contentX;
      inkY.value = contentY;

      // Initialise traveling stamp at launch position.
      stampX.value = launchX;
      stampY.value = launchY;
      stampScale.value = LAUNCH_SCALE;
      stampOpacity.value = 1;
      stampRotation.value = 0;
      inkOpacity.value = 0;
      shadowOpacity.value = 0;

      // ── Scale: grow → squash → rebound → settle → hold → shrink ──────────
      stampScale.value = withSequence(
        withTiming(1.0, { duration: TRAVEL_MS, easing: Easing.out(Easing.cubic) }),
        withTiming(0.88, { duration: SQUASH_MS, easing: Easing.out(Easing.quad) }),
        withSpring(1.06, { damping: 5, stiffness: 420 }),
        withSpring(1.0,  { damping: 14, stiffness: 200 }),
        withDelay(HOLD_MS, withTiming(LAUNCH_SCALE, { duration: RETURN_MS, easing: Easing.in(Easing.cubic) })),
      );

      // ── Rotation: travel 0 → −30°, spring back to 0 after impact ─────────
      stampRotation.value = withSequence(
        withTiming(-30, { duration: TRAVEL_MS, easing: Easing.inOut(Easing.quad) }),
        withSpring(0, { damping: 10, stiffness: 180 }),
      );

      // ── Position X: travel → return ───────────────────────────────────────
      // Callback on the UI thread schedules the return after RETURN_DELAY_MS.
      stampX.value = withTiming(
        contentX,
        { duration: TRAVEL_MS, easing: Easing.out(Easing.cubic) },
        (finished) => {
          'worklet';
          if (!finished) { runOnJS(fireComplete)(); return; }
          stampX.value = withDelay(
            RETURN_DELAY_MS,
            withTiming(launchX, { duration: RETURN_MS, easing: Easing.in(Easing.cubic) }, (fin2) => {
              'worklet';
              if (fin2) {
                stampOpacity.value = withTiming(0, { duration: 80 });
                runOnJS(fireComplete)();
              }
            }),
          );
        },
      );

      // ── Position Y: same travel/return as X ───────────────────────────────
      stampY.value = withTiming(
        contentY,
        { duration: TRAVEL_MS, easing: Easing.out(Easing.cubic) },
        (finished) => {
          'worklet';
          if (!finished) return;
          stampY.value = withDelay(
            RETURN_DELAY_MS,
            withTiming(launchY, { duration: RETURN_MS, easing: Easing.in(Easing.cubic) }),
          );
        },
      );

      // ── Ink impression: flash in at impact, fade after INK_HOLD_MS ────────
      inkOpacity.value = withDelay(
        TRAVEL_MS,
        withSequence(
          withTiming(1, { duration: 45 }),
          withDelay(INK_HOLD_MS, withTiming(0, { duration: INK_FADE_MS })),
        ),
      );

      // ── Shadow: grows during travel, dissipates after impact ──────────────
      shadowOpacity.value = withSequence(
        withTiming(0.6, { duration: TRAVEL_MS }),
        withTiming(0, { duration: 260 }),
      );

      // ── Fire haptic + onImpact at the moment of impact ────────────────────
      setTimeout(fireImpact, TRAVEL_MS);
    },
    // Shared values are stable Reanimated refs — no deps needed beyond the flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefersReducedMotion],
  );

  // ── Context value ─────────────────────────────────────────────────────────
  const contextValue: StampAnimationContextValue = { triggerStamp, isAnimating };

  return (
    <StampAnimationContext.Provider value={contextValue}>
      {children}

      {/*
       * Screen-level overlay — rendered last so it floats above every screen.
       * pointerEvents="none" so it never intercepts touch events.
       */}
      <Animated.View style={[StyleSheet.absoluteFillObject, { pointerEvents: 'none' }]}>
        {/* 1. Shadow ellipse — sharpens as stamp descends */}
        <Animated.View style={shadowStyle} />

        {/* 2. Traveling rubber stamp icon */}
        <Animated.View style={travelingStampStyle}>
          <StampIcon size={STAMP_FULL_SIZE} active color="rgba(220,55,0,0.90)" />
        </Animated.View>

        {/* 3. Ink impression — stays at content center, fades after impact */}
        <Animated.View style={inkContainerStyle}>
          <PortavaInkStamp animatedStyle={{}} theme={overlayTheme} size={STAMP_FULL_SIZE} />
        </Animated.View>
      </Animated.View>
    </StampAnimationContext.Provider>
  );
}
