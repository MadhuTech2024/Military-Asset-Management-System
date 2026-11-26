import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { SignJWT } from "jose";
import { DataSource } from "typeorm";
import { createBaseRouter } from "../routes/baseRoutes.js";
import { createDashboardRouter } from "../routes/dashboardRoutes.js";
import { createReportRouter } from "../routes/reportRoutes.js";
import {
  createJwtConfiguration,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from "./jwt.js";
import { InitialKristallballSchema1763938800000 } from "./migrations/1763938800000-InitialKristallballSchema.js";
import { CorrectInventoryIntegrity1763939400000 } from "./migrations/1763939400000-CorrectInventoryIntegrity.js";
import { FixReturnTriggerCasting1763939500000 } from "./migrations/1763939500000-FixReturnTriggerCasting.js";
import { SanitizeAuditSnapshots1763939600000 } from "./migrations/1763939600000-SanitizeAuditSnapshots.js";
import { HardenTriggerSearchPath1795545540000 } from "./migrations/1795545540000-HardenTriggerSearchPath.js";
import { PreventNegativeInventoryBalance1795551900000 } from "./migrations/1795551900000-PreventNegativeInventoryBalance.js";
import { AddBusinessIdempotency1795552000000 } from "./migrations/1795552000000-AddBusinessIdempotency.js";
import { AlignInventoryBalanceTimeSemantics1795601814000 } from "./migrations/1795601814000-AlignInventoryBalanceTimeSemantics.js";
import { SYNTHETIC_JWT_SECRET } from "./testJwtSecret.js";

const isolatedUrl = process.env.KRISTALLBALL_ISOLATED_TEST_DATABASE_URL;
const jwtConfiguration = createJwtConfiguration(SYNTHETIC_JWT_SECRET);

function makeDataSource(url) {
  return new DataSource({
    type: "postgres",
    url,
    ssl: false,
    synchronize: false,
    migrationsRun: false,
    logging: false,
  });
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function makeDates() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 10);
  const to = new Date(today.getTime() - 1);
  const inside = new Date(from.getTime() + 5 * 24 * 60 * 60 * 1000);
  const before = new Date(from.getTime() - 1000);
  const openingBefore = new Date(from.getTime() - 24 * 60 * 60 * 1000);
  const after = new Date(to.getTime() + 1);
  const insideLater = new Date(inside.getTime() + 1000);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    inside: inside.toISOString(),
    before: before.toISOString(),
    openingBefore: openingBefore.toISOString(),
    after: after.toISOString(),
    insideLater: insideLater.toISOString(),
  };
}

async function applyProductionMigrations(queryRunner) {
  for (const migration of [
    new InitialKristallballSchema1763938800000(),
    new CorrectInventoryIntegrity1763939400000(),
    new FixReturnTriggerCasting1763939500000(),
    new SanitizeAuditSnapshots1763939600000(),
    new HardenTriggerSearchPath1795545540000(),
    new PreventNegativeInventoryBalance1795551900000(),
    new AddBusinessIdempotency1795552000000(),
    new AlignInventoryBalanceTimeSemantics1795601814000(),
  ]) {
    await migration.up(queryRunner);
  }
}

async function insertPurchase(dataSource, purchase) {
  await dataSource.query(
    `INSERT INTO public.purchase (
       id, base_id, equipment_type_id, quantity, status, purchased_at,
       created_by, idempotency_key, completed_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      purchase.id,
      purchase.baseId,
      purchase.equipmentTypeId,
      purchase.quantity,
      purchase.status,
      purchase.purchasedAt,
      purchase.createdBy,
      purchase.idempotencyKey,
      purchase.completedAt,
      purchase.createdAt,
    ],
  );
}

async function insertTransfer(dataSource, transfer) {
  await dataSource.query(
    `INSERT INTO public.transfer (
       id, source_base_id, destination_base_id, equipment_type_id, quantity,
       status, idempotency_key, created_by, approved_by, completed_by,
       approved_at, completed_at, rejected_at, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
     )`,
    [
      transfer.id,
      transfer.sourceBaseId,
      transfer.destinationBaseId,
      transfer.equipmentTypeId,
      transfer.quantity,
      transfer.status,
      transfer.idempotencyKey,
      transfer.createdBy,
      transfer.approvedBy,
      transfer.completedBy,
      transfer.approvedAt,
      transfer.completedAt,
      transfer.rejectedAt,
      transfer.createdAt,
    ],
  );
}

async function insertAssignment(dataSource, assignment) {
  await dataSource.query(
    `INSERT INTO public.assignment (
       id, asset_id, base_id, equipment_type_id, quantity,
       personnel_reference, assigned_by, assigned_at, idempotency_key,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      assignment.id,
      assignment.assetId,
      assignment.baseId,
      assignment.equipmentTypeId,
      assignment.quantity,
      assignment.personnelReference,
      assignment.assignedBy,
      assignment.assignedAt,
      assignment.idempotencyKey,
      assignment.createdAt,
    ],
  );
}

async function insertMovement(dataSource, movement) {
  await dataSource.query(
    `INSERT INTO public.inventory_movement (
       id, asset_id, base_id, equipment_type_id, movement_type, quantity,
       direction, occurred_at, idempotency_key, purchase_id, transfer_id,
       assignment_id, expenditure_id, return_operation_id, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
     )`,
    [
      movement.id,
      movement.assetId,
      movement.baseId,
      movement.equipmentTypeId,
      movement.movementType,
      movement.quantity,
      movement.direction,
      movement.occurredAt,
      movement.idempotencyKey,
      movement.purchaseId ?? null,
      movement.transferId ?? null,
      movement.assignmentId ?? null,
      movement.expenditureId ?? null,
      movement.returnOperationId ?? null,
      movement.createdBy,
    ],
  );
}

