import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import bcrypt from "bcrypt";
import Base from "../models/Base.js";
import User from "../models/User.js";
import {
  assertLocalDemoSeedAllowed,
  seedDemoAccounts,
} from "./demoSeed.js";

const syntheticPassword = "synthetic-only-test-password";

function seed(dataSource, password = syntheticPassword) {
  return seedDemoAccounts({
    dataSource,
    password,
    env: validEnvironment(),
    explicitOptIn: true,
  });
}

function validEnvironment(overrides = {}) {
  return {
    NODE_ENV: "development",
    ENABLE_LOCAL_DEMO_SEED: "true",
    APP_DATABASE_ROLE: "kristallball_app",
    DATABASE_URL:
      "postgresql://kristallball_runtime@127.0.0.1:5433/military-management",
    ...overrides,
  };
}

class InMemoryDemoDataSource {
  constructor({ state, failAudit = false } = {}) {
    this.state = state ?? { bases: [], users: [], audits: [] };
    this.failAudit = failAudit;
  }

  async transaction(callback) {
    const workingState = JSON.parse(JSON.stringify(this.state));
    const failAudit = this.failAudit;
    const manager = {
      async query(sql, values) {
        if (sql.includes("FROM public.app_user")) {
          const emails = new Set(values[0].map((email) => email.toLowerCase()));
          return workingState.users
            .filter((user) => emails.has(user.email.toLowerCase()))
            .map(({ id, email }) => ({ id, email }));
        }
        if (sql.includes("FROM public.base")) {
          return workingState.bases
            .filter(
              (base) =>
                base.code === values[0] || base.name === values[1],
            )
            .map(({ id, code, name, isActive }) => ({
              id,
              code,
              name,
              is_active: isActive,
            }));
        }
        if (sql.includes("INSERT INTO public.audit_log")) {
          if (failAudit) {
            throw new Error("synthetic audit failure");
          }
          const [
            actorUserId,
            action,
            entityType,
            entityId,
            correlationId,
            baseId,
            beforeData,
            afterData,
          ] = values;
          workingState.audits.push({
            actorUserId,
            action,
            entityType,
            entityId,
            correlationId,
            baseId,
            beforeData,
            afterData,
          });
          return [{ id: randomUUID() }];
        }
        throw new Error("Unexpected synthetic query.");
      },
      getRepository: (entity) => {
        const collection =
          entity === Base
            ? workingState.bases
            : entity === User
              ? workingState.users
              : null;
        if (!collection) {
          throw new Error("Unexpected synthetic entity.");
        }
        return {
          create: (record) => ({ ...record }),
          async save(record) {
            const saved = { ...record, id: record.id ?? randomUUID() };
            collection.push(saved);
            return saved;
          },
        };
      },
    };

    const result = await callback(manager);
    this.state = workingState;
    return result;
  }
}

test("local demo seed requires explicit development opt-in and the restricted loopback target", () => {
  const options = { explicitOptIn: true, password: syntheticPassword };
  assert.doesNotThrow(() =>
    assertLocalDemoSeedAllowed(validEnvironment(), options),
  );

  for (const [environment, expectedMessage] of [
    [
      validEnvironment({ NODE_ENV: "production" }),
      /disabled in production/u,
    ],
    [
      validEnvironment({ NODE_ENV: "test" }),
      /requires NODE_ENV=development/u,
    ],
    [
      validEnvironment({ ENABLE_LOCAL_DEMO_SEED: "" }),
      /explicit local demo-seed opt-in/iu,
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://kristallball_runtime@demo.example.invalid:5433/military-management",
      }),
      /loopback PostgreSQL/u,
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://kristallball_runtime@localhost:5433/military-management",
      }),
      /loopback PostgreSQL/u,
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://kristallball_runtime@127.0.0.1:5433/military-management?host=demo.example.invalid",
      }),
      /loopback PostgreSQL/u,
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://kristallball_runtime@127.0.0.1:5433/other-database",
      }),
      /loopback PostgreSQL/u,
    ],
    [
      validEnvironment({
        DATABASE_URL:
          "postgresql://postgres@127.0.0.1:5433/military-management",
      }),
      /loopback PostgreSQL/u,
    ],
  ]) {
    assert.throws(() => {
      assertLocalDemoSeedAllowed(environment, {
        ...options,
        explicitOptIn: environment.ENABLE_LOCAL_DEMO_SEED === "true",
      });
    }, expectedMessage);
  }
});

