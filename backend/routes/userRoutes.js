import { Router } from "express";
import { createUserController } from "../controllers/userController.js";
import {
  AUTHORIZATION_OPERATIONS,
} from "../config/authorizationPolicies.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import {
  validateStatusBody,
  validateUserCreateBody,
  validateUserListQuery,
  validateUserUpdateBody,
  validateUuidParam,
} from "../middlewares/apiValidation.js";

export function createUserRouter({
  dataSource,
  jwtConfiguration,
  passwordHasher,
}) {
  const router = Router();
  const controller = createUserController({ dataSource, passwordHasher });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorize = createAuthorizationMiddleware({ dataSource })
    .requireOperation(AUTHORIZATION_OPERATIONS.MANAGE_USERS);

  router.get(
    "/",
    authenticate,
    authorize,
    validateUserListQuery,
    controller.list,
  );
  router.get(
    "/:id",
    authenticate,
    authorize,
    validateUuidParam("id"),
    controller.getById,
  );
  router.post(
    "/",
    authenticate,
    authorize,
    validateUserCreateBody,
    controller.create,
  );
  router.patch(
    "/:id/status",
    authenticate,
    authorize,
    validateUuidParam("id"),
    validateStatusBody,
    controller.setActive,
  );
  router.patch(
    "/:id",
    authenticate,
    authorize,
    validateUuidParam("id"),
    validateUserUpdateBody,
    controller.update,
  );

  return router;
}
