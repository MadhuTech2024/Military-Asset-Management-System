export function createSyntheticJwtSecret(byteLength = 48, offset = 0) {
  const bytes = Buffer.from(
    Array.from({ length: byteLength }, (_, index) => (index + offset) % 256),
  );
  return bytes.toString("base64url");
}

export const SYNTHETIC_JWT_SECRET = createSyntheticJwtSecret();
