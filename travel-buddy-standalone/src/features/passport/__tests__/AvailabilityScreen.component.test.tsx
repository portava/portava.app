/**
 * Component tests for the Passport Availability editor
 * (spec §6/§7/§8, TABLE 7/8/9/10).
 *
 * Two seams are exercised:
 *   • AvailabilityView — the presentational screen, rendered with a FABRICATED
 *     editor (no data hook, no async), so the UI contract is deterministic:
 *       1. The WEEKLY recurring grid (TABLE 9) and the INTENT chips (§8) render.
 *       2. §31 — an expired window is never shown as the current status
 *          (the hook yields currentWindow=null; the view shows "Not set yet").
 *       3. The Open-to-Plans toggle is wired to setOpenToPlans.
 *       4. The Social Availability options (TABLE 10) render and are selectable.
 *   • useAvailabilityEditor — the real hook against a mocked service, proving
 *     the explicit-set path writes source='explicit' (§7).
 *
 * NOTE: render()/renderHook() are awaited (RNTL 14 + React 19 + jest-expo) or the
 * tree stays unbound and queries throw "render not called".
 */
import React from 'react';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { AvailabilityView } from '../AvailabilityScreen.tsx';
import {
  useAvailabilityEditor,
  pickCurrentWindow,
  defaultTonightWindow,
  type UseAvailabilityEditorResult,
} from '../useAvailabilityEditor.ts';
import * as availabilitySvc from '../../../services/availability.ts';

// NOTE: intentional exhaustive stub — the real service reaches Supabase auth +
// the API server, neither of which exists in the jest-expo env. These are the
// seams under test; every function the hook calls is a jest.fn so the create /
// patch paths can be asserted on. (No requireActual: we want deterministic fns.)
jest.mock('../../../services/availability', () => ({
  getMyAvailability: jest.fn(),
  patchMyAvailability: jest.fn(),
  getMyAvailabilityWindows: jest.fn(),
  createMyAvailabilityWindow: jest.fn(),
  patchMyAvailabilityWindow: jest.fn(),
  deleteMyAvailabilityWindow: jest.fn(),
}));

// NOTE: react-native-safe-area-context needs a provider that isn't mounted in
// these unit renders — spread the real module and override just the insets hook.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetAvailability = availabilitySvc.getMyAvailability as jest.Mock;
const mockPatchAvailability = availabilitySvc.patchMyAvailability as jest.Mock;
const mockGetWindows = availabilitySvc.getMyAvailabilityWindows as jest.Mock;
const mockCreateWindow = availabilitySvc.createMyAvailabilityWindow as jest.Mock;
const mockPatchWindow = availabilitySvc.patchMyAvailabilityWindow as jest.Mock;

type AvailabilityWindow = availabilitySvc.AvailabilityWindow;

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeWindow(over: Partial<AvailabilityWindow> = {}): AvailabilityWindow {
  const now = Date.now();
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: 'u1',
    type: 'one_time',
    startAt: new Date(now - 3_600_000).toISOString(),
    endAt: new Date(now + 3_600_000).toISOString(),
    tripId: null,
    openToPlans: true,
    intents: ['Nightlife'],
    groupPreference: 'small_group',
    maxTravelMinutes: 20,
    visibility: 'followers',
    source: 'explicit',
    socialAvailability: 'maybe',
    expiresAt: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...over,
  };
}

/** A fully-formed editor result for rendering AvailabilityView in isolation. */
function makeEditor(over: Partial<UseAvailabilityEditorResult> = {}): UseAvailabilityEditorResult {
  const { startAt, endAt } = defaultTonightWindow(Date.now());
  return {
    loading: false,
    error: null,
    saving: false,
    windowsEnabled: true,
    currentWindow: null,
    inferredPrompt: null,
    draft: {
      openToPlans: false,
      intents: [],
      groupPreference: null,
      maxTravelMinutes: null,
      socialAvailability: 'not_open',
      startAt,
      endAt,
      visibility: 'followers',
    },
    weeklyDays: {},
    setOpenToPlans: jest.fn(),
    toggleIntent: jest.fn(),
    setGroupPreference: jest.fn(),
    setMaxTravelMinutes: jest.fn(),
    setSocialAvailability: jest.fn(),
    toggleWeeklyBlock: jest.fn(),
    save: jest.fn().mockResolvedValue({ ok: true, enabled: true }),
    clearWindow: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Defaults for the hook test's mounted load().
  mockGetAvailability.mockResolvedValue({
    ok: true,
    data: { weeklyDays: {}, openToMeet: false, strictMode: false, quickStatus: null },
  });
  mockGetWindows.mockResolvedValue({ ok: true, data: { windows: [], enabled: true } });
  mockPatchAvailability.mockResolvedValue({ ok: true, data: { weeklyDays: {}, openToMeet: false } });
  mockCreateWindow.mockResolvedValue({ ok: true, data: { window: makeWindow(), enabled: true } });
  mockPatchWindow.mockResolvedValue({ ok: true, data: { window: makeWindow(), enabled: true } });
});

// ── AvailabilityView (presentational) ──────────────────────────────────────────

