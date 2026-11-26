import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { SignJWT } from "jose";
import { createAuthMiddleware } from "../middlewares/authMiddleware.js";
import { createAuthorizationMiddleware } from "../middlewares/rbacMiddleware.js";
import {
  areTransferActorsDistinct,
  isTransferActionCurrentlyAuthorized,
  AUTHORIZATION_OPERATIONS as OP,
  AUTHORIZATION_SCOPE as SCOPE,
  getAuthorizationScope,
} from "./authorizationPolicies.js";
import {
  createJwtConfiguration,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from "./jwt.js";
import { SYNTHETIC_JWT_SECRET } from "./testJwtSecret.js";

const jwtSecret = SYNTHETIC_JWT_SECRET;
const jwtConfiguration = createJwtConfiguration(jwtSecret);

function makeUser({
  id = randomUUID(),
  role = "LOGISTICS_OFFICER",
  baseId = randomUUID(),
  isActive = true,
} = {}) {
  return { id, role, baseId, isActive };
}

function makeTransfer({
  id = randomUUID(),
  sourceBaseId = randomUUID(),
  destinationBaseId = randomUUID(),
  status = "PENDING",
  createdBy = randomUUID(),
  approvedBy = null,
  completedBy = null,
} = {}) {
  return {
    id,
    source_base_id: sourceBaseId,
    destination_base_id: destinationBaseId,
    status,
    created_by: createdBy,
    approved_by: approvedBy,
    completed_by: completedBy,
  };
}

function createDataSource(queryHandler) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return queryHandler(sql, values);
    },
  };
}

async function invoke(middleware, {
  currentUser,
  body = {},
  params = {},
  query = {},
} = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  const request = { currentUser, body, params, query };
  let nextCalled = false;
  await middleware(request, response, () => {
    nextCalled = true;
  });
  return { request, response, nextCalled };
}

test("shared transfer replay authorization preserves lifecycle replay permissions", () => {
  const requesterId = randomUUID();
  const approverId = randomUUID();
  const completerId = randomUUID();
  const sourceBaseId = randomUUID();
  const destinationBaseId = randomUUID();

  const approvedReplay = {
    source_base_id: sourceBaseId,
    destination_base_id: destinationBaseId,
    created_by: requesterId,
    approved_by: approverId,
    completed_by: null,
  };
  assert.equal(
    isTransferActionCurrentlyAuthorized({
      role: "LOGISTICS_OFFICER",
      operation: OP.TRANSFER_COMPLETE,
      userId: completerId,
      userBaseId: destinationBaseId,
      transfer: approvedReplay,
    }),
    true,
  );

  const completedReplay = {
    ...approvedReplay,
    completed_by: completerId,
  };
  assert.equal(
    isTransferActionCurrentlyAuthorized({
      role: "LOGISTICS_OFFICER",
      operation: OP.TRANSFER_COMPLETE,
      userId: completerId,
      userBaseId: destinationBaseId,
      transfer: completedReplay,
    }),
    true,
  );
  assert.equal(
    isTransferActionCurrentlyAuthorized({
      role: "LOGISTICS_OFFICER",
      operation: OP.TRANSFER_COMPLETE,
      userId: completerId,
      userBaseId: sourceBaseId,
      transfer: completedReplay,
    }),
    false,
  );
  assert.equal(
    isTransferActionCurrentlyAuthorized({
      role: "LOGISTICS_OFFICER",
      operation: OP.TRANSFER_APPROVE,
      userId: completerId,
      userBaseId: destinationBaseId,
      transfer: completedReplay,
    }),
    false,
  );
});

