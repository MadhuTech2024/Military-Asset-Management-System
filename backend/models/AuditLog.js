import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "AuditLog",
  tableName: "audit_log",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    actorUserId: { name: "actor_user_id", type: "uuid", nullable: true },
    action: { type: "varchar", length: 64 },
    entityType: { name: "entity_type", type: "varchar", length: 64 },
    entityId: { type: "uuid", nullable: true },
    correlationId: { name: "correlation_id", type: "uuid" },
    baseId: { name: "base_id", type: "uuid", nullable: true },
    beforeData: { name: "before_data", type: "jsonb", nullable: true },
    afterData: { name: "after_data", type: "jsonb", nullable: true },
    ipAddress: { name: "ip_address", type: "inet", nullable: true },
    userAgent: { name: "user_agent", type: "varchar", length: 512, nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
  },
  indices: [
    { name: "idx_audit_entity", columns: ["entityType", "entityId"] },
    { name: "idx_audit_actor", columns: ["actorUserId"] },
    { name: "idx_audit_base", columns: ["baseId"] },
  ],
});
