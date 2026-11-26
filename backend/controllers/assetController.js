import {
  sendDatabaseError,
  sendConflict,
  sendNotFound,
} from "../utils/apiResponses.js";
import { writeBusinessAudit } from "../utils/businessAudit.js";
import {
  calculateInventoryBalance,
  INVENTORY_CTES,
  toSafeNonNegativeInteger,
} from "../utils/inventoryBalance.js";

export { calculateInventoryBalance };

const INVENTORY_COLUMNS = `
  id, base_id, base_code, base_name, equipment_type_id,
  equipment_type_code, equipment_type_name, equipment_type_category,
  opening_balance, purchases, transfers_in, transfers_out, assigned_out,
  returned, expended, is_active, opening_at
`;

function toInventoryDto(row) {
  const balance = calculateInventoryBalance({
    openingBalance: row.opening_balance,
    purchases: row.purchases,
    transfersIn: row.transfers_in,
    transfersOut: row.transfers_out,
    assignedOut: row.assigned_out,
    returned: row.returned,
    expended: row.expended,
  });
  return {
    id: row.id,
    base: {
      id: row.base_id,
      code: row.base_code,
      name: row.base_name,
    },
    equipmentType: {
      id: row.equipment_type_id,
      code: row.equipment_type_code,
      name: row.equipment_type_name,
      category: row.equipment_type_category,
    },
    ...balance,
    isActive: row.is_active,
    openingAt: row.opening_at,
  };
}

function paginationMeta(countRows, limit, offset) {
  const total = Number(countRows[0]?.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Inventory count is invalid.");
  }
  return { limit, offset, total };
}

async function loadInventory(dataSource, {
  baseId,
  equipmentTypeId = null,
  assetId = null,
  limit = 50,
  offset = 0,
}) {
  const parameters = [baseId, equipmentTypeId, assetId, limit, offset];
  const [rows, countRows] = await Promise.all([
    dataSource.query(
      `${INVENTORY_CTES}
       SELECT ${INVENTORY_COLUMNS}
       FROM inventory_rows
       WHERE ($1::uuid IS NULL OR base_id = $1)
         AND ($2::uuid IS NULL OR equipment_type_id = $2)
         AND ($3::uuid IS NULL OR id = $3)
       ORDER BY base_name, equipment_type_name, id
       LIMIT $4 OFFSET $5`,
      parameters,
    ),
    dataSource.query(
      `SELECT COUNT(*) AS total
       FROM public.asset asset
       WHERE ($1::uuid IS NULL OR asset.base_id = $1)
         AND ($2::uuid IS NULL OR asset.equipment_type_id = $2)
         AND ($3::uuid IS NULL OR asset.id = $3)`,
      [baseId, equipmentTypeId, assetId],
    ),
  ]);
  if (
    !Array.isArray(rows) ||
    !Array.isArray(countRows) ||
    countRows.length !== 1
  ) {
    throw new Error("Could not retrieve inventory.");
  }
  return {
    items: rows.map(toInventoryDto),
    meta: paginationMeta(countRows, limit, offset),
  };
}