async function insertReturn(dataSource, returnOperation) {
  await dataSource.query(
    `INSERT INTO public.return_operation (
       id, assignment_id, asset_id, base_id, equipment_type_id, quantity,
       idempotency_key, returned_by, returned_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      returnOperation.id,
      returnOperation.assignmentId,
      returnOperation.assetId,
      returnOperation.baseId,
      returnOperation.equipmentTypeId,
      returnOperation.quantity,
      returnOperation.idempotencyKey,
      returnOperation.returnedBy,
      returnOperation.returnedAt,
    ],
  );
}

async function getBalance(dataSource, assetId) {
  const [row] = await dataSource.query(
    `SELECT CASE
              WHEN asset.opening_at <= now() THEN asset.opening_balance
              ELSE 0
            END
              + COALESCE(
                  SUM(
                    CASE
                      WHEN movement.occurred_at <= now() THEN
                        CASE movement.direction
                          WHEN 'IN' THEN movement.quantity
                          ELSE -movement.quantity
                        END
                      ELSE 0
                    END
                  ),
                  0
                )::integer AS balance
     FROM public.asset asset
     LEFT JOIN public.inventory_movement movement
       ON movement.asset_id = asset.id
     WHERE asset.id = $1
     GROUP BY asset.opening_balance, asset.opening_at`,
    [assetId],
  );
  return Number(row.balance);
}

async function seedReportingFixtures(dataSource) {
  const dates = makeDates();
  const suffix = randomUUID().replaceAll("-", "");
  const ids = {
    bases: {
      a: randomUUID(),
      b: randomUUID(),
      c: randomUUID(),
      d: randomUUID(),
    },
    equipmentType: randomUUID(),
    users: {
      admin: randomUUID(),
      commanderA: randomUUID(),
      commanderB: randomUUID(),
      commanderD: randomUUID(),
      logisticsA: randomUUID(),
      logisticsB: randomUUID(),
      logisticsC: randomUUID(),
      logisticsD: randomUUID(),
    },
    assets: {
      a: randomUUID(),
      b: randomUUID(),
      c: randomUUID(),
      d: randomUUID(),
    },
    purchases: {
      start: randomUUID(),
      end: randomUUID(),
      pendingA: randomUUID(),
      pendingB: randomUUID(),
      pendingOutside: randomUUID(),
    },
    transfers: {
      completedAB: randomUUID(),
      approvedBA: randomUUID(),
      pendingAC: randomUUID(),
      completedCD: randomUUID(),
      rejectedCD: randomUUID(),
      rejectedOutside: randomUUID(),
    },
    assignments: {
      createdInsideAssignedBefore: randomUUID(),
      createdBeforeAssignedTo: randomUUID(),
      createdAfterAssignedFrom: randomUUID(),
    },
    movements: {
      purchaseStart: randomUUID(),
      purchaseEnd: randomUUID(),
      transferOutAB: randomUUID(),
      transferInAB: randomUUID(),
      transferOutCD: randomUUID(),
      transferInCD: randomUUID(),
      assignmentBeforePeriod: randomUUID(),
      assignmentFromBoundary: randomUUID(),
      assignmentToBoundary: randomUUID(),
      expenditure: randomUUID(),
    },
    returns: {
      beforeAssignmentInsidePeriod: randomUUID(),
      beforeAssignmentOutsidePeriod: randomUUID(),
      insideAssignmentOutsidePeriod: randomUUID(),
    },
    expenditure: randomUUID(),
  };

  const baseEntries = [
    ["a", "Synthetic Reporting A"],
    ["b", "Synthetic Reporting B"],
    ["c", "Synthetic Reporting C"],
    ["d", "Synthetic Reporting D"],
  ];
  await dataSource.query(
    `INSERT INTO public.base (id, code, name)
     VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9), ($10, $11, $12)`,
    baseEntries.flatMap(([key, name], index) => [
      ids.bases[key],
      `RPT-${index}-${suffix.slice(index * 4, index * 4 + 8)}`,
      name,
    ]),
  );
  await dataSource.query(
    `INSERT INTO public.equipment_type (id, code, name, category)
     VALUES ($1, $2, $3, 'SYNTHETIC')`,
    [ids.equipmentType, `RPT-EQ-${suffix.slice(0, 8)}`, "Synthetic Report Item"],
  );
  await dataSource.query(
    `INSERT INTO public.app_user (
       id, email, password_hash, full_name, role, base_id
     ) VALUES
       ($1, $2, 'synthetic-only', 'Synthetic Reporting Admin', 'ADMIN', NULL),
       ($3, $4, 'synthetic-only', 'Synthetic Reporting Commander A', 'BASE_COMMANDER', $5),
       ($6, $7, 'synthetic-only', 'Synthetic Reporting Commander B', 'BASE_COMMANDER', $8),
       ($9, $10, 'synthetic-only', 'Synthetic Reporting Commander D', 'BASE_COMMANDER', $11),
       ($12, $13, 'synthetic-only', 'Synthetic Reporting Logistics A', 'LOGISTICS_OFFICER', $14),
       ($15, $16, 'synthetic-only', 'Synthetic Reporting Logistics B', 'LOGISTICS_OFFICER', $17),
       ($18, $19, 'synthetic-only', 'Synthetic Reporting Logistics C', 'LOGISTICS_OFFICER', $20),
       ($21, $22, 'synthetic-only', 'Synthetic Reporting Logistics D', 'LOGISTICS_OFFICER', $23)`,
    [
      ids.users.admin,
      `rpt-admin-${suffix}@example.test`,
      ids.users.commanderA,
      `rpt-commander-a-${suffix}@example.test`,
      ids.bases.a,
      ids.users.commanderB,
      `rpt-commander-b-${suffix}@example.test`,
      ids.bases.b,
      ids.users.commanderD,
      `rpt-commander-d-${suffix}@example.test`,
      ids.bases.d,
      ids.users.logisticsA,
      `rpt-logistics-a-${suffix}@example.test`,
      ids.bases.a,
      ids.users.logisticsB,
      `rpt-logistics-b-${suffix}@example.test`,
      ids.bases.b,
      ids.users.logisticsC,
      `rpt-logistics-c-${suffix}@example.test`,
      ids.bases.c,
      ids.users.logisticsD,
      `rpt-logistics-d-${suffix}@example.test`,
      ids.bases.d,
    ],
  );
  await dataSource.query(
    `INSERT INTO public.asset (
       id, base_id, equipment_type_id, opening_balance, opening_at
     ) VALUES
       ($1, $2, $3, 100, $4),
       ($5, $6, $3, 30, $7),
       ($8, $9, $3, 20, $10),
       ($11, $12, $3, 11, $13)`,
    [
      ids.assets.a,
      ids.bases.a,
      ids.equipmentType,
      dates.openingBefore,
      ids.assets.b,
      ids.bases.b,
      dates.from,
      ids.assets.c,
      ids.bases.c,
      dates.after,
      ids.assets.d,
      ids.bases.d,
      dates.inside,
    ],
  );

  await insertPurchase(dataSource, {
    id: ids.purchases.start,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 5,
    status: "COMPLETED",
    purchasedAt: dates.from,
    createdBy: ids.users.admin,
    idempotencyKey: `report-purchase-start-${suffix}`,
    completedAt: dates.inside,
    createdAt: dates.after,
  });
  await insertPurchase(dataSource, {
    id: ids.purchases.end,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 2,
    status: "COMPLETED",
    purchasedAt: dates.to,
    createdBy: ids.users.admin,
    idempotencyKey: `report-purchase-end-${suffix}`,
    completedAt: dates.to,
    createdAt: dates.after,
  });
  await insertPurchase(dataSource, {
    id: ids.purchases.pendingA,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 8,
    status: "PENDING",
    purchasedAt: dates.inside,
    createdBy: ids.users.logisticsA,
    idempotencyKey: `report-purchase-pending-a-${suffix}`,
    completedAt: null,
    createdAt: dates.after,
  });
  await insertPurchase(dataSource, {
    id: ids.purchases.pendingB,
    baseId: ids.bases.b,
    equipmentTypeId: ids.equipmentType,
    quantity: 6,
    status: "PENDING",
    purchasedAt: dates.inside,
    createdBy: ids.users.logisticsB,
    idempotencyKey: `report-purchase-pending-b-${suffix}`,
    completedAt: null,
    createdAt: dates.after,
  });
  await insertPurchase(dataSource, {
    id: ids.purchases.pendingOutside,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 9,
    status: "PENDING",
    purchasedAt: dates.before,
    createdBy: ids.users.logisticsA,
    idempotencyKey: `report-purchase-outside-${suffix}`,
    completedAt: null,
    createdAt: dates.inside,
  });

  await insertTransfer(dataSource, {
    id: ids.transfers.completedAB,
    sourceBaseId: ids.bases.a,
    destinationBaseId: ids.bases.b,
    equipmentTypeId: ids.equipmentType,
    quantity: 4,
    status: "COMPLETED",
    idempotencyKey: `report-transfer-completed-ab-${suffix}`,
    createdBy: ids.users.logisticsA,
    approvedBy: ids.users.commanderB,
    completedBy: ids.users.logisticsB,
    approvedAt: dates.inside,
    completedAt: dates.inside,
    rejectedAt: null,
    createdAt: dates.from,
  });
  await insertTransfer(dataSource, {
    id: ids.transfers.approvedBA,
    sourceBaseId: ids.bases.b,
    destinationBaseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 2,
    status: "APPROVED",
    idempotencyKey: `report-transfer-approved-ba-${suffix}`,
    createdBy: ids.users.logisticsB,
    approvedBy: ids.users.commanderA,
    completedBy: null,
    approvedAt: dates.inside,
    completedAt: null,
    rejectedAt: null,
    createdAt: dates.inside,
  });
  await insertTransfer(dataSource, {
    id: ids.transfers.pendingAC,
    sourceBaseId: ids.bases.a,
    destinationBaseId: ids.bases.c,
    equipmentTypeId: ids.equipmentType,
    quantity: 3,
    status: "PENDING",
    idempotencyKey: `report-transfer-pending-ac-${suffix}`,
    createdBy: ids.users.logisticsA,
    approvedBy: null,
    completedBy: null,
    approvedAt: null,
    completedAt: null,
    rejectedAt: null,
    createdAt: dates.to,
  });
  await insertTransfer(dataSource, {
    id: ids.transfers.completedCD,
    sourceBaseId: ids.bases.c,
    destinationBaseId: ids.bases.d,
    equipmentTypeId: ids.equipmentType,
    quantity: 5,
    status: "COMPLETED",
    idempotencyKey: `report-transfer-completed-cd-${suffix}`,
    createdBy: ids.users.logisticsC,
    approvedBy: ids.users.commanderD,
    completedBy: ids.users.logisticsD,
    approvedAt: dates.inside,
    completedAt: dates.after,
    rejectedAt: null,
    createdAt: dates.inside,
  });
  await insertTransfer(dataSource, {
    id: ids.transfers.rejectedCD,
    sourceBaseId: ids.bases.c,
    destinationBaseId: ids.bases.d,
    equipmentTypeId: ids.equipmentType,
    quantity: 1,
    status: "REJECTED",
    idempotencyKey: `report-transfer-rejected-cd-${suffix}`,
    createdBy: ids.users.logisticsC,
    approvedBy: null,
    completedBy: null,
    approvedAt: null,
    completedAt: null,
    rejectedAt: dates.inside,
    createdAt: dates.inside,
  });
  await insertTransfer(dataSource, {
    id: ids.transfers.rejectedOutside,
    sourceBaseId: ids.bases.d,
    destinationBaseId: ids.bases.c,
    equipmentTypeId: ids.equipmentType,
    quantity: 5,
    status: "REJECTED",
    idempotencyKey: `report-transfer-outside-${suffix}`,
    createdBy: ids.users.logisticsD,
    approvedBy: null,
    completedBy: null,
    approvedAt: null,
    completedAt: null,
    rejectedAt: dates.after,
    createdAt: dates.after,
  });

  await insertAssignment(dataSource, {
    id: ids.assignments.createdInsideAssignedBefore,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 10,
    personnelReference: `SYNTHETIC-OLD-${suffix.slice(0, 8)}`,
    assignedBy: ids.users.admin,
    assignedAt: dates.before,
    idempotencyKey: `report-assignment-old-${suffix}`,
    createdAt: dates.inside,
  });
  await insertAssignment(dataSource, {
    id: ids.assignments.createdBeforeAssignedTo,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 4,
    personnelReference: `SYNTHETIC-TO-${suffix.slice(0, 8)}`,
    assignedBy: ids.users.admin,
    assignedAt: dates.to,
    idempotencyKey: `report-assignment-to-${suffix}`,
    createdAt: dates.before,
  });
  await insertAssignment(dataSource, {
    id: ids.assignments.createdAfterAssignedFrom,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 1,
    personnelReference: `SYNTHETIC-FROM-${suffix.slice(0, 8)}`,
    assignedBy: ids.users.admin,
    assignedAt: dates.from,
    idempotencyKey: `report-assignment-from-${suffix}`,
    createdAt: dates.insideLater,
  });
  await dataSource.query(
    `INSERT INTO public.expenditure (
       id, asset_id, base_id, equipment_type_id, quantity, reason_code,
       recorded_by, expended_at, idempotency_key
     ) VALUES ($1, $2, $3, $4, 2, 'SYNTHETIC-TEST', $5, $6, $7)`,
    [
      ids.expenditure,
      ids.assets.a,
      ids.bases.a,
      ids.equipmentType,
      ids.users.admin,
      dates.to,
      `report-expenditure-${suffix}`,
    ],
  );

  await insertMovement(dataSource, {
    id: ids.movements.purchaseStart,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "PURCHASE",
    quantity: 5,
    direction: "IN",
    occurredAt: dates.from,
    idempotencyKey: `report-movement-purchase-start-${suffix}`,
    purchaseId: ids.purchases.start,
    createdBy: ids.users.admin,
  });
  await insertMovement(dataSource, {
    id: ids.movements.purchaseEnd,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "PURCHASE",
    quantity: 2,
    direction: "IN",
    occurredAt: dates.to,
    idempotencyKey: `report-movement-purchase-end-${suffix}`,
    purchaseId: ids.purchases.end,
    createdBy: ids.users.admin,
  });
  await insertMovement(dataSource, {
    id: ids.movements.transferOutAB,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "TRANSFER_OUT",
    quantity: 4,
    direction: "OUT",
    occurredAt: dates.inside,
    idempotencyKey: `report-movement-transfer-ab-out-${suffix}`,
    transferId: ids.transfers.completedAB,
    createdBy: ids.users.logisticsB,
  });
  await insertMovement(dataSource, {
    id: ids.movements.transferInAB,
    assetId: ids.assets.b,
    baseId: ids.bases.b,
    equipmentTypeId: ids.equipmentType,
    movementType: "TRANSFER_IN",
    quantity: 4,
    direction: "IN",
    occurredAt: dates.inside,
    idempotencyKey: `report-movement-transfer-ab-in-${suffix}`,
    transferId: ids.transfers.completedAB,
    createdBy: ids.users.logisticsB,
  });
  await insertMovement(dataSource, {
    id: ids.movements.transferOutCD,
    assetId: ids.assets.c,
    baseId: ids.bases.c,
    equipmentTypeId: ids.equipmentType,
    movementType: "TRANSFER_OUT",
    quantity: 5,
    direction: "OUT",
    occurredAt: dates.after,
    idempotencyKey: `report-movement-transfer-cd-out-${suffix}`,
    transferId: ids.transfers.completedCD,
    createdBy: ids.users.logisticsD,
  });
  await insertMovement(dataSource, {
    id: ids.movements.transferInCD,
    assetId: ids.assets.d,
    baseId: ids.bases.d,
    equipmentTypeId: ids.equipmentType,
    movementType: "TRANSFER_IN",
    quantity: 5,
    direction: "IN",
    occurredAt: dates.after,
    idempotencyKey: `report-movement-transfer-cd-in-${suffix}`,
    transferId: ids.transfers.completedCD,
    createdBy: ids.users.logisticsD,
  });
  await insertMovement(dataSource, {
    id: ids.movements.assignmentBeforePeriod,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "ASSIGNMENT",
    quantity: 10,
    direction: "OUT",
    occurredAt: dates.before,
    idempotencyKey: `report-movement-assignment-old-${suffix}`,
    assignmentId: ids.assignments.createdInsideAssignedBefore,
    createdBy: ids.users.admin,
  });
  await insertMovement(dataSource, {
    id: ids.movements.assignmentFromBoundary,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "ASSIGNMENT",
    quantity: 1,
    direction: "OUT",
    occurredAt: dates.from,
    idempotencyKey: `report-movement-assignment-from-${suffix}`,
    assignmentId: ids.assignments.createdAfterAssignedFrom,
    createdBy: ids.users.admin,
  });
  await insertMovement(dataSource, {
    id: ids.movements.assignmentToBoundary,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "ASSIGNMENT",
    quantity: 4,
    direction: "OUT",
    occurredAt: dates.to,
    idempotencyKey: `report-movement-assignment-to-${suffix}`,
    assignmentId: ids.assignments.createdBeforeAssignedTo,
    createdBy: ids.users.admin,
  });
  await insertReturn(dataSource, {
    id: ids.returns.beforeAssignmentInsidePeriod,
    assignmentId: ids.assignments.createdInsideAssignedBefore,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 3,
    idempotencyKey: `report-return-old-inside-${suffix}`,
    returnedBy: ids.users.logisticsA,
    returnedAt: dates.inside,
  });
  await insertReturn(dataSource, {
    id: ids.returns.beforeAssignmentOutsidePeriod,
    assignmentId: ids.assignments.createdInsideAssignedBefore,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 2,
    idempotencyKey: `report-return-old-outside-${suffix}`,
    returnedBy: ids.users.logisticsA,
    returnedAt: dates.after,
  });
  await insertReturn(dataSource, {
    id: ids.returns.insideAssignmentOutsidePeriod,
    assignmentId: ids.assignments.createdBeforeAssignedTo,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    quantity: 1,
    idempotencyKey: `report-return-new-outside-${suffix}`,
    returnedBy: ids.users.logisticsA,
    returnedAt: dates.after,
  });
  await insertMovement(dataSource, {
    id: ids.movements.expenditure,
    assetId: ids.assets.a,
    baseId: ids.bases.a,
    equipmentTypeId: ids.equipmentType,
    movementType: "EXPENDITURE",
    quantity: 2,
    direction: "OUT",
    occurredAt: dates.to,
    idempotencyKey: `report-movement-expenditure-${suffix}`,
    expenditureId: ids.expenditure,
    createdBy: ids.users.admin,
  });

  return { dates, ids };
}

async function signToken(userId) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtConfiguration.key);
}

function queryPath(path, params) {
  const query = new URLSearchParams(params).toString();
  return query ? `${path}?${query}` : path;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test(
  "isolated PostgreSQL executes reporting and dashboard queries against synthetic fixtures",
  { skip: !isolatedUrl },
  async (t) => {
    const clusterUrl = new URL(isolatedUrl);
    if (
      clusterUrl.hostname !== "127.0.0.1" ||
      !clusterUrl.port ||
      clusterUrl.port === "5432" ||
      clusterUrl.pathname !== "/postgres" ||
      clusterUrl.username !== "postgres" ||
      clusterUrl.password ||
      clusterUrl.search ||
      clusterUrl.hash
    ) {
      throw new Error(
        "Reporting integration requires a password-free, non-default loopback URL to the postgres maintenance database.",
      );
    }

    const clusterAdmin = makeDataSource(isolatedUrl);
    let targetAdmin;
    let migrationRunner;
    let targetDatabaseName;
    let databaseCreated = false;
    let server;
    let fixture;
    const tokens = new Map();
    try {
      await clusterAdmin.initialize();
      const [cluster] = await clusterAdmin.query(
        `SELECT current_database() AS database_name,
                current_setting('data_directory') AS data_directory,
                current_setting('server_version_num') AS version_number,
                session_user::text AS login_role`,
      );
      assert.equal(cluster.database_name, "postgres");
      assert.equal(cluster.login_role, "postgres");
      assert.equal(Math.floor(Number(cluster.version_number) / 10000), 18);
      assert.match(
        cluster.data_directory.toLowerCase(),
        /kristallball-step1-pg-/,
        "reporting tests require the dedicated disposable PostgreSQL cluster",
      );

      targetDatabaseName = `step1_reporting_${randomUUID().replaceAll("-", "")}`;
      await clusterAdmin.query(
        `CREATE DATABASE ${quoteIdentifier(targetDatabaseName)} OWNER postgres`,
      );
      databaseCreated = true;
      const marker = randomUUID();
      await clusterAdmin.query(
        `COMMENT ON DATABASE ${quoteIdentifier(targetDatabaseName)}
         IS ${quoteLiteral(`kristallball.identity=${marker}`)}`,
      );

      const targetUrl = new URL(isolatedUrl);
      targetUrl.pathname = `/${targetDatabaseName}`;
      targetAdmin = makeDataSource(targetUrl.toString());
      await targetAdmin.initialize();
      migrationRunner = targetAdmin.createQueryRunner();
      await migrationRunner.connect();
      await applyProductionMigrations(migrationRunner);
      await migrationRunner.release();
      migrationRunner = undefined;

      await t.test(
        "inventory time migration rolls back and reapplies on isolated PostgreSQL",
        async () => {
          const migration =
            new AlignInventoryBalanceTimeSemantics1795601814000();
          const rollbackRunner = targetAdmin.createQueryRunner();
          let migrationReverted = false;
          let probeTransactionActive = false;
          await rollbackRunner.connect();
          const readGuardState = async () => {
            const [functionState] = await rollbackRunner.query(
              `SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition,
                      p.prosecdef,
                      p.proconfig,
                      COALESCE(p.proacl::text, '') AS acl,
                      pg_catalog.pg_get_userbyid(p.proowner) AS owner
               FROM pg_catalog.pg_proc p
               JOIN pg_catalog.pg_namespace namespace
                 ON namespace.oid = p.pronamespace
               WHERE namespace.nspname = 'public'
                 AND p.proname = 'validate_inventory_balance'
                 AND p.pronargs = 0`,
            );
            const [triggerState] = await rollbackRunner.query(
              `SELECT count(*)::integer AS trigger_count
               FROM pg_catalog.pg_trigger
               WHERE tgrelid = 'public.inventory_movement'::regclass
                 AND tgname = 'trg_validate_inventory_balance'
                 AND NOT tgisinternal`,
            );
            return { functionState, triggerState };
          };

          try {
            const beforeRollback = await readGuardState();
            await migration.down(rollbackRunner);
            migrationReverted = true;
            const rolledBack = await readGuardState();
            assert.equal(rolledBack.triggerState.trigger_count, 1);
            assert.equal(rolledBack.functionState.prosecdef, false);
            assert.deepEqual(
              rolledBack.functionState.proconfig,
              beforeRollback.functionState.proconfig,
            );
            assert.equal(
              rolledBack.functionState.acl,
              beforeRollback.functionState.acl,
            );
            assert.equal(
              rolledBack.functionState.owner,
              beforeRollback.functionState.owner,
            );
            assert.match(rolledBack.functionState.definition, /FOR UPDATE/u);
            assert.doesNotMatch(
              rolledBack.functionState.definition,
              /opening_at|occurred_at/u,
            );

            await rollbackRunner.startTransaction();
            probeTransactionActive = true;
            const probeBaseId = randomUUID();
            const probeEquipmentTypeId = randomUUID();
            const probeActorId = randomUUID();
            const probeAssetId = randomUUID();
            const probeExpenditureId = randomUUID();
            const probeMovementKey = `rollback-probe-${randomUUID()}`;
            const [probeTimes] = await rollbackRunner.query(
              `SELECT pg_catalog.clock_timestamp()::text AS event_at,
                      (pg_catalog.clock_timestamp() + interval '1 hour')::text
                        AS opening_at`,
            );
            await rollbackRunner.query(
              `INSERT INTO public.base (id, code, name)
               VALUES ($1, $2, 'Synthetic Rollback Probe Base')`,
              [probeBaseId, `RB-${randomUUID().slice(0, 8)}`],
            );
            await rollbackRunner.query(
              `INSERT INTO public.equipment_type (id, code, name, category)
               VALUES ($1, $2, $3, 'TEST')`,
              [
                probeEquipmentTypeId,
                `RB-EQ-${randomUUID().slice(0, 8)}`,
                `Synthetic Rollback Probe ${randomUUID().slice(0, 8)}`,
              ],
            );
            await rollbackRunner.query(
              `INSERT INTO public.app_user (
                 id, email, password_hash, full_name, role
               ) VALUES ($1, $2, 'synthetic', 'Synthetic Rollback Probe', 'ADMIN')`,
              [probeActorId, `rollback-${randomUUID()}@example.test`],
            );
            await rollbackRunner.query(
              `INSERT INTO public.asset (
                 id, base_id, equipment_type_id, opening_balance, opening_at
               ) VALUES ($1, $2, $3, 5, $4::timestamptz)`,
              [
                probeAssetId,
                probeBaseId,
                probeEquipmentTypeId,
                probeTimes.opening_at,
              ],
            );
            const [beforeOpening] = await rollbackRunner.query(
              `SELECT $1::timestamptz < $2::timestamptz AS value`,
              [probeTimes.event_at, probeTimes.opening_at],
            );
            assert.equal(beforeOpening.value, true);
            await rollbackRunner.query(
              `INSERT INTO public.expenditure (
                 id, asset_id, base_id, equipment_type_id, quantity,
                 reason_code, recorded_by, expended_at, idempotency_key
               ) VALUES ($1, $2, $3, $4, 1, 'ROLLBACK-PROBE', $5, $6, $7)`,
              [
                probeExpenditureId,
                probeAssetId,
                probeBaseId,
                probeEquipmentTypeId,
                probeActorId,
                probeTimes.event_at,
                `rollback-exp-${randomUUID()}`,
              ],
            );
            const probeMovement = await rollbackRunner.query(
              `INSERT INTO public.inventory_movement (
                 asset_id, base_id, equipment_type_id, movement_type,
                 quantity, direction, occurred_at, idempotency_key,
                 expenditure_id, created_by
               ) VALUES (
                 $1, $2, $3, 'EXPENDITURE', 1, 'OUT', $4, $5, $6, $7
               )
               RETURNING id`,
              [
                probeAssetId,
                probeBaseId,
                probeEquipmentTypeId,
                probeTimes.event_at,
                probeMovementKey,
                probeExpenditureId,
                probeActorId,
              ],
            );
            assert.equal(probeMovement.length, 1);
            await rollbackRunner.rollbackTransaction();
            probeTransactionActive = false;

            await migration.up(rollbackRunner);
            migrationReverted = false;
            const reapplied = await readGuardState();
            assert.equal(reapplied.triggerState.trigger_count, 1);
            assert.equal(reapplied.functionState.prosecdef, false);
            assert.deepEqual(
              reapplied.functionState.proconfig,
              beforeRollback.functionState.proconfig,
            );
            assert.equal(
              reapplied.functionState.acl,
              beforeRollback.functionState.acl,
            );
            assert.equal(
              reapplied.functionState.owner,
              beforeRollback.functionState.owner,
            );
            assert.match(
              reapplied.functionState.definition,
              /NEW\.occurred_at > pg_catalog\.clock_timestamp\(\)/u,
            );
            assert.match(
              reapplied.functionState.definition,
              /asset\.opening_at <= NEW\.occurred_at/u,
            );
            assert.match(
              reapplied.functionState.definition,
              /movement\.occurred_at <= NEW\.occurred_at/u,
            );
            assert.doesNotMatch(
              reapplied.functionState.definition,
              /GREATEST\(/u,
            );
          } finally {
            if (
              probeTransactionActive &&
              rollbackRunner.isTransactionActive
            ) {
              await rollbackRunner.rollbackTransaction();
            }
            if (migrationReverted) await migration.up(rollbackRunner);
            await rollbackRunner.release();
          }
        },
      );

      fixture = await seedReportingFixtures(targetAdmin);
      const userIds = Object.values(fixture.ids.users);
      for (const userId of userIds) {
        tokens.set(userId, await signToken(userId));
      }

      const app = express();
      app.use("/api/dashboard", createDashboardRouter({
        dataSource: targetAdmin,
        jwtConfiguration,
      }));
      app.use("/api/reports", createReportRouter({
        dataSource: targetAdmin,
        jwtConfiguration,
      }));
      app.use("/api/bases", createBaseRouter({
        dataSource: targetAdmin,
        jwtConfiguration,
      }));
      server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const serverUrl = `http://127.0.0.1:${server.address().port}`;
      const request = (path, userId) =>
        fetch(`${serverUrl}${path}`, {
          method: "GET",
          headers: { authorization: `Bearer ${tokens.get(userId)}` },
        });
      const periodQuery = {
        from: fixture.dates.from,
        to: fixture.dates.to,
      };

      await t.test("historical inventory and movement dates reconcile in PostgreSQL", async () => {
        const response = await request(
          queryPath("/api/reports/inventory-movements", periodQuery),
          fixture.ids.users.admin,
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(body.data.summary, {
          assetPositionCount: 4,
          openingBalance: 90,
          openingBalanceIntroduced: 41,
          purchases: 7,
          transfersIn: 4,
          transfersOut: 4,
          netMovement: 7,
          grossAssigned: 5,
          returned: 3,
          netAssigned: 2,
          expenditureQuantity: 2,
          closingBalance: 134,
        });
        assert.equal(body.meta.total, 8);
        assert.equal(body.data.movements.length, 8);
        const movementIds = new Set(body.data.movements.map((row) => row.id));
        for (const id of [
          fixture.ids.movements.purchaseStart,
          fixture.ids.movements.purchaseEnd,
          fixture.ids.movements.transferOutAB,
          fixture.ids.movements.transferInAB,
          fixture.ids.movements.assignmentFromBoundary,
          fixture.ids.movements.assignmentToBoundary,
          fixture.ids.movements.expenditure,
        ]) {
          assert.equal(movementIds.has(id), true);
        }
        assert.equal(
          body.data.movements.some(
            (row) =>
              row.assignmentId ===
                fixture.ids.assignments.createdInsideAssignedBefore &&
              row.movementType === "ASSIGNMENT",
          ),
          false,
        );
        assert.equal(
          body.data.movements.some(
            (row) =>
              row.returnOperationId ===
                fixture.ids.returns.beforeAssignmentInsidePeriod &&
              row.assignmentId ===
                fixture.ids.assignments.createdInsideAssignedBefore &&
              row.quantity === 3,
          ),
          true,
        );
        assert.equal(
          body.data.movements.some(
            (row) =>
              row.returnOperationId ===
                fixture.ids.returns.beforeAssignmentOutsidePeriod ||
              row.returnOperationId ===
                fixture.ids.returns.insideAssignmentOutsidePeriod,
          ),
          false,
        );
        assert.equal(
          body.data.movements.some(
            (row) => row.transferId === fixture.ids.transfers.completedCD,
          ),
          false,
        );
        assert.equal(
          body.data.movements.filter((row) => row.movementType === "PURCHASE")
            .length,
          2,
        );
        assert.equal(
          body.data.summary.closingBalance,
          body.data.summary.openingBalance +
            body.data.summary.openingBalanceIntroduced +
            body.data.summary.netMovement -
            body.data.summary.netAssigned -
            body.data.summary.expenditureQuantity,
        );

        const purchaseTypeResponse = await request(
          queryPath("/api/reports/inventory-movements", {
            ...periodQuery,
            movementType: "PURCHASE",
          }),
          fixture.ids.users.admin,
        );
        assert.equal(purchaseTypeResponse.status, 200);
        const purchaseTypeBody = await purchaseTypeResponse.json();
        assert.equal(purchaseTypeBody.meta.total, 2);
        assert.equal(purchaseTypeBody.data.movements.length, 2);
        assert.equal(purchaseTypeBody.data.summary.purchases, 7);

        const sourceResponse = await request(
          queryPath("/api/reports/inventory-movements", periodQuery),
          fixture.ids.users.logisticsA,
        );
        const sourceBody = await sourceResponse.json();
        assert.equal(sourceResponse.status, 200);
        assert.equal(
          sourceBody.data.movements.some(
            (row) =>
              row.transferId === fixture.ids.transfers.completedAB &&
              row.movementType === "TRANSFER_OUT" &&
              row.direction === "OUT",
          ),
          true,
        );
        assert.equal(
          sourceBody.data.movements.some(
            (row) => row.baseId !== fixture.ids.bases.a,
          ),
          false,
        );

        const destinationResponse = await request(
          queryPath("/api/reports/inventory-movements", periodQuery),
          fixture.ids.users.logisticsB,
        );
        const destinationBody = await destinationResponse.json();
        assert.equal(destinationResponse.status, 200);
        assert.equal(
          destinationBody.data.movements.some(
            (row) =>
              row.transferId === fixture.ids.transfers.completedAB &&
              row.movementType === "TRANSFER_IN" &&
              row.direction === "IN",
          ),
          true,
        );
        assert.equal(
          destinationBody.data.movements.some(
            (row) => row.baseId !== fixture.ids.bases.b,
          ),
          false,
        );

        const emptyBaseResponse = await request(
          queryPath("/api/reports/inventory-movements", periodQuery),
          fixture.ids.users.logisticsD,
        );
        assert.equal(emptyBaseResponse.status, 200);
        const emptyBaseBody = await emptyBaseResponse.json();
        assert.equal(emptyBaseBody.meta.total, 0);
        assert.deepEqual(emptyBaseBody.data.movements, []);
        assert.equal(emptyBaseBody.data.summary.openingBalance, 0);
        assert.equal(emptyBaseBody.data.summary.openingBalanceIntroduced, 11);
        assert.equal(emptyBaseBody.data.summary.closingBalance, 11);

        const pagedResponse = await request(
          queryPath("/api/reports/inventory-movements", {
            ...periodQuery,
            limit: "2",
            offset: "1",
          }),
          fixture.ids.users.admin,
        );
        assert.equal(pagedResponse.status, 200);
        const pagedBody = await pagedResponse.json();
        assert.equal(pagedBody.meta.total, 8);
        assert.equal(pagedBody.data.movements.length, 2);
      });

      await t.test("purchase and transfer reports use their schema timestamps and scopes", async () => {
        const purchaseResponse = await request(
          queryPath("/api/reports/purchases", periodQuery),
          fixture.ids.users.admin,
        );
        assert.equal(purchaseResponse.status, 200);
        const purchaseBody = await purchaseResponse.json();
        assert.equal(purchaseBody.meta.total, 4);
        assert.equal(purchaseBody.data.purchases.length, 4);
        assert.deepEqual(purchaseBody.data.pending, { count: 2, quantity: 14 });
        const purchaseIds = new Set(
          purchaseBody.data.purchases.map((row) => row.id),
        );
        for (const id of [
          fixture.ids.purchases.start,
          fixture.ids.purchases.end,
          fixture.ids.purchases.pendingA,
          fixture.ids.purchases.pendingB,
        ]) {
          assert.equal(purchaseIds.has(id), true);
        }
        assert.equal(purchaseIds.has(fixture.ids.purchases.pendingOutside), false);
        const startPurchase = purchaseBody.data.purchases.find(
          (purchase) => purchase.id === fixture.ids.purchases.start,
        );
        assert.equal(startPurchase.purchasedAt, fixture.dates.from);
        assert.equal(startPurchase.createdAt, fixture.dates.after);

        const purchasePageResponse = await request(
          queryPath("/api/reports/purchases", {
            ...periodQuery,
            limit: "1",
            offset: "1",
          }),
          fixture.ids.users.admin,
        );
        assert.equal(purchasePageResponse.status, 200);
        const purchasePage = await purchasePageResponse.json();
        assert.equal(purchasePage.meta.total, 4);
        assert.equal(purchasePage.data.purchases.length, 1);

        const transferResponse = await request(
          queryPath("/api/reports/transfers", periodQuery),
          fixture.ids.users.admin,
        );
        assert.equal(transferResponse.status, 200);
        const transferBody = await transferResponse.json();
        assert.equal(transferBody.meta.total, 5);
        assert.deepEqual(transferBody.data.byStatus, {
          PENDING: { count: 1, quantity: 3 },
          APPROVED: { count: 1, quantity: 2 },
          COMPLETED: { count: 2, quantity: 9 },
          REJECTED: { count: 1, quantity: 1 },
        });
        const transferIds = new Set(
          transferBody.data.transfers.map((transfer) => transfer.id),
        );
        assert.equal(transferIds.has(fixture.ids.transfers.completedAB), true);
        assert.equal(transferIds.has(fixture.ids.transfers.completedCD), true);
        assert.equal(transferIds.has(fixture.ids.transfers.rejectedOutside), false);
        const createdInsideCompleted = transferBody.data.transfers.find(
          (transfer) => transfer.id === fixture.ids.transfers.completedCD,
        );
        assert.equal(createdInsideCompleted.createdAt, fixture.dates.inside);
        assert.equal(createdInsideCompleted.completedAt, fixture.dates.after);

        const sourceTransferResponse = await request(
          queryPath("/api/reports/transfers", periodQuery),
          fixture.ids.users.logisticsA,
        );
        assert.equal(sourceTransferResponse.status, 200);
        const sourceTransferIds = new Set(
          (await sourceTransferResponse.json()).data.transfers.map(
            (transfer) => transfer.id,
          ),
        );
        assert.equal(sourceTransferIds.has(fixture.ids.transfers.completedAB), true);
        assert.equal(sourceTransferIds.has(fixture.ids.transfers.pendingAC), true);
        assert.equal(sourceTransferIds.has(fixture.ids.transfers.approvedBA), true);
        assert.equal(sourceTransferIds.has(fixture.ids.transfers.rejectedCD), false);

        const destinationTransferResponse = await request(
          queryPath("/api/reports/transfers", periodQuery),
          fixture.ids.users.logisticsB,
        );
        assert.equal(destinationTransferResponse.status, 200);
        const destinationTransferIds = new Set(
          (await destinationTransferResponse.json()).data.transfers.map(
            (transfer) => transfer.id,
          ),
        );
        assert.equal(
          destinationTransferIds.has(fixture.ids.transfers.completedAB),
          true,
        );
        assert.equal(
          destinationTransferIds.has(fixture.ids.transfers.approvedBA),
          true,
        );
        assert.equal(
          destinationTransferIds.has(fixture.ids.transfers.pendingAC),
          false,
        );

        const unrelatedTransferResponse = await request(
          queryPath("/api/reports/transfers", periodQuery),
          fixture.ids.users.logisticsD,
        );
        assert.equal(unrelatedTransferResponse.status, 200);
        const unrelatedTransferBody = await unrelatedTransferResponse.json();
        assert.equal(unrelatedTransferBody.meta.total, 2);
        assert.equal(
          unrelatedTransferBody.data.transfers.some(
            (transfer) => transfer.id === fixture.ids.transfers.completedAB,
          ),
          false,
        );
        assert.equal(
          unrelatedTransferBody.data.transfers.some(
            (transfer) => transfer.id === fixture.ids.transfers.rejectedOutside,
          ),
          false,
        );

        const [movementRows] = await targetAdmin.query(
          `SELECT count(*)::integer AS transfer_movement_count
           FROM public.inventory_movement
           WHERE transfer_id = ANY($1::uuid[])`,
          [[
            fixture.ids.transfers.completedAB,
            fixture.ids.transfers.completedCD,
            fixture.ids.transfers.approvedBA,
            fixture.ids.transfers.pendingAC,
            fixture.ids.transfers.rejectedCD,
          ]],
        );
        assert.equal(movementRows.transfer_movement_count, 4);
      });

      await t.test("assignment, return, and expenditure reports use event semantics", async () => {
        const assignmentResponse = await request(
          queryPath("/api/reports/assignments", periodQuery),
          fixture.ids.users.logisticsA,
        );
        assert.equal(assignmentResponse.status, 200);
        const assignmentBody = await assignmentResponse.json();
        assert.equal(assignmentBody.meta.total, 2);
        assert.deepEqual(
          assignmentBody.data.assignments.map((assignment) => assignment.id),
          [
            fixture.ids.assignments.createdBeforeAssignedTo,
            fixture.ids.assignments.createdAfterAssignedFrom,
          ],
        );
        assert.deepEqual(
          assignmentBody.data.assignments.map((assignment) => [
            assignment.createdAt,
            assignment.assignedAt,
          ]),
          [
            [fixture.dates.before, fixture.dates.to],
            [fixture.dates.insideLater, fixture.dates.from],
          ],
        );
        assert.deepEqual(assignmentBody.data.summary, {
          assignmentCount: 2,
          grossAssigned: 5,
          cumulativeReturned: 1,
          netAssigned: 4,
        });
        assert.deepEqual(
          assignmentBody.data.assignments.map((assignment) => ({
            grossAssigned: assignment.grossAssigned,
            cumulativeReturned: assignment.cumulativeReturned,
            netAssigned: assignment.netAssigned,
          })),
          [
            { grossAssigned: 4, cumulativeReturned: 1, netAssigned: 3 },
            { grossAssigned: 1, cumulativeReturned: 0, netAssigned: 1 },
          ],
        );
        assert.equal(
          assignmentBody.data.assignments.some(
            (assignment) =>
              assignment.id ===
              fixture.ids.assignments.createdInsideAssignedBefore,
          ),
          false,
        );

        const returnResponse = await request(
          queryPath("/api/reports/returns", periodQuery),
          fixture.ids.users.logisticsA,
        );
        assert.equal(returnResponse.status, 200);
        const returnBody = await returnResponse.json();
        assert.equal(returnBody.meta.total, 1);
        assert.deepEqual(returnBody.data.summary, { count: 1, quantity: 3 });
        assert.equal(returnBody.data.returns.length, 1);
        assert.equal(
          returnBody.data.returns[0].assignmentId,
          fixture.ids.assignments.createdInsideAssignedBefore,
        );
        assert.equal(returnBody.data.returns[0].returnedAt, fixture.dates.inside);

        const expenditureResponse = await request(
          queryPath("/api/reports/expenditures", periodQuery),
          fixture.ids.users.logisticsA,
        );
        assert.equal(expenditureResponse.status, 200);
        const expenditureBody = await expenditureResponse.json();
        assert.equal(expenditureBody.meta.total, 1);
        assert.deepEqual(expenditureBody.data.summary, { count: 1, quantity: 2 });
        assert.equal(expenditureBody.data.expenditures.length, 1);
        assert.equal(
          expenditureBody.data.expenditures[0].expendedAt,
          fixture.dates.to,
        );
        assert.doesNotMatch(
          JSON.stringify(expenditureBody),
          /cost|amount|price|totalValue/iu,
        );

        const allAssignmentsResponse = await request(
          "/api/reports/assignments",
          fixture.ids.users.admin,
        );
        assert.equal(allAssignmentsResponse.status, 200);
        const allAssignments = await allAssignmentsResponse.json();
        assert.deepEqual(
          allAssignments.data.assignments.map((assignment) => assignment.id),
          [
            fixture.ids.assignments.createdBeforeAssignedTo,
            fixture.ids.assignments.createdAfterAssignedFrom,
            fixture.ids.assignments.createdInsideAssignedBefore,
          ],
        );
        assert.deepEqual(
          {
            gross: allAssignments.data.summary.grossAssigned,
            returned: allAssignments.data.summary.cumulativeReturned,
            net: allAssignments.data.summary.netAssigned,
          },
          { gross: 15, returned: 6, net: 9 },
        );
      });

      await t.test("dashboard quantities reconcile across bases and enforce scope", async () => {
        assert.deepEqual(
          await Promise.all(
            Object.values(fixture.ids.assets).map((assetId) =>
              getBalance(targetAdmin, assetId),
            ),
          ),
          [92, 34, 15, 16],
        );
        const globalResponse = await request(
          "/api/dashboard",
          fixture.ids.users.admin,
        );
        assert.equal(globalResponse.status, 200);
        const globalBody = await globalResponse.json();
        assert.deepEqual(globalBody.data.dashboard, {
          inventory: { availableQuantity: 157, netAssignedQuantity: 9 },
          pendingPurchases: { count: 3, quantity: 23 },
          transfers: {
            pending: { count: 1, quantity: 3 },
            approved: { count: 1, quantity: 2 },
          },
          expenditureQuantity: 2,
        });
        assert.equal(
          (await request("/api/dashboard", fixture.ids.users.logisticsA)).status,
          403,
        );
        assert.equal(
          (await request(
            `/api/dashboard?baseId=${fixture.ids.bases.b}`,
            fixture.ids.users.admin,
          )).status,
          400,
        );

        const baseExpectations = [
          ["a", "logisticsA", 92, 9, 2, 17, 2, 3, 2],
          ["b", "logisticsB", 34, 0, 1, 6, 0, 0, 2],
          ["c", "logisticsC", 15, 0, 0, 0, 0, 3, 0],
          ["d", "logisticsD", 16, 0, 0, 0, 0, 0, 0],
        ];
        let summedAvailable = 0;
        let summedNetAssigned = 0;
        let summedPendingPurchases = 0;
        let summedExpenditures = 0;
        for (const [
          baseKey,
          userKey,
          available,
          netAssigned,
          pendingPurchaseCount,
          pendingPurchaseQuantity,
          expenditureQuantity,
          pendingTransferQuantity,
          approvedTransferQuantity,
        ] of baseExpectations) {
          const response = await request(
            `/api/bases/${fixture.ids.bases[baseKey]}/dashboard`,
            fixture.ids.users[userKey],
          );
          assert.equal(response.status, 200);
          const dashboard = (await response.json()).data.dashboard;
          assert.equal(dashboard.inventory.availableQuantity, available);
          assert.equal(dashboard.inventory.netAssignedQuantity, netAssigned);
          assert.deepEqual(dashboard.pendingPurchases, {
            count: pendingPurchaseCount,
            quantity: pendingPurchaseQuantity,
          });
          assert.equal(dashboard.expenditureQuantity, expenditureQuantity);
          assert.equal(
            dashboard.transfers.pending.quantity,
            pendingTransferQuantity,
          );
          assert.equal(
            dashboard.transfers.approved.quantity,
            approvedTransferQuantity,
          );
          summedAvailable += available;
          summedNetAssigned += netAssigned;
          summedPendingPurchases += pendingPurchaseQuantity;
          summedExpenditures += expenditureQuantity;
        }
        assert.equal(summedAvailable, globalBody.data.dashboard.inventory.availableQuantity);
        assert.equal(summedNetAssigned, globalBody.data.dashboard.inventory.netAssignedQuantity);
        assert.equal(summedPendingPurchases, globalBody.data.dashboard.pendingPurchases.quantity);
        assert.equal(summedExpenditures, globalBody.data.dashboard.expenditureQuantity);
        assert.equal(
          (await request(
            `/api/bases/${fixture.ids.bases.b}/dashboard`,
            fixture.ids.users.logisticsA,
          )).status,
          403,
        );
        assert.equal(
          (await request(
            `/api/bases/${fixture.ids.bases.d}/dashboard`,
            fixture.ids.users.admin,
          )).status,
          200,
        );
        assert.equal(
          (
            await request(
              queryPath("/api/reports/purchases", {
                ...periodQuery,
                baseId: fixture.ids.bases.b,
              }),
              fixture.ids.users.logisticsA,
            )
          ).status,
          400,
        );
      });
    } finally {
      let cleanupError;
      const attemptCleanup = async (operation) => {
        try {
          await operation();
        } catch (error) {
          if (!cleanupError) cleanupError = error;
        }
      };
      if (server?.listening) {
        await attemptCleanup(() => closeServer(server));
      }
      if (migrationRunner) {
        await attemptCleanup(() => migrationRunner.release());
      }
      if (targetAdmin?.isInitialized) {
        await attemptCleanup(() => targetAdmin.destroy());
      }
      if (databaseCreated && clusterAdmin.isInitialized) {
        await attemptCleanup(() =>
          clusterAdmin.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(targetDatabaseName)}`,
          ),
        );
      }
      if (clusterAdmin.isInitialized) {
        await attemptCleanup(() => clusterAdmin.destroy());
      }
      if (cleanupError) throw cleanupError;
    }
  },
);
