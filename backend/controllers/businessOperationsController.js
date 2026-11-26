import { randomUUID } from "node:crypto";
import { isUuid } from "../config/jwt.js";
import {
  areTransferActorsDistinct,
  isTransferActionCurrentlyAuthorized,
  AUTHORIZATION_OPERATIONS,
  AUTHORIZATION_SCOPE,
  getAuthorizationScope,
} from "../config/authorizationPolicies.js";
import { executeIdempotentCommand } from "../utils/businessIdempotency.js";
import { writeBusinessAudit } from "../utils/businessAudit.js";
import { rowsOfCommandResult } from "../utils/databaseResults.js";
import {
  sendConflict,
  sendDatabaseError,
  sendNotFound,
} from "../utils/apiResponses.js";

const ACTOR_QUERY = `
  SELECT id, role, base_id, is_active
  FROM public.app_user
  WHERE id = $1
  FOR SHARE
`;

const PURCHASE_COLUMNS = `
  id, base_id, equipment_type_id, quantity, status, reference_code,
  purchased_at, created_by, created_at, updated_at
`;

const TRANSFER_COLUMNS = `
  id, source_base_id, destination_base_id, equipment_type_id, quantity,
  status, created_by, approved_by, completed_by, approved_at, completed_at,
  rejected_at, created_at, updated_at
`;

const ASSIGNMENT_COLUMNS = `
  id, asset_id, base_id, equipment_type_id, quantity, returned_quantity,
  status, assigned_by, assigned_at, returned_at, created_at, updated_at
`;

const RETURN_COLUMNS = `
  id, assignment_id, asset_id, base_id, equipment_type_id, quantity,
  returned_by, returned_at, created_at
`;

const EXPENDITURE_COLUMNS = `
  id, asset_id, base_id, equipment_type_id, quantity, reason_code,
  recorded_by, expended_at, created_at, updated_at
`;

function timestampDto(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function rowsOf(result) {
  if (!Array.isArray(result)) {
    throw new Error("The database returned an invalid result.");
  }
  return result;
}

function toPurchaseDto(row) {
  return {
    id: row.id,
    baseId: row.base_id,
    equipmentTypeId: row.equipment_type_id,
    quantity: row.quantity,
    status: row.status,
    referenceCode: row.reference_code,
    purchasedAt: timestampDto(row.purchased_at),
    createdBy: row.created_by,
    createdAt: timestampDto(row.created_at),
    updatedAt: timestampDto(row.updated_at),
  };
}

function toTransferDto(row) {
  return {
    id: row.id,
    sourceBaseId: row.source_base_id,
    destinationBaseId: row.destination_base_id,
    equipmentTypeId: row.equipment_type_id,
    quantity: row.quantity,
    status: row.status,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    completedBy: row.completed_by,
    approvedAt: timestampDto(row.approved_at),
    completedAt: timestampDto(row.completed_at),
    rejectedAt: timestampDto(row.rejected_at),
    createdAt: timestampDto(row.created_at),
    updatedAt: timestampDto(row.updated_at),
  };
}

function toAssignmentDto(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    baseId: row.base_id,
    equipmentTypeId: row.equipment_type_id,
    quantity: row.quantity,
    returnedQuantity: row.returned_quantity,
    status: row.status,
    assignedBy: row.assigned_by,
    assignedAt: timestampDto(row.assigned_at),
    returnedAt: timestampDto(row.returned_at),
    createdAt: timestampDto(row.created_at),
    updatedAt: timestampDto(row.updated_at),
  };
}

function toReturnDto(row, assignment) {
  return {
    id: row.id,
    assignmentId: row.assignment_id,
    assetId: row.asset_id,
    baseId: row.base_id,
    equipmentTypeId: row.equipment_type_id,
    quantity: row.quantity,
    returnedBy: row.returned_by,
    returnedAt: timestampDto(row.returned_at),
    assignmentStatus: assignment.status,
    assignmentReturnedQuantity: assignment.returned_quantity,
  };
}

function toExpenditureDto(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    baseId: row.base_id,
    equipmentTypeId: row.equipment_type_id,
    quantity: row.quantity,
    reasonCode: row.reason_code,
    recordedBy: row.recorded_by,
    expendedAt: timestampDto(row.expended_at),
    createdAt: timestampDto(row.created_at),
  };
}

function responseResult(entityType, entity, property, toDto, status = 201) {
  return {
    kind: "success",
    status,
    entityType,
    entityId: entity.id,
    body: { success: true, data: { [property]: toDto(entity) } },
  };
}

function actorCanAccess(actor, operation, baseId) {
  const scope = getAuthorizationScope(actor.role, operation);
  return (
    scope === AUTHORIZATION_SCOPE.GLOBAL ||
    (scope === AUTHORIZATION_SCOPE.OWN_BASE &&
      isUuid(actor.base_id) &&
      actor.base_id === baseId)
  );
}

async function loadActor(manager, actorId) {
  const rows = rowsOf(await manager.query(ACTOR_QUERY, [actorId]));
  if (rows.length !== 1 || rows[0].is_active !== true) {
    return null;
  }
  return rows[0];
}

