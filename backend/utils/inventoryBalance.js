export const INVENTORY_CTES = `
  WITH movement_totals AS (
    SELECT
      movement.asset_id,
      SUM(CASE
        WHEN movement.movement_type = 'PURCHASE'
          AND purchase.status = 'COMPLETED'
        THEN movement.quantity ELSE 0
      END) AS purchases,
      SUM(CASE
        WHEN movement.movement_type = 'TRANSFER_IN'
          AND transfer.status = 'COMPLETED'
        THEN movement.quantity ELSE 0
      END) AS transfers_in,
      SUM(CASE
        WHEN movement.movement_type = 'TRANSFER_OUT'
          AND transfer.status = 'COMPLETED'
        THEN movement.quantity ELSE 0
      END) AS transfers_out,
      SUM(CASE
        WHEN movement.movement_type = 'ASSIGNMENT'
        THEN movement.quantity ELSE 0
      END) AS assigned_out,
      SUM(CASE
        WHEN movement.movement_type = 'RETURN'
        THEN movement.quantity ELSE 0
      END) AS returned,
      SUM(CASE
        WHEN movement.movement_type = 'EXPENDITURE'
        THEN movement.quantity ELSE 0
      END) AS expended
    FROM public.inventory_movement movement
    LEFT JOIN public.purchase purchase
      ON purchase.id = movement.purchase_id
    LEFT JOIN public.transfer transfer
      ON transfer.id = movement.transfer_id
    WHERE movement.occurred_at <= now()
    GROUP BY movement.asset_id
  ),
  inventory_rows AS (
    SELECT
      asset.id,
      asset.base_id,
      base.code AS base_code,
      base.name AS base_name,
      asset.equipment_type_id,
      equipment_type.code AS equipment_type_code,
      equipment_type.name AS equipment_type_name,
      equipment_type.category AS equipment_type_category,
      CASE
        WHEN asset.opening_at <= now() THEN asset.opening_balance
        ELSE 0
      END AS opening_balance,
      COALESCE(movement_totals.purchases, 0) AS purchases,
      COALESCE(movement_totals.transfers_in, 0) AS transfers_in,
      COALESCE(movement_totals.transfers_out, 0) AS transfers_out,
      COALESCE(movement_totals.assigned_out, 0) AS assigned_out,
      COALESCE(movement_totals.returned, 0) AS returned,
      COALESCE(movement_totals.expended, 0) AS expended,
      asset.is_active,
      asset.opening_at
    FROM public.asset asset
    JOIN public.base base ON base.id = asset.base_id
    JOIN public.equipment_type equipment_type
      ON equipment_type.id = asset.equipment_type_id
    LEFT JOIN movement_totals ON movement_totals.asset_id = asset.id
  )
`;

export function toSafeNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Inventory ledger totals are invalid.");
  }
  return parsed;
}

export function calculateInventoryBalance({
  openingBalance,
  purchases,
  transfersIn,
  transfersOut,
  assignedOut,
  returned,
  expended,
}) {
  const opening = toSafeNonNegativeInteger(openingBalance);
  const purchaseTotal = toSafeNonNegativeInteger(purchases);
  const transferInTotal = toSafeNonNegativeInteger(transfersIn);
  const transferOutTotal = toSafeNonNegativeInteger(transfersOut);
  const assignmentTotal = toSafeNonNegativeInteger(assignedOut);
  const returnedTotal = toSafeNonNegativeInteger(returned);
  const expendedTotal = toSafeNonNegativeInteger(expended);
  const assignedBig = BigInt(assignmentTotal) - BigInt(returnedTotal);
  if (assignedBig < 0n) {
    throw new Error("Returns exceed the assignment movement total.");
  }

  const netMovementBig =
    BigInt(purchaseTotal) +
    BigInt(transferInTotal) -
    BigInt(transferOutTotal);
  const closingBalanceBig =
    BigInt(opening) +
    netMovementBig -
    assignedBig -
    BigInt(expendedTotal);
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafeInteger = BigInt(Number.MIN_SAFE_INTEGER);
  if (
    netMovementBig > maxSafeInteger ||
    netMovementBig < minSafeInteger ||
    closingBalanceBig < 0n ||
    closingBalanceBig > maxSafeInteger
  ) {
    throw new Error("The computed inventory balance is invalid.");
  }

  const assigned = Number(assignedBig);
  const netMovement = Number(netMovementBig);
  const closingBalance = Number(closingBalanceBig);
  return {
    openingBalance: opening,
    purchases: purchaseTotal,
    transfersIn: transferInTotal,
    transfersOut: transferOutTotal,
    netMovement,
    assigned,
    returned: returnedTotal,
    expended: expendedTotal,
    closingBalance,
  };
}