export function createInventoryController({ dataSource }) {
  return {
    async createOpeningStock(request, response) {
      const { baseId, equipmentTypeId, openingBalance } =
        request.validatedBody;
      try {
        const result = await dataSource.transaction(async (manager) => {
          const bases = await manager.query(
            `SELECT id, is_active
             FROM public.base
             WHERE id = $1
             FOR SHARE`,
            [baseId],
          );
          if (!Array.isArray(bases) || bases.length !== 1) {
            return { kind: "base-not-found" };
          }
          if (bases[0].is_active !== true) {
            return { kind: "inactive-base" };
          }

          const equipmentTypes = await manager.query(
            `SELECT id, is_active
             FROM public.equipment_type
             WHERE id = $1
             FOR SHARE`,
            [equipmentTypeId],
          );
          if (!Array.isArray(equipmentTypes) || equipmentTypes.length !== 1) {
            return { kind: "equipment-type-not-found" };
          }
          if (equipmentTypes[0].is_active !== true) {
            return { kind: "inactive-equipment-type" };
          }

          const assets = await manager.query(
            `INSERT INTO public.asset (
               base_id, equipment_type_id, opening_balance, opening_at, is_active
             ) VALUES ($1, $2, $3, pg_catalog.clock_timestamp(), TRUE)
             RETURNING id, base_id, equipment_type_id, opening_balance, opening_at`,
            [baseId, equipmentTypeId, openingBalance],
          );
          if (!Array.isArray(assets) || assets.length !== 1) {
            throw new Error("The opening stock could not be persisted.");
          }
          const asset = assets[0];
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "OPENING_STOCK_CREATED",
            entityType: "asset",
            entityId: asset.id,
            baseId: asset.base_id,
            afterData: {
              baseId: asset.base_id,
              equipmentTypeId: asset.equipment_type_id,
              openingBalance: asset.opening_balance,
              openingAt: asset.opening_at,
            },
          });
          return { kind: "created", asset };
        });

        if (result.kind === "base-not-found") {
          return sendNotFound(response, "Base");
        }
        if (result.kind === "equipment-type-not-found") {
          return sendNotFound(response, "Equipment type");
        }
        if (
          result.kind === "inactive-base" ||
          result.kind === "inactive-equipment-type"
        ) {
          return sendConflict(
            response,
            "INACTIVE_RESOURCE",
            "An active base and equipment type are required.",
          );
        }
        return response.status(201).json({
          success: true,
          data: {
            openingStock: {
              id: result.asset.id,
              baseId: result.asset.base_id,
              equipmentTypeId: result.asset.equipment_type_id,
              openingBalance: toSafeNonNegativeInteger(
                result.asset.opening_balance,
              ),
              openingAt: result.asset.opening_at,
            },
          },
        });
      } catch (error) {
        if (
          (error?.code ?? error?.driverError?.code) === "23505" &&
          (error?.constraint ?? error?.driverError?.constraint) ===
            "uq_asset_base_equipment"
        ) {
          return sendConflict(
            response,
            "OPENING_STOCK_ALREADY_SET",
            "Opening stock has already been set for this base and equipment type.",
          );
        }
        return sendDatabaseError(response, error);
      }
    },

    async list(request, response) {
      try {
        const { limit, offset, baseId: requestedBaseId, equipmentTypeId } =
          request.validatedQuery;
        if (
          request.authorizedBaseId !== null &&
          requestedBaseId !== null &&
          request.authorizedBaseId !== requestedBaseId
        ) {
          return response.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You are not allowed to access this inventory scope.",
            },
          });
        }
        const result = await loadInventory(dataSource, {
          baseId: request.authorizedBaseId ?? requestedBaseId,
          equipmentTypeId,
          limit,
          offset,
        });
        return response.status(200).json({
          success: true,
          data: { inventory: result.items },
          meta: result.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async getById(request, response) {
      try {
        const result = await loadInventory(dataSource, {
          baseId: request.authorizedBaseId,
          assetId: request.params.id,
          limit: 1,
        });
        if (result.items.length === 0) {
          return sendNotFound(response, "Inventory record");
        }
        return response.status(200).json({
          success: true,
          data: { inventory: result.items[0] },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async byBase(request, response) {
      try {
        const {
          baseId: requestedBaseId,
          equipmentTypeId,
          limit,
          offset,
        } = request.validatedQuery;
        if (
          requestedBaseId !== null &&
          requestedBaseId !== request.params.baseId
        ) {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "The request is invalid.",
            },
          });
        }
        const result = await loadInventory(dataSource, {
          baseId: request.params.baseId,
          equipmentTypeId,
          limit,
          offset,
        });
        return response.status(200).json({
          success: true,
          data: { inventory: result.items },
          meta: result.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async byEquipmentType(request, response) {
      try {
        const {
          baseId: requestedBaseId,
          equipmentTypeId: requestedEquipmentTypeId,
          limit,
          offset,
        } = request.validatedQuery;
        if (
          requestedEquipmentTypeId !== null &&
          requestedEquipmentTypeId !== request.params.equipmentTypeId
        ) {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "The request is invalid.",
            },
          });
        }
        if (
          request.authorizedBaseId !== null &&
          requestedBaseId !== null &&
          request.authorizedBaseId !== requestedBaseId
        ) {
          return response.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You are not allowed to access this inventory scope.",
            },
          });
        }
        const equipmentTypes = await dataSource.query(
          "SELECT id FROM public.equipment_type WHERE id = $1",
          [request.params.equipmentTypeId],
        );
        if (!Array.isArray(equipmentTypes)) {
          return sendDatabaseError(
            response,
            new Error("Could not verify equipment type."),
          );
        }
        if (equipmentTypes.length === 0) {
          return sendNotFound(response, "Equipment type");
        }

        const result = await loadInventory(dataSource, {
          baseId: request.authorizedBaseId ?? requestedBaseId,
          equipmentTypeId: request.params.equipmentTypeId,
          limit,
          offset,
        });
        return response.status(200).json({
          success: true,
          data: { inventory: result.items },
          meta: result.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async summary(request, response) {
      try {
        const rows = await dataSource.query(
          `${INVENTORY_CTES}
           SELECT
             base_id, base_code, base_name, equipment_type_id,
             equipment_type_code, equipment_type_name,
             COUNT(*) AS record_count,
             SUM(opening_balance) AS opening_balance,
             SUM(purchases) AS purchases,
             SUM(transfers_in) AS transfers_in,
             SUM(transfers_out) AS transfers_out,
             SUM(assigned_out) AS assigned_out,
             SUM(returned) AS returned,
             SUM(expended) AS expended
           FROM inventory_rows
           WHERE ($1::uuid IS NULL OR base_id = $1)
           GROUP BY
             base_id, base_code, base_name, equipment_type_id,
             equipment_type_code, equipment_type_name
           ORDER BY base_name, equipment_type_name, equipment_type_id`,
          [request.authorizedBaseId],
        );
        if (!Array.isArray(rows)) {
          return sendDatabaseError(response, new Error("Could not retrieve summary."));
        }

        const summary = rows.map((row) => ({
          base: {
            id: row.base_id,
            code: row.base_code,
            name: row.base_name,
          },
          equipmentType: {
            id: row.equipment_type_id,
            code: row.equipment_type_code,
            name: row.equipment_type_name,
          },
          recordCount: toSafeNonNegativeInteger(row.record_count),
          ...calculateInventoryBalance({
            openingBalance: row.opening_balance,
            purchases: row.purchases,
            transfersIn: row.transfers_in,
            transfersOut: row.transfers_out,
            assignedOut: row.assigned_out,
            returned: row.returned,
            expended: row.expended,
          }),
        }));
        return response.status(200).json({
          success: true,
          data: { summary },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
