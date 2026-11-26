import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import api, { setAccessToken } from "../services/api.js";
import {
  authenticateLogin,
  clearAuthSession,
} from "../auth/demoAuth.js";
import {
  clearDemoPrincipal,
  setDemoPrincipal,
} from "../demo/demoService.js";

const AuthContext = createContext(null);
const demoModeEnabled = __KRISTALLBALL_DEMO_MODE__ === true;
const demoPassword = __KRISTALLBALL_DEMO_PASSWORD__;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isDemoSession, setIsDemoSession] = useState(false);

  const logout = useCallback(() => {
    clearDemoPrincipal();
    clearAuthSession({
      clearAccessToken: () => setAccessToken(null),
      setUser,
      setDemoSession: setIsDemoSession,
    });
  }, []);

  useEffect(() => {
    window.addEventListener("kristallball:session-expired", logout);
    return () => {
      window.removeEventListener("kristallball:session-expired", logout);
      setAccessToken(null);
    };
  }, [logout]);

  const login = useCallback(async (credentials) => {
    const result = await authenticateLogin({
      credentials,
      demoModeEnabled,
      demoPassword,
      loginWithBackend: async (backendCredentials) => {
        const response = await api.post("/auth/login", backendCredentials);
        return response.data.data;
      },
    });
    if (result.isDemoSession) setDemoPrincipal(result.user);
    else clearDemoPrincipal();
    setAccessToken(result.accessToken);
    setUser(result.user);
    setIsDemoSession(result.isDemoSession);
    return result.user;
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      isDemoSession,
      demoModeEnabled,
      login,
      logout,
    }),
    [user, isDemoSession, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return value;
}
