import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { SignJWT } from "jose";
import { createAuditRouter } from "../routes/auditRoutes.js";
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
  inactive: randomUUID(),
  baseA: randomUUID(),
  baseB: randomUUID(),
  transferAB: randomUUID(),
  auditA: randomUUID(),
  auditB: randomUUID(),
  auditTransferMissing: randomUUID(),
  missingTransferRef: randomUUID(),
};

const users = new Map([
  [ids.admin, {
    id: ids.admin,
    email: "admin@example.test",
    full_name: "Synthetic Admin",
    role: "ADMIN",
    base_id: null,
    is_active: true,
  }],
  [ids.commanderA, {
    id: ids.commanderA,
    email: "commander@example.test",
    full_name: "Synthetic Commander",
    role: "BASE_COMMANDER",
    base_id: ids.baseA,
    is_active: true,
  }],
  [ids.commanderB, {
    id: ids.commanderB,
    email: "commander-b@example.test",
    full_name: "Synthetic Commander B",
    role: "BASE_COMMANDER",
    base_id: ids.baseB,
    is_active: true,
  }],
  [ids.logisticsA, {
    id: ids.logisticsA,
    email: "logistics-a@example.test",
    full_name: "Synthetic Logistics A",
    role: "LOGISTICS_OFFICER",
    base_id: ids.baseA,
    is_active: true,
  }],
  [ids.logisticsB, {
    id: ids.logisticsB,
    email: "logistics-b@example.test",
    full_name: "Synthetic Logistics B",
    role: "LOGISTICS_OFFICER",
    base_id: ids.baseB,
    is_active: true,
  }],
  [ids.inactive, {
    id: ids.inactive,
    email: "inactive@example.test",
    full_name: "Synthetic Inactive",
    role: "ADMIN",
    base_id: null,
    is_active: false,
  }],
]);

const events = [
  {
    id: ids.auditA,
    actor_user_id: ids.admin,
    action: "PURCHASE_CREATED",
    entity_type: "purchase",
    entity_id: randomUUID(),
    base_id: ids.baseA,
    correlation_id: randomUUID(),
    created_at: "2026-11-20T10:00:00.000Z",
  },
  {
    id: ids.auditB,
    actor_user_id: ids.logisticsB,
    action: "TRANSFER_COMPLETED",
    entity_type: "transfer",
    entity_id: ids.transferAB,
    base_id: ids.baseB,
    correlation_id: randomUUID(),
    created_at: "2026-11-21T10:00:00.000Z",
  },
  {
    id: ids.auditTransferMissing,
    actor_user_id: ids.logisticsA,
    action: "TRANSFER_COMPLETED",
    entity_type: "transfer",
    entity_id: ids.missingTransferRef,
    base_id: ids.baseA,
    correlation_id: randomUUID(),
    created_at: "2026-11-22T10:00:00.000Z",
  },
];

const transfers = new Map([
  [ids.transferAB, {
    id: ids.transferAB,
    source_base_id: ids.baseA,
    destination_base_id: ids.baseB,
  }],
]);

function auditVisibleTo(event, baseId) {
  if (event.base_id === baseId) {
    return true;
  }
  if (event.entity_type !== "transfer") {
    return false;
  }
  const transfer = transfers.get(event.entity_id);
  return Boolean(
    transfer &&
      (transfer.source_base_id === baseId ||
        transfer.destination_base_id === baseId),
  );
}

function createDataSource() {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM public.app_user")) {
        const user = users.get(values[0]);
        return user ? [user] : [];
      }
      if (sql.includes("FROM public.audit_log audit")) {
        const detailMatch = sql.includes("audit.id = $1::uuid");
        if (detailMatch) {
          const event = events.find((candidate) => candidate.id === values[0]);
          if (!event) return [];
          const baseId = values[1];
          if (baseId && !auditVisibleTo(event, baseId)) return [];
          return [event];
        }

        let filtered = [...events];
        if (values.length > 0) {
          const scopeValue = values[0];
          if (
            typeof scopeValue === "string" &&
            (scopeValue === ids.baseA || scopeValue === ids.baseB)
          ) {
            filtered = filtered.filter((event) =>
              auditVisibleTo(event, scopeValue),
            );
          }
        }

        if (sql.includes("SELECT COUNT(*)")) {
          return [{ total: filtered.length }];
        }
        const limit = values.at(-2);
        const offset = values.at(-1);
        return filtered
          .sort((left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) ||
            String(right.id).localeCompare(String(left.id)),
          )
          .slice(offset, offset + limit);
      }
      if (sql.includes("FROM public.transfer transfer")) {
        const transfer = transfers.get(values[0]);
        return transfer ? [transfer] : [];
      }
      throw new Error(`Unexpected audit test query: ${sql}`);
    },
  };
}

