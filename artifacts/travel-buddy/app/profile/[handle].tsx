import { useEffect } from 'react';
import { useLocalSearchParams, router } from 'expo-router';

export default function ProfileHandleRedirect() {
  const { handle } = useLocalSearchParams<{ handle: string }>();

  useEffect(() => {
    if (handle) {
      router.replace(`/u/${encodeURIComponent(handle)}`);
    } else {
      router.back();
    }
  }, [handle]);

  return null;
}
