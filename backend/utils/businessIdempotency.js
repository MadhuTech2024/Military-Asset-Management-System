import { createHash } from "node:crypto";

const IDEMPOTENCY_LOOKUP = `
  SELECT actor_user_id, operation, request_fingerprint, http_status,
         response_payload
  FROM public.business_idempotency
  WHERE idempotency_key = $1
`;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function createRequestFingerprint({ actorId, operation, payload }) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({ actorId, operation, payload }),
      ),
      "utf8",
    )
    .digest("hex");
}

export function resolveIdempotencyRecord(
  row,
  { actorId, operation, fingerprint },
) {
  if (
    row.actor_user_id !== actorId ||
    row.operation !== operation ||
    row.request_fingerprint !== fingerprint
  ) {
    return { kind: "idempotency-conflict" };
  }
  if (
    !Number.isInteger(Number(row.http_status)) ||
    Number(row.http_status) < 200 ||
    Number(row.http_status) > 299 ||
    row.response_payload === null ||
    typeof row.response_payload !== "object" ||
    Array.isArray(row.response_payload)
  ) {
    return { kind: "database-error" };
  }
  return {
    kind: "replay",
    status: Number(row.http_status),
    body: row.response_payload,
  };
}

async function findExisting(source, key) {
  const rows = await source.query(IDEMPOTENCY_LOOKUP, [key]);
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("The idempotency record could not be verified.");
  }
  return rows[0] ?? null;
}

export async function lookupIdempotencyReplay(source, identity) {
  const previous = await findExisting(source, identity.idempotencyKey);
  return previous
    ? resolveIdempotencyRecord(previous, identity)
    : null;
}

const IDEMPOTENCY_UNIQUE_CONSTRAINTS = new Set([
  "business_idempotency_idempotency_key_key",
  "purchase_idempotency_key_key",
  "transfer_idempotency_key_key",
  "assignment_idempotency_key_key",
  "expenditure_idempotency_key_key",
  "return_operation_idempotency_key_key",
]);

function getDatabaseErrorConstraint(error) {
  return (
    error?.constraint ??
    error?.driverError?.constraint ??
    null
  );
}

function isUniqueViolation(error) {
  return error?.code === "23505" || error?.driverError?.code === "23505";
}

function isIdempotencyUniqueViolation(error) {
  if (!isUniqueViolation(error)) {
    return false;
  }
  const constraint = getDatabaseErrorConstraint(error);
  return constraint === null || IDEMPOTENCY_UNIQUE_CONSTRAINTS.has(constraint);
}

export async function executeIdempotentCommand({
  dataSource,
  actorId,
  operation,
  idempotencyKey,
  payload,
  authorize,
  execute,
}) {
  const fingerprint = createRequestFingerprint({
    actorId,
    operation,
    payload,
  });
  const identity = { actorId, operation, fingerprint, idempotencyKey };

  try {
    return await dataSource.transaction(async (manager) => {
      const authorization = await authorize(manager);
      if (authorization) {
        return authorization;
      }
      const previous = await lookupIdempotencyReplay(manager, identity);
      if (previous) {
        return previous;
      }

      const result = await execute(manager, {
        ...identity,
        lookupReplay: () => lookupIdempotencyReplay(manager, identity),
      });
      if (result.kind !== "success") {
        if (result.kind === "conflict") {
          const concurrentReplay = await lookupIdempotencyReplay(
            manager,
            identity,
          );
          if (concurrentReplay) {
            return concurrentReplay;
          }
        }
        return result;
      }

      const inserted = await manager.query(
        `INSERT INTO public.business_idempotency (
           idempotency_key, actor_user_id, operation, request_fingerprint,
           entity_type, entity_id, http_status, response_payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING id`,
        [
          idempotencyKey,
          actorId,
          operation,
          fingerprint,
          result.entityType,
          result.entityId,
          result.status,
          JSON.stringify(result.body),
        ],
      );
      if (!Array.isArray(inserted) || inserted.length !== 1) {
        throw new Error("The idempotency record could not be persisted.");
      }
      return result;
    });
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      try {
        return await dataSource.transaction(async (manager) => {
          const authorization = await authorize(manager);
          if (authorization) return authorization;
          const previous = await lookupIdempotencyReplay(manager, identity);
          if (previous) {
            return previous;
          }
          return previous ?? { kind: "database-error", error };
        });
      } catch (lookupError) {
        return { kind: "database-error", error: lookupError };
      }
    }
    return { kind: "database-error", error };
  }
}
