import { sendDatabaseError } from "../utils/apiResponses.js";
import {
  toSafeNonNegativeInteger,
} from "../utils/inventoryBalance.js";

function invalidBaseFilter(response) {
  return response.status(400).json({
    success: false,
    error: {
      code: "INVALID_REQUEST",
      message: "The baseId filter is not available for this role.",
    },
  });
}

function safeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function addSafeIntegers(values, label) {
  const total = values.reduce(
    (sum, value) => sum + BigInt(safeInteger(value, label)),
    0n,
  );
  if (
    total < BigInt(Number.MIN_SAFE_INTEGER) ||
    total > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(total);
}

function timestampDto(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function makeReportScope(request, response) {
  const isAdmin = request.currentUser.role === "ADMIN";
  if (!isAdmin && request.validatedQuery.baseId) {
    invalidBaseFilter(response);
    return null;
  }
  const baseId = isAdmin
    ? request.validatedQuery.baseId
    : request.authorizedBaseId ?? request.currentUser.baseId;
  if (!isAdmin && !baseId) {
    response.status(403).json({
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "You are not allowed to read this report.",
      },
    });
    return null;
  }
  return { baseId, equipmentTypeId: request.validatedQuery.equipmentTypeId };
}

function buildWhere({
  alias,
  baseColumn = "base_id",
  transferScope = false,
  timestampColumn,
  movementTypeColumn = null,
  scope,
  query,
}) {
  const clauses = [];
  const parameters = [];
  const add = (value) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };

  if (scope.baseId) {
    const baseParameter = `${add(scope.baseId)}::uuid`;
    clauses.push(
      transferScope
        ? `(${alias}.source_base_id = ${baseParameter} OR ${alias}.destination_base_id = ${baseParameter})`
        : `${alias}.${baseColumn} = ${baseParameter}`,
    );
  }
  if (scope.equipmentTypeId) {
    clauses.push(
      `${alias}.equipment_type_id = ${add(scope.equipmentTypeId)}::uuid`,
    );
  }
  if (query.from) {
    clauses.push(
      `${alias}.${timestampColumn} >= ${add(query.from)}::timestamptz`,
    );
  }
  if (query.to) {
    clauses.push(
      `${alias}.${timestampColumn} <= ${add(query.to)}::timestamptz`,
    );
  } else {
    clauses.push(`${alias}.${timestampColumn} <= now()`);
  }
  if (movementTypeColumn && query.movementType) {
    clauses.push(
      `${alias}.${movementTypeColumn} = ${add(query.movementType)}`,
    );
  }
  return {
    clause: clauses.length === 0 ? "TRUE" : clauses.join(" AND "),
    parameters,
  };
}

function reportMeta(countRows, limit, offset) {
  if (!Array.isArray(countRows) || countRows.length !== 1) {
    throw new Error("Report count is unavailable.");
  }
  const total = Number(countRows[0].total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Report count is invalid.");
  }
  return { limit, offset, total };
}

function inventoryMovementDto(row) {
  return {
    id: row.id,
    assetId: row.asset_id,
    baseId: row.base_id,
    equipmentTypeId: row.equipment_type_id,
    movementType: row.movement_type,
    direction: row.direction,
    quantity: row.quantity,
    occurredAt: timestampDto(row.occurred_at),
    purchaseId: row.purchase_id,
    transferId: row.transfer_id,
    assignmentId: row.assignment_id,
    expenditureId: row.expenditure_id,
    returnOperationId: row.return_operation_id,
  };
}

