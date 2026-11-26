import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequestFingerprint,
  executeIdempotentCommand,
} from "../utils/businessIdempotency.js";

const actorId = "59bc97c7-9187-42cc-8d9d-6694b3775b13";
const transferId = "a65733cc-c5ec-48fb-9351-3bf96ce2a29e";
const operation = "TRANSFER_APPROVE";
const idempotencyKey = "same-approval-request";
const payload = { transferId };

function createManager(recordProvider) {
  return {
    async query(sql) {
      assert.match(sql, /FROM public\.business_idempotency/u);
      return recordProvider();
    },
  };
}

test("concurrent state conflict replays the committed idempotency result", async () => {
  let record = null;
  const responsePayload = {
    success: true,
    data: { transfer: { id: transferId, status: "APPROVED" } },
  };
  const fingerprint = createRequestFingerprint({
    actorId,
    operation,
    payload,
  });
  const dataSource = {
    transaction: (callback) => callback(createManager(() => record ? [record] : [])),
  };

  const result = await executeIdempotentCommand({
    dataSource,
    actorId,
    operation,
    idempotencyKey,
    payload,
    authorize: async () => null,
    execute: async () => {
      record = {
        actor_user_id: actorId,
        operation,
        request_fingerprint: fingerprint,
        http_status: 200,
        response_payload: responsePayload,
      };
      return {
        kind: "conflict",
        code: "TRANSFER_STATE_CONFLICT",
        message: "Transfer is no longer pending.",
      };
    },
  });

  assert.deepEqual(result, {
    kind: "replay",
    status: 200,
    body: responsePayload,
  });
});

test("state conflict remains unchanged when no concurrent replay exists", async () => {
  const conflict = {
    kind: "conflict",
    code: "TRANSFER_STATE_CONFLICT",
    message: "Transfer is no longer pending.",
  };
  const dataSource = {
    transaction: (callback) => callback(createManager(() => [])),
  };

  const result = await executeIdempotentCommand({
    dataSource,
    actorId,
    operation,
    idempotencyKey,
    payload,
    authorize: async () => null,
    execute: async () => conflict,
  });

  assert.deepEqual(result, conflict);
});
