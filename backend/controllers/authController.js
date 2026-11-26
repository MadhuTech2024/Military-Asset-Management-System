import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  signAccessToken,
} from "../config/jwt.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAX_EMAIL_BYTES = 254;
const MAX_BCRYPT_PASSWORD_BYTES = 72;
const DUMMY_HASH_ROUNDS = 12;

function createSafeUser(user) {
  return {
    id: user.id,
    name: user.full_name,
    email: user.email,
    role: user.role,
    baseId: user.base_id ?? null,
    isActive: user.is_active,
  };
}

function sendInvalidCredentials(response) {
  return response.status(401).json({
    success: false,
    error: {
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect.",
    },
  });
}

function sendAuthenticationUnavailable(response) {
  return response.status(503).json({
    success: false,
    error: {
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Authentication is temporarily unavailable.",
    },
  });
}

function readCredentials(body) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof body.email !== "string" ||
    typeof body.password !== "string"
  ) {
    return null;
  }

  const email = body.email.trim().toLowerCase();
  if (
    Buffer.byteLength(email, "utf8") > MAX_EMAIL_BYTES ||
    !EMAIL_PATTERN.test(email) ||
    body.password.length === 0 ||
    Buffer.byteLength(body.password, "utf8") > MAX_BCRYPT_PASSWORD_BYTES
  ) {
    return null;
  }

  return { email, password: body.password };
}

export function createAuthController({
  dataSource,
  jwtConfiguration,
  passwordHasher = bcrypt,
}) {
  const dummyPasswordHash = passwordHasher.hashSync(
    randomBytes(32).toString("hex"),
    DUMMY_HASH_ROUNDS,
  );

  return {
    async login(request, response) {
      const credentials = readCredentials(request.body);
      if (!credentials) {
        return response.status(400).json({
          success: false,
          error: {
            code: "INVALID_REQUEST",
            message: "A valid email and password are required.",
          },
        });
      }

      let users;
      try {
        users = await dataSource.query(
          `SELECT id, email, password_hash, full_name, role, base_id, is_active
           FROM public.app_user
           WHERE pg_catalog.lower(email) = $1
           ORDER BY id
           LIMIT 2`,
          [credentials.email],
        );
        if (!Array.isArray(users)) {
          return sendAuthenticationUnavailable(response);
        }
      } catch {
        return sendAuthenticationUnavailable(response);
      }

      const user = users.length === 1 ? users[0] : null;
      const hash =
        typeof user?.password_hash === "string"
          ? user.password_hash
          : dummyPasswordHash;
      let passwordMatches = false;
      try {
        passwordMatches = await passwordHasher.compare(
          credentials.password,
          hash,
        );
      } catch {
        return sendInvalidCredentials(response);
      }

      if (!user || !passwordMatches || user.is_active !== true) {
        return sendInvalidCredentials(response);
      }

      try {
        const accessToken = await signAccessToken(user.id, jwtConfiguration);
        return response.status(200).json({
          success: true,
          data: {
            accessToken,
            tokenType: "Bearer",
            expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
            user: createSafeUser(user),
          },
        });
      } catch {
        return sendAuthenticationUnavailable(response);
      }
    },

    me(request, response) {
      return response.status(200).json({
        success: true,
        data: { user: request.currentUser },
      });
    },
  };
}
