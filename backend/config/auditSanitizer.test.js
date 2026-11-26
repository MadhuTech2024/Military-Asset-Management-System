import test from "node:test";
import assert from "node:assert/strict";
import {
  isSensitiveAuditKey,
  sanitizeAuditSnapshot,
} from "./auditSanitizer.js";

test("removes nested sensitive fields recursively", () => {
  const original = {
    action: "UPDATE",
    entity: {
      password: "plain",
      passwordHash: "hash",
      nested: {
        REFRESH_TOKEN: "refresh",
        jwt: "jwt-value",
        useful: "kept",
      },
    },
  };

  const sanitized = sanitizeAuditSnapshot(original);

  assert.deepEqual(sanitized, {
    action: "UPDATE",
    entity: {
      nested: { useful: "kept" },
    },
  });
  assert.equal(original.entity.password, "plain");
  assert.equal(original.entity.nested.jwt, "jwt-value");
});

test("sanitizes sensitive fields inside arrays", () => {
  const sanitized = sanitizeAuditSnapshot([
    { Authorization: "Bearer token", status: "active" },
    { cookie: "session=value", api_key: "key-value", id: "42" },
  ]);

  assert.deepEqual(sanitized, [
    { status: "active" },
    { id: "42" },
  ]);
});

test("matches mixed-case and punctuation-sensitive keys", () => {
  assert.equal(isSensitiveAuditKey("Password"), true);
  assert.equal(isSensitiveAuditKey("password_hash"), true);
  assert.equal(isSensitiveAuditKey("ACCESS-TOKEN"), true);
  assert.equal(isSensitiveAuditKey("RefreshToken"), true);
  assert.equal(isSensitiveAuditKey("Api_Key"), true);
  assert.equal(isSensitiveAuditKey("AUTHORIZATION"), true);
  assert.equal(isSensitiveAuditKey("status"), false);
});

test("does not mutate or share original nested objects", () => {
  const original = {
    before: { secret: "one", name: "original" },
    after: { SECRET: "two", name: "changed" },
  };
  const sanitized = sanitizeAuditSnapshot(original);

  assert.deepEqual(original.before, { secret: "one", name: "original" });
  assert.deepEqual(original.after, { SECRET: "two", name: "changed" });
  assert.deepEqual(sanitized, {
    before: { name: "original" },
    after: { name: "changed" },
  });
  assert.notEqual(sanitized.before, original.before);
});

test("preserves useful non-sensitive audit values", () => {
  const sanitized = sanitizeAuditSnapshot({
    entityId: "123",
    baseId: "abc",
    status: "COMPLETED",
    quantity: 4,
  });

  assert.deepEqual(sanitized, {
    entityId: "123",
    baseId: "abc",
    status: "COMPLETED",
    quantity: 4,
  });
});