test("demo seed runner refuses missing opt-in before loading a database connection", () => {
  const runnerPath = fileURLToPath(
    new URL("./runDemoSeed.js", import.meta.url),
  );
  const env = {
    ...process.env,
    NODE_ENV: "development",
    ENABLE_LOCAL_DEMO_SEED: "",
    LOCAL_DEMO_SEED_PASSWORD: "",
    DATABASE_URL: "",
    APP_DATABASE_ROLE: "",
  };
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, output);
  assert.match(output, /Local demo seed refused or failed/u);
  assert.doesNotMatch(output, /ECONNREFUSED|LOCAL_DEMO_SEED_PASSWORD/u);
});

test("demo seed creates active role-scoped accounts with bcrypt hashes and audit events", async () => {
  const dataSource = new InMemoryDemoDataSource();
  const result = await seed(dataSource);

  assert.equal(result.created, 3);
  assert.equal(result.skipped, 0);
  assert.equal(dataSource.state.bases.length, 1);
  assert.equal(dataSource.state.users.length, 3);
  assert.equal(dataSource.state.audits.length, 4);

  const usersByRole = new Map(
    dataSource.state.users.map((user) => [user.role, user]),
  );
  assert.equal(usersByRole.get("ADMIN").baseId, null);
  const demoBaseId = dataSource.state.bases[0].id;
  assert.equal(
    usersByRole.get("BASE_COMMANDER").baseId,
    demoBaseId,
  );
  assert.equal(
    usersByRole.get("LOGISTICS_OFFICER").baseId,
    demoBaseId,
  );

  for (const user of dataSource.state.users) {
    assert.equal(user.isActive, true);
    assert.notEqual(user.passwordHash, syntheticPassword);
    assert.equal(
      await bcrypt.compare(syntheticPassword, user.passwordHash),
      true,
    );
  }
  assert.equal(
    JSON.stringify(dataSource.state.audits).includes(syntheticPassword),
    false,
  );
});

test("re-running demo seed leaves existing accounts and passwords unchanged", async () => {
  const dataSource = new InMemoryDemoDataSource();
  await seed(dataSource);
  const existingAdmin = dataSource.state.users.find(
    (user) => user.role === "ADMIN",
  );
  existingAdmin.passwordHash = "existing-hash-must-not-change";
  existingAdmin.role = "LOGISTICS_OFFICER";
  const originalBaseCount = dataSource.state.bases.length;
  const originalAuditCount = dataSource.state.audits.length;

  const result = await seed(
    dataSource,
    "another-synthetic-test-password",
  );

  assert.equal(result.created, 0);
  assert.equal(result.skipped, 3);
  assert.equal(dataSource.state.users.length, 3);
  assert.equal(dataSource.state.bases.length, originalBaseCount);
  assert.equal(dataSource.state.audits.length, originalAuditCount);
  assert.equal(existingAdmin.passwordHash, "existing-hash-must-not-change");
  assert.equal(existingAdmin.role, "LOGISTICS_OFFICER");
});

test("audit failure rolls back demo base and account inserts", async () => {
  const dataSource = new InMemoryDemoDataSource({ failAudit: true });

  await assert.rejects(
    seed(dataSource),
    /synthetic audit failure/u,
  );
  assert.deepEqual(dataSource.state, { bases: [], users: [], audits: [] });
});

test("demo seed enforces the existing password byte limits", async () => {
  const dataSource = new InMemoryDemoDataSource();

  await assert.rejects(
    seed(dataSource, "short"),
    /existing password limits/u,
  );
  assert.deepEqual(dataSource.state, { bases: [], users: [], audits: [] });
});

test("production configuration is rejected before the seed transaction starts", async () => {
  const dataSource = new InMemoryDemoDataSource();

  await assert.rejects(
    seedDemoAccounts({
      dataSource,
      password: syntheticPassword,
      env: validEnvironment({ NODE_ENV: "production" }),
      explicitOptIn: true,
    }),
    /disabled in production/u,
  );
  assert.deepEqual(dataSource.state, { bases: [], users: [], audits: [] });
});
