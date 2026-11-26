import {
  sendConflict,
  sendDatabaseError,
  sendNotFound,
} from "../utils/apiResponses.js";
import { writeBusinessAudit } from "../utils/businessAudit.js";
import { rowsOfCommandResult } from "../utils/databaseResults.js";

const BASE_COLUMNS = `
  id, code, name, location_name, is_active, created_at, updated_at
`;

const BASE_REFERENCES_QUERY = `
  SELECT
    EXISTS (SELECT 1 FROM public.app_user WHERE base_id = $1) AS has_users,
    EXISTS (SELECT 1 FROM public.asset WHERE base_id = $1) AS has_assets,
    EXISTS (SELECT 1 FROM public.purchase WHERE base_id = $1) AS has_purchases,
    EXISTS (
      SELECT 1 FROM public.transfer
      WHERE source_base_id = $1 OR destination_base_id = $1
    ) AS has_transfers,
    EXISTS (SELECT 1 FROM public.assignment WHERE base_id = $1)
      AS has_assignments,
    EXISTS (SELECT 1 FROM public.expenditure WHERE base_id = $1)
      AS has_expenditures,
    EXISTS (SELECT 1 FROM public.return_operation WHERE base_id = $1)
      AS has_returns,
    EXISTS (SELECT 1 FROM public.inventory_movement WHERE base_id = $1)
      AS has_movements
`;

function toBaseDto(base) {
  return {
    id: base.id,
    code: base.code,
    name: base.name,
    locationName: base.location_name,
    isActive: base.is_active,
    createdAt: base.created_at,
    updatedAt: base.updated_at,
  };
}

function toBaseAuditSnapshot(base) {
  return {
    code: base.code,
    name: base.name,
    locationName: base.location_name,
    isActive: base.is_active,
  };
}

function hasReferences(row) {
  return Object.values(row).some((value) => value === true);
}