describe('AvailabilityView', () => {
  it('renders the weekly recurring grid and the intent chips', async () => {
    await render(<AvailabilityView editor={makeEditor()} />);

    // Intent chips (§8 / TABLE 9)
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Drinks')).toBeTruthy();
    expect(screen.getByText('Nightlife')).toBeTruthy();
    expect(screen.getByText('Explore')).toBeTruthy();
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByText('Meet Travelers')).toBeTruthy();

    // Weekly grid: all seven weekday rows (TABLE 9)
    expect(screen.getByText('Mon')).toBeTruthy();
    expect(screen.getByText('Sun')).toBeTruthy();
    // Each weekday exposes the four time blocks → 7 "Morning" cells.
    expect(screen.getAllByText('Morning').length).toBe(7);
  });

  it('pressing an intent chip toggles it through the editor', async () => {
    const editor = makeEditor();
    await render(<AvailabilityView editor={editor} />);

    fireEvent.press(screen.getByLabelText('Nightlife'));
    expect(editor.toggleIntent).toHaveBeenCalledWith('Nightlife');
  });

  it('never shows an expired window as the current status (§31)', async () => {
    // Pure-helper guarantee (§31): an expired explicit window is not "current".
    const past = Date.now() - 10 * 60_000;
    const expired = makeWindow({
      startAt: new Date(past - 3_600_000).toISOString(),
      endAt: new Date(past).toISOString(),
      source: 'explicit',
    });
    expect(pickCurrentWindow([expired], Date.now())).toBeNull();
    // A live one IS selected.
    const live = makeWindow();
    expect(pickCurrentWindow([live], Date.now())?.id).toBe(live.id);

    // The view, given currentWindow=null (what the hook yields for the expired
    // list), presents "no current window" — never the stale window as current.
    await render(<AvailabilityView editor={makeEditor({ currentWindow: null })} />);
    expect(screen.getByText('Not set yet — press Set Availability.')).toBeTruthy();
    expect(screen.queryByText('Live now — expires when this window ends.')).toBeNull();
  });

  it('shows a live window as current when one is set', async () => {
    await render(<AvailabilityView editor={makeEditor({ currentWindow: makeWindow() })} />);
    expect(screen.getByText('Live now — expires when this window ends.')).toBeTruthy();
  });

  it('toggles Open to Plans through the editor', async () => {
    const editor = makeEditor();
    await render(<AvailabilityView editor={editor} />);

    const toggle = screen.getByLabelText('Open to Plans');
    expect(toggle.props.value).toBe(false);
    expect(screen.getByText('Off')).toBeTruthy();

    fireEvent(toggle, 'valueChange', true);
    expect(editor.setOpenToPlans).toHaveBeenCalledWith(true);
  });

  it('reflects an ON toggle state from the draft', async () => {
    const editor = makeEditor({
      draft: { ...makeEditor().draft, openToPlans: true },
    });
    await render(<AvailabilityView editor={editor} />);

    expect(screen.getByLabelText('Open to Plans').props.value).toBe(true);
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('renders and selects the social-availability options (TABLE 10)', async () => {
    const editor = makeEditor();
    await render(<AvailabilityView editor={editor} />);

    // All five TABLE 10 options present. ("Crew only" also labels a Group
    // Preference chip, so assert the social row via its unique description.)
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Maybe')).toBeTruthy();
    expect(screen.getByText('Just my crew')).toBeTruthy();
    expect(screen.getByText('Following only')).toBeTruthy();
    expect(screen.getByText('Not open')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Open'));
    expect(editor.setSocialAvailability).toHaveBeenCalledWith('open');
  });

  it('the "Set Availability" CTA invokes the editor save()', async () => {
    const editor = makeEditor();
    await render(<AvailabilityView editor={editor} />);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Set Availability'));
    });
    expect(editor.save).toHaveBeenCalledTimes(1);
  });
});

// ── useAvailabilityEditor (real hook, mocked service) ──────────────────────────

describe('useAvailabilityEditor — explicit-set path (§7)', () => {
  it("writes source='explicit' when saving with no current window", async () => {
    mockGetWindows.mockResolvedValue({ ok: true, data: { windows: [], enabled: true } });

    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The user picks an intent, then presses the explicit "Set Availability".
    await act(async () => {
      result.current.toggleIntent('Food');
    });
    await act(async () => {
      await result.current.save();
    });

    // §7: an answer given through the screen IS explicit — no current window, so
    // a new one is CREATED (never PATCHED) with source='explicit'.
    expect(mockCreateWindow).toHaveBeenCalledTimes(1);
    expect(mockPatchWindow).not.toHaveBeenCalled();
    expect(mockCreateWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'explicit',
        type: 'one_time',
        intents: expect.arrayContaining(['Food']),
      }),
    );
    // The weekly grid is persisted in the same explicit save.
    expect(mockPatchAvailability).toHaveBeenCalledTimes(1);
  });

  it('patches the existing window instead of creating when one is current', async () => {
    mockGetWindows.mockResolvedValue({ ok: true, data: { windows: [makeWindow()], enabled: true } });

    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.currentWindow).not.toBeNull());

    await act(async () => {
      await result.current.save();
    });

    expect(mockPatchWindow).toHaveBeenCalledTimes(1);
    expect(mockCreateWindow).not.toHaveBeenCalled();
  });
});
