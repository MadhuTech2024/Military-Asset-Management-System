import { sendDatabaseError, sendNotFound } from "../utils/apiResponses.js";

const AUDIT_COLUMNS = `
  audit.id,
  audit.actor_user_id,
  audit.action,
  audit.entity_type,
  audit.entity_id,
  audit.base_id,
  audit.correlation_id,
  audit.created_at
`;

function toAuditDto(row) {
  return {
    id: row.id,
    actorId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    baseId: row.base_id,
    correlationId: row.correlation_id,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
  };
}

function scopePredicate({ isAdmin, baseId, basePlaceholder = 1 }) {
  if (isAdmin) {
    return {
      predicate: "TRUE",
      parameters: [],
    };
  }
  return {
    predicate: `(
      audit.base_id = $${basePlaceholder}
      OR (
        audit.entity_type = 'transfer'
        AND EXISTS (
          SELECT 1
          FROM public.transfer transfer
          WHERE transfer.id = audit.entity_id
            AND (
              transfer.source_base_id = $${basePlaceholder}
              OR transfer.destination_base_id = $${basePlaceholder}
            )
        )
      )
    )`,
    parameters: [baseId],
  };
}

function buildWhere(request, scope) {
  const filters = request.validatedQuery;
  const clauses = [scope.predicate];
  const parameters = [...scope.parameters];

  function parameter(value) {
    parameters.push(value);
    return `$${parameters.length}`;
  }

  if (filters.action) {
    clauses.push(`audit.action = ${parameter(filters.action)}`);
  }
  if (filters.entityType) {
    clauses.push(`audit.entity_type = ${parameter(filters.entityType)}`);
  }
  if (filters.actorId) {
    clauses.push(`audit.actor_user_id = ${parameter(filters.actorId)}::uuid`);
  }
  if (scope.isAdmin && filters.baseId) {
    clauses.push(`audit.base_id = ${parameter(filters.baseId)}::uuid`);
  }
  if (filters.from) {
    clauses.push(`audit.created_at >= ${parameter(filters.from)}::timestamptz`);
  }
  if (filters.to) {
    clauses.push(`audit.created_at <= ${parameter(filters.to)}::timestamptz`);
  }

  return {
    clause: clauses.join(" AND "),
    parameters,
  };
}

export function createAuditController({ dataSource }) {
  if (!dataSource || typeof dataSource.query !== "function") {
    throw new Error("A runtime DataSource is required for audit reads.");
  }

  return {
    async list(request, response) {
      try {
        const isAdmin = request.currentUser.role === "ADMIN";
        const currentBaseId =
          request.authorizedBaseId ?? request.currentUser.baseId;
        if (!isAdmin && !currentBaseId) {
          return response.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You are not allowed to read audit events.",
            },
          });
        }
        if (!isAdmin && request.validatedQuery.baseId) {
          return response.status(400).json({
            success: false,
            error: {
              code: "INVALID_REQUEST",
              message: "The baseId filter is not available for this role.",
            },
          });
        }

        const scope = {
          ...scopePredicate({
            isAdmin,
            baseId: currentBaseId,
          }),
          isAdmin,
        };
        const where = buildWhere(request, scope);
        const limit = request.validatedQuery.limit;
        const offset = request.validatedQuery.offset;
        const limitIndex = where.parameters.length + 1;
        const offsetIndex = where.parameters.length + 2;

        const [countRows, rows] = await Promise.all([
          dataSource.query(
            `SELECT COUNT(*) AS total
             FROM public.audit_log audit
             WHERE ${where.clause}`,
            where.parameters,
          ),
          dataSource.query(
            `SELECT ${AUDIT_COLUMNS}
             FROM public.audit_log audit
             WHERE ${where.clause}
             ORDER BY audit.created_at DESC, audit.id DESC
             LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
            [...where.parameters, limit, offset],
          ),
        ]);
        if (
          !Array.isArray(countRows) ||
          countRows.length !== 1 ||
          !Array.isArray(rows)
        ) {
          throw new Error("Could not retrieve audit events.");
        }
        const total = Number(countRows[0].total);
        if (!Number.isSafeInteger(total) || total < 0) {
          throw new Error("Audit count is invalid.");
        }

        return response.status(200).json({
          success: true,
          data: { audits: rows.map(toAuditDto) },
          meta: { limit, offset, total },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async getById(request, response) {
      try {
        const isAdmin = request.currentUser.role === "ADMIN";
        const currentBaseId =
          request.authorizedBaseId ?? request.currentUser.baseId;
        if (!isAdmin && !currentBaseId) {
          return response.status(403).json({
            success: false,
            error: {
              code: "FORBIDDEN",
              message: "You are not allowed to read audit events.",
            },
          });
        }

        const scope = scopePredicate({
          isAdmin,
          baseId: currentBaseId,
          basePlaceholder: 2,
        });
        const parameters = [request.params.id, ...scope.parameters];
        const idIndex = 1;
        const rows = await dataSource.query(
          `SELECT ${AUDIT_COLUMNS}
           FROM public.audit_log audit
           WHERE audit.id = $${idIndex}::uuid
             AND ${scope.predicate}
           LIMIT 1`,
          parameters,
        );
        if (!Array.isArray(rows)) {
          throw new Error("Could not retrieve the audit event.");
        }
        if (rows.length === 0) {
          return sendNotFound(response, "Audit event");
        }

        return response.status(200).json({
          success: true,
          data: { audit: toAuditDto(rows[0]) },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