const INVENTORY_PERIOD_SUMMARY_SQL = `
  WITH asset_scope AS (
    SELECT id, base_id, equipment_type_id, opening_balance, opening_at
    FROM public.asset
    WHERE ($1::uuid IS NULL OR base_id = $1)
      AND ($2::uuid IS NULL OR equipment_type_id = $2)
  ),
  movement_rows AS (
    SELECT
      movement.asset_id,
      movement.movement_type,
      movement.quantity,
      movement.occurred_at,
      purchase.status AS purchase_status,
      transfer.status AS transfer_status
    FROM public.inventory_movement movement
    JOIN asset_scope asset ON asset.id = movement.asset_id
    LEFT JOIN public.purchase purchase
      ON purchase.id = movement.purchase_id
    LEFT JOIN public.transfer transfer
      ON transfer.id = movement.transfer_id
    WHERE movement.occurred_at <= COALESCE($4::timestamptz, now())
  ),
  movement_totals AS (
    SELECT
      asset_id,
      SUM(CASE WHEN $3::timestamptz IS NOT NULL
                    AND occurred_at < $3
                    AND movement_type = 'PURCHASE'
                    AND purchase_status = 'COMPLETED'
               THEN quantity ELSE 0 END) AS before_purchases,
      SUM(CASE WHEN $3::timestamptz IS NOT NULL
                    AND occurred_at < $3
                    AND movement_type = 'TRANSFER_IN'
                    AND transfer_status = 'COMPLETED'
               THEN quantity ELSE 0 END) AS before_transfers_in,
      SUM(CASE WHEN $3::timestamptz IS NOT NULL
                    AND occurred_at < $3
                    AND movement_type = 'TRANSFER_OUT'
                    AND transfer_status = 'COMPLETED'
               THEN quantity ELSE 0 END) AS before_transfers_out,
      SUM(CASE WHEN $3::timestamptz IS NOT NULL
                    AND occurred_at < $3
                    AND movement_type = 'ASSIGNMENT'
               THEN quantity ELSE 0 END) AS before_assigned,
      SUM(CASE WHEN $3::timestamptz IS NOT NULL
                    AND occurred_at < $3
                    AND movement_type = 'RETURN'
               THEN quantity ELSE 0 END) AS before_returned,
      SUM(CASE WHEN $3::timestamptz IS NOT NULL
                    AND occurred_at < $3
                    AND movement_type = 'EXPENDITURE'
               THEN quantity ELSE 0 END) AS before_expended,
      SUM(CASE WHEN ($3::timestamptz IS NULL OR occurred_at >= $3)
                    AND movement_type = 'PURCHASE'
                    AND purchase_status = 'COMPLETED'
               THEN quantity ELSE 0 END) AS purchases,
      SUM(CASE WHEN ($3::timestamptz IS NULL OR occurred_at >= $3)
                    AND movement_type = 'TRANSFER_IN'
                    AND transfer_status = 'COMPLETED'
               THEN quantity ELSE 0 END) AS transfers_in,
      SUM(CASE WHEN ($3::timestamptz IS NULL OR occurred_at >= $3)
                    AND movement_type = 'TRANSFER_OUT'
                    AND transfer_status = 'COMPLETED'
               THEN quantity ELSE 0 END) AS transfers_out,
      SUM(CASE WHEN ($3::timestamptz IS NULL OR occurred_at >= $3)
                    AND movement_type = 'ASSIGNMENT'
               THEN quantity ELSE 0 END) AS assigned,
      SUM(CASE WHEN ($3::timestamptz IS NULL OR occurred_at >= $3)
                    AND movement_type = 'RETURN'
               THEN quantity ELSE 0 END) AS returned,
      SUM(CASE WHEN ($3::timestamptz IS NULL OR occurred_at >= $3)
                    AND movement_type = 'EXPENDITURE'
               THEN quantity ELSE 0 END) AS expended
    FROM movement_rows
    GROUP BY asset_id
  ),
  asset_totals AS (
    SELECT
      asset.id,
      CASE
        WHEN $3::timestamptz IS NULL
          THEN CASE WHEN asset.opening_at <= COALESCE($4::timestamptz, now())
                    THEN asset.opening_balance ELSE 0 END
        WHEN asset.opening_at < $3 THEN asset.opening_balance
        ELSE 0
      END AS opening_balance,
      CASE
        WHEN $3::timestamptz IS NOT NULL
          AND asset.opening_at >= $3
          AND asset.opening_at <= COALESCE($4::timestamptz, now())
          THEN asset.opening_balance
        ELSE 0
      END AS opening_balance_introduced,
      COALESCE(movement_totals.before_purchases, 0) AS before_purchases,
      COALESCE(movement_totals.before_transfers_in, 0) AS before_transfers_in,
      COALESCE(movement_totals.before_transfers_out, 0) AS before_transfers_out,
      COALESCE(movement_totals.before_assigned, 0) AS before_assigned,
      COALESCE(movement_totals.before_returned, 0) AS before_returned,
      COALESCE(movement_totals.before_expended, 0) AS before_expended,
      COALESCE(movement_totals.purchases, 0) AS purchases,
      COALESCE(movement_totals.transfers_in, 0) AS transfers_in,
      COALESCE(movement_totals.transfers_out, 0) AS transfers_out,
      COALESCE(movement_totals.assigned, 0) AS assigned,
      COALESCE(movement_totals.returned, 0) AS returned,
      COALESCE(movement_totals.expended, 0) AS expended
    FROM asset_scope asset
    LEFT JOIN movement_totals ON movement_totals.asset_id = asset.id
  )
  SELECT
    COUNT(*) AS asset_count,
    COALESCE(SUM(opening_balance), 0) AS opening_balance,
    COALESCE(SUM(opening_balance_introduced), 0) AS opening_balance_introduced,
    COALESCE(SUM(before_purchases), 0) AS before_purchases,
    COALESCE(SUM(before_transfers_in), 0) AS before_transfers_in,
    COALESCE(SUM(before_transfers_out), 0) AS before_transfers_out,
    COALESCE(SUM(before_assigned), 0) AS before_assigned,
    COALESCE(SUM(before_returned), 0) AS before_returned,
    COALESCE(SUM(before_expended), 0) AS before_expended,
    COALESCE(SUM(purchases), 0) AS purchases,
    COALESCE(SUM(transfers_in), 0) AS transfers_in,
    COALESCE(SUM(transfers_out), 0) AS transfers_out,
    COALESCE(SUM(assigned), 0) AS assigned,
    COALESCE(SUM(returned), 0) AS returned,
    COALESCE(SUM(expended), 0) AS expended
  FROM asset_totals
`;