async function lockBases(manager, baseIds, { requireActive = true } = {}) {
  const uniqueIds = [...new Set(baseIds)].sort();
  const bases = new Map();
  for (const id of uniqueIds) {
    const rows = rowsOf(
      await manager.query(
        `SELECT id, is_active
         FROM public.base
         WHERE id = $1
         FOR SHARE`,
        [id],
      ),
    );
    if (rows.length !== 1) {
      return { kind: "conflict", code: "BASE_UNAVAILABLE", message: "A required base is unavailable." };
    }
    if (requireActive && rows[0].is_active !== true) {
      return { kind: "conflict", code: "INACTIVE_RESOURCE", message: "An active base is required." };
    }
    bases.set(id, rows[0]);
  }
  return { kind: "locked", bases };
}

async function lockEquipmentType(manager, equipmentTypeId) {
  const rows = rowsOf(
    await manager.query(
      `SELECT id, is_active
       FROM public.equipment_type
       WHERE id = $1
       FOR SHARE`,
      [equipmentTypeId],
    ),
  );
  if (rows.length !== 1) {
    return { kind: "conflict", code: "EQUIPMENT_TYPE_UNAVAILABLE", message: "The equipment type is unavailable." };
  }
  if (rows[0].is_active !== true) {
    return { kind: "conflict", code: "INACTIVE_RESOURCE", message: "An active equipment type is required." };
  }
  return { kind: "locked", equipmentType: rows[0] };
}

async function lockAssetPosition(manager, baseId, equipmentTypeId) {
  const rows = rowsOf(
    await manager.query(
      `SELECT id, base_id, equipment_type_id, opening_balance, is_active
       FROM public.asset
       WHERE base_id = $1 AND equipment_type_id = $2
       FOR UPDATE`,
      [baseId, equipmentTypeId],
    ),
  );
  if (rows.length !== 1) {
    return { kind: "conflict", code: "ASSET_POSITION_NOT_FOUND", message: "The required asset position does not exist." };
  }
  if (rows[0].is_active !== true) {
    return { kind: "conflict", code: "INACTIVE_RESOURCE", message: "An active asset position is required." };
  }
  return { kind: "locked", asset: rows[0] };
}

async function lockTransferAssetPositions(manager, transfer) {
  const rows = rowsOf(
    await manager.query(
      `SELECT id, base_id, equipment_type_id, opening_balance, is_active
       FROM public.asset
       WHERE (base_id = $1 OR base_id = $2)
         AND equipment_type_id = $3
       ORDER BY id
       FOR UPDATE`,
      [
        transfer.sourceBaseId,
        transfer.destinationBaseId,
        transfer.equipmentTypeId,
      ],
    ),
  );
  if (
    rows.length !== 2 ||
    rows.some(
      (asset) =>
        asset.equipment_type_id !== transfer.equipmentTypeId ||
        ![transfer.sourceBaseId, transfer.destinationBaseId].includes(
          asset.base_id,
        ),
    )
  ) {
    return {
      kind: "conflict",
      code: "ASSET_POSITION_NOT_FOUND",
      message: "Both source and destination asset positions must exist.",
    };
  }
  if (rows.some((asset) => asset.is_active !== true)) {
    return {
      kind: "conflict",
      code: "INACTIVE_RESOURCE",
      message: "Both transfer asset positions must be active.",
    };
  }
  const sourceAsset = rows.find(
    (asset) => asset.base_id === transfer.sourceBaseId,
  );
  const destinationAsset = rows.find(
    (asset) => asset.base_id === transfer.destinationBaseId,
  );
  if (!sourceAsset || !destinationAsset) {
    throw new Error("The transfer asset positions could not be verified.");
  }
  return { kind: "locked", sourceAsset, destinationAsset };
}

async function lockAssetById(manager, assetId) {
  const rows = rowsOf(
    await manager.query(
      `SELECT id, base_id, equipment_type_id, opening_balance, is_active
       FROM public.asset
       WHERE id = $1
       FOR UPDATE`,
      [assetId],
    ),
  );
  return rows.length === 1 ? rows[0] : null;
}

async function captureInventoryEventTimestamp(manager) {
  const rows = rowsOf(
    await manager.query(
      `SELECT pg_catalog.clock_timestamp()::text AS event_timestamp`,
    ),
  );
  if (
    rows.length !== 1 ||
    typeof rows[0].event_timestamp !== "string" ||
    Number.isNaN(Date.parse(rows[0].event_timestamp))
  ) {
    throw new Error("The inventory event timestamp could not be verified.");
  }
  return rows[0].event_timestamp;
}

async function getAvailableBalance(manager, assetId, eventTimestamp) {
  const rows = rowsOf(
    await manager.query(
      `SELECT (
         CASE
           WHEN asset.opening_at <= $2::timestamptz
           THEN asset.opening_balance::numeric
           ELSE 0::numeric
         END
         + COALESCE(
             pg_catalog.sum(
               CASE movement.direction
                 WHEN 'IN' THEN movement.quantity::numeric
                 ELSE -movement.quantity::numeric
               END
             ),
             0
           )
       )::text AS available
       FROM public.asset asset
       LEFT JOIN public.inventory_movement movement
         ON movement.asset_id = asset.id
        AND movement.occurred_at <= $2::timestamptz
       WHERE asset.id = $1
       GROUP BY asset.opening_balance, asset.opening_at`,
      [assetId, eventTimestamp],
    ),
  );
  if (rows.length !== 1 || !/^-?\d+$/u.test(String(rows[0].available))) {
    throw new Error("The inventory balance could not be verified.");
  }
  return BigInt(rows[0].available);
}

