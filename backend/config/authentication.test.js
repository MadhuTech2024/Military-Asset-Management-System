import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import express from "express";
import { SignJWT, jwtVerify } from "jose";
import { createAuthRouter } from "../routes/authRoutes.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  createJwtConfiguration,
  signAccessToken,
} from "./jwt.js";
import { createSyntheticJwtSecret } from "./testJwtSecret.js";

const secret = createSyntheticJwtSecret();
const jwtConfiguration = createJwtConfiguration(secret);
const password = "correct horse battery staple";
const invalidCredentials = {
  success: false,
  error: {
    code: "INVALID_CREDENTIALS",
    message: "Email or password is incorrect.",
  },
};

let users;
let databaseUnavailable;
let passwordHash;
let server;
let serverUrl;
let dataSource;

function makeUser({
  id = randomUUID(),
  email = "operator@example.test",
  fullName = "Synthetic Operator",
  role = "LOGISTICS_OFFICER",
  baseId = randomUUID(),
  isActive = true,
} = {}) {
  return {
    id,
    email,
    password_hash: passwordHash,
    full_name: fullName,
    role,
    base_id: baseId,
    is_active: isActive,
  };
}

function createTestDataSource() {
  return {
    async query(sql, values) {
      if (databaseUnavailable) {
        throw new Error("sensitive database failure details");
      }

      if (sql.includes("pg_catalog.lower(email)")) {
        return [...users.values()]
          .filter((user) => user.email.toLowerCase() === values[0])
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, 2);
      }

      if (sql.includes("WHERE id = $1")) {
        const user = users.get(values[0]);
        return user ? [user] : [];
      }

      throw new Error("Unexpected authentication query.");
    },
  };
}

