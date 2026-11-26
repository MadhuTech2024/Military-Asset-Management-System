import { sendDatabaseError } from "../utils/apiResponses.js";
import {
  calculateInventoryBalance,
  INVENTORY_CTES,
  toSafeNonNegativeInteger,
} from "../utils/inventoryBalance.js";

function toSafeInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Dashboard totals are invalid.");
  }
  return parsed;
}

function sumSafeIntegers(values) {
  const total = values.reduce(
    (sum, value) => sum + BigInt(toSafeInteger(value)),
    0n,
  );
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Dashboard totals are invalid.");
  }
  return Number(total);
}

function toDashboardSummary(inventoryRows, purchaseRows, transferRows) {
  const balances = inventoryRows.map((row) =>
    calculateInventoryBalance({
      openingBalance: row.opening_balance,
      purchases: row.purchases,
      transfersIn: row.transfers_in,
      transfersOut: row.transfers_out,
      assignedOut: row.assigned_out,
      returned: row.returned,
      expended: row.expended,
    }),
  );

  const transfersByStatus = new Map(
    transferRows.map((row) => [
      row.status,
      {
        count: toSafeNonNegativeInteger(row.count),
        quantity: toSafeNonNegativeInteger(row.quantity),
      },
    ]),
  );
  const transferSummary = (status) =>
    transfersByStatus.get(status) ?? { count: 0, quantity: 0 };
  const purchaseRow = purchaseRows[0];
  if (!purchaseRow) {
    throw new Error("Dashboard purchase totals are unavailable.");
  }

  return {
    inventory: {
      availableQuantity: sumSafeIntegers(
        balances.map((balance) => balance.closingBalance),
      ),
      netAssignedQuantity: sumSafeIntegers(
        balances.map((balance) => balance.assigned),
      ),
    },
    pendingPurchases: {
      count: toSafeNonNegativeInteger(purchaseRow.pending_count),
      quantity: toSafeNonNegativeInteger(purchaseRow.pending_quantity),
    },
    transfers: {
      pending: transferSummary("PENDING"),
      approved: transferSummary("APPROVED"),
    },
    expenditureQuantity: sumSafeIntegers(
      balances.map((balance) => balance.expended),
    ),
  };
}

export function createDashboardController({ dataSource }) {
  if (!dataSource || typeof dataSource.query !== "function") {
    throw new Error("A runtime DataSource is required for dashboard reads.");
  }

  async function loadSummary(baseId) {
    const [inventoryRows, purchaseRows, transferRows] = await Promise.all([
      dataSource.query(
        `${INVENTORY_CTES}
         SELECT
           base_id, equipment_type_id,
           SUM(opening_balance) AS opening_balance,
           SUM(purchases) AS purchases,
           SUM(transfers_in) AS transfers_in,
           SUM(transfers_out) AS transfers_out,
           SUM(assigned_out) AS assigned_out,
           SUM(returned) AS returned,
           SUM(expended) AS expended
         FROM inventory_rows
         WHERE ($1::uuid IS NULL OR base_id = $1)
         GROUP BY base_id, equipment_type_id`,
        [baseId],
      ),
      dataSource.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'PENDING') AS pending_count,
           COALESCE(
             SUM(quantity) FILTER (WHERE status = 'PENDING'),
             0
           ) AS pending_quantity
         FROM public.purchase
         WHERE ($1::uuid IS NULL OR base_id = $1)`,
        [baseId],
      ),
      dataSource.query(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(quantity), 0) AS quantity
         FROM public.transfer
         WHERE ($1::uuid IS NULL OR
                source_base_id = $1 OR destination_base_id = $1)
         GROUP BY status`,
        [baseId],
      ),
    ]);
    if (
      !Array.isArray(inventoryRows) ||
      !Array.isArray(purchaseRows) ||
      purchaseRows.length !== 1 ||
      !Array.isArray(transferRows)
    ) {
      throw new Error("Dashboard query results are invalid.");
    }
    return toDashboardSummary(inventoryRows, purchaseRows, transferRows);
  }

  return {
    async global(request, response) {
      try {
        const summary = await loadSummary(null);
        return response.status(200).json({
          success: true,
          data: { dashboard: summary },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },

    async byBase(request, response) {
      try {
        const summary = await loadSummary(request.params.id);
        return response.status(200).json({
          success: true,
          data: { dashboard: summary },
        });
      } catch (error) {
        return sendDatabaseError(response, error);
      }
    },
  };
}
