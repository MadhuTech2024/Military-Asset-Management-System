import { randomUUID } from "node:crypto";
import { sanitizeAuditSnapshot } from "../config/auditSanitizer.js";

export async function writeBusinessAudit(
  manager,
  {
    actorUserId,
    action,
    entityType,
    entityId,
    baseId = null,
    correlationId = randomUUID(),
    beforeData = null,
    afterData = null,
  },
) {
  const rows = await manager.query(
    `INSERT INTO public.audit_log (
       actor_user_id, action, entity_type, entity_id, correlation_id,
       base_id, before_data, after_data
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     RETURNING id`,
    [
      actorUserId,
      action,
      entityType,
      entityId,
      correlationId,
      baseId,
      beforeData === null
        ? null
        : JSON.stringify(sanitizeAuditSnapshot(beforeData)),
      afterData === null
        ? null
        : JSON.stringify(sanitizeAuditSnapshot(afterData)),
    ],
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("The business audit event could not be persisted.");
  }
  return rows[0].id;
}