async function startTestServer({ loginRateLimitOptions } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      dataSource,
      jwtConfiguration,
      loginRateLimitOptions,
    }),
  );
  const listeningServer = app.listen(0, "127.0.0.1");
  await once(listeningServer, "listening");
  const address = listeningServer.address();
  return {
    server: listeningServer,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(listeningServer) {
  if (!listeningServer?.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    listeningServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function postLogin(body, url = serverUrl) {
  return fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getMe(token, url = serverUrl) {
  return fetch(`${url}/api/auth/me`, {
    headers: token ? { authorization: token } : {},
  });
}

async function makeSignedToken({
  signingSecret = secret,
  algorithm = "HS256",
  issuer = JWT_ISSUER,
  audience = JWT_AUDIENCE,
  subject,
  omitSubject = false,
  issuedAt = Math.floor(Date.now() / 1000),
  expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
  claims = {},
} = {}) {
  let token = new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt);
  if (!omitSubject) {
    token = token.setSubject(subject);
  }
  return token.sign(createJwtConfiguration(signingSecret).key);
}

before(async () => {
  passwordHash = await bcrypt.hash(password, 4);
  dataSource = createTestDataSource();
  ({ server, url: serverUrl } = await startTestServer({
    loginRateLimitOptions: { limit: 1000 },
  }));
});

after(async () => {
  await closeServer(server);
});

beforeEach(() => {
  databaseUnavailable = false;
  users = new Map();
  const user = makeUser({ email: "Operator@Example.test" });
  users.set(user.id, user);
});

test("JWT secret must be canonical Base64URL with at least 32 random bytes", () => {
  const standardBase64 = Buffer.alloc(48, 0xfb).toString("base64");
  const shortSecret = createSyntheticJwtSecret(31);
  const placeholder = Buffer.from(
    "This is an example placeholder secret and must never be used.",
  ).toString("base64url");

  for (const invalidSecret of [
    undefined,
    "",
    "short-secret",
    "A".repeat(43),
    standardBase64,
    "AB",
    shortSecret,
    placeholder,
  ]) {
    assert.throws(
      () => createJwtConfiguration(invalidSecret),
      (error) => {
        assert.match(error.message, /JWT_SECRET/);
        if (invalidSecret) {
          assert.equal(error.message.includes(invalidSecret), false);
        }
        return true;
      },
    );
  }
});

test("JWT configuration accepts 48-byte and minimum 32-byte Base64URL secrets", () => {
  assert.doesNotThrow(() => createJwtConfiguration(secret));
  assert.doesNotThrow(() =>
    createJwtConfiguration(createSyntheticJwtSecret(32)),
  );
});

test("Base64URL normalization preserves the existing canonical textual HMAC key", () => {
  const secretBytes = Buffer.from(secret, "base64url");
  const expectedKey = new TextEncoder().encode(secretBytes.toString("base64"));

  assert.deepEqual(createJwtConfiguration(secret).key, expectedKey);
});

test("server refuses a missing JWT secret before loading the database connection", () => {
  const result = spawnSync(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: "",
      JWT_SECRET: "",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /JWT_SECRET must be configured/);
  assert.doesNotMatch(output, /Missing required DATABASE_URL|127\.0\.0\.1/);
});

test("login normalizes email, verifies bcrypt, and returns a minimal 15-minute JWT", async () => {
  const user = [...users.values()][0];
  const response = await postLogin({
    email: "  OPERATOR@example.test ",
    password,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.expiresInSeconds, ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(body.data.tokenType, "Bearer");
  assert.deepEqual(body.data.user, {
    id: user.id,
    name: user.full_name,
    email: user.email,
    role: user.role,
    baseId: user.base_id,
    isActive: true,
  });
  assert.equal(JSON.stringify(body).includes(user.password_hash), false);

  const { payload, protectedHeader } = await jwtVerify(
    body.data.accessToken,
    jwtConfiguration.key,
    {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    },
  );
  assert.equal(protectedHeader.alg, "HS256");
  assert.deepEqual(Object.keys(payload).sort(), [
    "aud",
    "exp",
    "iat",
    "iss",
    "sub",
  ]);
  assert.equal(payload.sub, user.id);
  assert.equal(payload.iss, JWT_ISSUER);
  assert.equal(payload.aud, JWT_AUDIENCE);
  assert.equal(payload.exp - payload.iat, ACCESS_TOKEN_TTL_SECONDS);
});

test("all demo roles authenticate and retain their database role and base scope", async () => {
  const demoPassword = "synthetic-demo-login-password";
  const demoPasswordHash = await bcrypt.hash(demoPassword, 12);
  const demoBaseId = randomUUID();
  const demoAccounts = [
    {
      email: "admin.demo@example.com",
      role: "ADMIN",
      baseId: null,
    },
    {
      email: "commander.demo@example.com",
      role: "BASE_COMMANDER",
      baseId: demoBaseId,
    },
    {
      email: "logistics.demo@example.com",
      role: "LOGISTICS_OFFICER",
      baseId: demoBaseId,
    },
  ];

  for (const account of demoAccounts) {
    const user = makeUser({
      email: account.email,
      fullName: "Synthetic Demo Account",
      role: account.role,
      baseId: account.baseId,
    });
    user.password_hash = demoPasswordHash;
    users.set(user.id, user);

    const response = await postLogin({
      email: account.email,
      password: demoPassword,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.user.role, account.role);
    assert.equal(body.data.user.baseId, account.baseId);
    assert.equal(JSON.stringify(body).includes(demoPassword), false);
    assert.equal(JSON.stringify(body).includes(demoPasswordHash), false);

    const meResponse = await getMe(`Bearer ${body.data.accessToken}`);
    const meBody = await meResponse.json();
    assert.equal(meResponse.status, 200);
    assert.equal(meBody.data.user.role, account.role);
    assert.equal(meBody.data.user.baseId, account.baseId);
    assert.equal("password_hash" in meBody.data.user, false);
  }
});

test("wrong password, unknown email, and inactive user share one generic response", async () => {
  const active = [...users.values()][0];
  const inactive = makeUser({
    email: "inactive@example.test",
    isActive: false,
  });
  users.set(inactive.id, inactive);

  const wrongPassword = await postLogin({
    email: active.email,
    password: "wrong password",
  });
  const unknownUser = await postLogin({
    email: "unknown@example.test",
    password,
  });
  const inactiveUser = await postLogin({
    email: inactive.email,
    password,
  });
  const responses = await Promise.all(
    [wrongPassword, unknownUser, inactiveUser].map((response) =>
      response.json(),
    ),
  );

  assert.deepEqual(
    [wrongPassword.status, unknownUser.status, inactiveUser.status],
    [401, 401, 401],
  );
  assert.deepEqual(responses, [
    invalidCredentials,
    invalidCredentials,
    invalidCredentials,
  ]);
});

test("login rejects missing, malformed, oversized, and wrongly typed credentials", async () => {
  for (const body of [
    {},
    { password },
    { email: "operator@example.test" },
    { email: 123, password },
    { email: "operator@example.test", password: 123 },
    { email: "not-an-email", password },
    { email: "operator@example.test", password: "x".repeat(73) },
    [],
  ]) {
    const response = await postLogin(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
});

test("authentication errors do not disclose account existence or password hashes", async () => {
  const user = [...users.values()][0];
  const responses = await Promise.all([
    postLogin({ email: user.email, password: "incorrect" }),
    postLogin({ email: "missing@example.test", password }),
  ]);
  const bodies = await Promise.all(responses.map((response) => response.text()));

  assert.deepEqual(responses.map((response) => response.status), [401, 401]);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies.some((body) => body.includes(user.password_hash)), false);
});

test("me requires a well-formed bearer header", async () => {
  for (const authorization of [undefined, "Bearer", "Basic token", "Bearer one two"]) {
    const response = await getMe(authorization);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }
});

test("me rejects invalid, expired, tampered, wrongly issued, and wrongly addressed JWTs", async () => {
  const user = [...users.values()][0];
  const valid = await signAccessToken(user.id, jwtConfiguration);
  const [, payloadSegment, signatureSegment] = valid.split(".");
  const payload = JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf8"),
  );
  payload.sub = randomUUID();
  const tampered = [
    valid.split(".")[0],
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    signatureSegment,
  ].join(".");

  const tokens = [
    await makeSignedToken({
      signingSecret: createSyntheticJwtSecret(48, 1),
      subject: user.id,
    }),
    tampered,
    await makeSignedToken({
      subject: user.id,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
      issuedAt: Math.floor(Date.now() / 1000) - 60,
    }),
    await makeSignedToken({ subject: user.id, issuer: "wrong-issuer" }),
    await makeSignedToken({ subject: user.id, audience: "wrong-audience" }),
    await makeSignedToken({ subject: user.id, algorithm: "HS384" }),
    await makeSignedToken({ omitSubject: true }),
  ];

  for (const token of tokens) {
    const response = await getMe(`Bearer ${token}`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
  }
});

test("deleted or deactivated users lose access immediately", async () => {
  const user = [...users.values()][0];
  const token = await signAccessToken(user.id, jwtConfiguration);

  users.delete(user.id);
  const deletedResponse = await getMe(`Bearer ${token}`);
  assert.equal(deletedResponse.status, 401);

  const reactivatedFixture = makeUser({ id: user.id, isActive: false });
  users.set(user.id, reactivatedFixture);
  const inactiveResponse = await getMe(`Bearer ${token}`);
  assert.equal(inactiveResponse.status, 401);
});

test("me reads current role and base from PostgreSQL, not JWT authorization claims", async () => {
  const user = [...users.values()][0];
  const token = await makeSignedToken({
    subject: user.id,
    claims: { role: "ADMIN", baseId: randomUUID(), isActive: false },
  });
  const latestBaseId = randomUUID();
  user.role = "BASE_COMMANDER";
  user.base_id = latestBaseId;
  user.is_active = true;

  const response = await getMe(`Bearer ${token}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.user.role, "BASE_COMMANDER");
  assert.equal(body.data.user.baseId, latestBaseId);
  assert.equal(body.data.user.isActive, true);
  assert.equal("password_hash" in body.data.user, false);
});

test("database failures return safe responses without logging database details", async () => {
  databaseUnavailable = true;
  const loginResponse = await postLogin({
    email: "operator@example.test",
    password,
  });
  const loginBody = await loginResponse.text();
  const meResponse = await getMe(
    `Bearer ${await signAccessToken([...users.keys()][0], jwtConfiguration)}`,
  );
  const meBody = await meResponse.text();

  assert.equal(loginResponse.status, 503);
  assert.equal(meResponse.status, 503);
  assert.doesNotMatch(
    `${loginBody}${meBody}`,
    /sensitive database failure details|password_hash|JWT_SECRET/,
  );
});

test("login rate limiter returns a generic 429 response", async () => {
  const limitedServer = await startTestServer();
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await postLogin({}, limitedServer.url);
      assert.equal(response.status, 400);
    }

    const limited = await postLogin({}, limitedServer.url);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  } finally {
    await closeServer(limitedServer.server);
  }
});
