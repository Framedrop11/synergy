import React, { useState, useCallback } from 'react';
import {
  SafeAreaView, StyleSheet, Text, View, TextInput,
  TouchableOpacity, Alert, StatusBar, Image,
} from 'react-native';
import { router } from 'expo-router';
import { storeToken } from '@/utils/authStorage';
import { configureGoogleSignIn, getNativeGoogleSignIn } from '@/utils/googleSignIn';

const API_URL = process.env.EXPO_PUBLIC_API_URL;
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [serverWaking, setServerWaking] = useState(false);

  // ── Google Sign-In ──────────────────────────────────────────────────────
  const onGooglePress = useCallback(async () => {
    if (!GOOGLE_WEB_CLIENT_ID) {
      Alert.alert('Google sign-in unavailable', 'This APK was built without the Google Web Client ID. Rebuild with the preview profile after confirming its EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID setting.');
      return;
    }
    setLoading(true);
    let google: Awaited<ReturnType<typeof getNativeGoogleSignIn>> = null;
    try {
      google = await getNativeGoogleSignIn();
      if (!google) {
        Alert.alert('Google sign-in unavailable', 'Google sign-in is available in the installed APK. Use email login in Expo Go.');
        return;
      }
      await configureGoogleSignIn(GOOGLE_WEB_CLIENT_ID);
      await google.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const response = await google.GoogleSignin.signIn();

      if (!google.isSuccessResponse(response)) {
        // User cancelled — silent
        return;
      }

      const idToken = response.data.idToken;
      if (!idToken) {
        Alert.alert('Error', 'Google sign-in did not return an ID token.');
        return;
      }

      const controller = new AbortController();
      setServerWaking(false);
      const wakeTimer = setTimeout(() => setServerWaking(true), 4000);
      const timeoutId = setTimeout(() => controller.abort(), 45000);

      let fetchResponse: Response;
      try {
        fetchResponse = await fetch(`${API_URL}/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(wakeTimer);
        clearTimeout(timeoutId);
        setServerWaking(false);
      }

      const data = await fetchResponse.json();
      if (fetchResponse.ok) {
        await storeToken(data.token, data.userId);
        router.replace('/home');
      } else {
        Alert.alert('Error', data.message || 'Google login failed.');
      }
    } catch (error) {
      if (google?.isErrorWithCode(error)) {
        if (error.code === google.statusCodes.SIGN_IN_CANCELLED) {
          return;
        }
        if (error.code === google.statusCodes.IN_PROGRESS) {
          Alert.alert('Error', 'Google sign-in is already in progress.');
          return;
        }
        if (error.code === google.statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
          Alert.alert('Error', 'Google Play Services is unavailable on this device.');
          return;
        }
        if (error.code === '10') {
          Alert.alert(
            'Google sign-in setup incomplete',
            'Google does not recognize this APK’s Android identity. In the same Google Cloud project as the Web Client ID, add an Android OAuth client for this app’s package name and the SHA-1 fingerprint of the EAS signing key.'
          );
          return;
        }
        if (error.code === '12500') {
          Alert.alert(
            'Google sign-in failed',
            'Google rejected this app’s OAuth setup (12500). Confirm the Android OAuth client matches this APK’s package name and SHA-1, and that the Web client ID belongs to the same Google Cloud project.'
          );
          return;
        }
      }
      if (error instanceof Error && error.name === 'AbortError') {
        Alert.alert(
          'Error',
          'The server is taking too long to respond. It may be waking up; please try again in a minute.'
        );
        return;
      }
      if (error instanceof TypeError) {
        Alert.alert(
          'Error',
          'Could not reach the server. Check your internet connection; the server may be waking up.'
        );
        return;
      }
      const errorCode = google?.isErrorWithCode(error) ? error.code : undefined;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Google login failed:', { code: errorCode, message: errorMessage });
      Alert.alert(
        'Google login failed',
        `${errorCode ? `Error ${errorCode}: ` : ''}${errorMessage || 'Unknown error.'}`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Email / Password ────────────────────────────────────────────────────
  const handleEmailLogin = async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter both email and password.');
      return;
    }
    setLoading(true);
    setServerWaking(false);
    const wakeTimer = setTimeout(() => setServerWaking(true), 4000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        await storeToken(data.token, data.userId);
        router.replace('/home');
      } else {
        Alert.alert('Error', data.message || 'Invalid email or password');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        Alert.alert('Error', 'The server took too long to respond. Please try again.');
      } else {
        Alert.alert('Error', 'Could not reach the server. Check your internet connection and try again.');
      }
    } finally {
      clearTimeout(wakeTimer);
      clearTimeout(timeoutId);
      setServerWaking(false);
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar backgroundColor="#F7F8FB" />
      <View style={styles.header}>
        <Text style={styles.welcomeText}>PatientCareAI</Text>
        <Text style={styles.subHeader}>Welcome!</Text>
      </View>

      <View style={styles.inputContainer}>
        <TextInput
          placeholder="Email"
          placeholderTextColor="#888"
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TextInput
          placeholder="Password"
          placeholderTextColor="#888"
          secureTextEntry
          style={styles.input}
          value={password}
          onChangeText={setPassword}
        />
      </View>

      <TouchableOpacity style={styles.loginButton} onPress={handleEmailLogin} disabled={loading}>
        <Text style={styles.loginButtonText}>{loading ? 'Logging in…' : 'Login'}</Text>
      </TouchableOpacity>
      {loading && serverWaking && (
        <Text style={{ color: '#888', textAlign: 'center' }}>
          Waking up the server, this can take up to a minute.
        </Text>
      )}

      <TouchableOpacity style={styles.googleButton} onPress={onGooglePress} disabled={loading}>
        <View style={styles.buttonContent}>
          <Image
            source={{ uri: 'http://pngimg.com/uploads/google/google_PNG19635.png' }}
            style={styles.googleLogo}
          />
          <Text style={styles.googleButtonText}>Login with Google</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity>
        <Text style={styles.forgotPassword}>Forgot Password?</Text>
      </TouchableOpacity>

      <View style={styles.signUpContainer}>
        <Text style={styles.noAccountText}>Don&apos;t have an account?</Text>
        <TouchableOpacity onPress={() => router.push('/signin')}>
          <Text style={styles.signUpText}> Sign Up</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#F7F8FB' },
  header: { alignItems: 'center', marginTop: 130, marginBottom: 60 },
  welcomeText: { fontSize: 38, fontWeight: 'bold', color: '#31363F' },
  subHeader: { fontSize: 30, color: '#888' },
  inputContainer: { marginBottom: 10, paddingHorizontal: 20 },
  input: {
    height: 50, borderWidth: 1, borderRadius: 13,
    marginBottom: 20, padding: 10, fontSize: 16, color: '#31363F', backgroundColor: '#fff',
  },
  loginButton: {
    backgroundColor: '#2A7BB5', padding: 15, borderRadius: 10,
    alignItems: 'center', marginVertical: 10, marginHorizontal: 20,
    elevation: 2,
  },
  loginButtonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  forgotPassword: { color: '#888', textAlign: 'center', marginVertical: 10 },
  signUpContainer: { flexDirection: 'row', justifyContent: 'center', marginTop: 120 },
  noAccountText: { color: '#888' },
  signUpText: { color: '#3572EF' },
  googleButton: {
    backgroundColor: '#fff', padding: 15, borderRadius: 10,
    alignItems: 'center', marginVertical: 10, marginHorizontal: 20,
    borderWidth: 1, elevation: 2,
  },
  buttonContent: { flexDirection: 'row', alignItems: 'center' },
  googleLogo: { width: 20, height: 20, marginRight: 10 },
  googleButtonText: { color: '#222831', fontSize: 18, fontWeight: 'bold' },
});
