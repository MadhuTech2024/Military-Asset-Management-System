import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { SignJWT } from "jose";
import { createBusinessOperationsController } from "../controllers/businessOperationsController.js";
import { createBusinessOperationsRouter } from "../routes/businessOperationsRoutes.js";
import { AUTHORIZATION_OPERATIONS } from "./authorizationPolicies.js";
import {
  createJwtConfiguration,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from "./jwt.js";
import { SYNTHETIC_JWT_SECRET } from "./testJwtSecret.js";

const jwtConfiguration = createJwtConfiguration(SYNTHETIC_JWT_SECRET);
const ids = {
  admin: randomUUID(),
  commanderA: randomUUID(),
  commanderB: randomUUID(),
  logisticsA: randomUUID(),
  logisticsB: randomUUID(),
  baseA: randomUUID(),
  baseB: randomUUID(),
  equipmentType: randomUUID(),
  assetA: randomUUID(),
  transfer: randomUUID(),
};

const users = [
  { id: ids.admin, role: "ADMIN", base_id: null, is_active: true },
  { id: ids.commanderA, role: "BASE_COMMANDER", base_id: ids.baseA, is_active: true },
  { id: ids.commanderB, role: "BASE_COMMANDER", base_id: ids.baseB, is_active: true },
  { id: ids.logisticsA, role: "LOGISTICS_OFFICER", base_id: ids.baseA, is_active: true },
  { id: ids.logisticsB, role: "LOGISTICS_OFFICER", base_id: ids.baseB, is_active: true },
];

function createGateDataSource() {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM public.app_user")) {
        const user = users.find((candidate) => candidate.id === values[0]);
        return user
          ? [{ ...user, email: "synthetic@example.test", full_name: "Synthetic User" }]
          : [];
      }
      if (sql.includes("FROM public.business_idempotency")) {
        return [];
      }
      if (sql.includes("id AS base_id FROM public.base")) {
        return [{ base_id: values[0] }];
      }
      if (sql.includes("FROM public.asset WHERE id = $1")) {
        return [{ base_id: ids.baseA }];
      }
      if (sql.includes("FROM public.assignment WHERE id = $1")) {
        return [{ base_id: ids.baseA }];
      }
      if (sql.includes("FROM public.transfer")) {
        return [{
          id: values[0],
          source_base_id: ids.baseA,
          destination_base_id: ids.baseB,
          status: "COMPLETED",
          created_by: ids.logisticsA,
          approved_by: ids.commanderB,
          completed_by: ids.logisticsB,
        }];
      }
      throw new Error(`Unexpected controlled route query: ${sql}`);
    },
    async transaction() {
      throw new Error("The controller must not run for denied or invalid requests.");
    },
  };
}

async function tokenFor(userId) {
  return new SignJWT({ role: "ADMIN", baseId: ids.baseB })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtConfiguration.key);
}

