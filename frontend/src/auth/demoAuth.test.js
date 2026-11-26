import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateDemoUser,
  authenticateLogin,
  canAccessRoles,
  clearAuthSession,
  DEMO_USERS,
  DemoAuthenticationError,
  resolveDemoMode,
} from "./demoAuth.js";

const testPassword = "synthetic-only-test-password";

test("demo mode is enabled only by explicit local Vite development configuration", () => {
  assert.equal(
    resolveDemoMode({
      command: "serve",
      mode: "development",
      enabled: "true",
    }),
    true,
  );
  assert.equal(
    resolveDemoMode({
      command: "build",
      mode: "production",
      enabled: "true",
    }),
    false,
  );
  assert.equal(
    resolveDemoMode({
      command: "serve",
      mode: "development",
      enabled: "false",
    }),
    false,
  );
});

test("all three exact demo accounts authenticate locally with their intended role", async () => {
  let backendLoginCalls = 0;

  for (const expected of DEMO_USERS) {
    const user = authenticateDemoUser(
      { email: expected.email, password: testPassword },
      testPassword,
    );
    assert.deepEqual(user, expected);

    const result = await authenticateLogin({
      credentials: { email: expected.email, password: testPassword },
      demoModeEnabled: true,
      demoPassword: testPassword,
      loginWithBackend: async () => {
        backendLoginCalls += 1;
        throw new Error("Backend login must not be called in demo mode.");
      },
    });
    assert.equal(result.user.role, expected.role);
    assert.equal(result.isDemoSession, true);
    assert.equal(result.accessToken, null);
  }

  assert.equal(backendLoginCalls, 0);
});

test("demo credentials reject wrong passwords and unknown email addresses clearly", () => {
  for (const credentials of [
    { email: DEMO_USERS[0].email, password: "wrong-password" },
    { email: "unknown@example.com", password: testPassword },
  ]) {
    assert.throws(
      () => authenticateDemoUser(credentials, testPassword),
      (error) =>
        error instanceof DemoAuthenticationError &&
        error.message === "Email or demo password is incorrect.",
    );
  }
});

test("enabled demo mode fails locally when its password is not configured", async () => {
  let backendLoginCalls = 0;
  await assert.rejects(
    authenticateLogin({
      credentials: { email: DEMO_USERS[0].email, password: testPassword },
      demoModeEnabled: true,
      demoPassword: "",
      loginWithBackend: async () => {
        backendLoginCalls += 1;
      },
    }),
    /password is not configured/u,
  );
  assert.equal(backendLoginCalls, 0);
});

test("backend login remains the path when demo mode is disabled", async () => {
  const backendResult = {
    user: { id: "live-user", role: "ADMIN" },
    accessToken: "backend-token",
  };
  let backendLoginCalls = 0;
  const result = await authenticateLogin({
    credentials: { email: "user@example.com", password: "live-password" },
    demoModeEnabled: false,
    demoPassword: "",
    loginWithBackend: async () => {
      backendLoginCalls += 1;
      return backendResult;
    },
  });

  assert.equal(backendLoginCalls, 1);
  assert.equal(result.user, backendResult.user);
  assert.equal(result.accessToken, backendResult.accessToken);
  assert.equal(result.isDemoSession, false);
});

test("route role checks allow only the configured roles", () => {
  const [admin, commander, logistics] = DEMO_USERS;
  assert.equal(canAccessRoles(admin, ["ADMIN"]), true);
  assert.equal(canAccessRoles(commander, ["ADMIN"]), false);
  assert.equal(canAccessRoles(logistics, ["BASE_COMMANDER"]), false);
  assert.equal(canAccessRoles(commander, undefined), true);
});

test("logout clears the token, user, and demo-session state", () => {
  const calls = [];
  clearAuthSession({
    clearAccessToken: () => calls.push("token"),
    setUser: (user) => calls.push(["user", user]),
    setDemoSession: (value) => calls.push(["demo", value]),
  });
  assert.deepEqual(calls, [
    "token",
    ["user", null],
    ["demo", false],
  ]);
});
