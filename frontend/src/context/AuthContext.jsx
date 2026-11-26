import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import api, { setAccessToken } from "../services/api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  const logout = useCallback(() => {
    setAccessToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    window.addEventListener("kristallball:session-expired", logout);
    return () => {
      window.removeEventListener("kristallball:session-expired", logout);
      setAccessToken(null);
    };
  }, [logout]);

  const login = useCallback(async (credentials) => {
    const response = await api.post("/auth/login", credentials);
    const { accessToken, user: authenticatedUser } = response.data.data;
    setAccessToken(accessToken);
    setUser(authenticatedUser);
    return authenticatedUser;
  }, []);

  const value = useMemo(
    () => ({ user, isAuthenticated: Boolean(user), login, logout }),
    [user, login, logout],
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