async function withRouter(operation) {
  const dataSource = createGateDataSource();
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createBusinessOperationsRouter({ dataSource, jwtConfiguration }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await operation({
      dataSource,
      async request(path, { userId, method = "POST", body, key } = {}) {
        const headers = {};
        if (userId) {
          headers.authorization = `Bearer ${await tokenFor(userId)}`;
        }
        if (body !== undefined) {
          headers["content-type"] = "application/json";
        }
        if (key !== undefined) {
          headers["Idempotency-Key"] = key;
        }
        return fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      },
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function createPurchaseDataSource({
  failAudit = false,
  actorRole = "ADMIN",
  actorBaseId = null,
  actorActive = true,
} = {}) {
  let state = {
    purchases: [],
    audits: [],
    idempotency: [],
    movements: [],
  };
  const actor = {
    ...users.find((user) => user.id === ids.admin),
    role: actorRole,
    base_id: actorBaseId,
    is_active: actorActive,
  };
  const source = {
    get state() {
      return state;
    },
    async query(sql, values = []) {
      return queryState(state, sql, values);
    },
    async transaction(operation) {
      const previousState = structuredClone(state);
      try {
        return await operation({
          query: async (sql, values = []) => queryState(state, sql, values),
        });
      } catch (error) {
        state = previousState;
        throw error;
      }
    },
  };

  function queryState(current, sql, values) {
    if (sql.includes("FROM public.app_user")) {
      return [{ ...actor }];
    }
    if (sql.includes("FROM public.base") && sql.includes("FOR SHARE")) {
      return [{ id: ids.baseA, is_active: true }];
    }
    if (sql.includes("FROM public.equipment_type")) {
      return [{ id: ids.equipmentType, is_active: true }];
    }
    if (
      sql.includes("FROM public.asset") &&
      sql.includes("base_id = $1 AND equipment_type_id = $2")
    ) {
      return [{
        id: ids.assetA,
        base_id: ids.baseA,
        equipment_type_id: ids.equipmentType,
        opening_balance: 10,
        is_active: true,
      }];
    }
    if (sql.includes("FROM public.business_idempotency")) {
      return current.idempotency.filter(
        (row) => row.idempotency_key === values[0],
      );
    }
    if (sql.startsWith("INSERT INTO public.purchase")) {
      const purchase = {
        id: randomUUID(),
        base_id: values[0],
        equipment_type_id: values[1],
        quantity: values[2],
        status: "PENDING",
        reference_code: values[3],
        purchased_at: "2026-11-25T00:00:00.000Z",
        created_by: values[4],
        created_at: "2026-11-25T00:00:00.000Z",
        updated_at: "2026-11-25T00:00:00.000Z",
      };
      current.purchases.push(purchase);
      return [purchase];
    }
    if (sql.startsWith("INSERT INTO public.audit_log")) {
      if (failAudit) {
        const error = new Error("synthetic audit insert failure");
        error.code = "XX000";
        throw error;
      }
      current.audits.push({
        actor_user_id: values[0],
        action: values[1],
        entity_id: values[3],
        base_id: values[5],
      });
      return [{ id: randomUUID() }];
    }
    if (sql.startsWith("INSERT INTO public.business_idempotency")) {
      const row = {
        idempotency_key: values[0],
        actor_user_id: values[1],
        operation: values[2],
        request_fingerprint: values[3],
        entity_type: values[4],
        entity_id: values[5],
        http_status: values[6],
        response_payload: JSON.parse(values[7]),
      };
      current.idempotency.push(row);
      return [{ id: randomUUID() }];
    }
    throw new Error(`Unexpected controlled purchase query: ${sql}`);
  }

  return source;
}

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function purchaseRequest(source, quantity, idempotencyKey) {
  return {
    dataSource: source,
    currentUser: {
      id: ids.admin,
      role: "ADMIN",
      baseId: null,
      isActive: true,
    },
    validatedBody: {
      baseId: ids.baseA,
      equipmentTypeId: ids.equipmentType,
      quantity,
      referenceCode: null,
    },
    idempotencyKey,
  };
}

test("business routes authenticate, enforce role/base scope, and validate before controllers", async () => {
  await withRouter(async ({ dataSource, request }) => {
    assert.equal((await request("/purchases")).status, 401);

    const commanderPurchase = await request("/purchases", {
      userId: ids.commanderA,
      body: {
        baseId: ids.baseA,
        equipmentTypeId: ids.equipmentType,
        quantity: 1,
      },
      key: "purchase-denied",
    });
    assert.equal(commanderPurchase.status, 403);

    const adminApproval = await request(`/transfers/${ids.transfer}/approve`, {
      userId: ids.admin,
      body: {},
      key: "admin-approval-denied",
    });
    assert.equal(adminApproval.status, 403);
    assert.equal(
      dataSource.calls.some(({ sql }) => sql.includes("FROM public.transfer")),
      false,
    );

    const crossBaseInitiation = await request("/transfers", {
      userId: ids.logisticsA,
      body: {
        sourceBaseId: ids.baseB,
        destinationBaseId: ids.baseA,
        equipmentTypeId: ids.equipmentType,
        quantity: 1,
      },
      key: "cross-base-denied",
    });
    assert.equal(crossBaseInitiation.status, 403);

    const invalidAssignment = await request("/assignments", {
      userId: ids.commanderA,
      body: {
        assetId: ids.assetA,
        quantity: 1,
        personnelReference: "SYNTHETIC-REF",
        actorId: ids.admin,
      },
      key: "unexpected-field",
    });
    assert.equal(invalidAssignment.status, 400);

    const missingCommandKey = await request(
      `/transfers/${ids.transfer}/approve`,
      {
        userId: ids.commanderB,
        body: {},
      },
    );
    assert.equal(missingCommandKey.status, 400);
  });
});

test("pending purchase is audited without a movement and exact retries replay", async () => {
  const source = createPurchaseDataSource();
  const controller = createBusinessOperationsController({ dataSource: source });
  const first = makeResponse();
  await controller.createPurchase(
    purchaseRequest(source, 3, "purchase-retry-1"),
    first,
  );
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.data.purchase.status, "PENDING");
  assert.equal(source.state.purchases.length, 1);
  assert.equal(source.state.movements.length, 0);
  assert.equal(source.state.audits.length, 1);
  assert.equal(source.state.audits[0].action, "PURCHASE_CREATED");
  assert.equal(source.state.audits[0].actor_user_id, ids.admin);
  assert.equal(
    source.state.audits[0].entity_id,
    first.body.data.purchase.id,
  );
  assert.equal(source.state.audits[0].base_id, ids.baseA);

  const replay = makeResponse();
  await controller.createPurchase(
    purchaseRequest(source, 3, "purchase-retry-1"),
    replay,
  );
  assert.equal(replay.statusCode, 201);
  assert.deepEqual(replay.body, first.body);
  assert.equal(source.state.purchases.length, 1);
  assert.equal(source.state.movements.length, 0);
  assert.equal(source.state.audits.length, 1);

  const changedPayload = makeResponse();
  await controller.createPurchase(
    purchaseRequest(source, 4, "purchase-retry-1"),
    changedPayload,
  );
  assert.equal(changedPayload.statusCode, 409);
  assert.equal(changedPayload.body.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(source.state.purchases.length, 1);
  assert.equal(source.state.movements.length, 0);
  assert.equal(source.state.audits.length, 1);
  assert.equal(source.state.idempotency.length, 1);
});

test("audit failure rolls back the purchase and its idempotency record", async () => {
  const source = createPurchaseDataSource({ failAudit: true });
  const controller = createBusinessOperationsController({ dataSource: source });
  const response = makeResponse();
  await controller.createPurchase(
    purchaseRequest(source, 2, "purchase-audit-failure"),
    response,
  );
  assert.equal(response.statusCode, 500);
  assert.equal(source.state.purchases.length, 0);
  assert.equal(source.state.audits.length, 0);
  assert.equal(source.state.idempotency.length, 0);
});

test("controller replay denies role, base, and inactive-user authorization changes", async () => {
  for (const changes of [
    { actorRole: "BASE_COMMANDER", actorBaseId: ids.baseA, actorActive: true },
    { actorRole: "ADMIN", actorBaseId: null, actorActive: false },
  ]) {
    const source = createPurchaseDataSource(changes);
    const controller = createBusinessOperationsController({ dataSource: source });
    const response = makeResponse();
    await controller.createPurchase(
      purchaseRequest(source, 3, "protected-replay"),
      response,
    );
    assert.equal([403, 401].includes(response.statusCode), true);
  }
});

test("unauthorized replay requests never reach idempotency lookup", async () => {
  await withRouter(async ({ dataSource, request }) => {
    const start = dataSource.calls.length;
    const response = await request("/purchases", {
      userId: ids.commanderA,
      body: {
        baseId: ids.baseA,
        equipmentTypeId: ids.equipmentType,
        quantity: 1,
      },
      key: "unauthorized-replay",
    });
    assert.equal(response.status, 403);
    const callsAfterRequest = dataSource.calls.slice(start);
    assert.equal(
      callsAfterRequest.some(({ sql }) =>
        sql.includes("FROM public.business_idempotency"),
      ),
      false,
    );
  });
});