async function insertMovement(
  manager,
  {
    assetId,
    baseId,
    equipmentTypeId,
    movementType,
    quantity,
    direction,
    occurredAt,
    idempotencyKey,
    transferId = null,
    assignmentId = null,
    expenditureId = null,
    createdBy,
  },
) {
  const rows = rowsOf(
    await manager.query(
      `INSERT INTO public.inventory_movement (
         asset_id, base_id, equipment_type_id, movement_type, quantity,
         direction, occurred_at, idempotency_key, purchase_id, transfer_id,
         assignment_id, expenditure_id, created_by
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::timestamptz, $8,
           NULL, $9, $10, $11, $12
       )
       RETURNING id`,
      [
        assetId,
        baseId,
        equipmentTypeId,
        movementType,
        quantity,
        direction,
        occurredAt,
        idempotencyKey,
        transferId,
        assignmentId,
        expenditureId,
        createdBy,
      ],
    ),
  );
  if (rows.length !== 1) {
    throw new Error("The inventory movement could not be persisted.");
  }
  return rows[0].id;
}

async function insertAudit(
  manager,
  { actorId, action, entityType, entityId, baseId, beforeData, afterData },
) {
  await writeBusinessAudit(manager, {
    actorUserId: actorId,
    action,
    entityType,
    entityId,
    baseId,
    correlationId: randomUUID(),
    beforeData,
    afterData,
  });
}

async function authorizeMutation(manager, request, operation) {
  const actorId = request.currentUser?.id;
  if (!isUuid(actorId)) {
    return { kind: "unauthenticated" };
  }
  const actor = await loadActor(manager, actorId);
  if (!actor) {
    return { kind: "unauthenticated" };
  }

  let baseId;
  if (
    operation === AUTHORIZATION_OPERATIONS.PURCHASE_CREATE
  ) {
    baseId = request.validatedBody.baseId;
  } else if (
    operation === AUTHORIZATION_OPERATIONS.TRANSFER_INITIATE
  ) {
    baseId = request.validatedBody.sourceBaseId;
  } else if (
    operation === AUTHORIZATION_OPERATIONS.ASSIGNMENT_CREATE ||
    operation === AUTHORIZATION_OPERATIONS.EXPENDITURE_RECORD
  ) {
    const assets = rowsOf(
      await manager.query(
        `SELECT base_id FROM public.asset WHERE id = $1`,
        [request.validatedBody.assetId],
      ),
    );
    if (assets.length === 0) {
      return { kind: "not-found", resource: "Asset" };
    }
    if (assets.length !== 1) {
      throw new Error("The asset position could not be verified.");
    }
    baseId = assets[0].base_id;
  } else if (
    operation === AUTHORIZATION_OPERATIONS.ASSIGNMENT_RETURN
  ) {
    const assignments = rowsOf(
      await manager.query(
        `SELECT base_id FROM public.assignment WHERE id = $1`,
        [request.params.assignmentId],
      ),
    );
    if (assignments.length === 0) {
      return { kind: "not-found", resource: "Assignment" };
    }
    if (assignments.length !== 1) {
      throw new Error("The assignment could not be verified.");
    }
    baseId = assignments[0].base_id;
  } else if (
    operation === AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE ||
    operation === AUTHORIZATION_OPERATIONS.TRANSFER_REJECT ||
    operation === AUTHORIZATION_OPERATIONS.TRANSFER_COMPLETE
  ) {
    const transfers = rowsOf(
      await manager.query(
        `SELECT source_base_id, destination_base_id, status,
                created_by, approved_by, completed_by
         FROM public.transfer
         WHERE id = $1`,
        [request.params.transferId],
      ),
    );
    if (transfers.length === 0) {
      return { kind: "not-found", resource: "Transfer" };
    }
    if (transfers.length !== 1) {
      throw new Error("The transfer could not be verified.");
    }
    const transfer = transfers[0];
    if (!isTransferActionCurrentlyAuthorized({
      role: actor.role,
      operation,
      userId: actor.id,
      userBaseId: actor.base_id,
      transfer,
    })) {
      return { kind: "forbidden" };
    }
    baseId = transfer.destination_base_id;
  } else {
    return { kind: "forbidden" };
  }

  return actorCanAccess(actor, operation, baseId)
    ? null
    : { kind: "forbidden" };
}

function command(request, operation, payload, execute) {
  const actorId = request.currentUser?.id;
  if (!isUuid(actorId)) {
    return Promise.resolve({ kind: "unauthenticated" });
  }
  return executeIdempotentCommand({
    dataSource: request.dataSource,
    actorId,
    operation,
    idempotencyKey: request.idempotencyKey,
    payload,
    authorize: (manager) => authorizeMutation(manager, request, operation),
    execute,
  });
}

