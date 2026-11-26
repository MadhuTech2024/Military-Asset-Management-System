import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "Transfer",
  tableName: "transfer",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    sourceBaseId: { name: "source_base_id", type: "uuid" },
    destinationBaseId: { name: "destination_base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    quantity: { type: "integer" },
    status: { type: "enum", enum: ["PENDING", "APPROVED", "COMPLETED", "REJECTED"], default: "PENDING" },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 128, unique: true },
    createdBy: { name: "created_by", type: "uuid" },
    approvedBy: { name: "approved_by", type: "uuid", nullable: true },
    completedBy: { name: "completed_by", type: "uuid", nullable: true },
    approvedAt: { name: "approved_at", type: "timestamptz", nullable: true },
    completedAt: { name: "completed_at", type: "timestamptz", nullable: true },
    rejectedAt: { name: "rejected_at", type: "timestamptz", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  relations: {
    sourceBase: { type: "many-to-one", target: "Base", joinColumn: { name: "source_base_id" }, onDelete: "RESTRICT" },
    destinationBase: { type: "many-to-one", target: "Base", joinColumn: { name: "destination_base_id" }, onDelete: "RESTRICT" },
    equipmentType: { type: "many-to-one", target: "EquipmentType", joinColumn: { name: "equipment_type_id" }, onDelete: "RESTRICT" },
    creator: { type: "many-to-one", target: "User", joinColumn: { name: "created_by" }, onDelete: "RESTRICT" },
  },
  indices: [
    { name: "idx_transfer_source_status", columns: ["sourceBaseId", "status"] },
    { name: "idx_transfer_destination_status", columns: ["destinationBaseId", "status"] },
  ],
});
