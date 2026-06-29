/**
 * useNotificationHandler — wires up two notification-response paths:
 *
 *  1. Cold-start: app was killed; user tapped a push banner → app launches.
 *     getLastNotificationResponseAsync() captures the tap and routes immediately.
 *
 *  2. Live: app is foregrounded or backgrounded; user taps a banner.
 *     addNotificationResponseReceivedListener fires and routes.
 *
 * Routing priority:
 *   a. `data.actionUrl` — the canonical field used by NotificationTemplateService
 *   b. Legacy `data.screen` shim (availability → /trip/:id, meetup → /meetup/:id)
 *
 * Call this hook once inside a component that is always mounted (e.g. PushSetup
 * in the root layout). It is a no-op on web.
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { NotificationResponse } from 'expo-notifications';
import { router } from 'expo-router';
import {
  getLastNotificationResponseAsync,
  addNotificationResponseReceivedListener,
} from '../lib/safeNotifications';

type NotifData = Record<string, unknown> | null | undefined;

function resolveRoute(data: NotifData): string | null {
  if (!data) return null;

  if (typeof data.actionUrl === 'string' && data.actionUrl.length > 0) {
    return data.actionUrl;
  }

  if (data.screen === 'availability' && typeof data.tripId === 'string') {
    return `/trip/${data.tripId}`;
  }
  if (data.screen === 'meetup' && typeof data.meetupId === 'string') {
    return `/meetup/${data.meetupId}`;
  }

  return null;
}

function handleResponse(response: NotificationResponse): void {
  const data = response.notification.request.content.data as NotifData;
  const route = resolveRoute(data);
  if (route) {
    router.push(route as any);
  }
}

export function useNotificationHandler(): void {
  if (Platform.OS === 'web') return;

  const coldStartHandled = useRef(false);

  useEffect(() => {
    if (coldStartHandled.current) return;
    coldStartHandled.current = true;

    getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleResponse(response);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const sub = addNotificationResponseReceivedListener(handleResponse);
    return () => sub.remove();
  }, []);
}
