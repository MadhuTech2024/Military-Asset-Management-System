const SENSITIVE_NORMALIZED_KEYS = new Set([
  "password",
  "passwordhash",
  "passwd",
  "token",
  "accesstoken",
  "refreshtoken",
  "jwt",
  "jwttoken",
  "secret",
  "authorization",
  "cookie",
  "apikey",
  "apisecret",
  "credential",
  "credentials",
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveAuditKey(key) {
  if (typeof key !== "string") {
    return false;
  }

  const normalized = normalizeKey(key);
  if (SENSITIVE_NORMALIZED_KEYS.has(normalized)) {
    return true;
  }

  return (
    normalized.includes("password") ||
    normalized.includes("passwd") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("apikey") ||
    normalized.includes("credential")
  );
}

export function sanitizeAuditSnapshot(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditSnapshot(item, seen));
  }

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (!isSensitiveAuditKey(key)) {
      sanitized[key] = sanitizeAuditSnapshot(nestedValue, seen);
    }
  }

  seen.delete(value);
  return sanitized;
}
