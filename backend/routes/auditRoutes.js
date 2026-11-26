import { Router } from "express";
import { createAuditController } from "../controllers/auditController.js";
import { AUTHORIZATION_OPERATIONS } from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import {
  validateAuditListQuery,
  validateUuidParam,
} from "../middlewares/apiValidation.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";

export function createAuditRouter({ dataSource, jwtConfiguration }) {
  const router = Router();
  const controller = createAuditController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const auditScope = authorization.requireBaseCollection(
    AUTHORIZATION_OPERATIONS.AUDIT_LOG_READ,
  );

  router.get(
    "/",
    authenticate,
    auditScope,
    validateAuditListQuery,
    controller.list,
  );
  router.get(
    "/:id",
    authenticate,
    auditScope,
    validateUuidParam("id"),
    controller.getById,
  );

  return router;
}
