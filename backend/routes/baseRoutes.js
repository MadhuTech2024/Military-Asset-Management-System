import { Router } from "express";
import { createBaseController } from "../controllers/baseController.js";
import { createDashboardController } from "../controllers/dashboardController.js";
import {
  AUTHORIZATION_OPERATIONS,
} from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";
import {
  validateBaseCreateBody,
  validateBaseListQuery,
  validateBaseUpdateBody,
  validateStatusBody,
  validateEmptyQuery,
  validateTransferDestinationListQuery,
  validateUuidParam,
} from "../middlewares/apiValidation.js";

export function createBaseRouter({ dataSource, jwtConfiguration }) {
  const router = Router();
  const controller = createBaseController({ dataSource });
  const dashboardController = createDashboardController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const readBaseScope = authorization.requireBaseCollection(
    AUTHORIZATION_OPERATIONS.BASE_DASHBOARD,
  );
  const manageBases = authorization.requireOperation(
    AUTHORIZATION_OPERATIONS.MANAGE_BASES,
  );
  const transferInitiationScope = authorization.requireBaseCollection(
    AUTHORIZATION_OPERATIONS.TRANSFER_INITIATE,
  );

  router.get(
    "/",
    authenticate,
    readBaseScope,
    validateBaseListQuery,
    controller.list,
  );
  router.get(
    "/transfer-destinations",
    authenticate,
    transferInitiationScope,
    validateTransferDestinationListQuery,
    controller.listTransferDestinations,
  );
  router.get(
    "/:id/dashboard",
    authenticate,
    readBaseScope,
    validateUuidParam("id"),
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.BASE_DASHBOARD,
      {
        resourceType: "base",
        getResourceId: (request) => request.params.id,
      },
    ),
    validateEmptyQuery,
    dashboardController.byBase,
  );
  router.get(
    "/:id",
    authenticate,
    readBaseScope,
    validateUuidParam("id"),
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.BASE_DASHBOARD,
      {
        resourceType: "base",
        getResourceId: (request) => request.params.id,
      },
    ),
    controller.getById,
  );
  router.post(
    "/",
    authenticate,
    manageBases,
    validateBaseCreateBody,
    controller.create,
  );
  router.patch(
    "/:id/status",
    authenticate,
    manageBases,
    validateUuidParam("id"),
    validateStatusBody,
    controller.setActive,
  );
  router.patch(
    "/:id",
    authenticate,
    manageBases,
    validateUuidParam("id"),
    validateBaseUpdateBody,
    controller.update,
  );

  return router;
}
