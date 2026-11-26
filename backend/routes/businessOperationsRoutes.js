import { Router } from "express";
import { createBusinessOperationsController } from "../controllers/businessOperationsController.js";
import { AUTHORIZATION_OPERATIONS } from "../config/authorizationPolicies.js";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import {
  validateAssignmentCreateBody,
  validateEmptyRequestBody,
  validateExpenditureCreateBody,
  validateIdempotencyKey,
  validatePurchaseCreateBody,
  validateReturnBody,
  validateTransferCreateBody,
  validateUuidParam,
} from "../middlewares/apiValidation.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";

export function createBusinessOperationsRouter({
  dataSource,
  jwtConfiguration,
}) {
  const router = Router();
  const controller = createBusinessOperationsController({ dataSource });
  const authenticate = createAuthMiddleware({ dataSource, jwtConfiguration });
  const authorization = createAuthorizationMiddleware({ dataSource });

  router.post(
    "/purchases",
    authenticate,
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.PURCHASE_CREATE,
      {
        resourceType: "base",
        getResourceId: (request) => request.body?.baseId,
      },
    ),
    validatePurchaseCreateBody,
    validateIdempotencyKey,
    controller.createPurchase,
  );
  router.post(
    "/transfers",
    authenticate,
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.TRANSFER_INITIATE,
      {
        resourceType: "base",
        getResourceId: (request) => request.body?.sourceBaseId,
      },
    ),
    validateTransferCreateBody,
    validateIdempotencyKey,
    controller.initiateTransfer,
  );

  const transferActions = [
    [
      "approve",
      AUTHORIZATION_OPERATIONS.TRANSFER_APPROVE,
      controller.approveTransfer,
    ],
    [
      "reject",
      AUTHORIZATION_OPERATIONS.TRANSFER_REJECT,
      controller.rejectTransfer,
    ],
    [
      "complete",
      AUTHORIZATION_OPERATIONS.TRANSFER_COMPLETE,
      controller.completeTransfer,
    ],
  ];
  for (const [action, operation, handler] of transferActions) {
    router.post(
      `/transfers/:transferId/${action}`,
      authenticate,
      authorization.requireTransferAction(operation, {
        getTransferId: (request) => request.params.transferId,
      }),
      validateUuidParam("transferId"),
      validateEmptyRequestBody,
      validateIdempotencyKey,
      handler,
    );
  }

  router.post(
    "/assignments",
    authenticate,
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.ASSIGNMENT_CREATE,
      {
        resourceType: "asset",
        getResourceId: (request) => request.body?.assetId,
      },
    ),
    validateAssignmentCreateBody,
    validateIdempotencyKey,
    controller.createAssignment,
  );
  router.post(
    "/assignments/:assignmentId/returns",
    authenticate,
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.ASSIGNMENT_RETURN,
      {
        resourceType: "assignment",
        getResourceId: (request) => request.params.assignmentId,
      },
    ),
    validateUuidParam("assignmentId"),
    validateReturnBody,
    validateIdempotencyKey,
    controller.recordReturn,
  );
  router.post(
    "/expenditures",
    authenticate,
    authorization.requireBaseResource(
      AUTHORIZATION_OPERATIONS.EXPENDITURE_RECORD,
      {
        resourceType: "asset",
        getResourceId: (request) => request.body?.assetId,
      },
    ),
    validateExpenditureCreateBody,
    validateIdempotencyKey,
    controller.recordExpenditure,
  );

  return router;
}