function sendCommandResult(response, result) {
  if (result.kind === "success" || result.kind === "replay") {
    return response.status(result.status).json(result.body);
  }
  if (result.kind === "unauthenticated") {
    return response.status(401).json({
      success: false,
      error: { code: "UNAUTHENTICATED", message: "Authentication is required." },
    });
  }
  if (result.kind === "forbidden") {
    return response.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "You are not allowed to perform this operation." },
    });
  }
  if (result.kind === "not-found") {
    return sendNotFound(response, result.resource);
  }
  if (result.kind === "idempotency-conflict") {
    return sendConflict(
      response,
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key has already been used for a different request.",
    );
  }
  if (result.kind === "conflict") {
    return sendConflict(response, result.code, result.message);
  }
  const error = result.error;
  const code = error?.code ?? error?.driverError?.code;
  const message = error?.driverError?.message ?? error?.message;
  if (
    (code === "P0001" || error?.driverError?.code === "P0001") &&
    typeof message === "string" &&
    message.includes("Inventory movement would make asset balance negative")
  ) {
    return sendConflict(
      response,
      "INSUFFICIENT_STOCK",
      "The operation would make available inventory negative.",
    );
  }
  if (code === "40P01" || code === "40001") {
    return response.status(503).json({
      success: false,
      error: {
        code: "TRANSACTION_RETRY_REQUIRED",
        message: "The transaction could not be serialized; retry with the same idempotency key.",
      },
    });
  }
  return sendDatabaseError(response, error ?? new Error("The request failed."));
}

async function executeMutation(request, operation, payload, execute) {
  return command(request, operation, payload, execute);
}

