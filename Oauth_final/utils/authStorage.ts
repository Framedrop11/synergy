/**
 * Centralized auth token storage.
 * Stores the JWT from email/password or Google login in AsyncStorage
 * so it can be attached to every API request.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const TOKEN_KEY = "synergy_auth_token";
const USER_ID_KEY = "synergy_user_id";

export const storeToken = async (token: string, userId: string) => {
  await AsyncStorage.multiSet([
    [TOKEN_KEY, token],
    [USER_ID_KEY, userId],
  ]);
};

export const getToken = async (): Promise<string | null> => {
  return AsyncStorage.getItem(TOKEN_KEY);
};

export const getUserId = async (): Promise<string | null> => {
  return AsyncStorage.getItem(USER_ID_KEY);
};

export const clearAuth = async () => {
  await AsyncStorage.multiRemove([TOKEN_KEY, USER_ID_KEY]);
};

/**
 * Build a fetch options object with Authorization header pre-filled.
 */
export const authHeaders = async (): Promise<HeadersInit> => {
  const token = await getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};
