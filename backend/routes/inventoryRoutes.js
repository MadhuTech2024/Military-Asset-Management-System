import { Router } from "express";
import { createInventoryController } from "../controllers/assetController.js";
import {
  AUTHORIZATION_OPERATIONS,
} from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import {
  validateInventoryListQuery,
  validateOpeningStockBody,
  validateUuidParam,
} from "../middlewares/apiValidation.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";

export function createInventoryRouter({ dataSource, jwtConfiguration }) {
  const router = Router();
  const controller = createInventoryController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const inventoryScope = authorization.requireBaseCollection(
    AUTHORIZATION_OPERATIONS.INVENTORY_ACCESS,
  );
  const manageOpeningStock = authorization.requireOperation(
    AUTHORIZATION_OPERATIONS.MANAGE_OPENING_STOCK,
  );

  router.post(
    "/opening-stock",
    authenticate,
    manageOpeningStock,
    validateOpeningStockBody,
    controller.createOpeningStock,
  );
  router.get(
    "/",
    authenticate,
    inventoryScope,
    validateInventoryListQuery,
    controller.list,
  );
  router.get(
    "/summary",
    authenticate,
    inventoryScope,
    controller.summary,
  );
  router.get(
    "/bases/:baseId",
    authenticate,
    inventoryScope,
    validateUuidParam("baseId"),
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.INVENTORY_ACCESS,
      {
        resourceType: "base",
        getResourceId: (request) => request.params.baseId,
      },
    ),
    validateInventoryListQuery,
    controller.byBase,
  );
  router.get(
    "/equipment-types/:equipmentTypeId",
    authenticate,
    inventoryScope,
    validateUuidParam("equipmentTypeId"),
    validateInventoryListQuery,
    controller.byEquipmentType,
  );
  router.get(
    "/:id",
    authenticate,
    inventoryScope,
    validateUuidParam("id"),
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.INVENTORY_ACCESS,
      {
        resourceType: "asset",
        getResourceId: (request) => request.params.id,
      },
    ),
    controller.getById,
  );

  return router;
}
