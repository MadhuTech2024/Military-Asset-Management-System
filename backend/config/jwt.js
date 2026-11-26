import { SignJWT, jwtVerify } from "jose";

export const JWT_ISSUER = "kristallball-api";
export const JWT_AUDIENCE = "kristallball-client";
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const JWT_SECRET_ERROR =
  "JWT_SECRET must be an unpadded Base64URL value containing at least 32 cryptographically random bytes.";

function isWeakPlaceholder(secretBytes) {
  const value = secretBytes.toString("utf8");
  return (
    /^[\x20-\x7e]+$/.test(value) &&
    /\b(?:replace|change|your|example|placeholder|dummy|sample|test|secret)\b/i.test(
      value,
    )
  );
}

export function createJwtConfiguration(secret) {
  if (
    typeof secret !== "string" ||
    !BASE64URL_PATTERN.test(secret) ||
    secret.length % 4 === 1
  ) {
    throw new Error(JWT_SECRET_ERROR);
  }

  const secretBytes = Buffer.from(secret, "base64url");
  if (
    secretBytes.length < 32 ||
    secretBytes.toString("base64url") !== secret ||
    new Set(secretBytes).size < 16 ||
    isWeakPlaceholder(secretBytes)
  ) {
    throw new Error(JWT_SECRET_ERROR);
  }

  // Preserve the existing textual HMAC key while accepting Base64URL input.
  const key = new TextEncoder().encode(secretBytes.toString("base64"));

  return Object.freeze({
    key,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export async function signAccessToken(subject, configuration) {
  if (!isUuid(subject)) {
    throw new Error("A valid user identifier is required for an access token.");
  }

  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(configuration.issuer)
    .setAudience(configuration.audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(configuration.key);
}

export async function verifyAccessToken(token, configuration) {
  const { payload, protectedHeader } = await jwtVerify(
    token,
    configuration.key,
    {
      algorithms: ["HS256"],
      issuer: configuration.issuer,
      audience: configuration.audience,
      maxTokenAge: `${ACCESS_TOKEN_TTL_SECONDS}s`,
    },
  );

  if (
    protectedHeader.typ !== "JWT" ||
    !isUuid(payload.sub) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp)
  ) {
    throw new Error("The access token is invalid.");
  }

  return payload.sub;
}