export function createBusinessOperationsController({ dataSource }) {
  async function run(request, response, operation, payload, execute) {
    return sendCommandResult(
      response,
      await executeMutation(
        { ...request, dataSource },
        operation,
        payload,
        execute,
      ),
    );
  }

  async function createPurchase(request, response) {
    const body = request.validatedBody;
    return run(
      request,
      response,
      AUTHORIZATION_OPERATIONS.PURCHASE_CREATE,
      body,
      async (manager, context) => {
        const actor = await loadActor(manager, request.currentUser.id);
        if (!actor) {
          return { kind: "unauthenticated" };
        }
        if (!actorCanAccess(actor, AUTHORIZATION_OPERATIONS.PURCHASE_CREATE, body.baseId)) {
          return { kind: "forbidden" };
        }
        const bases = await lockBases(manager, [body.baseId]);
        if (bases.kind !== "locked") return bases;
        const equipment = await lockEquipmentType(manager, body.equipmentTypeId);
        if (equipment.kind !== "locked") return equipment;
        const position = await lockAssetPosition(
          manager,
          body.baseId,
          body.equipmentTypeId,
        );
        if (position.kind !== "locked") return position;
        const purchases = rowsOf(
          await manager.query(
            `INSERT INTO public.purchase (
               base_id, equipment_type_id, quantity, status, reference_code,
               purchased_at, created_by, idempotency_key
             ) VALUES ($1, $2, $3, 'PENDING', $4, pg_catalog.now(), $5, $6)
             RETURNING ${PURCHASE_COLUMNS}`,
            [
              body.baseId,
              body.equipmentTypeId,
              body.quantity,
              body.referenceCode,
              actor.id,
              request.idempotencyKey,
            ],
          ),
        );
        if (purchases.length !== 1) {
          throw new Error("The purchase could not be persisted.");
        }
        const purchase = purchases[0];
        const dto = toPurchaseDto(purchase);
        await insertAudit(manager, {
          actorId: actor.id,
          action: "PURCHASE_CREATED",
          entityType: "purchase",
          entityId: purchase.id,
          baseId: purchase.base_id,
          afterData: {
            status: purchase.status,
            quantity: purchase.quantity,
            equipmentTypeId: purchase.equipment_type_id,
          },
        });
        return {
          ...responseResult("purchase", purchase, "purchase", toPurchaseDto),
          body: { success: true, data: { purchase: dto } },
        };
      },
    );
  }

  async function initiateTransfer(request, response) {
    const body = request.validatedBody;
    return run(
      request,
      response,
      AUTHORIZATION_OPERATIONS.TRANSFER_INITIATE,
      body,
      async (manager, context) => {
        const actor = await loadActor(manager, request.currentUser.id);
        if (!actor) return { kind: "unauthenticated" };
        if (body.sourceBaseId === body.destinationBaseId) {
          return {
            kind: "conflict",
            code: "INVALID_TRANSFER_BASES",
            message: "Source and destination bases must differ.",
          };
        }
        if (!actorCanAccess(actor, AUTHORIZATION_OPERATIONS.TRANSFER_INITIATE, body.sourceBaseId)) {
          return { kind: "forbidden" };
        }
        const bases = await lockBases(manager, [
          body.sourceBaseId,
          body.destinationBaseId,
        ]);
        if (bases.kind !== "locked") return bases;
        const equipment = await lockEquipmentType(manager, body.equipmentTypeId);
        if (equipment.kind !== "locked") return equipment;
        const positions = await lockTransferAssetPositions(manager, {
          sourceBaseId: body.sourceBaseId,
          destinationBaseId: body.destinationBaseId,
          equipmentTypeId: body.equipmentTypeId,
        });
        if (positions.kind !== "locked") return positions;
        const transfers = rowsOf(
          await manager.query(
            `INSERT INTO public.transfer (
               source_base_id, destination_base_id, equipment_type_id,
               quantity, status, idempotency_key, created_by
             ) VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
             RETURNING ${TRANSFER_COLUMNS}`,
            [
              body.sourceBaseId,
              body.destinationBaseId,
              body.equipmentTypeId,
              body.quantity,
              request.idempotencyKey,
              actor.id,
            ],
          ),
        );
        if (transfers.length !== 1) {
          throw new Error("The transfer could not be persisted.");
        }
        const transfer = transfers[0];
        const dto = toTransferDto(transfer);
        await insertAudit(manager, {
          actorId: actor.id,
          action: "TRANSFER_INITIATED",
          entityType: "transfer",
          entityId: transfer.id,
          baseId: transfer.source_base_id,
          afterData: {
            status: transfer.status,
            sourceBaseId: transfer.source_base_id,
            destinationBaseId: transfer.destination_base_id,
            equipmentTypeId: transfer.equipment_type_id,
            quantity: transfer.quantity,
          },
        });
        return {
          ...responseResult("transfer", transfer, "transfer", toTransferDto),
          body: { success: true, data: { transfer: dto } },
        };
      },
    );
  }

  async function runTransferAction(request, response, operation, action) {
    const transferId = request.params.transferId;
    const payload = { transferId };
    return run(request, response, operation, payload, async (manager, context) => {
      const actor = await loadActor(manager, request.currentUser.id);
      if (!actor) return { kind: "unauthenticated" };

      const currentTransfers = rowsOf(
        await manager.query(
          `SELECT ${TRANSFER_COLUMNS}
           FROM public.transfer
           WHERE id = $1`,
          [transferId],
        ),
      );
      if (currentTransfers.length === 0) {
        return { kind: "not-found", resource: "Transfer" };
      }
      if (currentTransfers.length !== 1) {
        throw new Error("The transfer could not be verified.");
      }
      const observed = currentTransfers[0];
      const bases = await lockBases(
        manager,
        [observed.source_base_id, observed.destination_base_id],
        { requireActive: false },
      );
      if (bases.kind !== "locked") return bases;

      const transfers = rowsOf(
        await manager.query(
          `SELECT ${TRANSFER_COLUMNS}
           FROM public.transfer
           WHERE id = $1
           FOR UPDATE`,
          [transferId],
        ),
      );
      if (transfers.length === 0) {
        return { kind: "not-found", resource: "Transfer" };
      }
      if (transfers.length !== 1) {
        throw new Error("The transfer could not be verified.");
      }
      let transfer = transfers[0];
      if (
        transfer.source_base_id !== observed.source_base_id ||
        transfer.destination_base_id !== observed.destination_base_id
      ) {
        return {
          kind: "conflict",
          code: "TRANSFER_STATE_CONFLICT",
          message: "The transfer changed while the command was being processed.",
        };
      }

      if (
        !actorCanAccess(
          actor,
          operation,
          transfer.destination_base_id,
        )
      ) {
        return { kind: "forbidden" };
      }

      if (action === "approve" || action === "reject") {
        if (
          !areTransferActorsDistinct({
            requesterId: transfer.created_by,
            approverId: actor.id,
          })
        ) {
          return {
            kind: "conflict",
            code: "TRANSFER_ACTOR_SEPARATION",
            message: "The requester cannot approve or reject their own transfer.",
          };
        }
        if (
          transfer.status !== "PENDING" ||
          transfer.approved_by !== null ||
          transfer.completed_by !== null ||
          transfer.rejected_at !== null
        ) {
          return {
            kind: "conflict",
            code: "TRANSFER_STATE_CONFLICT",
            message: "Only a pending transfer can be approved or rejected.",
          };
        }
        const lockedBases = bases.bases;
        if (
          lockedBases.get(transfer.source_base_id)?.is_active !== true ||
          lockedBases.get(transfer.destination_base_id)?.is_active !== true
        ) {
          return {
            kind: "conflict",
            code: "INACTIVE_RESOURCE",
            message: "Both transfer bases must be active.",
          };
        }
        const equipment = await lockEquipmentType(
          manager,
          transfer.equipment_type_id,
        );
        if (equipment.kind !== "locked") return equipment;
        const positions = await lockTransferAssetPositions(manager, {
          sourceBaseId: transfer.source_base_id,
          destinationBaseId: transfer.destination_base_id,
          equipmentTypeId: transfer.equipment_type_id,
        });
        if (positions.kind !== "locked") return positions;
        const approved = action === "approve";
        const updated = rowsOfCommandResult(
          await manager.query(
            `UPDATE public.transfer
             SET status = $2,
                 approved_by = CASE WHEN $3 THEN $4::uuid ELSE NULL::uuid END,
                 approved_at = CASE WHEN $3 THEN pg_catalog.now() ELSE NULL END,
                 rejected_at = CASE WHEN $3 THEN NULL ELSE pg_catalog.now() END,
                 updated_at = pg_catalog.now()
             WHERE id = $1
             RETURNING ${TRANSFER_COLUMNS}`,
            [transferId, approved ? "APPROVED" : "REJECTED", approved, actor.id],
          ),
        );
        if (updated.length !== 1) {
          throw new Error("The transfer state could not be updated.");
        }
        transfer = updated[0];
        const dto = toTransferDto(transfer);
        await insertAudit(manager, {
          actorId: actor.id,
          action: approved ? "TRANSFER_APPROVED" : "TRANSFER_REJECTED",
          entityType: "transfer",
          entityId: transfer.id,
          baseId: transfer.destination_base_id,
          beforeData: { status: "PENDING" },
          afterData: {
            status: transfer.status,
            approvedBy: transfer.approved_by,
            rejectedAt: transfer.rejected_at,
          },
        });
        return {
          ...responseResult("transfer", transfer, "transfer", toTransferDto, 200),
          body: { success: true, data: { transfer: dto } },
        };
      }

      if (
        transfer.status !== "APPROVED" ||
        !isUuid(transfer.approved_by) ||
        transfer.completed_by !== null ||
        !areTransferActorsDistinct({
          requesterId: transfer.created_by,
          approverId: transfer.approved_by,
          completionActorId: actor.id,
        })
      ) {
        return {
          kind: "conflict",
          code: "TRANSFER_STATE_CONFLICT",
          message: "The transfer is not eligible for completion by this actor.",
        };
      }

      const lockedBases = bases.bases;
      if (
        lockedBases.get(transfer.source_base_id)?.is_active !== true ||
        lockedBases.get(transfer.destination_base_id)?.is_active !== true
      ) {
        return {
          kind: "conflict",
          code: "INACTIVE_RESOURCE",
          message: "Both transfer bases must be active at completion.",
        };
      }
      const equipment = await lockEquipmentType(manager, transfer.equipment_type_id);
      if (equipment.kind !== "locked") return equipment;
      const positions = await lockTransferAssetPositions(manager, {
        sourceBaseId: transfer.source_base_id,
        destinationBaseId: transfer.destination_base_id,
        equipmentTypeId: transfer.equipment_type_id,
      });
      if (positions.kind !== "locked") return positions;
      const { sourceAsset, destinationAsset } = positions;
      const eventTimestamp = await captureInventoryEventTimestamp(manager);
      if (
        (await getAvailableBalance(manager, sourceAsset.id, eventTimestamp)) <
        BigInt(transfer.quantity)
      ) {
        return {
          kind: "conflict",
          code: "INSUFFICIENT_STOCK",
          message: "The source base does not have enough available inventory.",
        };
      }

      const updated = rowsOfCommandResult(
        await manager.query(
          `UPDATE public.transfer
           SET status = 'COMPLETED', completed_by = $2,
               completed_at = $3::timestamptz, updated_at = pg_catalog.now()
           WHERE id = $1
           RETURNING ${TRANSFER_COLUMNS}`,
          [transfer.id, actor.id, eventTimestamp],
        ),
      );
      if (updated.length !== 1) {
        throw new Error("The transfer state could not be updated.");
      }
      transfer = updated[0];
      await insertMovement(manager, {
        assetId: sourceAsset.id,
        baseId: transfer.source_base_id,
        equipmentTypeId: transfer.equipment_type_id,
        movementType: "TRANSFER_OUT",
        quantity: transfer.quantity,
        direction: "OUT",
        occurredAt: eventTimestamp,
        idempotencyKey: `transfer:${transfer.id}:out`,
        transferId: transfer.id,
        createdBy: actor.id,
      });
      await insertMovement(manager, {
        assetId: destinationAsset.id,
        baseId: transfer.destination_base_id,
        equipmentTypeId: transfer.equipment_type_id,
        movementType: "TRANSFER_IN",
        quantity: transfer.quantity,
        direction: "IN",
        occurredAt: eventTimestamp,
        idempotencyKey: `transfer:${transfer.id}:in`,
        transferId: transfer.id,
        createdBy: actor.id,
      });
      const dto = toTransferDto(transfer);
      await insertAudit(manager, {
        actorId: actor.id,
        action: "TRANSFER_COMPLETED",
        entityType: "transfer",
        entityId: transfer.id,
        baseId: transfer.destination_base_id,
        beforeData: { status: "APPROVED" },
        afterData: {
          status: transfer.status,
          sourceBaseId: transfer.source_base_id,
          destinationBaseId: transfer.destination_base_id,
          quantity: transfer.quantity,
          completedBy: actor.id,
        },
      });
      return {
        ...responseResult("transfer", transfer, "transfer", toTransferDto, 200),
        body: { success: true, data: { transfer: dto } },
      };
    });
  }

  async function createAssignment(request, response) {
    const body = request.validatedBody;
    return run(
      request,
      response,
      AUTHORIZATION_OPERATIONS.ASSIGNMENT_CREATE,
      body,
      async (manager, context) => {
        const actor = await loadActor(manager, request.currentUser.id);
        if (!actor) return { kind: "unauthenticated" };
        const assetRows = rowsOf(
          await manager.query(
            `SELECT id, base_id, equipment_type_id
             FROM public.asset
             WHERE id = $1`,
            [body.assetId],
          ),
        );
        if (assetRows.length === 0) {
          return { kind: "not-found", resource: "Asset" };
        }
        if (assetRows.length !== 1) {
          throw new Error("The asset position could not be verified.");
        }
        const initialAsset = assetRows[0];
        if (!actorCanAccess(actor, AUTHORIZATION_OPERATIONS.ASSIGNMENT_CREATE, initialAsset.base_id)) {
          return { kind: "forbidden" };
        }
        const bases = await lockBases(manager, [initialAsset.base_id]);
        if (bases.kind !== "locked") return bases;
        const equipment = await lockEquipmentType(
          manager,
          initialAsset.equipment_type_id,
        );
        if (equipment.kind !== "locked") return equipment;
        const asset = await lockAssetById(manager, body.assetId);
        if (!asset) return { kind: "not-found", resource: "Asset" };
        if (
          asset.base_id !== initialAsset.base_id ||
          asset.equipment_type_id !== initialAsset.equipment_type_id
        ) {
          return {
            kind: "conflict",
            code: "ASSET_POSITION_CHANGED",
            message: "The asset position changed while the request was being processed.",
          };
        }
        if (asset.is_active !== true) {
          return {
            kind: "conflict",
            code: "INACTIVE_RESOURCE",
            message: "An active asset position is required.",
          };
        }
        const eventTimestamp = await captureInventoryEventTimestamp(manager);
        if (
          (await getAvailableBalance(manager, asset.id, eventTimestamp)) <
          BigInt(body.quantity)
        ) {
          return {
            kind: "conflict",
            code: "INSUFFICIENT_STOCK",
            message: "The base does not have enough available inventory.",
          };
        }

        const assignments = rowsOf(
          await manager.query(
            `INSERT INTO public.assignment (
               asset_id, base_id, equipment_type_id, quantity,
               personnel_reference, assigned_by, assigned_at, idempotency_key
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
             RETURNING ${ASSIGNMENT_COLUMNS}`,
            [
              asset.id,
              asset.base_id,
              asset.equipment_type_id,
              body.quantity,
              body.personnelReference,
              actor.id,
              eventTimestamp,
              request.idempotencyKey,
            ],
          ),
        );
        if (assignments.length !== 1) {
          throw new Error("The assignment could not be persisted.");
        }
        const assignment = assignments[0];
        await insertMovement(manager, {
          assetId: asset.id,
          baseId: asset.base_id,
          equipmentTypeId: asset.equipment_type_id,
          movementType: "ASSIGNMENT",
          quantity: assignment.quantity,
          direction: "OUT",
          occurredAt: eventTimestamp,
          idempotencyKey: `assignment:${assignment.id}:initial`,
          assignmentId: assignment.id,
          createdBy: actor.id,
        });
        const dto = toAssignmentDto(assignment);
        await insertAudit(manager, {
          actorId: actor.id,
          action: "ASSIGNMENT_CREATED",
          entityType: "assignment",
          entityId: assignment.id,
          baseId: assignment.base_id,
          afterData: {
            status: assignment.status,
            assetId: assignment.asset_id,
            equipmentTypeId: assignment.equipment_type_id,
            quantity: assignment.quantity,
          },
        });
        return {
          ...responseResult("assignment", assignment, "assignment", toAssignmentDto),
          body: { success: true, data: { assignment: dto } },
        };
      },
    );
  }

  async function recordReturn(request, response) {
    const assignmentId = request.params.assignmentId;
    const body = request.validatedBody;
    return run(
      request,
      response,
      AUTHORIZATION_OPERATIONS.ASSIGNMENT_RETURN,
      { assignmentId, ...body },
      async (manager, context) => {
        const actor = await loadActor(manager, request.currentUser.id);
        if (!actor) return { kind: "unauthenticated" };
        const references = rowsOf(
          await manager.query(
            `SELECT base_id
             FROM public.assignment
             WHERE id = $1`,
            [assignmentId],
          ),
        );
        if (references.length === 0) {
          return { kind: "not-found", resource: "Assignment" };
        }
        if (references.length !== 1) {
          throw new Error("The assignment could not be verified.");
        }
        if (!actorCanAccess(actor, AUTHORIZATION_OPERATIONS.ASSIGNMENT_RETURN, references[0].base_id)) {
          return { kind: "forbidden" };
        }
        const bases = await lockBases(manager, [references[0].base_id], {
          requireActive: false,
        });
        if (bases.kind !== "locked") return bases;
        const assignments = rowsOf(
          await manager.query(
            `SELECT id, asset_id, base_id, equipment_type_id, quantity,
                    returned_quantity, status
             FROM public.assignment
             WHERE id = $1
             FOR UPDATE`,
            [assignmentId],
          ),
        );
        if (assignments.length === 0) {
          return { kind: "not-found", resource: "Assignment" };
        }
        if (assignments.length !== 1) {
          throw new Error("The assignment could not be verified.");
        }
        const assignment = assignments[0];
        if (assignment.status === "CANCELLED") {
          return {
            kind: "conflict",
            code: "RETURN_NOT_ALLOWED",
            message: "Returns cannot be recorded for a cancelled assignment.",
          };
        }
        const outstanding =
          Number(assignment.quantity) - Number(assignment.returned_quantity);
        if (!Number.isSafeInteger(outstanding) || body.quantity > outstanding) {
          return {
            kind: "conflict",
            code: "RETURN_QUANTITY_EXCEEDED",
            message: "The return exceeds the outstanding assigned quantity.",
          };
        }
        const asset = await lockAssetById(manager, assignment.asset_id);
        if (!asset) return { kind: "not-found", resource: "Asset" };
        if (
          asset.base_id !== assignment.base_id ||
          asset.equipment_type_id !== assignment.equipment_type_id
        ) {
          return {
            kind: "conflict",
            code: "ASSET_POSITION_CHANGED",
            message: "The asset position changed while the request was being processed.",
          };
        }
        const eventTimestamp = await captureInventoryEventTimestamp(manager);
        const returnedRows = rowsOf(
          await manager.query(
            `INSERT INTO public.return_operation (
               assignment_id, asset_id, base_id, equipment_type_id, quantity,
               idempotency_key, returned_by, returned_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
             RETURNING ${RETURN_COLUMNS}`,
            [
              assignment.id,
              assignment.asset_id,
              assignment.base_id,
              assignment.equipment_type_id,
              body.quantity,
              request.idempotencyKey,
              actor.id,
              eventTimestamp,
            ],
          ),
        );
        if (returnedRows.length !== 1) {
          throw new Error("The return could not be persisted.");
        }
        const updatedAssignments = rowsOf(
          await manager.query(
            `SELECT id, status, returned_quantity
             FROM public.assignment
             WHERE id = $1`,
            [assignment.id],
          ),
        );
        if (updatedAssignments.length !== 1) {
          throw new Error("The returned assignment could not be verified.");
        }
        const returned = returnedRows[0];
        const dto = toReturnDto(returned, updatedAssignments[0]);
        await insertAudit(manager, {
          actorId: actor.id,
          action: "ASSIGNMENT_RETURN_RECORDED",
          entityType: "return_operation",
          entityId: returned.id,
          baseId: returned.base_id,
          afterData: {
            assignmentId: returned.assignment_id,
            quantity: returned.quantity,
            assignmentStatus: updatedAssignments[0].status,
          },
        });
        return {
          ...responseResult("return_operation", returned, "return", () => dto),
          body: { success: true, data: { return: dto } },
        };
      },
    );
  }

  async function recordExpenditure(request, response) {
    const body = request.validatedBody;
    return run(
      request,
      response,
      AUTHORIZATION_OPERATIONS.EXPENDITURE_RECORD,
      body,
      async (manager, context) => {
        const actor = await loadActor(manager, request.currentUser.id);
        if (!actor) return { kind: "unauthenticated" };
        const assetRows = rowsOf(
          await manager.query(
            `SELECT id, base_id, equipment_type_id
             FROM public.asset
             WHERE id = $1`,
            [body.assetId],
          ),
        );
        if (assetRows.length === 0) {
          return { kind: "not-found", resource: "Asset" };
        }
        if (assetRows.length !== 1) {
          throw new Error("The asset position could not be verified.");
        }
        const initialAsset = assetRows[0];
        if (!actorCanAccess(actor, AUTHORIZATION_OPERATIONS.EXPENDITURE_RECORD, initialAsset.base_id)) {
          return { kind: "forbidden" };
        }
        const bases = await lockBases(manager, [initialAsset.base_id]);
        if (bases.kind !== "locked") return bases;
        const equipment = await lockEquipmentType(
          manager,
          initialAsset.equipment_type_id,
        );
        if (equipment.kind !== "locked") return equipment;
        const asset = await lockAssetById(manager, body.assetId);
        if (!asset) return { kind: "not-found", resource: "Asset" };
        if (
          asset.base_id !== initialAsset.base_id ||
          asset.equipment_type_id !== initialAsset.equipment_type_id
        ) {
          return {
            kind: "conflict",
            code: "ASSET_POSITION_CHANGED",
            message: "The asset position changed while the request was being processed.",
          };
        }
        if (asset.is_active !== true) {
          return {
            kind: "conflict",
            code: "INACTIVE_RESOURCE",
            message: "An active asset position is required.",
          };
        }
        const eventTimestamp = await captureInventoryEventTimestamp(manager);
        if (
          (await getAvailableBalance(manager, asset.id, eventTimestamp)) <
          BigInt(body.quantity)
        ) {
          return {
            kind: "conflict",
            code: "INSUFFICIENT_STOCK",
            message: "The base does not have enough available inventory.",
          };
        }
        const expenditures = rowsOf(
          await manager.query(
            `INSERT INTO public.expenditure (
               asset_id, base_id, equipment_type_id, quantity, reason_code,
               notes, recorded_by, expended_at, idempotency_key
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)
             RETURNING ${EXPENDITURE_COLUMNS}`,
            [
              asset.id,
              asset.base_id,
              asset.equipment_type_id,
              body.quantity,
              body.reasonCode,
              body.notes,
              actor.id,
              eventTimestamp,
              request.idempotencyKey,
            ],
          ),
        );
        if (expenditures.length !== 1) {
          throw new Error("The expenditure could not be persisted.");
        }
        const expenditure = expenditures[0];
        await insertMovement(manager, {
          assetId: asset.id,
          baseId: asset.base_id,
          equipmentTypeId: asset.equipment_type_id,
          movementType: "EXPENDITURE",
          quantity: expenditure.quantity,
          direction: "OUT",
          occurredAt: eventTimestamp,
          idempotencyKey: `expenditure:${expenditure.id}:movement`,
          expenditureId: expenditure.id,
          createdBy: actor.id,
        });
        const dto = toExpenditureDto(expenditure);
        await insertAudit(manager, {
          actorId: actor.id,
          action: "EXPENDITURE_RECORDED",
          entityType: "expenditure",
          entityId: expenditure.id,
          baseId: expenditure.base_id,
          afterData: {
            quantity: expenditure.quantity,
            reasonCode: expenditure.reason_code,
            assetId: expenditure.asset_id,
          },
        });
        return {
          ...responseResult("expenditure", expenditure, "expenditure", toExpenditureDto),
          body: { success: true, data: { expenditure: dto } },
        };
      },
    );
  }

  return Object.freeze({
    createPurchase,
    initiateTransfer,
    approveTransfer: (request, response) =>
      runTransferAction(
        request,
        response,
        AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE,
        "approve",
      ),
    rejectTransfer: (request, response) =>
      runTransferAction(
        request,
        response,
        AUTHORIZATION_OPERATIONS.TRANSFER_REJECT,
        "reject",
      ),
    completeTransfer: (request, response) =>
      runTransferAction(
        request,
        response,
        AUTHORIZATION_OPERATIONS.TRANSFER_COMPLETE,
        "complete",
      ),
    createAssignment,
    recordReturn,
    recordExpenditure,
  });
}
