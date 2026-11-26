import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "Purchase",
  tableName: "purchase",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    baseId: { name: "base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    quantity: { type: "integer" },
    status: { type: "enum", enum: ["PENDING", "COMPLETED", "REJECTED"], default: "PENDING" },
    referenceCode: { name: "reference_code", type: "varchar", length: 64, nullable: true, unique: true },
    purchasedAt: { name: "purchased_at", type: "timestamptz" },
    createdBy: { name: "created_by", type: "uuid" },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 128, unique: true },
    completedAt: { name: "completed_at", type: "timestamptz", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  relations: {
    base: { type: "many-to-one", target: "Base", joinColumn: { name: "base_id" }, onDelete: "RESTRICT" },
    equipmentType: { type: "many-to-one", target: "EquipmentType", joinColumn: { name: "equipment_type_id" }, onDelete: "RESTRICT" },
    creator: { type: "many-to-one", target: "User", joinColumn: { name: "created_by" }, onDelete: "RESTRICT" },
  },
  indices: [
    { name: "idx_purchase_base", columns: ["baseId"] },
    { name: "idx_purchase_equipment", columns: ["equipmentTypeId"] },
    { name: "idx_purchase_status", columns: ["status"] },
  ],
});