export function createBaseController({ dataSource }) {
  return {
    async list(request, response) {
      try {
        const { limit, offset, isActive, search } = request.validatedQuery;
        const baseId = request.authorizedBaseId;
        const [countRows, bases] = await Promise.all([
          dataSource.query(
            `SELECT COUNT(*) AS total
             FROM public.base
             WHERE ($1::uuid IS NULL OR id = $1)
               AND ($2::boolean IS NULL OR is_active = $2)
               AND ($3::text IS NULL OR
                    pg_catalog.strpos(pg_catalog.lower(code), pg_catalog.lower($3)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(name), pg_catalog.lower($3)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(location_name), pg_catalog.lower($3)) > 0)`,
            [baseId, isActive ?? null, search],
          ),
          dataSource.query(
            `SELECT ${BASE_COLUMNS}
             FROM public.base
             WHERE ($1::uuid IS NULL OR id = $1)
               AND ($2::boolean IS NULL OR is_active = $2)
               AND ($3::text IS NULL OR
                    pg_catalog.strpos(pg_catalog.lower(code), pg_catalog.lower($3)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(name), pg_catalog.lower($3)) > 0 OR
                    pg_catalog.strpos(pg_catalog.lower(location_name), pg_catalog.lower($3)) > 0)
             ORDER BY name, id
             LIMIT $4 OFFSET $5`,
            [baseId, isActive ?? null, search, limit, offset],
          ),
        ]);
        if (
          !Array.isArray(countRows) ||
          countRows.length !== 1 ||
          !Array.isArray(bases)
        ) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }

        return response.status(200).json({
          success: true,
          data: { bases: bases.map(toBaseDto) },
          meta: { limit, offset, total: Number(countRows[0].total) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async listTransferDestinations(request, response) {
      try {
        const { limit, offset } = request.validatedQuery;
        const sourceBaseId = request.authorizedBaseId;
        const [countRows, bases] = await Promise.all([
          dataSource.query(
            `SELECT COUNT(*) AS total
             FROM public.base base
             WHERE base.is_active = TRUE
               AND ($1::uuid IS NULL OR base.id <> $1)`,
            [sourceBaseId],
          ),
          dataSource.query(
            `SELECT base.id, base.code, base.name
             FROM public.base base
             WHERE base.is_active = TRUE
               AND ($1::uuid IS NULL OR base.id <> $1)
             ORDER BY base.name, base.id
             LIMIT $2 OFFSET $3`,
            [sourceBaseId, limit, offset],
          ),
        ]);
        if (
          !Array.isArray(countRows) ||
          countRows.length !== 1 ||
          !Array.isArray(bases)
        ) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        const total = Number(countRows[0].total);
        if (!Number.isSafeInteger(total) || total < 0) {
          return sendDatabaseError(response, new Error("Base count is invalid."));
        }

        return response.status(200).json({
          success: true,
          data: {
            bases: bases.map(({ id, code, name }) => ({ id, code, name })),
          },
          meta: { limit, offset, total },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async getById(request, response) {
      try {
        const bases = await dataSource.query(
          `SELECT ${BASE_COLUMNS}
           FROM public.base
           WHERE id = $1`,
          [request.params.id],
        );
        if (!Array.isArray(bases)) {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        if (bases.length === 0) {
          return sendNotFound(response, "Base");
        }
        return response.status(200).json({
          success: true,
          data: { base: toBaseDto(bases[0]) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async create(request, response) {
      const { code, name, locationName } = request.validatedBody;
      try {
        const base = await dataSource.transaction(async (manager) => {
          const bases = await manager.query(
            `INSERT INTO public.base (code, name, location_name)
             VALUES ($1, $2, $3)
             RETURNING ${BASE_COLUMNS}`,
            [code, name, locationName],
          );
          if (!Array.isArray(bases) || bases.length !== 1) {
            throw new Error("The base could not be persisted.");
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "BASE_CREATED",
            entityType: "base",
            entityId: bases[0].id,
            baseId: bases[0].id,
            afterData: toBaseAuditSnapshot(bases[0]),
          });
          return bases[0];
        });
        return response.status(201).json({
          success: true,
          data: { base: toBaseDto(base) },
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
          const currentBases = await manager.query(
            `SELECT ${BASE_COLUMNS}
             FROM public.base
             WHERE id = $1
             FOR UPDATE`,
            [id],
          );
          if (!Array.isArray(currentBases) || currentBases.length > 1) {
            return { kind: "database-error" };
          }
          if (currentBases.length === 0) {
            return { kind: "not-found" };
          }

          const bases = rowsOfCommandResult(
            await manager.query(
              `UPDATE public.base
               SET code = CASE WHEN $2 THEN $3 ELSE code END,
                   name = CASE WHEN $4 THEN $5 ELSE name END,
                   location_name = CASE WHEN $6 THEN $7 ELSE location_name END,
                   updated_at = now()
               WHERE id = $1
               RETURNING ${BASE_COLUMNS}`,
              [
                id,
                body.code !== undefined,
                body.code ?? null,
                body.name !== undefined,
                body.name ?? null,
                Object.hasOwn(body, "locationName"),
                body.locationName ?? null,
              ],
            ),
          );
          if (!Array.isArray(bases) || bases.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: "BASE_UPDATED",
            entityType: "base",
            entityId: bases[0].id,
            baseId: bases[0].id,
            beforeData: toBaseAuditSnapshot(currentBases[0]),
            afterData: toBaseAuditSnapshot(bases[0]),
          });
          return { kind: "updated", base: bases[0] };
        });
        if (result.kind === "not-found") {
          return sendNotFound(response, "Base");
        }
        if (result.kind !== "updated") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        return response.status(200).json({
          success: true,
          data: { base: toBaseDto(result.base) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async setActive(request, response) {
      const { id } = request.params;
      const { isActive } = request.validatedBody;
      try {
        const result = await dataSource.transaction(async (manager) => {
          const currentBases = await manager.query(
            `SELECT id, is_active
             FROM public.base
             WHERE id = $1
             FOR UPDATE`,
            [id],
          );
          if (!Array.isArray(currentBases) || currentBases.length > 1) {
            return { kind: "database-error" };
          }
          if (currentBases.length === 0) {
            return { kind: "not-found" };
          }
          const current = currentBases[0];
          if (current.is_active === isActive) {
            return { kind: "unchanged", base: current };
          }

          if (current.is_active === true && !isActive) {
            const references = await manager.query(
              BASE_REFERENCES_QUERY,
              [id],
            );
            if (!Array.isArray(references) || references.length !== 1) {
              return { kind: "database-error" };
            }
            if (hasReferences(references[0])) {
              return { kind: "conflict" };
            }
          }

          const bases = rowsOfCommandResult(
            await manager.query(
              `UPDATE public.base
               SET is_active = $2, updated_at = now()
               WHERE id = $1
               RETURNING ${BASE_COLUMNS}`,
              [id, isActive],
            ),
          );
          if (!Array.isArray(bases)) {
            return { kind: "database-error" };
          }
          if (bases.length === 0) {
            return { kind: "not-found" };
          }
          if (bases.length !== 1) {
            return { kind: "database-error" };
          }
          await writeBusinessAudit(manager, {
            actorUserId: request.currentUser.id,
            action: isActive ? "BASE_ACTIVATED" : "BASE_DEACTIVATED",
            entityType: "base",
            entityId: bases[0].id,
            baseId: bases[0].id,
            beforeData: { isActive: current.is_active },
            afterData: { isActive: bases[0].is_active },
          });
          return { kind: "updated", base: bases[0] };
        });

        if (result.kind === "not-found") {
          return sendNotFound(response, "Base");
        }
        if (result.kind === "conflict") {
          return sendConflict(
            response,
            "BASE_IN_USE",
            "A base with related users or inventory records cannot be deactivated.",
          );
        }
        if (result.kind !== "updated" && result.kind !== "unchanged") {
          return sendDatabaseError(response, new Error("Invalid query result."));
        }
        return response.status(200).json({
          success: true,
          data: { base: toBaseDto(result.base) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
