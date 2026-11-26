import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { SignJWT } from "jose";
import { createBaseRouter } from "../routes/baseRoutes.js";
import { createDashboardRouter } from "../routes/dashboardRoutes.js";
import { createReportRouter } from "../routes/reportRoutes.js";
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
  baseC: randomUUID(),
  equipmentType: randomUUID(),
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
  [ids.commanderB, {
    id: ids.commanderB,
    email: "commander-b@example.test",
    full_name: "Synthetic Commander B",
    role: "BASE_COMMANDER",
    base_id: ids.baseB,
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
]);

const purchases = [
  {
    id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    quantity: 4,
    status: "PENDING",
    purchased_at: "2026-11-20T10:00:00.000Z",
    completed_at: null,
    created_at: "2026-11-19T10:00:00.000Z",
  },
  {
    id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    quantity: 7,
    status: "COMPLETED",
    purchased_at: "2026-11-21T10:00:00.000Z",
    completed_at: "2026-11-21T11:00:00.000Z",
    created_at: "2026-11-20T10:00:00.000Z",
  },
  {
    id: randomUUID(),
    base_id: ids.baseB,
    equipment_type_id: ids.equipmentType,
    quantity: 9,
    status: "PENDING",
    purchased_at: "2026-11-22T10:00:00.000Z",
    completed_at: null,
    created_at: "2026-11-21T10:00:00.000Z",
  },
];

const transfers = [
  {
    id: randomUUID(),
    source_base_id: ids.baseA,
    destination_base_id: ids.baseB,
    equipment_type_id: ids.equipmentType,
    quantity: 2,
    status: "COMPLETED",
    created_at: "2026-11-20T10:00:00.000Z",
    approved_at: "2026-11-20T11:00:00.000Z",
    completed_at: "2026-11-20T12:00:00.000Z",
    rejected_at: null,
  },
  {
    id: randomUUID(),
    source_base_id: ids.baseB,
    destination_base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    quantity: 4,
    status: "APPROVED",
    created_at: "2026-11-21T10:00:00.000Z",
    approved_at: "2026-11-21T11:00:00.000Z",
    completed_at: null,
    rejected_at: null,
  },
  {
    id: randomUUID(),
    source_base_id: ids.baseA,
    destination_base_id: ids.baseC,
    equipment_type_id: ids.equipmentType,
    quantity: 5,
    status: "PENDING",
    created_at: "2026-11-22T10:00:00.000Z",
    approved_at: null,
    completed_at: null,
    rejected_at: null,
  },
  {
    id: randomUUID(),
    source_base_id: ids.baseB,
    destination_base_id: ids.baseC,
    equipment_type_id: ids.equipmentType,
    quantity: 8,
    status: "COMPLETED",
    created_at: "2026-11-23T10:00:00.000Z",
    approved_at: "2026-11-23T11:00:00.000Z",
    completed_at: "2026-11-23T12:00:00.000Z",
    rejected_at: null,
  },
];

const assignments = [
  {
    id: randomUUID(),
    asset_id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    status: "ACTIVE",
    created_at: "2026-11-20T10:00:00.000Z",
    assigned_at: "2026-11-20T10:00:00.000Z",
    gross_assigned: 10,
    cumulative_returned: 5,
  },
  {
    id: randomUUID(),
    asset_id: randomUUID(),
    base_id: ids.baseB,
    equipment_type_id: ids.equipmentType,
    status: "ACTIVE",
    created_at: "2026-11-21T10:00:00.000Z",
    assigned_at: "2026-11-21T10:00:00.000Z",
    gross_assigned: 2,
    cumulative_returned: 0,
  },
];

const movements = [
  movement("PURCHASE", "IN", ids.baseA, 7, { purchase_id: purchases[1].id }),
  movement("TRANSFER_OUT", "OUT", ids.baseA, 2, { transfer_id: transfers[0].id }),
  movement("TRANSFER_IN", "IN", ids.baseB, 2, { transfer_id: transfers[0].id }),
  movement("ASSIGNMENT", "OUT", ids.baseA, 10, {
    assignment_id: assignments[0].id,
  }),
  movement("RETURN", "IN", ids.baseA, 3, {
    assignment_id: assignments[0].id,
    return_operation_id: randomUUID(),
  }),
  movement("RETURN", "IN", ids.baseA, 2, {
    assignment_id: assignments[0].id,
    return_operation_id: randomUUID(),
  }),
  movement("EXPENDITURE", "OUT", ids.baseA, 1, {
    expenditure_id: randomUUID(),
  }),
  movement("ASSIGNMENT", "OUT", ids.baseB, 2, {
    assignment_id: assignments[1].id,
  }),
];

