import Constants, { AppOwnership } from 'expo-constants';

type GoogleSignInModule = typeof import('@react-native-google-signin/google-signin');

let googleSignInModule: Promise<GoogleSignInModule> | undefined;
let configuredWebClientId: string | undefined;

export const isExpoGo = Constants.appOwnership === AppOwnership.Expo;

export const getNativeGoogleSignIn = async (): Promise<GoogleSignInModule | null> => {
  if (isExpoGo) return null;

  googleSignInModule ??= import('@react-native-google-signin/google-signin');
  return googleSignInModule;
};

export const configureGoogleSignIn = async (webClientId: string): Promise<boolean> => {
  const google = await getNativeGoogleSignIn();
  if (!google) return false;

  if (configuredWebClientId !== webClientId) {
    google.GoogleSignin.configure({ webClientId, offlineAccess: false });
    configuredWebClientId = webClientId;
  }

  return true;
};
