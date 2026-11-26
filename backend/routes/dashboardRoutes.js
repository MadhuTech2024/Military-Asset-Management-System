import { Router } from "express";
import { createDashboardController } from "../controllers/dashboardController.js";
import { AUTHORIZATION_OPERATIONS } from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import { validateEmptyQuery } from "../middlewares/apiValidation.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";

export function createDashboardRouter({ dataSource, jwtConfiguration }) {
  const router = Router();
  const controller = createDashboardController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });

  router.get(
    "/",
    authenticate,
    authorization.requireOperation(
      AUTHORIZATION_OPERATIONS.GLOBAL_DASHBOARD,
    ),
    validateEmptyQuery,
    controller.global,
  );

  return router;
}