function movement(movementType, direction, baseId, quantity, references = {}) {
  return {
    id: randomUUID(),
    asset_id: randomUUID(),
    base_id: baseId,
    equipment_type_id: ids.equipmentType,
    movement_type: movementType,
    direction,
    quantity,
    occurred_at: "2026-11-22T10:00:00.000Z",
    purchase_id: null,
    transfer_id: null,
    assignment_id: null,
    expenditure_id: null,
    return_operation_id: null,
    ...references,
  };
}

const dashboardInventory = [
  {
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    opening_balance: "20",
    purchases: "7",
    transfers_in: "0",
    transfers_out: "2",
    assigned_out: "10",
    returned: "5",
    expended: "1",
  },
  {
    base_id: ids.baseB,
    equipment_type_id: ids.equipmentType,
    opening_balance: "100",
    purchases: "0",
    transfers_in: "2",
    transfers_out: "0",
    assigned_out: "2",
    returned: "0",
    expended: "0",
  },
];

const periodAssets = [
  {
    id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    opening_balance: 20,
    opening_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: randomUUID(),
    base_id: ids.baseB,
    equipment_type_id: ids.equipmentType,
    opening_balance: 100,
    opening_at: "2026-01-01T00:00:00.000Z",
  },
];

const periodMovements = [
  periodMovement(periodAssets[0], "PURCHASE", 7, "2026-11-21T10:00:00.000Z", {
    purchase_status: "COMPLETED",
  }),
  periodMovement(periodAssets[0], "TRANSFER_OUT", 2, "2026-11-20T10:00:00.000Z", {
    transfer_status: "COMPLETED",
  }),
  periodMovement(periodAssets[1], "TRANSFER_IN", 2, "2026-11-20T10:00:00.000Z", {
    transfer_status: "COMPLETED",
  }),
  periodMovement(periodAssets[0], "ASSIGNMENT", 10, "2026-11-21T10:00:00.000Z"),
  periodMovement(periodAssets[0], "RETURN", 3, "2026-11-22T10:00:00.000Z"),
  periodMovement(periodAssets[0], "RETURN", 2, "2026-11-23T10:00:00.000Z"),
  periodMovement(periodAssets[0], "EXPENDITURE", 1, "2026-11-22T10:00:00.000Z"),
  periodMovement(periodAssets[1], "ASSIGNMENT", 2, "2026-11-21T10:00:00.000Z"),
  periodMovement(periodAssets[0], "PURCHASE", 4, "2026-11-19T10:00:00.000Z", {
    purchase_status: "PENDING",
  }),
  periodMovement(periodAssets[0], "TRANSFER_IN", 4, "2026-11-19T10:00:00.000Z", {
    transfer_status: "APPROVED",
  }),
];

function periodMovement(asset, movement_type, quantity, occurred_at, extra = {}) {
  return {
    asset_id: asset.id,
    movement_type,
    quantity,
    occurred_at,
    purchase_status: null,
    transfer_status: null,
    ...extra,
  };
}

function filterByBase(rows, baseId, transfer = false) {
  if (!baseId) return rows;
  return rows.filter((row) =>
    transfer
      ? row.source_base_id === baseId || row.destination_base_id === baseId
      : row.base_id === baseId,
  );
}

function filterMovementType(rows, sql, values) {
  if (sql.includes("movement.movement_type = 'RETURN'")) {
    return rows.filter((row) => row.movement_type === "RETURN");
  }
  if (sql.includes("movement.movement_type = 'EXPENDITURE'")) {
    return rows.filter((row) => row.movement_type === "EXPENDITURE");
  }
  const parameterizedType = sql.match(
    /movement\.movement_type = \$(\d+)/u,
  );
  if (parameterizedType) {
    return rows.filter(
      (row) => row.movement_type === values[Number(parameterizedType[1]) - 1],
    );
  }
  return rows;
}

function scopeBase(values) {
  return values.find((value) => value === ids.baseA || value === ids.baseB) ?? null;
}

function page(rows, values) {
  const limit = values.at(-2);
  const offset = values.at(-1);
  if (!Number.isInteger(limit) || !Number.isInteger(offset)) return rows;
  return rows.slice(offset, offset + limit);
}

