import { Router } from "express";
import { createEquipmentTypeController } from "../controllers/equipmentTypeController.js";
import {
  AUTHORIZATION_OPERATIONS,
} from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import {
  validateEquipmentTypeCreateBody,
  validateEquipmentTypeListQuery,
  validateEquipmentTypeUpdateBody,
  validateStatusBody,
  validateUuidParam,
} from "../middlewares/apiValidation.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";

export function createEquipmentTypeRouter({
  dataSource,
  jwtConfiguration,
}) {
  const router = Router();
  const controller = createEquipmentTypeController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const readEquipmentTypes = authorization.requireOperation(
    AUTHORIZATION_OPERATIONS.EQUIPMENT_TYPE_ACCESS,
  );
  const manageEquipmentTypes = authorization.requireOperation(
    AUTHORIZATION_OPERATIONS.MANAGE_EQUIPMENT_TYPES,
  );

  router.get(
    "/",
    authenticate,
    readEquipmentTypes,
    validateEquipmentTypeListQuery,
    controller.list,
  );
  router.get(
    "/:id",
    authenticate,
    readEquipmentTypes,
    validateUuidParam("id"),
    controller.getById,
  );
  router.post(
    "/",
    authenticate,
    manageEquipmentTypes,
    validateEquipmentTypeCreateBody,
    controller.create,
  );
  router.patch(
    "/:id/status",
    authenticate,
    manageEquipmentTypes,
    validateUuidParam("id"),
    validateStatusBody,
    controller.setActive,
  );
  router.patch(
    "/:id",
    authenticate,
    manageEquipmentTypes,
    validateUuidParam("id"),
    validateEquipmentTypeUpdateBody,
    controller.update,
  );

  return router;
}