async function signToken({
  subject,
  role = "ADMIN",
  baseId = randomUUID(),
}) {
  return new SignJWT({ role, baseId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(jwtConfiguration.key);
}

async function startAuthzServer({ dataSource }) {
  const app = express();
  const authenticate = createAuthMiddleware({
    dataSource,
    jwtConfiguration,
  });
  const authorization = createAuthorizationMiddleware({ dataSource });

  app.use(express.json());
  app.post(
    "/inventory/:assetId",
    authenticate,
    authorization.requireBaseResource(OP.INVENTORY_ACCESS, {
      resourceType: "asset",
      getResourceId: (request) => request.params.assetId,
    }),
    (request, response) => {
      response.status(200).json({ currentUser: request.currentUser });
    },
  );
  app.post(
    "/manage-users",
    authenticate,
    authorization.requireOperation(OP.MANAGE_USERS),
    (_request, response) => {
      response.status(200).json({ success: true });
    },
  );

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

async function closeServer(server) {
  if (!server?.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test("authorization policy matches every role and operation in the matrix", () => {
  const matrix = [
    [OP.MANAGE_USERS, SCOPE.GLOBAL, SCOPE.DENY, SCOPE.DENY],
    [OP.MANAGE_BASES, SCOPE.GLOBAL, SCOPE.DENY, SCOPE.DENY],
    [OP.GLOBAL_DASHBOARD, SCOPE.GLOBAL, SCOPE.DENY, SCOPE.DENY],
    [OP.BASE_DASHBOARD, SCOPE.ANY_BASE, SCOPE.OWN_BASE, SCOPE.OWN_BASE],
    [OP.INVENTORY_ACCESS, SCOPE.GLOBAL, SCOPE.OWN_BASE, SCOPE.OWN_BASE],
    [
      OP.EQUIPMENT_TYPE_ACCESS,
      SCOPE.GLOBAL,
      SCOPE.GLOBAL,
      SCOPE.GLOBAL,
    ],
    [
      OP.MANAGE_EQUIPMENT_TYPES,
      SCOPE.GLOBAL,
      SCOPE.GLOBAL,
      SCOPE.GLOBAL,
    ],
    [OP.MANAGE_OPENING_STOCK, SCOPE.GLOBAL, SCOPE.DENY, SCOPE.DENY],
    [OP.PURCHASE_CREATE, SCOPE.GLOBAL, SCOPE.DENY, SCOPE.OWN_BASE],
    [OP.TRANSFER_INITIATE, SCOPE.GLOBAL, SCOPE.DENY, SCOPE.OWN_BASE],
    [OP.TRANSFER_APPROVE, SCOPE.DENY, SCOPE.OWN_BASE, SCOPE.DENY],
    [OP.TRANSFER_REJECT, SCOPE.DENY, SCOPE.OWN_BASE, SCOPE.DENY],
    [OP.TRANSFER_COMPLETE, SCOPE.DENY, SCOPE.DENY, SCOPE.OWN_BASE],
    [OP.ASSIGNMENT_CREATE, SCOPE.GLOBAL, SCOPE.OWN_BASE, SCOPE.DENY],
    [OP.ASSIGNMENT_RETURN, SCOPE.GLOBAL, SCOPE.OWN_BASE, SCOPE.DENY],
    [OP.EXPENDITURE_RECORD, SCOPE.GLOBAL, SCOPE.OWN_BASE, SCOPE.DENY],
  ];

  for (const [operation, admin, commander, logistics] of matrix) {
    assert.deepEqual(
      [
        getAuthorizationScope("ADMIN", operation),
        getAuthorizationScope("BASE_COMMANDER", operation),
        getAuthorizationScope("LOGISTICS_OFFICER", operation),
      ],
      [admin, commander, logistics],
      operation,
    );
  }
});

test("missing and unknown roles and operations are denied by default", () => {
  assert.equal(getAuthorizationScope(undefined, OP.MANAGE_USERS), SCOPE.DENY);
  assert.equal(getAuthorizationScope(null, OP.MANAGE_USERS), SCOPE.DENY);
  assert.equal(
    getAuthorizationScope("UNKNOWN_ROLE", OP.MANAGE_USERS),
    SCOPE.DENY,
  );
  assert.equal(
    getAuthorizationScope("ADMIN", "UNLISTED_OPERATION"),
    SCOPE.DENY,
  );
});

test("transfer actor policy requires distinct requester, approver, and completer", () => {
  const requesterId = randomUUID();
  const approverId = randomUUID();
  const completionActorId = randomUUID();

  assert.equal(
    areTransferActorsDistinct({
      requesterId,
      approverId,
      completionActorId,
    }),
    true,
  );
  assert.equal(
    areTransferActorsDistinct({ requesterId, approverId: requesterId }),
    false,
  );
  assert.equal(
    areTransferActorsDistinct({
      requesterId,
      approverId,
      completionActorId: approverId,
    }),
    false,
  );
  assert.equal(areTransferActorsDistinct({ requesterId: null }), false);
});

test("global operations require an active authenticated user and ignore request role fields", async () => {
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource(() => []),
  });
  const requireManageUsers = authorization.requireOperation(OP.MANAGE_USERS);

  for (const currentUser of [
    undefined,
    makeUser({ isActive: false }),
    makeUser({ role: undefined }),
    makeUser({ role: "UNKNOWN_ROLE" }),
  ]) {
    const result = await invoke(requireManageUsers, {
      currentUser,
      body: { role: "ADMIN" },
    });
    assert.equal(result.nextCalled, false);
    assert.equal(
      result.response.statusCode,
      currentUser && currentUser.isActive === true ? 403 : 401,
    );
  }

  const logisticsSpoof = await invoke(requireManageUsers, {
    currentUser: makeUser({ role: "LOGISTICS_OFFICER" }),
    body: { role: "ADMIN" },
    query: { role: "ADMIN" },
    params: { role: "ADMIN" },
  });
  assert.equal(logisticsSpoof.response.statusCode, 403);

  const adminRequest = await invoke(requireManageUsers, {
    currentUser: makeUser({ role: "ADMIN" }),
    body: { role: "LOGISTICS_OFFICER" },
  });
  assert.equal(adminRequest.nextCalled, true);
});

test("base collection authorization derives scope only from the current user", async () => {
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource(() => []),
  });
  const middleware = authorization.requireBaseCollection(OP.BASE_DASHBOARD);
  const assignedBaseId = randomUUID();

  const ownBase = await invoke(middleware, {
    currentUser: makeUser({
      role: "BASE_COMMANDER",
      baseId: assignedBaseId,
    }),
    body: { baseId: randomUUID() },
    query: { baseId: randomUUID() },
  });
  assert.equal(ownBase.nextCalled, true);
  assert.equal(ownBase.request.authorizedBaseId, assignedBaseId);
  assert.equal(ownBase.request.authorizationScope, SCOPE.OWN_BASE);

  const admin = await invoke(middleware, {
    currentUser: makeUser({ role: "ADMIN", baseId: null }),
    body: { baseId: assignedBaseId },
  });
  assert.equal(admin.nextCalled, true);
  assert.equal(admin.request.authorizedBaseId, null);
  assert.equal(admin.request.authorizationScope, SCOPE.ANY_BASE);

  const missingAssignment = await invoke(middleware, {
    currentUser: makeUser({ role: "LOGISTICS_OFFICER", baseId: null }),
  });
  assert.equal(missingAssignment.response.statusCode, 403);
});

test("all explicitly approved equipment-type roles pass their operation policies", async () => {
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource(() => []),
  });

  for (const role of [
    "ADMIN",
    "BASE_COMMANDER",
    "LOGISTICS_OFFICER",
  ]) {
    for (const operation of [
      OP.EQUIPMENT_TYPE_ACCESS,
      OP.MANAGE_EQUIPMENT_TYPES,
    ]) {
      const result = await invoke(
        authorization.requireOperation(operation),
        { currentUser: makeUser({ role }) },
      );
      assert.equal(result.nextCalled, true, `${role} ${operation}`);
    }
  }
});

