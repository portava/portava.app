import AsyncStorage from '@react-native-async-storage/async-storage';
import { freshToken } from './apiToken.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from './discoveryViewerScope.ts';
export type ProtectedCategory = 'home' | 'work' | 'school';
export interface ProtectedPlace { id: string; category: ProtectedCategory; lat: number; lng: number; radiusMeters: number }
export interface RouteFlowConsent { available: boolean; granted: boolean; current: boolean; withdrawalPending?: boolean; disclosure: { version: string; title: string; what: string; who: string; retention: string; off: string } | null }
const pendingWithdrawals = new Set<string>();
const key = (owner: string) => `map_route_flow_withdrawal_v1:${encodeURIComponent(owner)}`;
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const owner = currentDiscoveryScope();
  if (!owner.viewer?.startsWith('u:')) throw new Error('Sign in to manage map privacy.');
  const token = await freshToken();
  if (!token || !isCurrentDiscoveryScope(owner)) throw new Error('Account changed. Please try again.');
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const base = process.env.EXPO_PUBLIC_API_BASE_URL;
    if (!base) throw new Error('Map privacy is unavailable.');
    const response = await fetch(`${base}/api/map/privacy${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new Error('Your change could not be confirmed. Please try again.');
    const result = response.status === 204 ? undefined : await response.json();
    if (!isCurrentDiscoveryScope(owner)) throw new Error('Account changed. Please try again.');
    return result as T;
  } finally { clearTimeout(timeout); }
}
export async function readProtectedPlaces(): Promise<ProtectedPlace[]> {
  const result = await request<{ places: ProtectedPlace[] }>('/protected-places');
  if (!Array.isArray(result?.places)) throw new Error('Protected places could not be read.');
  return result.places;
}
export async function saveProtectedPlace(category: ProtectedCategory, point: { lat: number; lng: number }): Promise<void> {
  await request('/protected-places', 'PUT', { category, lat: Number(point.lat.toFixed(2)), lng: Number(point.lng.toFixed(2)), radiusMeters: 1500 });
}
export async function removeProtectedPlace(category: ProtectedCategory): Promise<void> { await request(`/protected-places/${category}`, 'DELETE'); }
export async function readMapRouteConsent(): Promise<RouteFlowConsent> {
  const owner = currentDiscoveryScope(); const result = await request<RouteFlowConsent>('/route-flow');
  if (!result || typeof result.granted !== 'boolean' || typeof result.available !== 'boolean' || typeof result.current !== 'boolean') throw new Error('Route settings could not be read.');
  const pending = owner.viewer && (pendingWithdrawals.has(owner.viewer) || await AsyncStorage.getItem(key(owner.viewer)) !== null);
  return pending ? { ...result, granted: false, current: false, withdrawalPending: true } : result;
}
export async function setMapRouteConsent(granted: boolean, displayedVersion?: string): Promise<void> {
  const scope = currentDiscoveryScope(); const owner = scope.viewer; if (!owner?.startsWith('u:')) throw new Error('Sign in first.');
  if (granted && (pendingWithdrawals.has(owner) || await AsyncStorage.getItem(key(owner)) !== null)) throw new Error('Complete the pending withdrawal before opting in again.');
  if (!granted) { pendingWithdrawals.add(owner); try { await AsyncStorage.setItem(key(owner), 'pending'); } catch {} }
  if (!isCurrentDiscoveryScope(scope)) throw new Error('Account changed. Please try again.');
  await request('/route-flow', 'PUT', { granted, ...(displayedVersion ? { displayedVersion } : {}) });
  if (!granted) { await AsyncStorage.removeItem(key(owner)); pendingWithdrawals.delete(owner); }
}
/** Called only by the navigation press. Never prompts or starts location capture. */
export async function contributeNavigationIntent(destination: { lat: number; lng: number }): Promise<void> {
  const owner = currentDiscoveryScope();
  try {
    const consent = await readMapRouteConsent();
    if (!consent.granted || !consent.available || !consent.current || !consent.disclosure || !isCurrentDiscoveryScope(owner)) return;
    const location: typeof import('expo-location') = require('expo-location');
    if ((await location.getForegroundPermissionsAsync()).status !== 'granted') return;
    const recent = await location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 100 });
    if (!recent || recent.timestamp > Date.now() + 5000 || Date.now() - recent.timestamp > 60000 || !isCurrentDiscoveryScope(owner)) return;
    if (!owner.viewer || pendingWithdrawals.has(owner.viewer) || await AsyncStorage.getItem(key(owner.viewer)) !== null || !isCurrentDiscoveryScope(owner)) return;
    await request('/navigation', 'POST', { origin: { lat: recent.coords.latitude, lng: recent.coords.longitude }, destination, observedAt: recent.timestamp, displayedVersion: consent.disclosure.version });
  } catch { /* An optional contribution never blocks the requested navigation. */ }
}
