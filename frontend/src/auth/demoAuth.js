import { getDemoUserByEmail } from "../demo/demoService.js";
import { DEMO_USERS } from "./demoUsers.js";

export { DEMO_USERS };

export class DemoAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DemoAuthenticationError";
  }
}

export function resolveDemoMode({ command, mode, enabled }) {
  return (
    command === "serve" &&
    mode === "development" &&
    enabled === "true"
  );
}

export function authenticateDemoUser(credentials, demoPassword) {
  if (typeof demoPassword !== "string" || demoPassword.length === 0) {
    throw new DemoAuthenticationError(
      "Local demo authentication is enabled but its password is not configured.",
    );
  }

  const email =
    typeof credentials?.email === "string"
      ? credentials.email.trim().toLowerCase()
      : "";
  const user = getDemoUserByEmail(email);

  if (
    !user ||
    !user.isActive ||
    typeof credentials?.password !== "string" ||
    credentials.password !== demoPassword
  ) {
    throw new DemoAuthenticationError("Email or demo password is incorrect.");
  }

  return { ...user };
}

export async function authenticateLogin({
  credentials,
  demoModeEnabled,
  demoPassword,
  loginWithBackend,
}) {
  if (demoModeEnabled) {
    return {
      user: authenticateDemoUser(credentials, demoPassword),
      accessToken: null,
      isDemoSession: true,
    };
  }

  const result = await loginWithBackend(credentials);
  return {
    user: result.user,
    accessToken: result.accessToken,
    isDemoSession: false,
  };
}

export function canAccessRoles(user, roles) {
  return !roles || roles.includes(user?.role);
}

export function clearAuthSession({
  clearAccessToken,
  setUser,
  setDemoSession,
}) {
  clearAccessToken();
  setUser(null);
  setDemoSession(false);
}