test("base resource access uses database ownership and ignores client base claims", async () => {
  const ownBaseId = randomUUID();
  const otherBaseId = randomUUID();
  const ownAssetId = randomUUID();
  const otherAssetId = randomUUID();
  const assets = new Map([
    [ownAssetId, { base_id: ownBaseId }],
    [otherAssetId, { base_id: otherBaseId }],
  ]);
  const dataSource = createDataSource((sql, values) => {
    assert.match(sql, /FROM public\.asset WHERE id = \$1/);
    return assets.has(values[0]) ? [assets.get(values[0])] : [];
  });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const middleware = authorization.requireBaseResource(
    OP.INVENTORY_ACCESS,
    {
      resourceType: "asset",
      getResourceId: (request) => request.params.assetId,
    },
  );
  const logistics = makeUser({
    role: "LOGISTICS_OFFICER",
    baseId: ownBaseId,
  });

  const crossBaseAttempt = await invoke(middleware, {
    currentUser: logistics,
    params: { assetId: otherAssetId, baseId: ownBaseId },
    body: { baseId: ownBaseId, role: "ADMIN" },
  });
  assert.equal(crossBaseAttempt.response.statusCode, 403);
  assert.equal(dataSource.calls.at(-1).values[0], otherAssetId);

  const ownBaseAttempt = await invoke(middleware, {
    currentUser: logistics,
    params: { assetId: ownAssetId, baseId: otherBaseId },
    body: { baseId: otherBaseId, role: "ADMIN" },
  });
  assert.equal(ownBaseAttempt.nextCalled, true);
  assert.equal(dataSource.calls.at(-1).values[0], ownAssetId);
});

