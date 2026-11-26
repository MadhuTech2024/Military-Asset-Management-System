import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { DEMO_USERS } from "../auth/demoUsers.js";
import { calculatePosition } from "./demoData.js";
import {
  DemoServiceError,
  getDemoDataSnapshot,
  handleDemoRequest,
  resetDemoData,
  setDemoPrincipal,
} from "./demoService.js";

const [admin, commander, logistics] = DEMO_USERS;
const baseIds = [
  "00000000-0000-4000-8000-000000000010",
  "00000000-0000-4000-8000-000000000011",
];
const typeId = "00000000-0000-4000-8000-000000000100";

function useUser(user) {
  setDemoPrincipal(user);
}

beforeEach(() => {
  resetDemoData();
});

async function request(method, url, data = {}, params = {}) {
  return handleDemoRequest({ method, url, data, params });
}

async function inventoryPosition(baseId, equipmentTypeId = typeId) {
  const result = await request("get", "/inventory", {}, { limit: 100, baseId });
  return result.data.data.inventory.find(
    (row) => row.baseId === baseId && row.equipmentTypeId === equipmentTypeId,
  );
}

test("demo dataset meets the minimum counts and inventory reconciles", () => {
  const snapshot = getDemoDataSnapshot();
  assert.equal(snapshot.bases.length, 5);
  assert.equal(snapshot.equipmentTypes.length, 12);
  assert.equal(snapshot.personnel.length >= 12, true);
  assert.equal(snapshot.purchases.length >= 8, true);
  assert.equal(snapshot.transfers.length >= 8, true);
  assert.equal(snapshot.assignments.length >= 10, true);
  assert.equal(snapshot.expenditures.length >= 8, true);
  assert.equal(snapshot.auditLogs.length >= 15, true);

  for (const position of snapshot.inventoryPositions) {
    const calculated = calculatePosition(snapshot, position);
    assert.ok(calculated.closingBalance > 0);
    assert.equal(
      calculated.closingBalance,
      position.openingBalance +
        calculated.purchases +
        calculated.transfersIn -
        calculated.transfersOut -
        calculated.assigned -
        calculated.expended,
    );
  }
});

test("base-scoped users cannot expand base, inventory, personnel, or audit visibility", async () => {
  useUser(commander);

  const bases = await request("get", "/bases", {}, { limit: 100 });
  assert.deepEqual(
    bases.data.data.bases.map((base) => base.id),
    [commander.baseId],
  );
  const inventory = await request(
    "get",
    "/inventory",
    {},
    { limit: 100, baseId: baseIds[1] },
  );
  assert.ok(inventory.data.data.inventory.every((row) => row.baseId === commander.baseId));
  const personnel = await request(
    "get",
    "/personnel",
    {},
    { limit: 100, baseId: baseIds[1] },
  );
  assert.ok(personnel.data.data.personnel.every((person) => person.baseId === commander.baseId));
  const audits = await request(
    "get",
    "/audit",
    {},
    { limit: 100, baseId: baseIds[1] },
  );
  assert.ok(audits.data.data.audits.every((entry) => entry.baseId === commander.baseId));
});

test("pending purchases do not change stock and completed purchases add stock", async () => {
  useUser(admin);
  const before = await inventoryPosition(baseIds[0]);
  const purchase = await request("post", "/purchases", {
    baseId: baseIds[0],
    equipmentTypeId: typeId,
    quantity: 5,
    referenceCode: "LOCAL-SYNTHETIC-ORDER",
  });
  const purchaseId = purchase.data.data.purchase.id;
  assert.equal(purchase.data.data.purchase.status, "PENDING");
  assert.equal((await inventoryPosition(baseIds[0])).closingBalance, before.closingBalance);

  await request("post", `/demo/purchases/${purchaseId}/status`, { status: "COMPLETED" });
  assert.equal((await inventoryPosition(baseIds[0])).closingBalance, before.closingBalance + 5);
});

test("transfer stock moves only after destination approval and logistics completion", async () => {
  useUser(admin);
  const sourceBefore = await inventoryPosition(baseIds[1]);
  const destinationBefore = await inventoryPosition(baseIds[0]);
  const result = await request("post", "/transfers", {
    sourceBaseId: baseIds[1],
    destinationBaseId: baseIds[0],
    equipmentTypeId: typeId,
    quantity: 4,
  });
  const transferId = result.data.data.transfer.id;
  assert.equal((await inventoryPosition(baseIds[1])).closingBalance, sourceBefore.closingBalance);

  useUser(commander);
  await request("post", `/transfers/${transferId}/approve`);
  assert.equal((await inventoryPosition(baseIds[0])).closingBalance, destinationBefore.closingBalance);

  useUser(logistics);
  await request("post", `/transfers/${transferId}/complete`);
  useUser(admin);
  assert.equal((await inventoryPosition(baseIds[1])).closingBalance, sourceBefore.closingBalance - 4);
  assert.equal((await inventoryPosition(baseIds[0])).closingBalance, destinationBefore.closingBalance + 4);
});

test("assignments, returns, and expenditures update the same inventory ledger", async () => {
  useUser(commander);
  const before = await inventoryPosition(commander.baseId, "00000000-0000-4000-8000-000000000103");
  const assignment = await request("post", "/assignments", {
    assetId: before.id,
    quantity: 3,
    personnelReference: "SYN-0001",
  });
  const assignmentId = assignment.data.data.assignment.id;
  assert.equal(
    (await inventoryPosition(commander.baseId, before.equipmentTypeId)).closingBalance,
    before.closingBalance - 3,
  );

  await request("post", `/assignments/${assignmentId}/returns`, { quantity: 2 });
  assert.equal(
    (await inventoryPosition(commander.baseId, before.equipmentTypeId)).closingBalance,
    before.closingBalance - 1,
  );
  await request("post", "/expenditures", {
    assetId: before.id,
    quantity: 1,
    reasonCode: "SYNTHETIC-TEST",
    notes: "Local test record",
  });
  assert.equal(
    (await inventoryPosition(commander.baseId, before.equipmentTypeId)).closingBalance,
    before.closingBalance - 2,
  );
});

test("invalid roles and cross-base mutations are rejected", async () => {
  useUser(commander);
  await assert.rejects(
    request("post", "/purchases", {
      baseId: commander.baseId,
      equipmentTypeId: typeId,
      quantity: 1,
    }),
    (error) => error instanceof DemoServiceError && error.status === 403,
  );
  await assert.rejects(
    request("post", "/expenditures", {
      assetId: getDemoDataSnapshot().inventoryPositions.find(
        (position) => position.baseId === baseIds[1],
      ).id,
      quantity: 1,
      reasonCode: "OUT-OF-SCOPE",
    }),
    (error) => error instanceof DemoServiceError && error.status === 403,
  );
});

test("admin reset restores original synthetic records without affecting authentication state", async () => {
  useUser(admin);
  const startingCount = getDemoDataSnapshot().purchases.length;
  await request("post", "/purchases", {
    baseId: baseIds[0],
    equipmentTypeId: typeId,
    quantity: 1,
  });
  assert.equal(getDemoDataSnapshot().purchases.length, startingCount + 1);
  await request("post", "/demo/reset");
  assert.equal(getDemoDataSnapshot().purchases.length, startingCount);
  assert.equal((await request("get", "/bases", {}, { limit: 100 })).data.data.bases.length, 5);
});
