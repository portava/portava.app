import { Redirect } from 'expo-router';
// Placeholder route for the center stamp button. The tab press is intercepted
// in _layout to open the /create modal, so this only renders if reached directly.
export default function CreateTab() {
  return <Redirect href="/create" />;
}
