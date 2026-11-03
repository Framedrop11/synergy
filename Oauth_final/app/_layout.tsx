import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { configureGoogleSignIn } from '@/utils/googleSignIn';

const API_URL = process.env.EXPO_PUBLIC_API_URL;
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

export default function RootLayout() {
  useEffect(() => {
    if (GOOGLE_WEB_CLIENT_ID) {
      void configureGoogleSignIn(GOOGLE_WEB_CLIENT_ID).catch(() => {});
    }
    if (API_URL) {
      fetch(`${API_URL}/health`).catch(() => {});
    }
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="signin" />
      <Stack.Screen name="home" />
      <Stack.Screen name="caregiver" />
    </Stack>
  );
}