let dataSource;
let server;
let serverUrl;
const tokens = new Map();

async function makeToken(userId) {
  return new SignJWT({ role: "ADMIN", baseId: ids.baseB })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtConfiguration.key);
}

async function request(path, userId) {
  const headers = {};
  if (userId) {
    headers.authorization = `Bearer ${tokens.get(userId)}`;
  }
  return fetch(`${serverUrl}${path}`, { method: "GET", headers });
}

before(async () => {
  dataSource = createDataSource();
  for (const userId of [
    ids.admin,
    ids.commanderA,
    ids.commanderB,
    ids.logisticsA,
    ids.logisticsB,
    ids.inactive,
  ]) {
    tokens.set(userId, await makeToken(userId));
  }
  const app = express();
  app.use("/api/audit", createAuditRouter({
    dataSource,
    jwtConfiguration,
  }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  dataSource.calls.length = 0;
});

test("ADMIN lists and reads audit events globally", async () => {
  const listResponse = await request("/api/audit", ids.admin);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.data.audits.length, 3);

  const detailResponse = await request(`/api/audit/${ids.auditA}`, ids.admin);
  assert.equal(detailResponse.status, 200);
  const detailBody = await detailResponse.json();
  assert.deepEqual(
    Object.keys(detailBody.data.audit).sort(),
    ["action", "actorId", "baseId", "correlationId", "createdAt",
      "entityId", "entityType", "id"].sort(),
  );
});

test("BASE_COMMANDER and LOGISTICS_OFFICER are restricted to own-base events", async () => {
  for (const userId of [ids.commanderA, ids.logisticsA]) {
    const response = await request("/api/audit", userId);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.data.audits.every((event) =>
        auditVisibleTo(events.find((row) => row.id === event.id), ids.baseA),
      ),
      true,
    );
  }

  const logisticsBDetail = await request(
    `/api/audit/${ids.auditA}`,
    ids.logisticsB,
  );
  assert.equal(logisticsBDetail.status, 404);
});

test("transfer source and destination base visibility is supported", async () => {
  for (const userId of [
    ids.commanderA,
    ids.commanderB,
    ids.logisticsA,
    ids.logisticsB,
  ]) {
    const response = await request("/api/audit", userId);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.data.audits.some((event) => event.id === ids.auditB),
      true,
    );
  }
});

test("missing transfer references remain scoped by the stored baseId", async () => {
  const ownBaseList = await request("/api/audit", ids.logisticsA);
  assert.equal(ownBaseList.status, 200);
  const ownBaseBody = await ownBaseList.json();
  assert.equal(
    ownBaseBody.data.audits.some(
      (event) => event.id === ids.auditTransferMissing,
    ),
    true,
  );

  const otherBaseList = await request("/api/audit", ids.logisticsB);
  assert.equal(otherBaseList.status, 200);
  const otherBaseBody = await otherBaseList.json();
  assert.equal(
    otherBaseBody.data.audits.some(
      (event) => event.id === ids.auditTransferMissing,
    ),
    false,
  );

  assert.equal(
    (await request(
      `/api/audit/${ids.auditTransferMissing}`,
      ids.logisticsA,
    )).status,
    200,
  );
  assert.equal(
    (await request(
      `/api/audit/${ids.auditTransferMissing}`,
      ids.logisticsB,
    )).status,
    404,
  );
});