test("missing base assignments and unknown resources fail closed", async () => {
  const baseId = randomUUID();
  const assetId = randomUUID();
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource((_sql, values) =>
      values[0] === assetId ? [{ base_id: baseId }] : [],
    ),
  });
  const middleware = authorization.requireBaseResource(
    OP.INVENTORY_ACCESS,
    {
      resourceType: "asset",
      getResourceId: (request) => request.params.assetId,
    },
  );

  const noAssignment = await invoke(middleware, {
    currentUser: makeUser({ role: "BASE_COMMANDER", baseId: null }),
    params: { assetId },
  });
  assert.equal(noAssignment.response.statusCode, 403);

  const missingResource = await invoke(middleware, {
    currentUser: makeUser({ role: "ADMIN" }),
    params: { assetId: randomUUID() },
  });
  assert.equal(missingResource.response.statusCode, 403);

  assert.throws(
    () =>
      authorization.requireBaseResource(OP.INVENTORY_ACCESS, {
        resourceType: "unknown_table",
        getResourceId: (request) => request.params.id,
      }),
    /supported base resource/,
  );
});

test("database lookup failures return a safe authorization-unavailable response", async () => {
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource(() => {
      throw new Error("sensitive SQL and connection details");
    }),
  });
  const middleware = authorization.requireBaseResource(
    OP.INVENTORY_ACCESS,
    {
      resourceType: "asset",
      getResourceId: (request) => request.params.assetId,
    },
  );
  const result = await invoke(middleware, {
    currentUser: makeUser(),
    params: { assetId: randomUUID() },
  });

  assert.equal(result.response.statusCode, 503);
  assert.doesNotMatch(
    JSON.stringify(result.response.body),
    /sensitive SQL|connection details/,
  );
});

test("base dashboard grants ADMIN access to any database-verified base", async () => {
  const requestedBase = randomUUID();
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource((sql, values) => {
      assert.match(sql, /FROM public\.base WHERE id = \$1/);
      return [{ base_id: values[0] }];
    }),
  });
  const middleware = authorization.requireBaseResource(
    OP.BASE_DASHBOARD,
    {
      resourceType: "base",
      getResourceId: (request) => request.params.baseId,
    },
  );

  const result = await invoke(middleware, {
    currentUser: makeUser({ role: "ADMIN", baseId: null }),
    params: { baseId: requestedBase },
  });
  assert.equal(result.nextCalled, true);
});

test("transfer initiation checks the actual source base, not request-supplied ownership", async () => {
  const ownBaseId = randomUUID();
  const otherBaseId = randomUUID();
  const authorization = createAuthorizationMiddleware({
    dataSource: createDataSource((_sql, values) => [{ base_id: values[0] }]),
  });
  const middleware = authorization.requireBaseResource(
    OP.TRANSFER_INITIATE,
    {
      resourceType: "base",
      getResourceId: (request) => request.body.sourceBaseId,
    },
  );
  const user = makeUser({
    role: "LOGISTICS_OFFICER",
    baseId: ownBaseId,
  });

  const spoofedSource = await invoke(middleware, {
    currentUser: user,
    body: { sourceBaseId: otherBaseId, baseId: ownBaseId },
  });
  assert.equal(spoofedSource.response.statusCode, 403);

  const ownSource = await invoke(middleware, {
    currentUser: user,
    body: { sourceBaseId: ownBaseId },
  });
  assert.equal(ownSource.nextCalled, true);
});

