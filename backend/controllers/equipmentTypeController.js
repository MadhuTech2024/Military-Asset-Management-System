import {
  sendDatabaseError,
  sendNotFound,
} from "../utils/apiResponses.js";
import { writeBusinessAudit } from "../utils/businessAudit.js";
import { rowsOfCommandResult } from "../utils/databaseResults.js";

const EQUIPMENT_TYPE_COLUMNS = `
  id, code, name, category, description, is_active, created_at, updated_at
`;

function toEquipmentTypeDto(equipmentType) {
  return {
    id: equipmentType.id,
    code: equipmentType.code,
    name: equipmentType.name,
    category: equipmentType.category,
    description: equipmentType.description,
    isActive: equipmentType.is_active,
    createdAt: equipmentType.created_at,
    updatedAt: equipmentType.updated_at,
  };
}

function toEquipmentTypeAuditSnapshot(equipmentType) {
  return {
    code: equipmentType.code,
    name: equipmentType.name,
    category: equipmentType.category,
    isActive: equipmentType.is_active,
  };
}

export function createEquipmentTypeController({ dataSource }) {
  return {
    async list(request, response) {
      try {
        const { limit, offset, isActive, search } = request.validatedQuery;
        const [countRows, equipmentTypes] = await Promise.all([
          dataSource.query(
            `SELECT COUNT(*) AS total
             FROM public.equipment_type
             WHERE ($1::boolean IS NULL OR is_active = $1)
               AND ($2::text IS NULL OR
                    pg_catalog.strpos(pg_catalog.lower(code), pg_catalog.lower($2)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(name), pg_catalog.lower($2)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(category), pg_catalog.lower($2)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(description), pg_catalog.lower($2)) > 0)`,
            [isActive ?? null, search],
          ),
          dataSource.query(
            `SELECT ${EQUIPMENT_TYPE_COLUMNS}
             FROM public.equipment_type
             WHERE ($1::boolean IS NULL OR is_active = $1)
               AND ($2::text IS NULL OR
                    pg_catalog.strpos(pg_catalog.lower(code), pg_catalog.lower($2)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(name), pg_catalog.lower($2)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(category), pg_catalog.lower($2)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(description), pg_catalog.lower($2)) > 0)
             ORDER BY name, id
             LIMIT $3 OFFSET $4`,
            [isActive ?? null, search, limit, offset],
          ),
        ]);
        if (
          !Array.isArray(countRows) ||
          countRows.length !== 1 ||
          !Array.isArray(equipmentTypes)
        ) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }

        return response.status(200).json({
          success: true,
          data: { equipmentTypes: equipmentTypes.map(toEquipmentTypeDto) },
          meta: { limit, offset, total: Number(countRows[0].total) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async getById(request, response) {
      try {
        const equipmentTypes = await dataSource.query(
          `SELECT ${EQUIPMENT_TYPE_COLUMNS}
           FROM public.equipment_type
           WHERE id = $1`,
          [request.params.id],
        );
        if (!Array.isArray(equipmentTypes)) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        if (equipmentTypes.length === 0) {
          return sendNotFound(response, "Equipment type");
        }
        return response.status(200).json({
          success: true,
          data: { equipmentType: toEquipmentTypeDto(equipmentTypes[0]) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async create(request, response) {
      const { code, name, category, description } = request.validatedBody;
      try {
        const equipmentType = await dataSource.transaction(async (manager) => {
          const equipmentTypes = await manager.query(
            `INSERT INTO public.equipment_type
               (code, name, category, description)
             VALUES ($1, $2, $3, $4)
             RETURNING ${EQUIPMENT_TYPE_COLUMNS}`,
            [code, name, category, description],
          );
          if (!Array.isArray(equipmentTypes) || equipmentTypes.length !== 1) {
            throw new Error("The equipment type could not be persisted.");
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "EQUIPMENT_TYPE_CREATED",
            entityType: "equipment_type",
            entityId: equipmentTypes[0].id,
            afterData: toEquipmentTypeAuditSnapshot(equipmentTypes[0]),
          });
          return equipmentTypes[0];
        });
        return response.status(201).json({
          success: true,
          data: {
            equipmentType: toEquipmentTypeDto(equipmentType),
          },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async update(request, response) {
      const { id } = request.params;
      const body = request.validatedBody;
      try {
        const result = await dataSource.transaction(async (manager) => {
          const currentTypes = await manager.query(
            `SELECT ${EQUIPMENT_TYPE_COLUMNS}
             FROM public.equipment_type
             WHERE id = $1
             FOR UPDATE`,
            [id],
          );
          if (!Array.isArray(currentTypes) || currentTypes.length > 1) {
            return { kind: "database-error" };
          }
          if (currentTypes.length === 0) {
            return { kind: "not-found" };
          }

          const equipmentTypes = rowsOfCommandResult(
            await manager.query(
              `UPDATE public.equipment_type
               SET code = CASE WHEN $2 THEN $3 ELSE code END,
                   name = CASE WHEN $4 THEN $5 ELSE name END,
                   category = CASE WHEN $6 THEN $7 ELSE category END,
                   description = CASE WHEN $8 THEN $9 ELSE description END,
                   updated_at = now()
               WHERE id = $1
               RETURNING ${EQUIPMENT_TYPE_COLUMNS}`,
              [
                id,
                body.code !== undefined,
                body.code ?? null,
                body.name !== undefined,
                body.name ?? null,
                body.category !== undefined,
                body.category ?? null,
                Object.hasOwn(body, "description"),
                body.description ?? null,
              ],
            ),
          );
          if (!Array.isArray(equipmentTypes) || equipmentTypes.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "EQUIPMENT_TYPE_UPDATED",
            entityType: "equipment_type",
            entityId: equipmentTypes[0].id,
            beforeData: toEquipmentTypeAuditSnapshot(currentTypes[0]),
            afterData: toEquipmentTypeAuditSnapshot(equipmentTypes[0]),
          });
          return { kind: "updated", equipmentType: equipmentTypes[0] };
        });
        if (result.kind === "not-found") {
          return sendNotFound(response, "Equipment type");
        }
        if (result.kind !== "updated") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        return response.status(200).json({
          success: true,
          data: {
            equipmentType: toEquipmentTypeDto(result.equipmentType),
          },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async setActive(request, response) {
      try {
        const result = await dataSource.transaction(async (manager) => {
          const currentTypes = await manager.query(
            `SELECT ${EQUIPMENT_TYPE_COLUMNS}
             FROM public.equipment_type
             WHERE id = $1
             FOR UPDATE`,
            [request.params.id],
          );
          if (!Array.isArray(currentTypes) || currentTypes.length > 1) {
            return { kind: "database-error" };
          }
          if (currentTypes.length === 0) {
            return { kind: "not-found" };
          }

          const current = currentTypes[0];
          if (current.is_active === request.validatedBody.isActive) {
            return { kind: "unchanged", equipmentType: current };
          }

          const equipmentTypes = rowsOfCommandResult(
            await manager.query(
              `UPDATE public.equipment_type
               SET is_active = $2, updated_at = now()
               WHERE id = $1
               RETURNING ${EQUIPMENT_TYPE_COLUMNS}`,
              [request.params.id, request.validatedBody.isActive],
            ),
          );
          if (!Array.isArray(equipmentTypes) || equipmentTypes.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: equipmentTypes[0].is_active
              ? "EQUIPMENT_TYPE_ACTIVATED"
              : "EQUIPMENT_TYPE_DEACTIVATED",
            entityType: "equipment_type",
            entityId: equipmentTypes[0].id,
            beforeData: { isActive: current.is_active },
            afterData: { isActive: equipmentTypes[0].is_active },
          });
          return { kind: "updated", equipmentType: equipmentTypes[0] };
        });
        if (result.kind === "not-found") {
          return sendNotFound(response, "Equipment type");
        }
        if (result.kind !== "updated" && result.kind !== "unchanged") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        return response.status(200).json({
          success: true,
          data: {
            equipmentType: toEquipmentTypeDto(result.equipmentType),
          },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
