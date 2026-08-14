/**
 * Keyboard-avoidance Android migration — static smoke-test
 *
 * Run with: pnpm test (node:test auto-discovery)
 *
 * ## What & Why
 *
 * Before migration, screens passed
 *   behavior={Platform.OS === 'ios' ? 'padding' : undefined}
 * so Android received no keyboard avoidance. After migration every screen uses
 * the shared KeyboardSafeScrollView, which supplies behavior='height' on
 * Android (see KeyboardSafeView.tsx and the companion .android.component test).
 *
 * These tests verify the structural side of that migration:
 *   - Each screen imports KeyboardSafeScrollView from the shared UI module.
 *   - Each screen's JSX uses <KeyboardSafeScrollView in its render output.
 *   - No screen still has a hand-rolled behavior={...undefined...} pattern.
 *
 * Screens confirmed here:
 *   • Previously had no Android avoidance → now get 'height' via the wrapper
 *       sign-in, post/[id], meetup/[id], ConciergeCommandBar
 *   • Already used 'height' (regression guard — must not have regressed)
 *       GroupChatScreen, HostDashboardPanel, PulseCreate
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// From src/lib/__tests__/ back to the travel-buddy-standalone root.
const ROOT = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

// ── Screens that previously had no Android avoidance ─────────────────────────

describe('sign-in screen — migrated from no Android avoidance', () => {
  const src = read('app/(auth)/sign-in.tsx');

  it('imports a KeyboardSafe wrapper from the shared UI module', () => {
    // sign-in uses KeyboardSafeView (built-in ScrollView) rather than
    // KeyboardSafeScrollView, because it has no separate outer scroll container.
    // Both wrappers supply behavior="height" on Android via the same constant.
    assert.ok(
      src.includes('KeyboardSafeView'),
      'sign-in must import a KeyboardSafe* wrapper from ui/KeyboardSafeView',
    );
  });

  it('renders a KeyboardSafe wrapper in its JSX — inputs are keyboard-safe on Android', () => {
    // Accepts either KeyboardSafeView or KeyboardSafeScrollView — both wrappers
    // provide behavior="height" on Android via the shared BEHAVIOR constant.
    assert.ok(
      src.includes('<KeyboardSafeView') || src.includes('<KeyboardSafeScrollView'),
      'sign-in JSX must include a <KeyboardSafe* wrapper so Android gets behavior="height"',
    );
  });

  it('does not hand-roll a bare KeyboardAvoidingView', () => {
    // Hand-rolled KAV would bypass the shared Android-correct behavior.
    const hasRawKAV = src.includes('<KeyboardAvoidingView');
    assert.ok(
      !hasRawKAV,
      'sign-in must not use a bare KeyboardAvoidingView; use KeyboardSafeView or KeyboardSafeScrollView instead',
    );
  });
});

describe('post detail screen — migrated from no Android avoidance', () => {
  const src = read('app/post/[id].tsx');

  it('imports KeyboardSafeScrollView from the shared UI module', () => {
    assert.ok(
      src.includes('KeyboardSafeScrollView') && src.includes('KeyboardSafeView'),
      'post/[id] must import KeyboardSafeScrollView from ui/KeyboardSafeView',
    );
  });

  it('renders <KeyboardSafeScrollView — comment input is keyboard-safe on Android', () => {
    assert.ok(
      src.includes('<KeyboardSafeScrollView'),
      'post/[id] JSX must include <KeyboardSafeScrollView',
    );
  });

  it('does not hand-roll a bare KeyboardAvoidingView', () => {
    assert.ok(
      !src.includes('<KeyboardAvoidingView'),
      'post/[id] must not use a bare KeyboardAvoidingView',
    );
  });
});

describe('meetup edit screen — migrated from no Android avoidance', () => {
  const src = read('app/meetup/[id].tsx');

  it('imports KeyboardSafeScrollView from the shared UI module', () => {
    assert.ok(
      src.includes('KeyboardSafeScrollView') && src.includes('KeyboardSafeView'),
      'meetup/[id] must import KeyboardSafeScrollView from ui/KeyboardSafeView',
    );
  });

  it('renders <KeyboardSafeScrollView — edit-form inputs are keyboard-safe on Android', () => {
    assert.ok(
      src.includes('<KeyboardSafeScrollView'),
      'meetup/[id] JSX must include <KeyboardSafeScrollView so the edit form is accessible above the keyboard',
    );
  });

  it('does not hand-roll a bare KeyboardAvoidingView', () => {
    assert.ok(
      !src.includes('<KeyboardAvoidingView'),
      'meetup/[id] must not use a bare KeyboardAvoidingView',
    );
  });
});

describe('ConciergeCommandBar — migrated from no Android avoidance', () => {
  const src = read('src/components/ConciergeCommandBar.tsx');

  it('imports KeyboardSafeScrollView from the shared UI module', () => {
    assert.ok(
      src.includes('KeyboardSafeScrollView') && src.includes('KeyboardSafeView'),
      'ConciergeCommandBar must import KeyboardSafeScrollView from ui/KeyboardSafeView',
    );
  });

  it('renders <KeyboardSafeScrollView — the command input is keyboard-safe on Android', () => {
    assert.ok(
      src.includes('<KeyboardSafeScrollView'),
      'ConciergeCommandBar JSX must include <KeyboardSafeScrollView',
    );
  });

  it('does not hand-roll a bare KeyboardAvoidingView', () => {
    assert.ok(
      !src.includes('<KeyboardAvoidingView'),
      'ConciergeCommandBar must not use a bare KeyboardAvoidingView',
    );
  });
});

// ── Screens that already used 'height' — regression guard ────────────────────

describe('GroupChatScreen — already used height, must not have regressed', () => {
  const src = read('src/components/GroupChatScreen.tsx');

  it('imports KeyboardSafeScrollView from the shared UI module', () => {
    assert.ok(
      src.includes('KeyboardSafeScrollView') && src.includes('KeyboardSafeView'),
      'GroupChatScreen must import KeyboardSafeScrollView',
    );
  });

  it('renders <KeyboardSafeScrollView — chat composer is keyboard-safe on Android', () => {
    assert.ok(
      src.includes('<KeyboardSafeScrollView'),
      'GroupChatScreen JSX must include <KeyboardSafeScrollView',
    );
  });
});

describe('HostDashboardPanel — already used height, must not have regressed', () => {
  const src = read('src/components/HostDashboardPanel.tsx');

  it('imports KeyboardSafeScrollView from the shared UI module', () => {
    assert.ok(
      src.includes('KeyboardSafeScrollView') && src.includes('KeyboardSafeView'),
      'HostDashboardPanel must import KeyboardSafeScrollView',
    );
  });

  it('renders <KeyboardSafeScrollView — panel inputs are keyboard-safe on Android', () => {
    assert.ok(
      src.includes('<KeyboardSafeScrollView'),
      'HostDashboardPanel JSX must include <KeyboardSafeScrollView',
    );
  });
});

describe('PulseCreate — already used height, must not have regressed', () => {
  const src = read('src/components/PulseCreate.tsx');

  it('imports KeyboardSafeScrollView from the shared UI module', () => {
    assert.ok(
      src.includes('KeyboardSafeScrollView') && src.includes('KeyboardSafeView'),
      'PulseCreate must import KeyboardSafeScrollView',
    );
  });

  it('renders <KeyboardSafeScrollView — post-creation inputs are keyboard-safe on Android', () => {
    assert.ok(
      src.includes('<KeyboardSafeScrollView'),
      'PulseCreate JSX must include <KeyboardSafeScrollView',
    );
  });
});

// ── Shared wrapper — Android constant locked ──────────────────────────────────

describe('KeyboardSafeView.tsx — BEHAVIOR constant is platform-branched', () => {
  const src = read('src/components/ui/KeyboardSafeView.tsx');

  it("defines BEHAVIOR with Platform.OS === 'ios' ? 'padding' : 'height'", () => {
    // The constant must branch on the platform so Android gets 'height'.
    assert.ok(
      src.includes("Platform.OS === 'ios'") &&
        src.includes("'padding'") &&
        src.includes("'height'"),
      "KeyboardSafeView.tsx must branch on Platform.OS and provide 'height' for Android",
    );
  });

  it("exports both KeyboardSafeScrollView and KeyboardSafeView", () => {
    assert.ok(
      src.includes('export function KeyboardSafeScrollView'),
      'KeyboardSafeScrollView must be exported',
    );
    assert.ok(
      src.includes('export function KeyboardSafeView'),
      'KeyboardSafeView must be exported',
    );
  });
});