function inventoryPeriodSummary(row) {
  const before = (field) => BigInt(safeInteger(row[field], field));
  const openingBalance = addSafeIntegers(
    [
      row.opening_balance,
      (
        before("before_purchases") +
        before("before_transfers_in") -
        before("before_transfers_out") -
        before("before_assigned") +
        before("before_returned") -
        before("before_expended")
      ).toString(),
    ],
    "Opening balance",
  );
  const openingBalanceIntroduced = toSafeNonNegativeInteger(
    row.opening_balance_introduced,
  );
  const effectiveOpening = addSafeIntegers(
    [openingBalance, openingBalanceIntroduced],
    "Opening balance",
  );
  const purchases = toSafeNonNegativeInteger(row.purchases);
  const transfersIn = toSafeNonNegativeInteger(row.transfers_in);
  const transfersOut = toSafeNonNegativeInteger(row.transfers_out);
  const grossAssigned = toSafeNonNegativeInteger(row.assigned);
  const returned = toSafeNonNegativeInteger(row.returned);
  const expenditureQuantity = toSafeNonNegativeInteger(row.expended);
  const netMovementBig =
    BigInt(purchases) + BigInt(transfersIn) - BigInt(transfersOut);
  const netAssignedBig = BigInt(grossAssigned) - BigInt(returned);
  const closingBalanceBig =
    BigInt(effectiveOpening) +
    netMovementBig -
    netAssignedBig -
    BigInt(expenditureQuantity);
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafeInteger = BigInt(Number.MIN_SAFE_INTEGER);
  if (
    effectiveOpening < 0 ||
    netMovementBig < minSafeInteger ||
    netMovementBig > maxSafeInteger ||
    netAssignedBig < minSafeInteger ||
    netAssignedBig > maxSafeInteger ||
    closingBalanceBig < 0n ||
    closingBalanceBig > maxSafeInteger
  ) {
    throw new Error("The computed inventory period balance is invalid.");
  }
  return {
    assetPositionCount: toSafeNonNegativeInteger(row.asset_count),
    openingBalance,
    openingBalanceIntroduced,
    purchases,
    transfersIn,
    transfersOut,
    netMovement: Number(netMovementBig),
    grossAssigned,
    returned,
    netAssigned: Number(netAssignedBig),
    expenditureQuantity,
    closingBalance: Number(closingBalanceBig),
  };
}