test("transfer approval and rejection require a distinct destination commander", async () => {
  const sourceBaseId = randomUUID();
  const destinationBaseId = randomUUID();
  const requesterId = randomUUID();
  const transfer = makeTransfer({
    sourceBaseId,
    destinationBaseId,
    createdBy: requesterId,
  });
  const dataSource = createDataSource((sql, values) => {
    assert.match(sql, /FROM public\.transfer/);
    assert.equal(values[0], transfer.id);
    return [transfer];
  });
  const authorization = createAuthorizationMiddleware({ dataSource });
  const commander = makeUser({
    role: "BASE_COMMANDER",
    baseId: destinationBaseId,
  });
  const approve = authorization.requireTransferAction(OP.TRANSFER_APPROVE, {
    getTransferId: (request) => request.params.transferId,
  });
  const reject = authorization.requireTransferAction(OP.TRANSFER_REJECT, {
    getTransferId: (request) => request.params.transferId,
  });

  assert.equal(
    (await invoke(approve, {
      currentUser: commander,
      params: { transferId: transfer.id },
    })).nextCalled,
    true,
  );
  assert.equal(
    (await invoke(reject, {
      currentUser: commander,
      params: { transferId: transfer.id },
      body: {
        source_base_id: destinationBaseId,
        destination_base_id: sourceBaseId,
        status: "APPROVED",
        created_by: commander.id,
      },
    })).nextCalled,
    true,
  );

  const requesterTryingToApprove = await invoke(approve, {
    currentUser: makeUser({
      id: requesterId,
      role: "BASE_COMMANDER",
      baseId: destinationBaseId,
    }),
    params: { transferId: transfer.id },
  });
  assert.equal(requesterTryingToApprove.response.statusCode, 403);
});

test("transfer completion middleware checks scope and actors while controller handles state", async () => {
  const sourceBaseId = randomUUID();
  const destinationBaseId = randomUUID();
  const requesterId = randomUUID();
  const approverId = randomUUID();
  const transfer = makeTransfer({
    sourceBaseId,
    destinationBaseId,
    status: "APPROVED",
    createdBy: requesterId,
    approvedBy: approverId,
  });
  const dataSource = createDataSource(() => [transfer]);
  const authorization = createAuthorizationMiddleware({ dataSource });
  const complete = authorization.requireTransferAction(
    OP.TRANSFER_COMPLETE,
    { getTransferId: (request) => request.params.transferId },
  );

  const validCompletion = await invoke(complete, {
    currentUser: makeUser({
      role: "LOGISTICS_OFFICER",
      baseId: destinationBaseId,
    }),
    params: { transferId: transfer.id },
  });
  assert.equal(validCompletion.nextCalled, true);

  for (const replayableOrInvalidState of [
    { ...transfer, status: "PENDING" },
    { ...transfer, approved_by: null },
    { ...transfer, completed_by: randomUUID() },
  ]) {
    const invalidAuthorization = createAuthorizationMiddleware({
      dataSource: createDataSource(() => [replayableOrInvalidState]),
    });
    const result = await invoke(
      invalidAuthorization.requireTransferAction(
        OP.TRANSFER_COMPLETE,
        { getTransferId: (request) => request.params.transferId },
      ),
      {
        currentUser: makeUser({
          role: "LOGISTICS_OFFICER",
          baseId: destinationBaseId,
        }),
        params: { transferId: transfer.id },
      },
    );
    assert.equal(result.nextCalled, true);
  }

  const approverCompletes = await invoke(complete, {
    currentUser: makeUser({
      id: approverId,
      role: "LOGISTICS_OFFICER",
      baseId: destinationBaseId,
    }),
    params: { transferId: transfer.id },
  });
  assert.equal(approverCompletes.response.statusCode, 403);

  const wrongDestination = await invoke(complete, {
    currentUser: makeUser({
      role: "LOGISTICS_OFFICER",
      baseId: sourceBaseId,
    }),
    params: { transferId: transfer.id },
    body: { destination_base_id: sourceBaseId, status: "APPROVED" },
  });
  assert.equal(wrongDestination.response.statusCode, 403);
});

