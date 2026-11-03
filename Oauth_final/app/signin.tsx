import React, { useState } from 'react';
import {
  SafeAreaView, ScrollView, StyleSheet, Text, View,
  TextInput, TouchableOpacity, Alert, StatusBar,
} from 'react-native';
import { router } from 'expo-router';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

export default function SignInScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [serverWaking, setServerWaking] = useState(false);

  const handleSubmit = async () => {
    if (!name || !email || !phone || !password) {
      Alert.alert('Error', 'All fields are required.');
      return;
    }
    setIsLoading(true);
    setServerWaking(false);
    const wakeTimer = setTimeout(() => setServerWaking(true), 4000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`${API_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, password }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        Alert.alert('Error', errorData.error || 'Failed to create account.');
        return;
      }

      Alert.alert('Success', 'Account created successfully! Please login.');
      router.replace('/login');
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
      setIsLoading(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
      <StatusBar backgroundColor="#F7F8FB" />
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.greeting}>PatientCareAI</Text>
        </View>

        <TouchableOpacity style={styles.createAccountButton}>
          <Text style={styles.createAccountText}>Create a new account</Text>
        </TouchableOpacity>

        <View style={styles.inputContainer}>
          <TextInput placeholder="Full Name" placeholderTextColor="#888" value={name} onChangeText={setName} style={styles.input} />
          <TextInput placeholder="Phone Number" placeholderTextColor="#888" value={phone} onChangeText={setPhone} style={styles.input} keyboardType="phone-pad" />
          <TextInput placeholder="Email" placeholderTextColor="#888" value={email} onChangeText={setEmail} style={styles.input} keyboardType="email-address" autoCapitalize="none" />
          <TextInput placeholder="Password" placeholderTextColor="#888" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} />
        </View>

        <TouchableOpacity
          style={[styles.signUpButton, isLoading && styles.loadingButton]}
          onPress={handleSubmit}
          disabled={isLoading}
        >
          <Text style={styles.buttonText}>{isLoading ? 'Signing Up…' : 'Sign Up'}</Text>
        </TouchableOpacity>
        {isLoading && serverWaking && (
          <Text style={{ color: '#888', textAlign: 'center' }}>
            Waking up the server, this can take up to a minute.
          </Text>
        )}

        <View style={styles.loginRedirectContainer}>
          <Text style={styles.alreadyAccountText}>Already have an account?</Text>
          <TouchableOpacity onPress={() => router.replace('/login')}>
            <Text style={styles.loginText}> Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, backgroundColor: '#fff' },
  header: { alignItems: 'center', marginTop: 100, marginBottom: 8 },
  greeting: { fontSize: 38, fontWeight: 'bold', color: '#31363F' },
  createAccountButton: { paddingVertical: 10, paddingHorizontal: 20, alignItems: 'center', marginBottom: 50 },
  createAccountText: { fontSize: 20, color: '#888' },
  inputContainer: { paddingHorizontal: 20 },
  input: { height: 50, borderWidth: 1, marginBottom: 20, fontSize: 16, borderRadius: 13, padding: 10, color: '#31363F', backgroundColor: '#fff' },
  signUpButton: {
    backgroundColor: '#2A7BB5', paddingVertical: 15, borderRadius: 10,
    alignItems: 'center', marginHorizontal: 20, marginBottom: 20, marginTop: 10, elevation: 2,
  },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  loginRedirectContainer: { flexDirection: 'row', justifyContent: 'center', marginTop: 120 },
  alreadyAccountText: { color: '#888' },
  loginText: { color: '#3498DB' },
  loadingButton: { opacity: 0.5 },
});