export function createReportController({ dataSource }) {
  if (!dataSource || typeof dataSource.query !== "function") {
    throw new Error("A runtime DataSource is required for reports.");
  }

  async function readPage(request, response, {
    alias,
    baseColumn = "base_id",
    transferScope = false,
    timestampColumn,
    select,
    table,
    dto,
    fixedWhere = null,
  }) {
    const scope = makeReportScope(request, response);
    if (!scope) return null;
    const query = request.validatedQuery;
    const where = buildWhere({
      alias,
      baseColumn,
      transferScope,
      timestampColumn,
      scope,
      query,
    });
    const clause = fixedWhere
      ? `${where.clause} AND ${fixedWhere}`
      : where.clause;
    const countRows = await dataSource.query(
      `SELECT COUNT(*) AS total FROM ${table} ${alias} WHERE ${clause}`,
      where.parameters,
    );
    const rows = await dataSource.query(
      `SELECT ${select}
       FROM ${table} ${alias}
       WHERE ${clause}
       ORDER BY ${alias}.${timestampColumn} DESC, ${alias}.id DESC
       LIMIT $${where.parameters.length + 1}
       OFFSET $${where.parameters.length + 2}`,
      [...where.parameters, query.limit, query.offset],
    );
    if (!Array.isArray(rows)) {
      throw new Error("Report rows are unavailable.");
    }
    return {
      items: rows.map(dto),
      meta: reportMeta(countRows, query.limit, query.offset),
      where,
      scope,
      clause,
    };
  }

  return {
    async inventoryMovements(request, response) {
      try {
        const scope = makeReportScope(request, response);
        if (!scope) return;
        const query = request.validatedQuery;
        const summaryRows = await dataSource.query(
          INVENTORY_PERIOD_SUMMARY_SQL,
          [scope.baseId, scope.equipmentTypeId, query.from, query.to],
        );
        if (!Array.isArray(summaryRows) || summaryRows.length !== 1) {
          throw new Error("Inventory period summary is unavailable.");
        }

        const where = buildWhere({
          alias: "movement",
          timestampColumn: "occurred_at",
          movementTypeColumn: "movement_type",
          scope,
          query,
        });
        const countRows = await dataSource.query(
          `SELECT COUNT(*) AS total
           FROM public.inventory_movement movement
           WHERE ${where.clause}`,
          where.parameters,
        );
        const rows = await dataSource.query(
          `SELECT movement.id, movement.asset_id, movement.base_id,
                  movement.equipment_type_id, movement.movement_type,
                  movement.direction, movement.quantity, movement.occurred_at,
                  movement.purchase_id, movement.transfer_id,
                  movement.assignment_id, movement.expenditure_id,
                  movement.return_operation_id
           FROM public.inventory_movement movement
           WHERE ${where.clause}
           ORDER BY movement.occurred_at DESC, movement.id DESC
           LIMIT $${where.parameters.length + 1}
           OFFSET $${where.parameters.length + 2}`,
          [...where.parameters, query.limit, query.offset],
        );
        if (!Array.isArray(rows)) {
          throw new Error("Inventory movements are unavailable.");
        }
        return response.status(200).json({
          success: true,
          data: {
            summary: inventoryPeriodSummary(summaryRows[0]),
            movements: rows.map(inventoryMovementDto),
          },
          meta: reportMeta(countRows, query.limit, query.offset),
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async purchases(request, response) {
      try {
        const page = await readPage(request, response, {
          alias: "purchase",
          timestampColumn: "purchased_at",
          table: "public.purchase",
          select: `purchase.id, purchase.base_id, purchase.equipment_type_id,
                   purchase.quantity, purchase.status, purchase.purchased_at,
                   purchase.completed_at, purchase.created_at`,
          dto: (row) => ({
            id: row.id,
            baseId: row.base_id,
            equipmentTypeId: row.equipment_type_id,
            quantity: row.quantity,
            status: row.status,
            purchasedAt: timestampDto(row.purchased_at),
            completedAt: timestampDto(row.completed_at),
            createdAt: timestampDto(row.created_at),
          }),
        });
        if (!page) return;
        const summaryRows = await dataSource.query(
          `SELECT COUNT(*) FILTER (WHERE purchase.status = 'PENDING')
                    AS pending_count,
                  COALESCE(
                    SUM(purchase.quantity)
                      FILTER (WHERE purchase.status = 'PENDING'),
                    0
                  ) AS pending_quantity
           FROM public.purchase purchase
           WHERE ${page.clause}`,
          page.where.parameters,
        );
        if (!Array.isArray(summaryRows) || summaryRows.length !== 1) {
          throw new Error("Purchase report summary is unavailable.");
        }
        return response.status(200).json({
          success: true,
          data: {
            purchases: page.items,
            pending: {
              count: toSafeNonNegativeInteger(summaryRows[0].pending_count),
              quantity: toSafeNonNegativeInteger(
                summaryRows[0].pending_quantity,
              ),
            },
          },
          meta: page.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async transfers(request, response) {
      try {
        const page = await readPage(request, response, {
          alias: "transfer",
          baseColumn: "source_base_id",
          transferScope: true,
          timestampColumn: "created_at",
          table: "public.transfer",
          select: `transfer.id, transfer.source_base_id,
                   transfer.destination_base_id, transfer.equipment_type_id,
                   transfer.quantity, transfer.status, transfer.created_at,
                   transfer.approved_at, transfer.completed_at,
                   transfer.rejected_at`,
          dto: (row) => ({
            id: row.id,
            sourceBaseId: row.source_base_id,
            destinationBaseId: row.destination_base_id,
            equipmentTypeId: row.equipment_type_id,
            quantity: row.quantity,
            status: row.status,
            createdAt: timestampDto(row.created_at),
            approvedAt: timestampDto(row.approved_at),
            completedAt: timestampDto(row.completed_at),
            rejectedAt: timestampDto(row.rejected_at),
          }),
        });
        if (!page) return;
        const statusRows = await dataSource.query(
          `SELECT transfer.status, COUNT(*) AS count,
                  COALESCE(SUM(transfer.quantity), 0) AS quantity
           FROM public.transfer transfer
           WHERE ${page.clause}
           GROUP BY transfer.status`,
          page.where.parameters,
        );
        if (!Array.isArray(statusRows)) {
          throw new Error("Transfer report totals are unavailable.");
        }
        const byStatus = new Map(
          statusRows.map((row) => [
            row.status,
            {
              count: toSafeNonNegativeInteger(row.count),
              quantity: toSafeNonNegativeInteger(row.quantity),
            },
          ]),
        );
        return response.status(200).json({
          success: true,
          data: {
            transfers: page.items,
            byStatus: {
              PENDING: byStatus.get("PENDING") ?? { count: 0, quantity: 0 },
              APPROVED: byStatus.get("APPROVED") ?? { count: 0, quantity: 0 },
              COMPLETED: byStatus.get("COMPLETED") ?? { count: 0, quantity: 0 },
              REJECTED: byStatus.get("REJECTED") ?? { count: 0, quantity: 0 },
            },
          },
          meta: page.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async assignments(request, response) {
      try {
        const scope = makeReportScope(request, response);
        if (!scope) return;
        const query = request.validatedQuery;
        const where = buildWhere({
          alias: "assignment",
          timestampColumn: "assigned_at",
          scope,
          query,
        });
        const cte = `
          WITH assignment_totals AS (
            SELECT assignment_id,
              SUM(CASE WHEN movement_type = 'ASSIGNMENT'
                       THEN quantity ELSE 0 END) AS gross_assigned,
              SUM(CASE WHEN movement_type = 'RETURN'
                       THEN quantity ELSE 0 END) AS cumulative_returned
            FROM public.inventory_movement
            WHERE assignment_id IS NOT NULL
              AND occurred_at <= now()
            GROUP BY assignment_id
          )
        `;
        const from = `FROM public.assignment assignment
          LEFT JOIN assignment_totals totals
            ON totals.assignment_id = assignment.id
          WHERE ${where.clause}`;
        const [countRows, rows, summaryRows] = await Promise.all([
          dataSource.query(
            `SELECT COUNT(*) AS total
             FROM public.assignment assignment
             WHERE ${where.clause}`,
            where.parameters,
          ),
          dataSource.query(
            `${cte}
             SELECT assignment.id, assignment.asset_id, assignment.base_id,
                    assignment.equipment_type_id, assignment.status,
                    assignment.created_at, assignment.assigned_at,
                    COALESCE(totals.gross_assigned, 0) AS gross_assigned,
                    COALESCE(totals.cumulative_returned, 0)
                      AS cumulative_returned
             ${from}
                    ORDER BY assignment.assigned_at DESC, assignment.id DESC
             LIMIT $${where.parameters.length + 1}
             OFFSET $${where.parameters.length + 2}`,
            [...where.parameters, query.limit, query.offset],
          ),
          dataSource.query(
            `${cte}
             SELECT COUNT(*) AS assignment_count,
                    COALESCE(SUM(COALESCE(totals.gross_assigned, 0)), 0)
                      AS gross_assigned,
                    COALESCE(SUM(COALESCE(totals.cumulative_returned, 0)), 0)
                      AS cumulative_returned
             ${from}`,
            where.parameters,
          ),
        ]);
        if (
          !Array.isArray(countRows) ||
          !Array.isArray(rows) ||
          !Array.isArray(summaryRows) ||
          summaryRows.length !== 1
        ) {
          throw new Error("Assignment report results are unavailable.");
        }
        const assignments = rows.map((row) => {
          const grossAssigned = toSafeNonNegativeInteger(row.gross_assigned);
          const cumulativeReturned = toSafeNonNegativeInteger(
            row.cumulative_returned,
          );
          if (cumulativeReturned > grossAssigned) {
            throw new Error("Assignment return totals are invalid.");
          }
          return {
            id: row.id,
            assetId: row.asset_id,
            baseId: row.base_id,
            equipmentTypeId: row.equipment_type_id,
            status: row.status,
            createdAt: timestampDto(row.created_at),
            assignedAt: timestampDto(row.assigned_at),
            grossAssigned,
            cumulativeReturned,
            netAssigned: grossAssigned - cumulativeReturned,
          };
        });
        const summary = summaryRows[0];
        const grossAssigned = toSafeNonNegativeInteger(summary.gross_assigned);
        const cumulativeReturned = toSafeNonNegativeInteger(
          summary.cumulative_returned,
        );
        if (cumulativeReturned > grossAssigned) {
          throw new Error("Assignment return totals are invalid.");
        }
        return response.status(200).json({
          success: true,
          data: {
            assignments,
            summary: {
              assignmentCount: toSafeNonNegativeInteger(
                summary.assignment_count,
              ),
              grossAssigned,
              cumulativeReturned,
              netAssigned: grossAssigned - cumulativeReturned,
            },
          },
          meta: reportMeta(countRows, query.limit, query.offset),
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async returns(request, response) {
      try {
        const page = await readPage(request, response, {
          alias: "movement",
          timestampColumn: "occurred_at",
          table: "public.inventory_movement",
          fixedWhere: "movement.movement_type = 'RETURN'",
          select: `movement.id, movement.return_operation_id,
                   movement.assignment_id, movement.asset_id, movement.base_id,
                   movement.equipment_type_id, movement.quantity,
                   movement.occurred_at`,
          dto: (row) => ({
            movementId: row.id,
            returnOperationId: row.return_operation_id,
            assignmentId: row.assignment_id,
            assetId: row.asset_id,
            baseId: row.base_id,
            equipmentTypeId: row.equipment_type_id,
            quantity: row.quantity,
            returnedAt: timestampDto(row.occurred_at),
          }),
        });
        if (!page) return;
        const summaryRows = await dataSource.query(
          `SELECT COUNT(*) AS return_count,
                  COALESCE(SUM(movement.quantity), 0) AS returned_quantity
           FROM public.inventory_movement movement
           WHERE ${page.clause}`,
          page.where.parameters,
        );
        if (!Array.isArray(summaryRows) || summaryRows.length !== 1) {
          throw new Error("Return report summary is unavailable.");
        }
        return response.status(200).json({
          success: true,
          data: {
            returns: page.items,
            summary: {
              count: toSafeNonNegativeInteger(summaryRows[0].return_count),
              quantity: toSafeNonNegativeInteger(
                summaryRows[0].returned_quantity,
              ),
            },
          },
          meta: page.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async expenditures(request, response) {
      try {
        const page = await readPage(request, response, {
          alias: "movement",
          timestampColumn: "occurred_at",
          table: "public.inventory_movement",
          fixedWhere: "movement.movement_type = 'EXPENDITURE'",
          select: `movement.id, movement.expenditure_id, movement.asset_id,
                   movement.base_id, movement.equipment_type_id,
                   movement.quantity, movement.occurred_at`,
          dto: (row) => ({
            movementId: row.id,
            expenditureId: row.expenditure_id,
            assetId: row.asset_id,
            baseId: row.base_id,
            equipmentTypeId: row.equipment_type_id,
            quantity: row.quantity,
            expendedAt: timestampDto(row.occurred_at),
          }),
        });
        if (!page) return;
        const summaryRows = await dataSource.query(
          `SELECT COUNT(*) AS expenditure_count,
                  COALESCE(SUM(movement.quantity), 0) AS expenditure_quantity
           FROM public.inventory_movement movement
           WHERE ${page.clause}`,
          page.where.parameters,
        );
        if (!Array.isArray(summaryRows) || summaryRows.length !== 1) {
          throw new Error("Expenditure report summary is unavailable.");
        }
        return response.status(200).json({
          success: true,
          data: {
            expenditures: page.items,
            summary: {
              count: toSafeNonNegativeInteger(
                summaryRows[0].expenditure_count,
              ),
              quantity: toSafeNonNegativeInteger(
                summaryRows[0].expenditure_quantity,
              ),
            },
          },
          meta: page.meta,
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