test("ADMIN is explicitly denied transfer approval, rejection, and completion", async () => {
  const dataSource = createDataSource(() => {
    throw new Error("ADMIN must be denied before transfer lookup.");
  });
  const authorization = createAuthorizationMiddleware({ dataSource });

  for (const operation of [
    OP.TRANSFER_APPROVE,
    OP.TRANSFER_REJECT,
    OP.TRANSFER_COMPLETE,
  ]) {
    const middleware = authorization.requireTransferAction(operation, {
      getTransferId: (request) => request.params.transferId,
    });
    const result = await invoke(middleware, {
      currentUser: makeUser({ role: "ADMIN" }),
      params: { transferId: randomUUID() },
    });
    assert.equal(result.response.statusCode, 403);
  }
  assert.equal(dataSource.calls.length, 0);
});

test("authentication followed by authorization trusts database role and resource base", async () => {
  const userId = randomUUID();
  const ownBaseId = randomUUID();
  const otherBaseId = randomUUID();
  const ownAssetId = randomUUID();
  const otherAssetId = randomUUID();
  const databaseUser = {
    exists: true,
    role: "LOGISTICS_OFFICER",
    baseId: ownBaseId,
    isActive: true,
  };
  const assets = new Map([
    [ownAssetId, { base_id: ownBaseId }],
    [otherAssetId, { base_id: otherBaseId }],
  ]);
  const dataSource = createDataSource((sql, values) => {
    if (sql.includes("FROM public.app_user")) {
      return databaseUser.exists
        ? [{
            id: userId,
            email: "officer@example.test",
            full_name: "Synthetic Officer",
            role: databaseUser.role,
            base_id: databaseUser.baseId,
            is_active: databaseUser.isActive,
          }]
        : [];
    }
    if (sql.includes("FROM public.asset")) {
      const asset = assets.get(values[0]);
      return asset ? [asset] : [];
    }
    throw new Error("Unexpected query.");
  });
  const { server, url } = await startAuthzServer({ dataSource });
  const token = await signToken({
    subject: userId,
    role: "ADMIN",
    baseId: otherBaseId,
  });

  try {
    const crossBaseResponse = await fetch(`${url}/inventory/${otherAssetId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "ADMIN", baseId: ownBaseId }),
    });
    assert.equal(crossBaseResponse.status, 403);

    const ownBaseResponse = await fetch(`${url}/inventory/${ownAssetId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ role: "ADMIN", baseId: otherBaseId }),
    });
    assert.equal(ownBaseResponse.status, 200);
    const body = await ownBaseResponse.json();
    assert.equal(body.currentUser.role, "LOGISTICS_OFFICER");
    assert.equal(body.currentUser.baseId, ownBaseId);

    const databaseRoleResponse = await fetch(`${url}/manage-users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(databaseRoleResponse.status, 403);

    databaseUser.role = "ADMIN";
    const updatedRoleResponse = await fetch(`${url}/manage-users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(updatedRoleResponse.status, 200);

    databaseUser.role = "LOGISTICS_OFFICER";
    databaseUser.baseId = otherBaseId;
    const updatedBaseResponse = await fetch(`${url}/inventory/${ownAssetId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(updatedBaseResponse.status, 403);

    databaseUser.baseId = ownBaseId;
    databaseUser.isActive = false;
    const inactiveResponse = await fetch(`${url}/inventory/${ownAssetId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    assert.equal(inactiveResponse.status, 401);

    databaseUser.exists = false;
    const deletedResponse = await fetch(`${url}/manage-users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(deletedResponse.status, 401);
  } finally {
    await closeServer(server);
  }
});