function inventorySummary(values, empty, source) {
  const baseId = values[0];
  const equipmentTypeId = values[1];
  const from = values[2] ? Date.parse(values[2]) : null;
  const to = values[3] ? Date.parse(values[3]) : Date.now();
  if (empty) {
    return {
      asset_count: 0,
      opening_balance: 0,
      opening_balance_introduced: 0,
      before_purchases: 0,
      before_transfers_in: 0,
      before_transfers_out: 0,
      before_assigned: 0,
      before_returned: 0,
      before_expended: 0,
      purchases: 0,
      transfers_in: 0,
      transfers_out: 0,
      assigned: 0,
      returned: 0,
      expended: 0,
    };
  }
  const assetRows = source.assets
    .filter((asset) =>
      (!baseId || asset.base_id === baseId) &&
      (!equipmentTypeId || asset.equipment_type_id === equipmentTypeId),
    )
    .map((asset) => {
      const openingAt = Date.parse(asset.opening_at);
      const openingBalance = from === null
        ? (openingAt <= to ? asset.opening_balance : 0)
        : (openingAt < from ? asset.opening_balance : 0);
      const openingBalanceIntroduced =
        from !== null && openingAt >= from && openingAt <= to
          ? asset.opening_balance
          : 0;
      const totals = {
        before_purchases: 0,
        before_transfers_in: 0,
        before_transfers_out: 0,
        before_assigned: 0,
        before_returned: 0,
        before_expended: 0,
        purchases: 0,
        transfers_in: 0,
        transfers_out: 0,
        assigned: 0,
        returned: 0,
        expended: 0,
      };
      for (const movement of source.movements) {
        const occurredAt = Date.parse(movement.occurred_at);
        if (movement.asset_id !== asset.id || occurredAt > to) continue;
        if (
          (movement.movement_type === "PURCHASE" &&
            movement.purchase_status !== "COMPLETED") ||
          (movement.movement_type.startsWith("TRANSFER_") &&
            movement.transfer_status !== "COMPLETED")
        ) {
          continue;
        }
        const beforePeriod = from !== null && occurredAt < from;
        const prefix = beforePeriod ? "before_" : "";
        const field = {
          PURCHASE: "purchases",
          TRANSFER_IN: "transfers_in",
          TRANSFER_OUT: "transfers_out",
          ASSIGNMENT: "assigned",
          RETURN: "returned",
          EXPENDITURE: "expended",
        }[movement.movement_type];
        totals[`${prefix}${field}`] += movement.quantity;
      }
      return {
        asset_count: 1,
        opening_balance: openingBalance,
        opening_balance_introduced: openingBalanceIntroduced,
        ...totals,
      };
    });
  return Object.fromEntries(
    Object.keys(assetRows[0] ?? {
      asset_count: 0,
      opening_balance: 0,
      opening_balance_introduced: 0,
      before_purchases: 0,
      before_transfers_in: 0,
      before_transfers_out: 0,
      before_assigned: 0,
      before_returned: 0,
      before_expended: 0,
      purchases: 0,
      transfers_in: 0,
      transfers_out: 0,
      assigned: 0,
      returned: 0,
      expended: 0,
    }).map((key) => [
      key,
      assetRows.reduce((sum, row) => sum + Number(row[key]), 0),
    ]),
  );
}

function createDataSource() {
  const calls = [];
  let empty = false;
  let periodData = { assets: periodAssets, movements: periodMovements };
  return {
    calls,
    setEmpty(value) {
      empty = value;
    },
    setPeriodData(value) {
      periodData = value;
    },
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("FROM public.app_user")) {
        const user = users.get(values[0]);
        return user ? [user] : [];
      }
      if (sql.includes("SELECT id AS base_id FROM public.base")) {
        return [ids.baseA, ids.baseB, ids.baseC].includes(values[0])
          ? [{ base_id: values[0] }]
          : [];
      }
      if (sql.includes("FROM inventory_rows")) {
        const rows = empty
          ? []
          : filterByBase(dashboardInventory, values[0]);
        return rows;
      }
      if (
        sql.includes("FROM public.purchase") &&
        sql.includes("pending_count")
      ) {
        const rows = empty ? [] : filterByBase(purchases, values[0]);
        return [{
          pending_count: rows.filter((row) => row.status === "PENDING").length,
          pending_quantity: rows
            .filter((row) => row.status === "PENDING")
            .reduce((sum, row) => sum + row.quantity, 0),
        }];
      }
      if (
        sql.includes("FROM public.transfer") &&
        sql.includes("GROUP BY status")
      ) {
        const rows = empty
          ? []
          : filterByBase(transfers, values[0], true);
        return [...new Set(rows.map((row) => row.status))].map((status) => {
          const matching = rows.filter((row) => row.status === status);
          return {
            status,
            count: matching.length,
            quantity: matching.reduce((sum, row) => sum + row.quantity, 0),
          };
        });
      }
      if (sql.includes("WITH asset_scope AS")) {
        return [inventorySummary(values, empty, periodData)];
      }
      if (sql.includes("FROM public.purchase purchase")) {
        const rows = empty ? [] : filterByBase(purchases, scopeBase(values));
        if (sql.includes("pending_count")) {
          const pending = rows.filter((row) => row.status === "PENDING");
          return [{
            pending_count: pending.length,
            pending_quantity: pending.reduce((sum, row) => sum + row.quantity, 0),
          }];
        }
        if (sql.includes("COUNT(*) AS total")) {
          return [{ total: rows.length }];
        }
        return page(rows, values);
      }
      if (sql.includes("FROM public.transfer transfer")) {
        const rows = empty
          ? []
          : filterByBase(transfers, scopeBase(values), true);
        if (sql.includes("COUNT(*) AS total")) {
          return [{ total: rows.length }];
        }
        if (sql.includes("GROUP BY transfer.status")) {
          return [...new Set(rows.map((row) => row.status))].map((status) => {
            const matching = rows.filter((row) => row.status === status);
            return {
              status,
              count: matching.length,
              quantity: matching.reduce((sum, row) => sum + row.quantity, 0),
            };
          });
        }
        return page(rows, values);
      }
      if (sql.includes("WITH assignment_totals AS")) {
        const rows = empty ? [] : filterByBase(assignments, scopeBase(values));
        if (sql.includes("assignment_count")) {
          return [{
            assignment_count: rows.length,
            gross_assigned: rows.reduce(
              (sum, row) => sum + row.gross_assigned,
              0,
            ),
            cumulative_returned: rows.reduce(
              (sum, row) => sum + row.cumulative_returned,
              0,
            ),
          }];
        }
        return page(rows, values);
      }
      if (sql.includes("FROM public.assignment assignment")) {
        const rows = empty ? [] : filterByBase(assignments, scopeBase(values));
        return [{ total: rows.length }];
      }
      if (sql.includes("FROM public.inventory_movement movement")) {
        const rows = empty
          ? []
          : filterMovementType(
            filterByBase(movements, scopeBase(values)),
            sql,
            values,
          );
        if (sql.includes("return_count")) {
          return [{
            return_count: rows.length,
            returned_quantity: rows.reduce((sum, row) => sum + row.quantity, 0),
          }];
        }
        if (sql.includes("expenditure_count")) {
          return [{
            expenditure_count: rows.length,
            expenditure_quantity: rows.reduce(
              (sum, row) => sum + row.quantity,
              0,
            ),
          }];
        }
        if (sql.includes("COUNT(*) AS total")) {
          return [{ total: rows.length }];
        }
        return page(rows, values);
      }
      throw new Error(`Unexpected reporting test query: ${sql}`);
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
  return fetch(`${serverUrl}${path}`, {
    method: "GET",
    headers: userId
      ? { authorization: `Bearer ${tokens.get(userId)}` }
      : {},
  });
}