test("safe DTO fields exclude snapshots, IP, user-agent, and actor personal data", async () => {
  const response = await request(`/api/audit/${ids.auditA}`, ids.admin);
  assert.equal(response.status, 200);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /beforeData|afterData|ipAddress|userAgent|email|password/i);
});

test("baseId filter cannot expand an own-base user's scope", async () => {
  const response = await request(
    `/api/audit?baseId=${ids.baseB}`,
    ids.logisticsA,
  );
  assert.equal(response.status, 400);
});

test("invalid query parameters, UUIDs, dates, and windows are rejected", async () => {
  const cases = [
    "/api/audit?unexpected=value",
    "/api/audit?actorId=not-a-uuid",
    "/api/audit?baseId=not-a-uuid",
    "/api/audit?from=2026-01-01",
    "/api/audit?from=2025-01-01T00:00:00Z&to=2026-12-31T00:00:00Z",
    "/api/audit?from=2020-01-01T00:00:00Z",
  ];
  for (const path of cases) {
    const response = await request(path, ids.admin);
    assert.equal(response.status, 400);
  }
});

test("audit date filters enforce UTC validity, time bounds, and 365-day windows", async (context) => {
  const now = Date.now();
  context.mock.method(Date, "now", () => now);
  const day = 24 * 60 * 60 * 1000;
  const dateAt = (offset) => new Date(now + offset).toISOString();
  const cases = [
    { query: { to: dateAt(1000) }, expectedStatus: 400 },
    { query: { to: dateAt(-366 * day) }, expectedStatus: 400 },
    { query: { to: dateAt(-30 * day) }, expectedStatus: 200 },
    { query: { to: dateAt(-365 * day) }, expectedStatus: 200 },
    { query: { from: dateAt(1000) }, expectedStatus: 400 },
    { query: { from: dateAt(-366 * day) }, expectedStatus: 400 },
    {
      query: { from: dateAt(-10 * day), to: dateAt(-11 * day) },
      expectedStatus: 400,
    },
    {
      query: { from: dateAt(-367 * day), to: dateAt(-day) },
      expectedStatus: 400,
    },
    {
      query: { from: dateAt(-200 * day), to: dateAt(-100 * day) },
      expectedStatus: 200,
    },
    {
      query: { from: dateAt(-365 * day), to: dateAt(0) },
      expectedStatus: 200,
    },
    {
      query: { to: "2026-02-30T00:00:00Z" },
      expectedStatus: 400,
    },
    {
      query: {
        from: new Date(Math.floor((now - day) / 1000) * 1000)
          .toISOString()
          .replace(".000Z", "Z"),
      },
      expectedStatus: 200,
    },
  ];

  for (const { query, expectedStatus } of cases) {
    const search = new URLSearchParams(query).toString();
    const response = await request(`/api/audit?${search}`, ids.admin);
    assert.equal(response.status, expectedStatus, search);
  }
});

test("pagination defaults and limits are validated", async () => {
  assert.equal((await request("/api/audit", ids.admin)).status, 200);
  assert.equal((await request("/api/audit?limit=101", ids.admin)).status, 400);
  assert.equal((await request("/api/audit?limit=0", ids.admin)).status, 400);
  assert.equal((await request("/api/audit?offset=-1", ids.admin)).status, 400);
});

test("inactive users are denied", async () => {
  const response = await request("/api/audit", ids.inactive);
  assert.equal(response.status, 401);
});

test("audit API has no mutation routes", async () => {
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const response = await fetch(`${serverUrl}/api/audit`, {
      method,
    });
    assert.equal(response.status, 404);
  }
});

test("audit SQL uses parameterized values", async () => {
  await request(
    `/api/audit?action=PURCHASE_CREATED&actorId=${ids.admin}&limit=10&offset=2`,
    ids.admin,
  );
  const auditCalls = dataSource.calls.filter(({ sql }) =>
    sql.includes("FROM public.audit_log audit"),
  );
  assert.ok(auditCalls.length > 0);
  assert.equal(
    auditCalls.every(({ sql }) =>
      !sql.includes("PURCHASE_CREATED") &&
      !sql.includes(ids.admin),
    ),
    true,
  );
});
