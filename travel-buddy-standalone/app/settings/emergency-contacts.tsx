/** Legacy route — content moved into the Edit Profile & Settings hub. */
import { Redirect } from 'expo-router';

export default function LegacyRedirect() {
  return <Redirect href={"/profile/edit/emergency-contacts" as any} />;
}
