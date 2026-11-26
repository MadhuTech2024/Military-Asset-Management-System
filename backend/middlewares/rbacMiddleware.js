import { isUuid } from "../config/jwt.js";
import {
  isTransferActionCurrentlyAuthorized,
  AUTHORIZATION_OPERATIONS,
  AUTHORIZATION_SCOPE,
  getAuthorizationScope,
} from "../config/authorizationPolicies.js";

const BASE_RESOURCE_QUERIES = Object.freeze({
  base: "SELECT id AS base_id FROM public.base WHERE id = $1",
  asset: "SELECT base_id FROM public.asset WHERE id = $1",
  purchase: "SELECT base_id FROM public.purchase WHERE id = $1",
  inventoryMovement:
    "SELECT base_id FROM public.inventory_movement WHERE id = $1",
  assignment: "SELECT base_id FROM public.assignment WHERE id = $1",
  returnOperation:
    "SELECT base_id FROM public.return_operation WHERE id = $1",
  expenditure: "SELECT base_id FROM public.expenditure WHERE id = $1",
});

const TRANSFER_ACTIONS = new Set([
  AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE,
  AUTHORIZATION_OPERATIONS.TRANSFER_REJECT,
  AUTHORIZATION_OPERATIONS.TRANSFER_COMPLETE,
]);

const TRANSFER_QUERY = `
  SELECT id, source_base_id, destination_base_id, status,
         created_by, approved_by, completed_by
  FROM public.transfer
  WHERE id = $1
`;

function sendUnauthenticated(response) {
  return response.status(401).json({
    success: false,
    error: {
      code: "UNAUTHENTICATED",
      message: "Authentication is required.",
    },
  });
}

function sendForbidden(response) {
  return response.status(403).json({
    success: false,
    error: {
      code: "FORBIDDEN",
      message: "You are not allowed to perform this operation.",
    },
  });
}

function sendAuthorizationUnavailable(response) {
  return response.status(503).json({
    success: false,
    error: {
      code: "AUTHORIZATION_UNAVAILABLE",
      message: "Authorization is temporarily unavailable.",
    },
  });
}

function getAuthenticatedUser(request, response) {
  const user = request.currentUser;
  if (
    !user ||
    !isUuid(user.id) ||
    user.isActive !== true
  ) {
    sendUnauthenticated(response);
    return null;
  }

  return user;
}

function getRequestIdentifier(request, getResourceId) {
  try {
    const resourceId = getResourceId(request);
    return isUuid(resourceId) ? resourceId : null;
  } catch {
    return null;
  }
}

function hasExpectedOptionalUuid(value) {
  return value === null || isUuid(value);
}

function transferActionAllowed(user, operation, transfer) {
  return isTransferActionCurrentlyAuthorized({
    role: user.role,
    operation,
    userId: user.id,
    userBaseId: user.baseId,
    transfer,
  });
}

export function createAuthorizationMiddleware({ dataSource }) {
  if (!dataSource || typeof dataSource.query !== "function") {
    throw new Error("A runtime DataSource is required for authorization.");
  }

  function requireOperation(operation) {
    return function authorizeGlobalOperation(request, response, next) {
      const user = getAuthenticatedUser(request, response);
      if (!user) {
        return;
      }

      if (
        getAuthorizationScope(user.role, operation) !==
        AUTHORIZATION_SCOPE.GLOBAL
      ) {
        return sendForbidden(response);
      }

      return next();
    };
  }

  function requireBaseCollection(operation) {
    return function authorizeBaseCollection(request, response, next) {
      const user = getAuthenticatedUser(request, response);
      if (!user) {
        return;
      }

      const scope = getAuthorizationScope(user.role, operation);
      if (
        scope === AUTHORIZATION_SCOPE.DENY ||
        (scope === AUTHORIZATION_SCOPE.OWN_BASE && !isUuid(user.baseId))
      ) {
        return sendForbidden(response);
      }

      request.authorizationScope = scope;
      request.authorizedBaseId =
        scope === AUTHORIZATION_SCOPE.OWN_BASE ? user.baseId : null;
      return next();
    };
  }

  function requireBaseResource(
    operation,
    { resourceType, getResourceId } = {},
  ) {
    const query = BASE_RESOURCE_QUERIES[resourceType];
    if (!query || typeof getResourceId !== "function") {
      throw new Error("A supported base resource and identifier resolver are required.");
    }

    return async function authorizeBaseResource(request, response, next) {
      const user = getAuthenticatedUser(request, response);
      if (!user) {
        return;
      }

      const scope = getAuthorizationScope(user.role, operation);
      if (scope === AUTHORIZATION_SCOPE.DENY) {
        return sendForbidden(response);
      }

      const resourceId = getRequestIdentifier(request, getResourceId);
      if (!resourceId) {
        return sendForbidden(response);
      }

      let resources;
      try {
        resources = await dataSource.query(query, [resourceId]);
      } catch {
        return sendAuthorizationUnavailable(response);
      }

      if (!Array.isArray(resources)) {
        return sendAuthorizationUnavailable(response);
      }
      if (resources.length === 0) {
        return sendForbidden(response);
      }
      if (resources.length !== 1 || !isUuid(resources[0]?.base_id)) {
        return sendAuthorizationUnavailable(response);
      }

      const resourceBaseId = resources[0].base_id;
      const allowed =
        scope === AUTHORIZATION_SCOPE.GLOBAL ||
        scope === AUTHORIZATION_SCOPE.ANY_BASE ||
        (scope === AUTHORIZATION_SCOPE.OWN_BASE &&
          isUuid(user.baseId) &&
          user.baseId === resourceBaseId);

      if (!allowed) {
        return sendForbidden(response);
      }

      return next();
    };
  }

  function requireTransferAction(operation, { getTransferId } = {}) {
    if (
      !TRANSFER_ACTIONS.has(operation) ||
      typeof getTransferId !== "function"
    ) {
      throw new Error("A supported transfer action and identifier resolver are required.");
    }

    return async function authorizeTransferAction(
      request,
      response,
      next,
    ) {
      const user = getAuthenticatedUser(request, response);
      if (!user) {
        return;
      }

      if (
        getAuthorizationScope(user.role, operation) ===
        AUTHORIZATION_SCOPE.DENY
      ) {
        return sendForbidden(response);
      }

      const transferId = getRequestIdentifier(request, getTransferId);
      if (!transferId) {
        return sendForbidden(response);
      }

      let transfers;
      try {
        transfers = await dataSource.query(TRANSFER_QUERY, [transferId]);
      } catch {
        return sendAuthorizationUnavailable(response);
      }

      if (!Array.isArray(transfers)) {
        return sendAuthorizationUnavailable(response);
      }
      if (transfers.length === 0) {
        return sendForbidden(response);
      }
      if (transfers.length !== 1) {
        return sendAuthorizationUnavailable(response);
      }

      if (!transferActionAllowed(user, operation, transfers[0])) {
        return sendForbidden(response);
      }

      return next();
    };
  }

  return Object.freeze({
    requireOperation,
    requireBaseCollection,
    requireBaseResource,
    requireTransferAction,
  });
}
