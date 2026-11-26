import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { SignJWT } from "jose";
import { createBaseRouter } from "../routes/baseRoutes.js";
import { createEquipmentTypeRouter } from "../routes/equipmentTypeRoutes.js";
import { createInventoryRouter } from "../routes/inventoryRoutes.js";
import { createUserRouter } from "../routes/userRoutes.js";
import { createJwtConfiguration, JWT_AUDIENCE, JWT_ISSUER } from "./jwt.js";
import { calculateInventoryBalance } from "../controllers/assetController.js";
import { SYNTHETIC_JWT_SECRET } from "./testJwtSecret.js";

const jwtConfiguration = createJwtConfiguration(SYNTHETIC_JWT_SECRET);
const identifiers = {
  admin: randomUUID(),
  commander: randomUUID(),
  logisticsA: randomUUID(),
  logisticsB: randomUUID(),
  baseA: randomUUID(),
  baseB: randomUUID(),
  unusedBase: randomUUID(),
  equipmentTypeA: randomUUID(),
  equipmentTypeB: randomUUID(),
  assetA: randomUUID(),
  assetB: randomUUID(),
};

function makeUser({
  id,
  email,
  full_name,
  role,
  base_id = null,
  is_active = true,
} = {}) {
  return {
    id,
    email,
    password_hash: "synthetic-password-hash",
    full_name,
    role,
    base_id,
    is_active,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeBase({ id, code, name, is_active = true } = {}) {
  return {
    id,
    code,
    name,
    location_name: null,
    is_active,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeEquipmentType({
  id,
  code,
  name,
  category = "Vehicles",
  is_active = true,
} = {}) {
  return {
    id,
    code,
    name,
    category,
    description: null,
    is_active,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeInventoryRow({
  id,
  baseId,
  baseCode,
  baseName,
  equipmentTypeId,
  equipmentTypeCode,
  equipmentTypeName,
  openingBalance,
  purchases = 0,
  transfersIn = 0,
  transfersOut = 0,
  assignedOut = 0,
  returned = 0,
  expended = 0,
} = {}) {
  return {
    id,
    base_id: baseId,
    base_code: baseCode,
    base_name: baseName,
    equipment_type_id: equipmentTypeId,
    equipment_type_code: equipmentTypeCode,
    equipment_type_name: equipmentTypeName,
    equipment_type_category: "Vehicles",
    opening_balance: openingBalance,
    purchases,
    transfers_in: transfersIn,
    transfers_out: transfersOut,
    assigned_out: assignedOut,
    returned,
    expended,
    is_active: true,
    opening_at: "2026-01-01T00:00:00.000Z",
  };
}

function createFixtures() {
  const bases = [
    makeBase({
      id: identifiers.baseA,
      code: "SYN-A",
      name: "Synthetic Base Alpha",
    }),
    makeBase({
      id: identifiers.baseB,
      code: "SYN-B",
      name: "Synthetic Base Bravo",
    }),
    makeBase({
      id: identifiers.unusedBase,
      code: "SYN-C",
      name: "Synthetic Base Charlie",
      is_active: false,
    }),
  ];
  const equipmentTypes = [
    makeEquipmentType({
      id: identifiers.equipmentTypeA,
      code: "SYN-VEH-A",
      name: "Synthetic Vehicle A",
    }),
    makeEquipmentType({
      id: identifiers.equipmentTypeB,
      code: "SYN-VEH-B",
      name: "Synthetic Vehicle B",
      is_active: false,
    }),
  ];
  const users = [
    makeUser({
      id: identifiers.admin,
      email: "admin@example.test",
      full_name: "Synthetic Admin",
      role: "ADMIN",
    }),
    makeUser({
      id: identifiers.commander,
      email: "commander@example.test",
      full_name: "Synthetic Commander",
      role: "BASE_COMMANDER",
      base_id: identifiers.baseA,
    }),
    makeUser({
      id: identifiers.logisticsA,
      email: "logistics-a@example.test",
      full_name: "Synthetic Logistics A",
      role: "LOGISTICS_OFFICER",
      base_id: identifiers.baseA,
    }),
    makeUser({
      id: identifiers.logisticsB,
      email: "logistics-b@example.test",
      full_name: "Synthetic Logistics B",
      role: "LOGISTICS_OFFICER",
      base_id: identifiers.baseB,
    }),
  ];
  const inventoryRows = [
    makeInventoryRow({
      id: identifiers.assetA,
      baseId: identifiers.baseA,
      baseCode: "SYN-A",
      baseName: "Synthetic Base Alpha",
      equipmentTypeId: identifiers.equipmentTypeA,
      equipmentTypeCode: "SYN-VEH-A",
      equipmentTypeName: "Synthetic Vehicle A",
      openingBalance: "100",
      purchases: "20",
      transfersIn: "10",
      transfersOut: "5",
      assignedOut: "12",
      returned: "4",
      expended: "6",
    }),
    makeInventoryRow({
      id: identifiers.assetB,
      baseId: identifiers.baseB,
      baseCode: "SYN-B",
      baseName: "Synthetic Base Bravo",
      equipmentTypeId: identifiers.equipmentTypeA,
      equipmentTypeCode: "SYN-VEH-A",
      equipmentTypeName: "Synthetic Vehicle A",
      openingBalance: "40",
    }),
  ];
  return {
    users,
    bases,
    equipmentTypes,
    inventoryRows,
    baseReferences: false,
    auditEvents: [],
    failAuditInsert: false,
    failQueryContaining: null,
    queryCalls: [],
    transactionCount: 0,
  };
}

let state;
let dataSource;
let server;
let serverUrl;
let tokens;

function safeUserRow(user) {
  const { password_hash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

function createDataSource() {
  const source = {
    async query(sql, values = []) {
      state.queryCalls.push({ sql, values });
      if (sql.includes("INSERT INTO public.audit_log")) {
        if (state.failAuditInsert) {
          throw new Error("synthetic audit insert failure");
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
        const event = {
          actorUserId,
          action,
          entityType,
          entityId,
          correlationId,
          baseId,
          beforeData: beforeData === null ? null : JSON.parse(beforeData),
          afterData: afterData === null ? null : JSON.parse(afterData),
          id: randomUUID(),
        };
        state.auditEvents.push(event);
        return [{ id: event.id }];
      }
      if (state.failQueryContaining && sql.includes(state.failQueryContaining)) {
        const error = new Error("synthetic database details must not escape");
        error.code = "XX000";
        throw error;
      }

      if (sql.includes("public.app_user")) {
        if (
          sql.trimStart().startsWith(
            "SELECT id, email, full_name, role, base_id, is_active",
          )
        ) {
          const user = state.users.find((candidate) => candidate.id === values[0]);
          return user ? [safeUserRow(user)] : [];
        }
        if (sql.includes("SELECT COUNT(*) AS total")) {
          return [{ total: String(filterUsers(state.users, values).length) }];
        }
        if (sql.includes("ORDER BY created_at DESC")) {
          return filterUsers(state.users, values)
            .sort((left, right) => left.id.localeCompare(right.id))
            .slice(values[4], values[4] + values[3])
            .map(safeUserRow);
        }
        if (sql.includes("pg_catalog.lower(email)")) {
          return state.users
            .filter((user) => user.email.toLowerCase() === values[0])
            .filter((user) => values.length < 2 || user.id !== values[1])
            .slice(0, 1)
            .map(({ id }) => ({ id }));
        }
        if (sql.trimStart().startsWith("INSERT INTO public.app_user")) {
          const [email, password_hash, full_name, role, base_id] = values;
          const user = makeUser({
            id: randomUUID(),
            email,
            full_name,
            role,
            base_id,
          });
          user.password_hash = password_hash;
          state.users.push(user);
          return [safeUserRow(user)];
        }
        if (sql.trimStart().startsWith("SELECT id, email, role, base_id")) {
          const user = state.users.find((candidate) => candidate.id === values[0]);
          return user
            ? [{ id: user.id, email: user.email, role: user.role, base_id: user.base_id }]
            : [];
        }
        if (
          sql.trimStart().startsWith("SELECT") &&
          sql.includes("WHERE id = $1")
        ) {
          const user = state.users.find((candidate) => candidate.id === values[0]);
          return user ? [safeUserRow(user)] : [];
        }
        if (sql.trimStart().startsWith("UPDATE public.app_user")) {
          const user = state.users.find((candidate) => candidate.id === values[0]);
          if (!user) {
            return [];
          }
          if (sql.includes("SET is_active = $2")) {
            user.is_active = values[1];
          } else {
            if (values[1]) user.email = values[2];
            if (values[3]) user.full_name = values[4];
            if (values[5]) user.role = values[6];
            if (values[7]) user.base_id = values[8];
            if (values[9]) user.password_hash = values[10];
          }
          return [safeUserRow(user)];
        }
      }

      if (sql.includes("AS has_users")) {
        return [{
          has_users: state.baseReferences,
          has_assets: false,
          has_purchases: false,
          has_transfers: false,
          has_assignments: false,
          has_expenditures: false,
          has_returns: false,
          has_movements: false,
        }];
      }

      if (
        sql.includes("base.is_active = TRUE") &&
        sql.includes("base.id <>")
      ) {
        const eligibleBases = state.bases
          .filter(
            (base) =>
              base.is_active === true &&
              (values[0] === null || base.id !== values[0]),
          )
          .sort((left, right) => left.name.localeCompare(right.name));
        if (sql.includes("SELECT COUNT(*) AS total")) {
          return [{ total: String(eligibleBases.length) }];
        }
        return eligibleBases
          .slice(values[2], values[2] + values[1])
          .map(({ id, code, name }) => ({ id, code, name }));
      }

      if (sql.includes("public.base")) {
        if (sql.includes("id AS base_id")) {
          const base = state.bases.find((candidate) => candidate.id === values[0]);
          return base ? [{ base_id: base.id }] : [];
        }
        if (sql.includes("AND is_active = TRUE")) {
          const base = state.bases.find(
            (candidate) =>
              candidate.id === values[0] && candidate.is_active === true,
          );
          return base ? [{ id: base.id }] : [];
        }
        if (sql.includes("SELECT id, is_active")) {
          const base = state.bases.find((candidate) => candidate.id === values[0]);
          return base ? [{ id: base.id, is_active: base.is_active }] : [];
        }
        if (sql.includes("SELECT COUNT(*) AS total")) {
          const filtered = filterBases(state.bases, values);
          return [{ total: String(filtered.length) }];
        }
        if (sql.includes("ORDER BY name, id")) {
          const bases = filterBases(state.bases, values);
          return bases.slice(values[4], values[4] + values[3]);
        }
        if (sql.trimStart().startsWith("INSERT INTO public.base")) {
          const [code, name, location_name] = values;
          if (state.bases.some((base) => base.code === code || base.name === name)) {
            const error = new Error("duplicate base");
            error.code = "23505";
            throw error;
          }
          const base = makeBase({ id: randomUUID(), code, name });
          base.location_name = location_name;
          state.bases.push(base);
          return [base];
        }
        if (sql.includes("SET is_active = $2")) {
          const base = state.bases.find((candidate) => candidate.id === values[0]);
          if (!base) return [];
          base.is_active = values[1];
          return [base];
        }
        if (sql.trimStart().startsWith("UPDATE public.base")) {
          const base = state.bases.find((candidate) => candidate.id === values[0]);
          if (!base) return [];
          if (values[1]) base.code = values[2];
          if (values[3]) base.name = values[4];
          if (values[5]) base.location_name = values[6];
          return [base];
        }
        if (sql.includes("WHERE id = $1")) {
          const base = state.bases.find((candidate) => candidate.id === values[0]);
          return base ? [base] : [];
        }
      }

      if (sql.includes("public.equipment_type")) {
        if (sql.includes("SELECT COUNT(*) AS total")) {
          const filtered = filterEquipmentTypes(state.equipmentTypes, values);
          return [{ total: String(filtered.length) }];
        }
        if (sql.includes("ORDER BY name, id")) {
          const filtered = filterEquipmentTypes(state.equipmentTypes, values);
          return filtered.slice(values[3], values[3] + values[2]);
        }
        if (sql.trimStart().startsWith("INSERT INTO public.equipment_type")) {
          const [code, name, category, description] = values;
          if (
            state.equipmentTypes.some(
              (entry) => entry.code === code || entry.name === name,
            )
          ) {
            const error = new Error("duplicate equipment type");
            error.code = "23505";
            throw error;
          }
          const equipmentType = makeEquipmentType({
            id: randomUUID(),
            code,
            name,
            category,
          });
          equipmentType.description = description;
          state.equipmentTypes.push(equipmentType);
          return [equipmentType];
        }
        if (sql.trimStart().startsWith("UPDATE public.equipment_type")) {
          const equipmentType = state.equipmentTypes.find(
            (candidate) => candidate.id === values[0],
          );
          if (!equipmentType) return [];
          if (sql.includes("SET is_active = $2")) {
            equipmentType.is_active = values[1];
          } else {
            if (values[1]) equipmentType.code = values[2];
            if (values[3]) equipmentType.name = values[4];
            if (values[5]) equipmentType.category = values[6];
            if (values[7]) equipmentType.description = values[8];
          }
          return [equipmentType];
        }
        if (sql.includes("WHERE id = $1")) {
          const equipmentType = state.equipmentTypes.find(
            (candidate) => candidate.id === values[0],
          );
          return equipmentType ? [equipmentType] : [];
        }
      }

      if (sql.trimStart().startsWith("INSERT INTO public.asset")) {
        const [baseId, equipmentTypeId, openingBalance] = values;
        if (
          state.inventoryRows.some(
            (row) =>
              row.base_id === baseId &&
              row.equipment_type_id === equipmentTypeId,
          )
        ) {
          const error = new Error("duplicate asset position");
          error.code = "23505";
          error.constraint = "uq_asset_base_equipment";
          throw error;
        }
        const base = state.bases.find((entry) => entry.id === baseId);
        const equipmentType = state.equipmentTypes.find(
          (entry) => entry.id === equipmentTypeId,
        );
        const row = makeInventoryRow({
          id: randomUUID(),
          baseId,
          baseCode: base.code,
          baseName: base.name,
          equipmentTypeId,
          equipmentTypeCode: equipmentType.code,
          equipmentTypeName: equipmentType.name,
          openingBalance,
        });
        row.opening_at = new Date().toISOString();
        state.inventoryRows.push(row);
        return [{
          id: row.id,
          base_id: row.base_id,
          equipment_type_id: row.equipment_type_id,
          opening_balance: row.opening_balance,
          opening_at: row.opening_at,
        }];
      }

      if (sql.includes("FROM public.asset WHERE id = $1")) {
        const row = state.inventoryRows.find((candidate) => candidate.id === values[0]);
        return row ? [{ base_id: row.base_id }] : [];
      }
      if (sql.includes("WITH movement_totals AS")) {
        if (sql.includes("COUNT(*) AS total")) {
          const filtered = filterInventory(state.inventoryRows, values);
          return [{ total: String(filtered.length) }];
        }
        if (sql.includes("COUNT(*) AS record_count")) {
          return summarizeInventory(filterInventory(
            state.inventoryRows,
            [values[0], null, null],
          ));
        }
        return filterInventory(state.inventoryRows, values)
          .slice(values[4], values[4] + values[3]);
      }
      if (sql.includes("FROM public.asset asset")) {
        return [
          { total: String(filterInventory(state.inventoryRows, values).length) },
        ];
      }

      throw new Error(`Unexpected SQL in controlled test double: ${sql}`);
    },
  };
  source.transaction = async (operation) => {
    state.transactionCount += 1;
    const snapshot = structuredClone(state);
    try {
      return await operation({
        async query(sql, values) {
          const result = await source.query(sql, values);
          return sql.trimStart().startsWith("UPDATE") && Array.isArray(result)
            ? [result, result.length]
            : result;
        },
      });
    } catch (error) {
      state = snapshot;
      throw error;
    }
  };
  return source;
}

function filterInventory(rows, values) {
  const [baseId = null, equipmentTypeId = null, assetId = null] = values;
  return rows.filter(
    (row) =>
      (baseId === null || row.base_id === baseId) &&
      (equipmentTypeId === null || row.equipment_type_id === equipmentTypeId) &&
      (assetId === null || row.id === assetId),
  );
}

function filterUsers(users, values) {
  const [search, role = null, isActive = null] = values;
  const normalizedSearch = typeof search === "string" ? search.toLowerCase() : "";
  return users.filter(
    (user) =>
      (!normalizedSearch ||
        user.full_name.toLowerCase().includes(normalizedSearch) ||
        user.email.toLowerCase().includes(normalizedSearch)) &&
      (role === null || user.role === role) &&
      (isActive === null || user.is_active === isActive),
  );
}

function filterBases(bases, values) {
  const [baseId = null, isActive = null, search = null] = values;
  const normalizedSearch = typeof search === "string" ? search.toLowerCase() : "";
  return bases.filter(
    (base) =>
      (baseId === null || base.id === baseId) &&
      (isActive === null || base.is_active === isActive) &&
      (!normalizedSearch ||
        [base.code, base.name, base.location_name]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedSearch))),
  );
}

function filterEquipmentTypes(equipmentTypes, values) {
  const [isActive = null, search = null] = values;
  const normalizedSearch = typeof search === "string" ? search.toLowerCase() : "";
  return equipmentTypes.filter(
    (equipmentType) =>
      (isActive === null || equipmentType.is_active === isActive) &&
      (!normalizedSearch ||
        [
          equipmentType.code,
          equipmentType.name,
          equipmentType.category,
          equipmentType.description,
        ]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedSearch))),
  );
}

function summarizeInventory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.base_id}:${row.equipment_type_id}`;
    const group = groups.get(key) ?? {
      base_id: row.base_id,
      base_code: row.base_code,
      base_name: row.base_name,
      equipment_type_id: row.equipment_type_id,
      equipment_type_code: row.equipment_type_code,
      equipment_type_name: row.equipment_type_name,
      record_count: 0,
      opening_balance: 0,
      purchases: 0,
      transfers_in: 0,
      transfers_out: 0,
      assigned_out: 0,
      returned: 0,
      expended: 0,
    };
    group.record_count += 1;
    for (const field of [
      "opening_balance",
      "purchases",
      "transfers_in",
      "transfers_out",
      "assigned_out",
      "returned",
      "expended",
    ]) {
      group[field] += Number(row[field]);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

async function makeToken(userId) {
  return new SignJWT({
    role: "ADMIN",
    baseId: identifiers.baseB,
    isActive: false,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtConfiguration.key);
}

async function request(path, { userId, method = "GET", body } = {}) {
  const headers = {};
  if (userId) {
    headers.authorization = `Bearer ${tokens.get(userId)}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return fetch(`${serverUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function closeServer() {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

before(async () => {
  state = createFixtures();
  dataSource = createDataSource();
  tokens = new Map();
  for (const userId of [
    identifiers.admin,
    identifiers.commander,
    identifiers.logisticsA,
    identifiers.logisticsB,
  ]) {
    tokens.set(userId, await makeToken(userId));
  }

  const app = express();
  app.use(express.json());
  app.use(
    "/api/users",
    createUserRouter({
      dataSource,
      jwtConfiguration,
      passwordHasher: {
        async hash(password, rounds) {
          return `synthetic-bcrypt-${rounds}-${password}`;
        },
      },
    }),
  );
  app.use("/api/bases", createBaseRouter({ dataSource, jwtConfiguration }));
  app.use(
    "/api/equipment-types",
    createEquipmentTypeRouter({ dataSource, jwtConfiguration }),
  );
  app.use(
    "/api/inventory",
    createInventoryRouter({ dataSource, jwtConfiguration }),
  );
  app.use((_request, response) => {
    response.status(404).json({
      success: false,
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});

after(closeServer);

beforeEach(() => {
  state = createFixtures();
});

test("user routes require authentication and ADMIN authorization", async () => {
  const unauthenticated = await request("/api/users");
  assert.equal(unauthenticated.status, 401);

  state.queryCalls = [];
  const unauthorized = await request("/api/users", {
    userId: identifiers.commander,
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(
    state.queryCalls.some(({ sql }) => sql.includes("ORDER BY created_at DESC")),
    false,
  );
  assert.equal((await request("/api/bases")).status, 401);
  assert.equal((await request("/api/equipment-types")).status, 401);
  assert.equal((await request("/api/inventory")).status, 401);
});

test("inactive and deleted database users cannot access protected APIs", async () => {
  state.users.find((user) => user.id === identifiers.logisticsA).is_active = false;
  const inactive = await request("/api/inventory", {
    userId: identifiers.logisticsA,
  });
  assert.equal(inactive.status, 401);

  state.users = state.users.filter((user) => user.id !== identifiers.logisticsB);
  const deleted = await request("/api/equipment-types", {
    userId: identifiers.logisticsB,
  });
  assert.equal(deleted.status, 401);
});

test("user list and detail are paginated safe DTOs with validated IDs", async () => {
  const listResponse = await request("/api/users?limit=1&offset=0", {
    userId: identifiers.admin,
  });
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listBody.data.users.length, 1);
  assert.equal(listBody.meta.total, 4);
  assert.equal(JSON.stringify(listBody).includes("password_hash"), false);
  assert.equal(
    JSON.stringify(listBody).includes("synthetic-password-hash"),
    false,
  );

  const detailResponse = await request(`/api/users/${identifiers.commander}`, {
    userId: identifiers.admin,
  });
  const detailBody = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.data.user.id, identifiers.commander);
  assert.equal("passwordHash" in detailBody.data.user, false);

  assert.equal(
    (await request("/api/users/not-a-uuid", {
      userId: identifiers.admin,
    })).status,
    400,
  );
  assert.equal(
    (await request(`/api/users/${randomUUID()}`, {
      userId: identifiers.admin,
    })).status,
    404,
  );
  assert.equal(
    (await request("/api/users?limit=1000", {
      userId: identifiers.admin,
    })).status,
    400,
  );

  const filtered = await request(
    "/api/users?search=commander&role=BASE_COMMANDER&isActive=true",
    { userId: identifiers.admin },
  );
  const filteredBody = await filtered.json();
  assert.equal(filtered.status, 200);
  assert.equal(filteredBody.meta.total, 1);
  assert.equal(filteredBody.data.users[0].id, identifiers.commander);
  assert.equal(
    (await request("/api/users?role=UNKNOWN_ROLE", {
      userId: identifiers.admin,
    })).status,
    400,
  );
});

test("user creation, update, status, duplicates, and self-admin protection work", async () => {
  const created = await request("/api/users", {
    userId: identifiers.admin,
    method: "POST",
    body: {
      email: " NEW.USER@EXAMPLE.TEST ",
      name: "Synthetic New User",
      password: "synthetic password 123",
      role: "LOGISTICS_OFFICER",
      baseId: identifiers.baseA,
    },
  });
  const createdBody = await created.json();
  assert.equal(created.status, 201);
  assert.equal(createdBody.data.user.email, "new.user@example.test");
  assert.equal("password_hash" in createdBody.data.user, false);
  assert.equal(
    JSON.stringify(createdBody).includes("synthetic-bcrypt"),
    false,
  );
  const createdEvent = state.auditEvents.find(
    ({ action }) => action === "USER_CREATED",
  );
  assert.ok(createdEvent);
  assert.equal(createdEvent.actorUserId, identifiers.admin);
  assert.equal(createdEvent.entityType, "user");
  assert.equal(createdEvent.baseId, identifiers.baseA);
  assert.doesNotMatch(JSON.stringify(createdEvent), /email|password|synthetic/i);
  assert.ok(state.transactionCount > 0);
  assert.ok(
    state.queryCalls.some(
      ({ sql }) => sql.includes("FROM public.base") && sql.includes("FOR SHARE"),
    ),
  );

  const duplicate = await request("/api/users", {
    userId: identifiers.admin,
    method: "POST",
    body: {
      email: "commander@example.test",
      name: "Duplicate User",
      password: "synthetic password 123",
      role: "LOGISTICS_OFFICER",
      baseId: identifiers.baseA,
    },
  });
  assert.equal(duplicate.status, 409);

  const invalid = await request("/api/users", {
    userId: identifiers.admin,
    method: "POST",
    body: {
      email: "not-an-email",
      name: "",
      password: "short",
      role: "ADMIN",
    },
  });
  assert.equal(invalid.status, 400);

  const missingBaseAssignment = await request("/api/users", {
    userId: identifiers.admin,
    method: "POST",
    body: {
      email: "unassigned@example.test",
      name: "Synthetic Unassigned User",
      password: "synthetic password 123",
      role: "LOGISTICS_OFFICER",
    },
  });
  assert.equal(missingBaseAssignment.status, 400);

  const selfPromotion = await request(`/api/users/${identifiers.admin}`, {
    userId: identifiers.admin,
    method: "PATCH",
    body: { role: "ADMIN", baseId: null },
  });
  assert.equal(selfPromotion.status, 403);

  const nonAdminPromotion = await request(
    `/api/users/${identifiers.logisticsA}`,
    {
      userId: identifiers.logisticsA,
      method: "PATCH",
      body: { role: "ADMIN", baseId: null },
    },
  );
  assert.equal(nonAdminPromotion.status, 403);

  const updated = await request(`/api/users/${identifiers.logisticsB}`, {
    userId: identifiers.admin,
    method: "PATCH",
    body: { name: "Updated Synthetic Logistics" },
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.user.name, "Updated Synthetic Logistics");
  assert.ok(
    state.auditEvents.some(
      ({ action, entityId }) =>
        action === "USER_UPDATED" && entityId === identifiers.logisticsB,
    ),
  );
});

test("user status endpoint deactivates accounts and rejects invalid bodies", async () => {
  const response = await request(
    `/api/users/${identifiers.logisticsA}/status`,
    {
      userId: identifiers.admin,
      method: "PATCH",
      body: { isActive: false },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.user.isActive, false);
  const eventCount = state.auditEvents.length;
  assert.equal(state.auditEvents.at(-1).action, "USER_DEACTIVATED");

  const unchanged = await request(
    `/api/users/${identifiers.logisticsA}/status`,
    {
      userId: identifiers.admin,
      method: "PATCH",
      body: { isActive: false },
    },
  );
  assert.equal(unchanged.status, 200);
  assert.equal(state.auditEvents.length, eventCount);

  const invalid = await request(
    `/api/users/${identifiers.logisticsA}/status`,
    {
      userId: identifiers.admin,
      method: "PATCH",
      body: { isActive: "false" },
    },
  );
  assert.equal(invalid.status, 400);
});

test("base reads follow dashboard scope and cross-base access is denied", async () => {
  const ownList = await request("/api/bases", {
    userId: identifiers.commander,
  });
  const ownBody = await ownList.json();
  assert.equal(ownList.status, 200);
  assert.equal(ownBody.data.bases.length, 1);
  assert.equal(ownBody.data.bases[0].id, identifiers.baseA);

  const spoofedList = await request(`/api/bases?baseId=${identifiers.baseB}`, {
    userId: identifiers.commander,
  });
  assert.equal(spoofedList.status, 400);

  const crossBase = await request(`/api/bases/${identifiers.baseB}`, {
    userId: identifiers.commander,
  });
  assert.equal(crossBase.status, 403);
  const ownBase = await request(`/api/bases/${identifiers.baseA}`, {
    userId: identifiers.commander,
  });
  assert.equal((await ownBase.json()).data.base.id, identifiers.baseA);

  const adminList = await request("/api/bases", {
    userId: identifiers.admin,
  });
  assert.equal((await adminList.json()).data.bases.length, 3);
  const filteredList = await request(
    "/api/bases?search=syn-b&isActive=true",
    { userId: identifiers.admin },
  );
  const filteredBody = await filteredList.json();
  assert.equal(filteredList.status, 200);
  assert.equal(filteredBody.meta.total, 1);
  assert.equal(filteredBody.data.bases[0].id, identifiers.baseB);

  assert.equal(
    (await request("/api/bases/not-a-uuid", {
      userId: identifiers.admin,
    })).status,
    400,
  );
  assert.equal(
    (await request(`/api/bases/${randomUUID()}`, {
      userId: identifiers.admin,
    })).status,
    403,
  );
});

test("transfer destination options follow initiation scope and expose minimal active-base data", async () => {
  const adminResponse = await request(
    "/api/bases/transfer-destinations?limit=10",
    { userId: identifiers.admin },
  );
  const adminBody = await adminResponse.json();
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(
    adminBody.data.bases.map(({ id }) => id),
    [identifiers.baseA, identifiers.baseB],
  );
  assert.equal(adminBody.meta.total, 2);
  assert.deepEqual(Object.keys(adminBody.data.bases[0]).sort(), [
    "code",
    "id",
    "name",
  ]);
  assert.equal(
    adminBody.data.bases.some(({ id }) => id === identifiers.unusedBase),
    false,
  );

  const logisticsResponse = await request(
    "/api/bases/transfer-destinations",
    { userId: identifiers.logisticsA },
  );
  const logisticsBody = await logisticsResponse.json();
  assert.equal(logisticsResponse.status, 200);
  assert.deepEqual(
    logisticsBody.data.bases.map(({ id }) => id),
    [identifiers.baseB],
  );

  assert.equal(
    (
      await request("/api/bases/transfer-destinations", {
        userId: identifiers.commander,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `/api/bases/transfer-destinations?baseId=${identifiers.baseB}`,
        { userId: identifiers.logisticsA },
      )
    ).status,
    400,
  );
});

test("base CRUD is ADMIN-only and deactivation protects related records", async () => {
  const denied = await request("/api/bases", {
    userId: identifiers.commander,
    method: "POST",
    body: { code: "NEW-BASE", name: "New Base" },
  });
  assert.equal(denied.status, 403);

  const created = await request("/api/bases", {
    userId: identifiers.admin,
    method: "POST",
    body: { code: "SYN-NEW", name: "Synthetic New Base" },
  });
  assert.equal(created.status, 201);
  const createdBase = (await created.json()).data.base;
  assert.equal(state.auditEvents.at(-1).action, "BASE_CREATED");

  const duplicate = await request("/api/bases", {
    userId: identifiers.admin,
    method: "POST",
    body: { code: "SYN-A", name: "Duplicate Base" },
  });
  assert.equal(duplicate.status, 409);

  const invalid = await request("/api/bases", {
    userId: identifiers.admin,
    method: "POST",
    body: { code: "invalid code", name: "" },
  });
  assert.equal(invalid.status, 400);

  const updated = await request(`/api/bases/${createdBase.id}`, {
    userId: identifiers.admin,
    method: "PATCH",
    body: { name: "Renamed Synthetic Base" },
  });
  assert.equal((await updated.json()).data.base.name, "Renamed Synthetic Base");
  assert.equal(state.auditEvents.at(-1).action, "BASE_UPDATED");

  state.baseReferences = true;
  const protectedDeactivation = await request(
    `/api/bases/${identifiers.baseA}/status`,
    {
      userId: identifiers.admin,
      method: "PATCH",
      body: { isActive: false },
    },
  );
  assert.equal(protectedDeactivation.status, 409);

  state.baseReferences = false;
  const deactivated = await request(`/api/bases/${createdBase.id}/status`, {
    userId: identifiers.admin,
    method: "PATCH",
    body: { isActive: false },
  });
  assert.equal((await deactivated.json()).data.base.isActive, false);
  assert.equal(state.auditEvents.at(-1).action, "BASE_DEACTIVATED");
  assert.ok(state.transactionCount >= 2);
  assert.ok(
    state.queryCalls.some(
      ({ sql }) => sql.includes("SELECT id, is_active") && sql.includes("FOR UPDATE"),
    ),
  );
  const lockQueryIndex = state.queryCalls.findIndex(({ sql }) =>
    sql.includes("SELECT id, is_active") && sql.includes("FOR UPDATE"),
  );
  const referenceQueryIndex = state.queryCalls.findIndex(({ sql }) =>
    sql.includes("AS has_users"),
  );
  const deactivateQueryIndex = state.queryCalls.findIndex(({ sql }) =>
    sql.includes("UPDATE public.base") && sql.includes("SET is_active = $2"),
  );
  assert.ok(lockQueryIndex < referenceQueryIndex);
  assert.ok(referenceQueryIndex < deactivateQueryIndex);
});

test("equipment-type access and management follow the user-approved all-role policy", async () => {
  for (const userId of [
    identifiers.admin,
    identifiers.commander,
    identifiers.logisticsA,
  ]) {
    const list = await request("/api/equipment-types?limit=1", { userId });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data.equipmentTypes.length, 1);
  }
  const filteredList = await request(
    "/api/equipment-types?search=vehicles&isActive=true",
    { userId: identifiers.admin },
  );
  const filteredBody = await filteredList.json();
  assert.equal(filteredList.status, 200);
  assert.equal(filteredBody.meta.total, 1);

  const invalidFilter = await request(
    `/api/equipment-types?search=${"x".repeat(129)}`,
    { userId: identifiers.admin },
  );
  assert.equal(invalidFilter.status, 400);

  const created = await request("/api/equipment-types", {
    userId: identifiers.commander,
    method: "POST",
    body: {
      code: "SYN-EQ-3",
      name: "Synthetic Equipment Three",
      category: "Synthetic Category",
    },
  });
  assert.equal(created.status, 201);
  const createdType = (await created.json()).data.equipmentType;
  assert.equal(state.auditEvents.at(-1).action, "EQUIPMENT_TYPE_CREATED");

  const detail = await request(`/api/equipment-types/${createdType.id}`, {
    userId: identifiers.commander,
  });
  assert.equal((await detail.json()).data.equipmentType.id, createdType.id);

  const updated = await request(`/api/equipment-types/${createdType.id}`, {
    userId: identifiers.logisticsA,
    method: "PATCH",
    body: { description: "Synthetic description" },
  });
  assert.equal(
    (await updated.json()).data.equipmentType.description,
    "Synthetic description",
  );
  assert.equal(state.auditEvents.at(-1).action, "EQUIPMENT_TYPE_UPDATED");
  assert.equal(
    Object.hasOwn(state.auditEvents.at(-1).afterData, "description"),
    false,
  );

  const deactivated = await request(
    `/api/equipment-types/${createdType.id}/status`,
    {
      userId: identifiers.admin,
      method: "PATCH",
      body: { isActive: false },
    },
  );
  assert.equal((await deactivated.json()).data.equipmentType.isActive, false);
  assert.equal(
    state.auditEvents.at(-1).action,
    "EQUIPMENT_TYPE_DEACTIVATED",
  );

  const duplicate = await request("/api/equipment-types", {
    userId: identifiers.logisticsA,
    method: "POST",
    body: {
      code: "SYN-VEH-A",
      name: "Duplicate Equipment",
      category: "Synthetic Category",
    },
  });

  assert.equal(duplicate.status, 409);

  const invalid = await request("/api/equipment-types", {
    userId: identifiers.commander,
    method: "POST",
    body: { code: "bad code", name: "", category: "" },
  });
  assert.equal(invalid.status, 400);
  assert.equal(
    (await request("/api/equipment-types/not-a-uuid", {
      userId: identifiers.admin,
    })).status,
    400,
  );
  assert.equal(
    (await request(`/api/equipment-types/${randomUUID()}`, {
      userId: identifiers.admin,
    })).status,
    404,
  );
});

test("administrative mutations roll back when their audit insert fails", async () => {
  state.failAuditInsert = true;

  const userResponse = await request("/api/users", {
    userId: identifiers.admin,
    method: "POST",
    body: {
      email: "audit-failure@example.test",
      name: "Synthetic Audit Failure User",
      password: "synthetic password 123",
      role: "LOGISTICS_OFFICER",
      baseId: identifiers.baseA,
    },
  });
  assert.equal(userResponse.status, 500);
  assert.equal(
    state.users.some((user) => user.email === "audit-failure@example.test"),
    false,
  );
  assert.equal(state.auditEvents.length, 0);

  const baseResponse = await request("/api/bases", {
    userId: identifiers.admin,
    method: "POST",
    body: { code: "SYN-AUDIT-FAIL", name: "Synthetic Audit Failure Base" },
  });
  assert.equal(baseResponse.status, 500);
  assert.equal(
    state.bases.some((base) => base.code === "SYN-AUDIT-FAIL"),
    false,
  );
  assert.equal(state.auditEvents.length, 0);

  const equipmentTypeResponse = await request("/api/equipment-types", {
    userId: identifiers.logisticsA,
    method: "POST",
    body: {
      code: "SYN-AUDIT-FAIL",
      name: "Synthetic Audit Failure Equipment",
      category: "Synthetic Category",
    },
  });
  assert.equal(equipmentTypeResponse.status, 500);
  assert.equal(
    state.equipmentTypes.some(
      (equipmentType) => equipmentType.code === "SYN-AUDIT-FAIL",
    ),
    false,
  );
  assert.equal(state.auditEvents.length, 0);
});

test("inventory reads enforce base scope, filtering, and safe pagination", async () => {
  const logisticsList = await request("/api/inventory?limit=1", {
    userId: identifiers.logisticsA,
  });
  const logisticsBody = await logisticsList.json();
  assert.equal(logisticsList.status, 200);
  assert.equal(logisticsBody.data.inventory.length, 1);
  assert.equal(logisticsBody.data.inventory[0].base.id, identifiers.baseA);
  assert.equal(logisticsBody.meta.total, 1);

  const adminList = await request("/api/inventory", {
    userId: identifiers.admin,
  });
  assert.equal((await adminList.json()).meta.total, 2);
  const filteredAdminList = await request(
    `/api/inventory?baseId=${identifiers.baseB}`,
    { userId: identifiers.admin },
  );
  const filteredAdminBody = await filteredAdminList.json();
  assert.equal(filteredAdminList.status, 200);
  assert.equal(filteredAdminBody.meta.total, 1);
  assert.equal(filteredAdminBody.data.inventory[0].base.id, identifiers.baseB);

  const crossBaseRecord = await request(`/api/inventory/${identifiers.assetB}`, {
    userId: identifiers.logisticsA,
  });
  assert.equal(crossBaseRecord.status, 403);

  const ownRecord = await request(`/api/inventory/${identifiers.assetA}`, {
    userId: identifiers.logisticsA,
  });
  const ownRecordBody = await ownRecord.json();
  assert.equal(ownRecord.status, 200);
  assert.equal(ownRecordBody.data.inventory.closingBalance, 111);

  const crossBaseList = await request(
    `/api/inventory/bases/${identifiers.baseB}`,
    { userId: identifiers.logisticsA },
  );
  assert.equal(crossBaseList.status, 403);

  const ownBaseList = await request(
    `/api/inventory/bases/${identifiers.baseA}?limit=10`,
    { userId: identifiers.commander },
  );
  assert.equal((await ownBaseList.json()).data.inventory.length, 1);
  const ownBaseFilteredByType = await request(
    `/api/inventory/bases/${identifiers.baseA}?equipmentTypeId=${identifiers.equipmentTypeA}`,
    { userId: identifiers.commander },
  );
  assert.equal((await ownBaseFilteredByType.json()).data.inventory.length, 1);
  const mismatchedBaseFilter = await request(
    `/api/inventory/bases/${identifiers.baseA}?baseId=${identifiers.baseB}`,
    { userId: identifiers.admin },
  );
  assert.equal(mismatchedBaseFilter.status, 400);

  const byType = await request(
    `/api/inventory/equipment-types/${identifiers.equipmentTypeA}`,
    { userId: identifiers.logisticsA },
  );
  assert.equal((await byType.json()).data.inventory.length, 1);
  const adminByTypeAndBase = await request(
    `/api/inventory/equipment-types/${identifiers.equipmentTypeA}?baseId=${identifiers.baseB}`,
    { userId: identifiers.admin },
  );
  const adminByTypeAndBaseBody = await adminByTypeAndBase.json();
  assert.equal(adminByTypeAndBase.status, 200);
  assert.equal(adminByTypeAndBaseBody.meta.total, 1);
  assert.equal(
    adminByTypeAndBaseBody.data.inventory[0].base.id,
    identifiers.baseB,
  );
  const unauthorizedTypeBaseFilter = await request(
    `/api/inventory/equipment-types/${identifiers.equipmentTypeA}?baseId=${identifiers.baseB}`,
    { userId: identifiers.logisticsA },
  );
  assert.equal(unauthorizedTypeBaseFilter.status, 403);

  const summary = await request("/api/inventory/summary", {
    userId: identifiers.logisticsA,
  });
  const summaryBody = await summary.json();
  assert.equal(summaryBody.data.summary.length, 1);
  assert.equal(summaryBody.data.summary[0].closingBalance, 111);

  assert.equal(
    (await request("/api/inventory/not-a-uuid", {
      userId: identifiers.admin,
    })).status,
    400,
  );
  assert.equal(
    (await request(`/api/inventory/${randomUUID()}`, {
      userId: identifiers.admin,
    })).status,
    403,
  );
  assert.equal(
    (await request(`/api/inventory/equipment-types/${randomUUID()}`, {
      userId: identifiers.admin,
    })).status,
    404,
  );
  assert.equal(
    (await request("/api/inventory?baseId=" + identifiers.baseB, {
      userId: identifiers.logisticsA,
    })).status,
    403,
  );

  const ledgerQuery = state.queryCalls.find(({ sql }) =>
    sql.includes("WITH movement_totals AS"),
  );
  assert.ok(ledgerQuery.sql.includes("public.inventory_movement"));
  assert.ok(ledgerQuery.sql.includes("purchase.status = 'COMPLETED'"));
  assert.ok(ledgerQuery.sql.includes("transfer.status = 'COMPLETED'"));
});

test("opening stock is ADMIN-only, validated, unique, and audited atomically", async () => {
  const payload = {
    baseId: identifiers.baseA,
    equipmentTypeId: identifiers.equipmentTypeA,
    openingBalance: 25,
  };
  for (const userId of [identifiers.commander, identifiers.logisticsA]) {
    const denied = await request("/api/inventory/opening-stock", {
      userId,
      method: "POST",
      body: payload,
    });
    assert.equal(denied.status, 403);
  }

  const invalid = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: { ...payload, openingAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(invalid.status, 400);
  assert.equal(state.inventoryRows.length, 2);
  const zeroQuantity = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: { ...payload, openingBalance: 0 },
  });
  assert.equal(zeroQuantity.status, 400);
  const inactiveBase = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: { ...payload, baseId: identifiers.unusedBase },
  });
  assert.equal(inactiveBase.status, 409);
  const inactiveEquipmentType = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: { ...payload, equipmentTypeId: identifiers.equipmentTypeB },
  });
  assert.equal(inactiveEquipmentType.status, 409);

  const created = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: payload,
  });
  assert.equal(created.status, 409);

  const newPayload = {
    ...payload,
    equipmentTypeId: identifiers.equipmentTypeB,
  };
  state.equipmentTypes.find(
    (entry) => entry.id === identifiers.equipmentTypeB,
  ).is_active = true;
  const initialized = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: newPayload,
  });
  const initializedBody = await initialized.json();
  assert.equal(initialized.status, 201);
  assert.equal(initializedBody.data.openingStock.openingBalance, 25);
  assert.equal(typeof initializedBody.data.openingStock.openingAt, "string");
  assert.equal(state.inventoryRows.length, 3);
  assert.equal(
    state.auditEvents.filter(({ action }) => action === "OPENING_STOCK_CREATED")
      .length,
    1,
  );
  assert.equal(state.auditEvents.at(-1).actorUserId, identifiers.admin);
  assert.equal(state.auditEvents.at(-1).baseId, identifiers.baseA);

  const duplicate = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: newPayload,
  });
  assert.equal(duplicate.status, 409);
  assert.equal(state.inventoryRows.length, 3);
  assert.equal(
    state.auditEvents.filter(({ action }) => action === "OPENING_STOCK_CREATED")
      .length,
    1,
  );

  state.failAuditInsert = true;
  const beforeFailedAudit = state.inventoryRows.length;
  const failed = await request("/api/inventory/opening-stock", {
    userId: identifiers.admin,
    method: "POST",
    body: {
      ...payload,
      baseId: identifiers.baseB,
      equipmentTypeId: identifiers.equipmentTypeB,
    },
  });
  assert.equal(failed.status, 500);
  assert.equal(state.inventoryRows.length, beforeFailedAudit);
});

test("inventory calculation accounts for returns and rejects negative balances", () => {
  assert.deepEqual(
    calculateInventoryBalance({
      openingBalance: "100",
      purchases: "20",
      transfersIn: "10",
      transfersOut: "5",
      assignedOut: "12",
      returned: "4",
      expended: "6",
    }),
    {
      openingBalance: 100,
      purchases: 20,
      transfersIn: 10,
      transfersOut: 5,
      netMovement: 25,
      assigned: 8,
      returned: 4,
      expended: 6,
      closingBalance: 111,
    },
  );
  assert.throws(
    () =>
      calculateInventoryBalance({
        openingBalance: 1,
        purchases: 0,
        transfersIn: 0,
        transfersOut: 0,
        assignedOut: 3,
        returned: 0,
        expended: 0,
      }),
    /balance is invalid/,
  );
});

test("database failures return safe responses without exposing query details", async () => {
  state.failQueryContaining = "SELECT COUNT(*) AS total";
  const response = await request("/api/users", {
    userId: identifiers.admin,
  });
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.doesNotMatch(text, /synthetic database details|XX000/);
});
