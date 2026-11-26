import bcrypt from "bcrypt";
import Base from "../models/Base.js";
import User from "../models/User.js";
import { writeBusinessAudit } from "../utils/businessAudit.js";

const DEMO_BASE = Object.freeze({
  code: "DEMO-LOCAL",
  name: "Synthetic Local Demo Base",
  locationName: "Synthetic Training Area",
});

const DEMO_ACCOUNTS = Object.freeze([
  {
    email: "admin.demo@example.com",
    fullName: "Synthetic Demo Administrator",
    role: "ADMIN",
  },
  {
    email: "commander.demo@example.com",
    fullName: "Synthetic Demo Base Commander",
    role: "BASE_COMMANDER",
  },
  {
    email: "logistics.demo@example.com",
    fullName: "Synthetic Demo Logistics Officer",
    role: "LOGISTICS_OFFICER",
  },
]);

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 72;

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "::1") {
    return true;
  }
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function validateDemoPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_BYTES ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
  ) {
    throw new Error("The local demo password does not meet the existing password limits.");
  }
}

export function assertLocalDemoSeedAllowed(
  env,
  { explicitOptIn, password },
) {
  if (!env || typeof env !== "object") {
    throw new Error("Local demo-seed configuration is required.");
  }
  if (env.NODE_ENV === "production") {
    throw new Error("Local demo seeding is disabled in production.");
  }
  if (env.NODE_ENV !== "development") {
    throw new Error("Local demo seeding requires NODE_ENV=development.");
  }
  if (
    explicitOptIn !== true ||
    env.ENABLE_LOCAL_DEMO_SEED !== "true"
  ) {
    throw new Error("Explicit local demo-seed opt-in is required.");
  }
  if (env.APP_DATABASE_ROLE !== "kristallball_app") {
    throw new Error("APP_DATABASE_ROLE must be kristallball_app.");
  }

  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must target the local demo database.");
  }

  let databaseName;
  let databaseUser;
  try {
    databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
    databaseUser = decodeURIComponent(databaseUrl.username);
  } catch {
    throw new Error("DATABASE_URL must target the local demo database.");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !isLoopbackHost(databaseUrl.hostname) ||
    databaseUrl.port !== "5433" ||
    databaseName !== "military-management" ||
    databaseUser !== "kristallball_runtime" ||
    databaseUrl.search.length > 0 ||
    databaseUrl.hash.length > 0
  ) {
    throw new Error(
      "DATABASE_URL must use the restricted runtime login on loopback PostgreSQL port 5433 for military-management.",
    );
  }

  validateDemoPassword(password);
}

async function findDemoBase(manager) {
  const rows = await manager.query(
    `SELECT id, code, name, is_active
     FROM public.base
     WHERE code = $1 OR name = $2
     FOR SHARE`,
    [DEMO_BASE.code, DEMO_BASE.name],
  );
  if (!Array.isArray(rows)) {
    throw new Error("Could not verify the synthetic demo base.");
  }
  if (rows.length === 0) {
    const repository = manager.getRepository(Base);
    const base = await repository.save(
      repository.create({
        ...DEMO_BASE,
        isActive: true,
      }),
    );
    if (!base?.id) {
      throw new Error("Could not create the synthetic demo base.");
    }
    await writeBusinessAudit(manager, {
      actorUserId: null,
      action: "LOCAL_DEMO_BASE_CREATED",
      entityType: "base",
      entityId: base.id,
      baseId: base.id,
      afterData: { code: DEMO_BASE.code, isActive: true },
    });
    return { id: base.id, created: true };
  }
  if (
    rows.length !== 1 ||
    rows[0].code !== DEMO_BASE.code ||
    rows[0].name !== DEMO_BASE.name ||
    rows[0].is_active !== true
  ) {
    throw new Error("The reserved synthetic demo base conflicts with existing data.");
  }
  return { id: rows[0].id, created: false };
}

export async function seedDemoAccounts({
  dataSource,
  password,
  passwordHasher = bcrypt,
  env,
  explicitOptIn,
}) {
  assertLocalDemoSeedAllowed(env, { explicitOptIn, password });
  if (!dataSource || typeof dataSource.transaction !== "function") {
    throw new Error("A configured runtime database connection is required.");
  }

  return dataSource.transaction(async (manager) => {
    const existingRows = await manager.query(
      `SELECT id, email
       FROM public.app_user
       WHERE pg_catalog.lower(email) = ANY($1::text[])
       ORDER BY id`,
      [DEMO_ACCOUNTS.map(({ email }) => email)],
    );
    if (!Array.isArray(existingRows)) {
      throw new Error("Could not verify existing demo accounts.");
    }

    const existingEmails = new Set();
    for (const row of existingRows) {
      const email = row.email.toLowerCase();
      if (existingEmails.has(email)) {
        throw new Error("Duplicate case-insensitive demo accounts require manual review.");
      }
      existingEmails.add(email);
    }

    const accountsToCreate = DEMO_ACCOUNTS.filter(
      ({ email }) => !existingEmails.has(email),
    );
    if (accountsToCreate.length === 0) {
      return { created: 0, skipped: DEMO_ACCOUNTS.length };
    }

    const requiresBase = accountsToCreate.some(
      ({ role }) => role !== "ADMIN",
    );
    const base = requiresBase
      ? await findDemoBase(manager)
      : { id: null, created: false };
    const passwordHash = await passwordHasher.hash(password, BCRYPT_ROUNDS);
    const userRepository = manager.getRepository(User);

    for (const account of accountsToCreate) {
      const baseId = account.role === "ADMIN" ? null : base.id;
      const user = await userRepository.save(
        userRepository.create({
          email: account.email,
          passwordHash,
          fullName: account.fullName,
          role: account.role,
          baseId,
          isActive: true,
        }),
      );
      if (!user?.id) {
        throw new Error("Could not create a local demo account.");
      }

      await writeBusinessAudit(manager, {
        actorUserId: null,
        action: "LOCAL_DEMO_ACCOUNT_CREATED",
        entityType: "user",
        entityId: user.id,
        baseId,
        afterData: {
          role: account.role,
          baseId,
          isActive: true,
        },
      });
    }

    return {
      created: accountsToCreate.length,
      skipped: DEMO_ACCOUNTS.length - accountsToCreate.length,
      baseCreated: base.created,
    };
  });
}
