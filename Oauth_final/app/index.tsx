import React, { useEffect } from 'react';
import { Alert, BackHandler, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

export default function LandingPage() {
  useEffect(() => {
    // Navigate to login after 2 seconds
    const timer = setTimeout(() => {
      router.replace('/login');
    }, 2000);

    // Android back button → exit app from landing
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      Alert.alert('Exit App', 'Are you sure you want to exit?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'YES', onPress: () => BackHandler.exitApp() },
      ]);
      return true;
    });

    return () => {
      clearTimeout(timer);
      backHandler.remove();
    };
  }, []);

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
      <StatusBar backgroundColor="#2A7BB5" />
      <SafeAreaView style={styles.bodyContainer}>
        <View style={styles.descriptionContainer}>
          <Text style={styles.greeting}>PatientCareAI</Text>
          <Text style={styles.description}>Your health,</Text>
          <Text style={styles.description}>Always on time</Text>
        </View>
      </SafeAreaView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bodyContainer: {
    flex: 1,
    padding: 16,
    backgroundColor: '#2A7BB5',
    justifyContent: 'center',
  },
  descriptionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  greeting: {
    fontSize: 42,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 20,
  },
  description: {
    padding: 5,
    fontSize: 26,
    fontWeight: 'bold',
    textAlign: 'center',
    color: '#fff',
  },
});
