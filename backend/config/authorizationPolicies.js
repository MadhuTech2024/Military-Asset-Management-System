import { isUuid } from "./jwt.js";

export const AUTHORIZATION_ROLES = Object.freeze([
  "ADMIN",
  "BASE_COMMANDER",
  "LOGISTICS_OFFICER",
]);

export const AUTHORIZATION_OPERATIONS = Object.freeze({
  MANAGE_USERS: "MANAGE_USERS",
  MANAGE_BASES: "MANAGE_BASES",
  GLOBAL_DASHBOARD: "GLOBAL_DASHBOARD",
  BASE_DASHBOARD: "BASE_DASHBOARD",
  INVENTORY_ACCESS: "INVENTORY_ACCESS",
  EQUIPMENT_TYPE_ACCESS: "EQUIPMENT_TYPE_ACCESS",
  MANAGE_EQUIPMENT_TYPES: "MANAGE_EQUIPMENT_TYPES",
  MANAGE_OPENING_STOCK: "MANAGE_OPENING_STOCK",
  AUDIT_LOG_READ: "AUDIT_LOG_READ",
  PURCHASE_CREATE: "PURCHASE_CREATE",
  TRANSFER_INITIATE: "TRANSFER_INITIATE",
  TRANSFER_APPROVE: "TRANSFER_APPROVE",
  TRANSFER_REJECT: "TRANSFER_REJECT",
  TRANSFER_COMPLETE: "TRANSFER_COMPLETE",
  ASSIGNMENT_CREATE: "ASSIGNMENT_CREATE",
  ASSIGNMENT_RETURN: "ASSIGNMENT_RETURN",
  EXPENDITURE_RECORD: "EXPENDITURE_RECORD",
});

export const AUTHORIZATION_SCOPE = Object.freeze({
  DENY: "DENY",
  GLOBAL: "GLOBAL",
  ANY_BASE: "ANY_BASE",
  OWN_BASE: "OWN_BASE",
});

const { DENY, GLOBAL, ANY_BASE, OWN_BASE } = AUTHORIZATION_SCOPE;

export const AUTHORIZATION_POLICIES = Object.freeze({
  [AUTHORIZATION_OPERATIONS.MANAGE_USERS]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.MANAGE_BASES]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.GLOBAL_DASHBOARD]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.BASE_DASHBOARD]: Object.freeze({
    ADMIN: ANY_BASE,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: OWN_BASE,
  }),
  [AUTHORIZATION_OPERATIONS.INVENTORY_ACCESS]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: OWN_BASE,
  }),
  [AUTHORIZATION_OPERATIONS.EQUIPMENT_TYPE_ACCESS]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: GLOBAL,
    LOGISTICS_OFFICER: GLOBAL,
  }),
  [AUTHORIZATION_OPERATIONS.MANAGE_EQUIPMENT_TYPES]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: GLOBAL,
    LOGISTICS_OFFICER: GLOBAL,
  }),
  [AUTHORIZATION_OPERATIONS.MANAGE_OPENING_STOCK]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.AUDIT_LOG_READ]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: OWN_BASE,
  }),
  [AUTHORIZATION_OPERATIONS.PURCHASE_CREATE]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: OWN_BASE,
  }),
  [AUTHORIZATION_OPERATIONS.TRANSFER_INITIATE]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: OWN_BASE,
  }),
  [AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE]: Object.freeze({
    ADMIN: DENY,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.TRANSFER_REJECT]: Object.freeze({
    ADMIN: DENY,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.TRANSFER_COMPLETE]: Object.freeze({
    ADMIN: DENY,
    BASE_COMMANDER: DENY,
    LOGISTICS_OFFICER: OWN_BASE,
  }),
  [AUTHORIZATION_OPERATIONS.ASSIGNMENT_CREATE]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.ASSIGNMENT_RETURN]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: DENY,
  }),
  [AUTHORIZATION_OPERATIONS.EXPENDITURE_RECORD]: Object.freeze({
    ADMIN: GLOBAL,
    BASE_COMMANDER: OWN_BASE,
    LOGISTICS_OFFICER: DENY,
  }),
});

export function getAuthorizationScope(role, operation) {
  if (!AUTHORIZATION_ROLES.includes(role)) {
    return DENY;
  }

  return AUTHORIZATION_POLICIES[operation]?.[role] ?? DENY;
}

export function areTransferActorsDistinct({
  requesterId,
  approverId = null,
  completionActorId = null,
} = {}) {
  if (typeof requesterId !== "string" || requesterId.length === 0) {
    return false;
  }

  const actors = [requesterId, approverId, completionActorId].filter(
    (actorId) => actorId !== null && actorId !== undefined,
  );
  return (
    actors.every(
      (actorId) => typeof actorId === "string" && actorId.length > 0,
    ) && new Set(actors).size === actors.length
  );
}

export function isTransferActionCurrentlyAuthorized({
  role,
  operation,
  userId,
  userBaseId,
  transfer,
} = {}) {
  if (
    !AUTHORIZATION_ROLES.includes(role) ||
    getAuthorizationScope(role, operation) !== AUTHORIZATION_SCOPE.OWN_BASE ||
    !isTransferUuidSet(transfer)
  ) {
    return false;
  }

  if (
    typeof userId !== "string" ||
    typeof userBaseId !== "string" ||
    transfer.source_base_id === transfer.destination_base_id
  ) {
    return false;
  }

  if (
    operation === AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE ||
    operation === AUTHORIZATION_OPERATIONS.TRANSFER_REJECT
  ) {
    if (
      operation === AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE &&
      transfer.status === "APPROVED" &&
      transfer.approved_by !== userId
    ) {
      return false;
    }
    return (
      transfer.destination_base_id === userBaseId &&
      areTransferActorsDistinct({
        requesterId: transfer.created_by,
        approverId: userId,
      })
    );
  }

  if (operation === AUTHORIZATION_OPERATIONS.TRANSFER_COMPLETE) {
    if (transfer.destination_base_id !== userBaseId) {
      return false;
    }
    if (
      transfer.status === "COMPLETED" &&
      transfer.completed_by !== userId
    ) {
      return false;
    }
    if (transfer.approved_by === null) {
      return areTransferActorsDistinct({
        requesterId: transfer.created_by,
        completionActorId: userId,
      });
    }
    return areTransferActorsDistinct({
      requesterId: transfer.created_by,
      approverId: transfer.approved_by,
      completionActorId: userId,
    });
  }

  return false;
}

function isTransferUuidSet(transfer) {
  return Boolean(
    transfer &&
      isUuid(transfer.source_base_id) &&
      isUuid(transfer.destination_base_id) &&
      isUuid(transfer.created_by) &&
      (transfer.approved_by === null ||
        transfer.approved_by === undefined ||
        isUuid(transfer.approved_by)) &&
      (transfer.completed_by === null ||
        transfer.completed_by === undefined ||
        isUuid(transfer.completed_by)),
  );
}
