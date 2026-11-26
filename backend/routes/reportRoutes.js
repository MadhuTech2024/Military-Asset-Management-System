import { Router } from "express";
import { createReportController } from "../controllers/reportController.js";
import { AUTHORIZATION_OPERATIONS } from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import {
  validateInventoryMovementListQuery,
  validateReportListQuery,
} from "../middlewares/apiValidation.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";

export function createReportRouter({ dataSource, jwtConfiguration }) {
  const router = Router();
  const controller = createReportController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const reportScope = authorization.requireBaseCollection(
    AUTHORIZATION_OPERATIONS.INVENTORY_ACCESS,
  );

  router.get(
    "/inventory-movements",
    authenticate,
    reportScope,
    validateInventoryMovementListQuery,
    controller.inventoryMovements,
  );
  router.get(
    "/purchases",
    authenticate,
    reportScope,
    validateReportListQuery,
    controller.purchases,
  );
  router.get(
    "/transfers",
    authenticate,
    reportScope,
    validateReportListQuery,
    controller.transfers,
  );
  router.get(
    "/assignments",
    authenticate,
    reportScope,
    validateReportListQuery,
    controller.assignments,
  );
  router.get(
    "/returns",
    authenticate,
    reportScope,
    validateReportListQuery,
    controller.returns,
  );
  router.get(
    "/expenditures",
    authenticate,
    reportScope,
    validateReportListQuery,
    controller.expenditures,
  );

  return router;
}