before(async () => {
  dataSource = createDataSource();
  for (const userId of users.keys()) {
    tokens.set(userId, await makeToken(userId));
  }
  const app = express();
  app.use("/api/dashboard", createDashboardRouter({
    dataSource,
    jwtConfiguration,
  }));
  app.use("/api/reports", createReportRouter({
    dataSource,
    jwtConfiguration,
  }));
  app.use("/api/bases", createBaseRouter({
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
  dataSource.setEmpty(false);
  dataSource.setPeriodData({ assets: periodAssets, movements: periodMovements });
});

test("dashboard roles use current database scope and reject cross-base access", async () => {
  const global = await request("/api/dashboard", ids.admin);
  assert.equal(global.status, 200);
  const globalBody = await global.json();
  assert.equal(globalBody.data.dashboard.inventory.availableQuantity, 119);
  const inventoryQuery = dataSource.calls.find(({ sql }) =>
    sql.includes("WITH movement_totals AS"),
  );
  assert.ok(inventoryQuery);
  assert.match(inventoryQuery.sql, /movement\.occurred_at <= now\(\)/);
  assert.match(inventoryQuery.sql, /asset\.opening_at <= now\(\)/);
  assert.equal((await request("/api/dashboard", ids.logisticsA)).status, 403);

  for (const [userId, baseId, expectedAvailable] of [
    [ids.commanderA, ids.baseA, 19],
    [ids.logisticsA, ids.baseA, 19],
    [ids.commanderB, ids.baseB, 100],
  ]) {
    const ownBase = await request(`/api/bases/${baseId}/dashboard`, userId);
    assert.equal(ownBase.status, 200);
    const body = await ownBase.json();
    assert.equal(
      body.data.dashboard.inventory.availableQuantity,
      expectedAvailable,
    );
    assert.equal(
      body.data.dashboard.pendingPurchases.quantity,
      baseId === ids.baseA ? 4 : 9,
    );
  }
  assert.equal(
    (await request(`/api/bases/${ids.baseB}/dashboard`, ids.logisticsA)).status,
    403,
  );
  assert.equal(
    (await request(`/api/bases/${ids.baseB}/dashboard`, ids.admin)).status,
    200,
  );
  assert.equal(
    (await request("/api/dashboard?baseId=" + ids.baseB, ids.admin)).status,
    400,
  );
});

test("purchases separate pending metrics and enforce base isolation", async () => {
  const own = await request("/api/reports/purchases", ids.logisticsA);
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.equal(body.data.purchases.length, 2);
  assert.deepEqual(body.data.pending, { count: 1, quantity: 4 });
  assert.equal(body.data.purchases.every((row) => row.baseId === ids.baseA), true);
  assert.equal(
    (await request(`/api/reports/purchases?baseId=${ids.baseB}`, ids.logisticsA))
      .status,
    400,
  );
  assert.equal(
    (await request(`/api/reports/purchases?baseId=${ids.baseB}`, ids.admin))
      .status,
    200,
  );
});

test("transfer reports include source and destination bases without unrelated transfers", async () => {
  for (const [userId, ownBase] of [
    [ids.commanderA, ids.baseA],
    [ids.commanderB, ids.baseB],
    [ids.logisticsA, ids.baseA],
    [ids.logisticsB, ids.baseB],
  ]) {
    const response = await request("/api/reports/transfers", userId);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.data.transfers.some((row) => row.id === transfers[0].id),
      true,
    );
    assert.equal(
      body.data.transfers.some((row) => row.id === transfers[3].id),
      ownBase === ids.baseB,
    );
    assert.equal(
      body.data.transfers.some(
        (row) =>
          row.sourceBaseId !== ownBase && row.destinationBaseId !== ownBase,
      ),
      false,
    );
    assert.deepEqual(body.data.byStatus.PENDING, {
      count: ownBase === ids.baseA ? 1 : 0,
      quantity: ownBase === ids.baseA ? 5 : 0,
    });
  }

  const transferCalls = dataSource.calls.filter(({ sql }) =>
    sql.includes("FROM public.transfer transfer"),
  );
  assert.ok(transferCalls.length > 0);
  assert.equal(
    transferCalls.every(({ sql }) =>
      sql.includes("source_base_id = $1::uuid OR transfer.destination_base_id = $1::uuid"),
    ),
    true,
  );
});

test("inventory movements include completed ledger entries, not pending or approved operations", async () => {
  const own = await request("/api/reports/inventory-movements", ids.logisticsA);
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.equal(body.data.summary.closingBalance, 19);
  assert.equal(body.data.summary.netAssigned, 5);
  assert.equal(body.data.movements.some((row) => row.movementType === "PURCHASE"), true);
  assert.equal(
    body.data.movements.some(
      (row) =>
        row.transferId === transfers[1].id ||
        row.transferId === transfers[2].id,
    ),
    false,
  );
  assert.equal(body.data.movements.every((row) => row.baseId === ids.baseA), true);

  const destination = await request(
    "/api/reports/inventory-movements",
    ids.logisticsB,
  );
  assert.equal(destination.status, 200);
  const destinationBody = await destination.json();
  assert.equal(
    destinationBody.data.movements.some(
      (row) =>
        row.transferId === transfers[0].id && row.direction === "IN",
    ),
    true,
  );
  assert.equal(
    destinationBody.data.movements.some((row) => row.baseId === ids.baseA),
    false,
  );
});

test("inventory movement type filters only the paged ledger rows with validated parameters", async () => {
  const response = await request(
    "/api/reports/inventory-movements?movementType=RETURN",
    ids.logisticsA,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.summary.closingBalance, 19);
  assert.equal(
    body.data.movements.every((row) => row.movementType === "RETURN"),
    true,
  );
  const count = dataSource.calls.find(({ sql }) =>
    sql.includes("COUNT(*) AS total") &&
    sql.includes("FROM public.inventory_movement movement"),
  );
  const list = dataSource.calls.find(({ sql }) =>
    sql.includes("SELECT movement.id, movement.asset_id"),
  );
  assert.ok(count);
  assert.ok(list);
  assert.match(count.sql, /movement\.movement_type = \$2/u);
  assert.deepEqual(count.values, [ids.baseA, "RETURN"]);
  assert.deepEqual(count.values, list.values.slice(0, -2));

  assert.equal(
    (
      await request(
        "/api/reports/inventory-movements?movementType=UNKNOWN",
        ids.logisticsA,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/reports/purchases?movementType=RETURN",
        ids.logisticsA,
      )
    ).status,
    400,
  );
});

test("report UUID filters reject malformed values before querying", async () => {
  for (const path of [
    "/api/reports/inventory-movements?baseId=not-a-uuid",
    "/api/reports/inventory-movements?equipmentTypeId=not-a-uuid",
    "/api/reports/purchases?baseId=not-a-uuid",
  ]) {
    const callsBefore = dataSource.calls.length;
    const response = await request(path, ids.admin);
    assert.equal(response.status, 400, path);
    assert.equal(dataSource.calls.length, callsBefore + 1);
    assert.equal(
      dataSource.calls.at(-1).sql.includes("FROM public.app_user"),
      true,
    );
  }
});

test("period openings handle before, start, inside, end, and after boundaries across assets", async () => {
  const assets = [
    {
      id: randomUUID(),
      base_id: ids.baseA,
      equipment_type_id: randomUUID(),
      opening_balance: 10,
      opening_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: randomUUID(),
      base_id: ids.baseA,
      equipment_type_id: randomUUID(),
      opening_balance: 20,
      opening_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: randomUUID(),
      base_id: ids.baseA,
      equipment_type_id: randomUUID(),
      opening_balance: 30,
      opening_at: "2026-01-03T00:00:00.000Z",
    },
    {
      id: randomUUID(),
      base_id: ids.baseB,
      equipment_type_id: randomUUID(),
      opening_balance: 40,
      opening_at: "2026-01-04T00:00:00.000Z",
    },
    {
      id: randomUUID(),
      base_id: ids.baseB,
      equipment_type_id: randomUUID(),
      opening_balance: 50,
      opening_at: "2026-01-05T00:00:00.000Z",
    },
  ];
  dataSource.setPeriodData({ assets, movements: [] });
  const response = await request(
    "/api/reports/inventory-movements?from=2026-01-02T00%3A00%3A00Z&to=2026-01-04T00%3A00%3A00Z",
    ids.admin,
  );
  assert.equal(response.status, 200);
  const { summary } = (await response.json()).data;
  assert.equal(summary.assetPositionCount, 5);
  assert.equal(summary.openingBalance, 10);
  assert.equal(summary.openingBalanceIntroduced, 90);
  assert.equal(summary.purchases, 0);
  assert.equal(summary.closingBalance, 100);
});

test("empty periods preserve prior stock and exclude assets initialized after the period", async () => {
  const asset = {
    id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    opening_balance: 25,
    opening_at: "2026-01-01T00:00:00.000Z",
  };
  dataSource.setPeriodData({ assets: [asset], movements: [] });
  const emptyPeriod = await request(
    "/api/reports/inventory-movements?from=2026-02-01T00%3A00%3A00Z&to=2026-02-02T00%3A00%3A00Z",
    ids.admin,
  );
  assert.equal(emptyPeriod.status, 200);
  const emptySummary = (await emptyPeriod.json()).data.summary;
  assert.equal(emptySummary.openingBalance, 25);
  assert.equal(emptySummary.openingBalanceIntroduced, 0);
  assert.equal(emptySummary.closingBalance, 25);

  asset.opening_at = "2026-02-03T00:00:00.000Z";
  const beforeInitialization = await request(
    "/api/reports/inventory-movements?from=2026-02-01T00%3A00%3A00Z&to=2026-02-02T00%3A00%3A00Z",
    ids.admin,
  );
  assert.equal(beforeInitialization.status, 200);
  const beforeSummary = (await beforeInitialization.json()).data.summary;
  assert.equal(beforeSummary.openingBalance, 0);
  assert.equal(beforeSummary.openingBalanceIntroduced, 0);
  assert.equal(beforeSummary.closingBalance, 0);
});

test("returns from earlier assignments are valid period movements and outside returns remain in opening balance", async () => {
  const asset = {
    id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    opening_balance: 20,
    opening_at: "2026-01-01T00:00:00.000Z",
  };
  dataSource.setPeriodData({
    assets: [asset],
    movements: [
      periodMovement(asset, "ASSIGNMENT", 10, "2026-01-02T00:00:00.000Z"),
      periodMovement(asset, "RETURN", 3, "2026-01-03T00:00:00.000Z"),
      periodMovement(asset, "RETURN", 5, "2026-01-06T00:00:00.000Z"),
    ],
  });
  const response = await request(
    "/api/reports/inventory-movements?from=2026-01-05T00%3A00%3A00Z&to=2026-01-07T00%3A00%3A00Z",
    ids.admin,
  );
  assert.equal(response.status, 200);
  const { summary } = (await response.json()).data;
  assert.equal(summary.openingBalance, 13);
  assert.equal(summary.grossAssigned, 0);
  assert.equal(summary.returned, 5);
  assert.equal(summary.netAssigned, -5);
  assert.equal(summary.closingBalance, 18);
});

test("period inventory reconciles opening, completed movements, net assignment, returns, and expenditure", async () => {
  const asset = {
    id: randomUUID(),
    base_id: ids.baseA,
    equipment_type_id: ids.equipmentType,
    opening_balance: 20,
    opening_at: "2026-01-01T00:00:00.000Z",
  };
  dataSource.setPeriodData({
    assets: [asset],
    movements: [
      periodMovement(asset, "ASSIGNMENT", 10, "2026-01-02T00:00:00.000Z"),
      periodMovement(asset, "RETURN", 3, "2026-01-03T00:00:00.000Z"),
      periodMovement(asset, "PURCHASE", 5, "2026-01-05T00:00:00.000Z", {
        purchase_status: "COMPLETED",
      }),
      periodMovement(asset, "TRANSFER_IN", 4, "2026-01-06T00:00:00.000Z", {
        transfer_status: "COMPLETED",
      }),
      periodMovement(asset, "TRANSFER_OUT", 2, "2026-01-06T12:00:00.000Z", {
        transfer_status: "COMPLETED",
      }),
      periodMovement(asset, "ASSIGNMENT", 6, "2026-01-07T00:00:00.000Z"),
      periodMovement(asset, "RETURN", 2, "2026-01-08T00:00:00.000Z"),
      periodMovement(asset, "EXPENDITURE", 3, "2026-01-09T00:00:00.000Z"),
    ],
  });
  const response = await request(
    "/api/reports/inventory-movements?from=2026-01-05T00%3A00%3A00Z&to=2026-01-09T00%3A00%3A00Z",
    ids.admin,
  );
  assert.equal(response.status, 200);
  const { summary } = (await response.json()).data;
  assert.equal(summary.openingBalance, 13);
  assert.equal(summary.openingBalanceIntroduced, 0);
  assert.equal(summary.netMovement, 7);
  assert.equal(summary.grossAssigned, 6);
  assert.equal(summary.returned, 2);
  assert.equal(summary.netAssigned, 4);
  assert.equal(summary.expenditureQuantity, 3);
  assert.equal(
    summary.closingBalance,
    summary.openingBalance +
      summary.openingBalanceIntroduced +
      summary.netMovement -
      summary.netAssigned -
      summary.expenditureQuantity,
  );
  assert.equal(summary.closingBalance, 13);
});

test("assignment reports distinguish gross, cumulative returns, and net assigned", async () => {
  const from = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
  const to = encodeURIComponent(new Date().toISOString());
  const response = await request(
    `/api/reports/assignments?from=${from}&to=${to}`,
    ids.logisticsA,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    {
      gross: body.data.summary.grossAssigned,
      returned: body.data.summary.cumulativeReturned,
      net: body.data.summary.netAssigned,
    },
    { gross: 10, returned: 5, net: 5 },
  );
  assert.deepEqual(
    {
      gross: body.data.assignments[0].grossAssigned,
      returned: body.data.assignments[0].cumulativeReturned,
      net: body.data.assignments[0].netAssigned,
    },
    { gross: 10, returned: 5, net: 5 },
  );
  const assignmentPageQuery = dataSource.calls.find(({ sql }) =>
    sql.includes("WITH assignment_totals AS"),
  );
  assert.ok(assignmentPageQuery);
  assert.match(assignmentPageQuery.sql, /GROUP BY assignment_id/u);
  assert.match(assignmentPageQuery.sql, /LEFT JOIN assignment_totals/u);
  assert.match(
    assignmentPageQuery.sql,
    /assignment\.assigned_at >= \$\d+::timestamptz/u,
  );
  assert.match(
    assignmentPageQuery.sql,
    /assignment\.assigned_at <= \$\d+::timestamptz/u,
  );
  assert.match(
    assignmentPageQuery.sql,
    /ORDER BY assignment\.assigned_at DESC, assignment\.id DESC/u,
  );
  assert.doesNotMatch(
    assignmentPageQuery.sql,
    /assignment\.created_at\s*[<>]=|ORDER BY assignment\.created_at/u,
  );
});

test("returns and expenditures report quantities without financial fields", async () => {
  const returns = await request("/api/reports/returns", ids.logisticsA);
  assert.equal(returns.status, 200);
  const returnBody = await returns.json();
  assert.deepEqual(returnBody.data.summary, { count: 2, quantity: 5 });
  assert.equal(returnBody.data.returns.length, 2);

  const expenditures = await request("/api/reports/expenditures", ids.logisticsA);
  assert.equal(expenditures.status, 200);
  const expenditureBody = await expenditures.json();
  assert.deepEqual(expenditureBody.data.summary, { count: 1, quantity: 1 });
  assert.equal(
    JSON.stringify(expenditureBody).match(/cost|amount|price|totalValue/iu),
    null,
  );
});

test("report DTOs expose only approved fields", async () => {
  const expectations = [
    ["/api/reports/purchases", "purchases", [
      "id", "baseId", "equipmentTypeId", "quantity", "status",
      "purchasedAt", "completedAt", "createdAt",
    ]],
    ["/api/reports/transfers", "transfers", [
      "id", "sourceBaseId", "destinationBaseId", "equipmentTypeId",
      "quantity", "status", "createdAt", "approvedAt", "completedAt",
      "rejectedAt",
    ]],
    ["/api/reports/assignments", "assignments", [
      "id", "assetId", "baseId", "equipmentTypeId", "status", "createdAt",
      "assignedAt", "grossAssigned", "cumulativeReturned", "netAssigned",
    ]],
    ["/api/reports/returns", "returns", [
      "movementId", "returnOperationId", "assignmentId", "assetId", "baseId",
      "equipmentTypeId", "quantity", "returnedAt",
    ]],
    ["/api/reports/expenditures", "expenditures", [
      "movementId", "expenditureId", "assetId", "baseId",
      "equipmentTypeId", "quantity", "expendedAt",
    ]],
    ["/api/reports/inventory-movements", "movements", [
      "id", "assetId", "baseId", "equipmentTypeId", "movementType",
      "direction", "quantity", "occurredAt", "purchaseId", "transferId",
      "assignmentId", "expenditureId", "returnOperationId",
    ]],
  ];
  for (const [path, collection, expectedKeys] of expectations) {
    const response = await request(path, ids.admin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      Object.keys(body.data[collection][0]).sort(),
      expectedKeys.sort(),
    );
    assert.doesNotMatch(JSON.stringify(body), /email|password|snapshot|userAgent|ipAddress/iu);
  }
});

test("date filters enforce UTC format, future rejection, and exact 365-day boundaries", async (context) => {
  const now = Date.parse("2026-11-25T12:00:00.000Z");
  context.mock.method(Date, "now", () => now);
  const day = 24 * 60 * 60 * 1000;
  const at = (offset) => new Date(now + offset).toISOString();
  const cases = [
    ["to=" + encodeURIComponent(at(1)), 400],
    ["from=" + encodeURIComponent(at(1)), 400],
    ["to=" + encodeURIComponent(at(-365 * day)), 200],
    ["from=" + encodeURIComponent(at(-365 * day)), 200],
    ["from=" + encodeURIComponent(at(-365 * day - 1)), 400],
    [
      `from=${encodeURIComponent(at(-365 * day))}&to=${encodeURIComponent(at(0))}`,
      200,
    ],
    [
      `from=${encodeURIComponent(at(-365 * day - 1))}&to=${encodeURIComponent(at(0))}`,
      400,
    ],
    [
      `from=${encodeURIComponent(at(-day))}&to=${encodeURIComponent(at(-2 * day))}`,
      400,
    ],
    ["to=2026-02-30T00%3A00%3A00Z", 400],
    ["to=2026-11-25T12%3A00%3A00%2B00%3A00", 400],
    ["to=2026-11-25", 400],
    ["from=2026-11-25T12%3A00%3A00.000Z&to=2026-11-25T12%3A00%3A00Z", 200],
  ];
  for (const [query, expected] of cases) {
    const response = await request(`/api/reports/purchases?${query}`, ids.admin);
    assert.equal(response.status, expected, query);
  }
});

test("pagination defaults to 50, caps at 100, and validates offsets", async () => {
  const response = await request("/api/reports/purchases", ids.admin);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.meta, { limit: 50, offset: 0, total: 3 });
  const listCall = dataSource.calls.find(({ sql }) =>
    sql.includes("SELECT purchase.id"),
  );
  assert.deepEqual(listCall.values.slice(-2), [50, 0]);

  assert.equal(
    (await request("/api/reports/purchases?limit=100&offset=2", ids.admin))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/reports/purchases?limit=101", ids.admin)).status,
    400,
  );
  assert.equal(
    (await request("/api/reports/purchases?offset=-1", ids.admin)).status,
    400,
  );
});

test("empty reports return zero summaries and empty pages", async () => {
  dataSource.setEmpty(true);
  for (const path of [
    "/api/dashboard",
    `/api/bases/${ids.baseA}/dashboard`,
    "/api/reports/inventory-movements",
    "/api/reports/purchases",
    "/api/reports/transfers",
    "/api/reports/assignments",
    "/api/reports/returns",
    "/api/reports/expenditures",
  ]) {
    const userId = path === "/api/dashboard" ? ids.admin : ids.logisticsA;
    const response = await request(path, userId);
    assert.equal(response.status, 200, path);
    const body = await response.json();
    assert.equal(body.success, true);
    if (body.meta) assert.equal(body.meta.total, 0);
  }
});

test("count and page queries use identical predicates and parameterized filters", async () => {
  const from = "2026-11-01T00:00:00Z";
  const to = "2026-11-25T00:00:00Z";
  const response = await request(
    `/api/reports/purchases?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=10`,
    ids.logisticsA,
  );
  assert.equal(response.status, 200);
  const count = dataSource.calls.find(({ sql }) =>
    sql.startsWith("SELECT COUNT(*) AS total FROM public.purchase purchase"),
  );
  const list = dataSource.calls.find(({ sql }) =>
    sql.includes("SELECT purchase.id"),
  );
  assert.ok(count);
  assert.ok(list);
  const whereClause = (sql) =>
    sql.slice(sql.indexOf(" WHERE ") + 7).split(/\s+ORDER BY/u)[0];
  assert.equal(whereClause(count.sql), whereClause(list.sql));
  assert.deepEqual(count.values, list.values.slice(0, -2));
  assert.equal(
    count.sql.includes(ids.baseA) || count.sql.includes(from) || count.sql.includes(to),
    false,
  );
  assert.equal(count.values[0], ids.baseA);
});
