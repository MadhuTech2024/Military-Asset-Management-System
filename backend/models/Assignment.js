import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "Assignment",
  tableName: "assignment",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    assetId: { name: "asset_id", type: "uuid" },
    baseId: { name: "base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    quantity: { type: "integer" },
    returnedQuantity: { name: "returned_quantity", type: "integer", default: 0 },
    personnelReference: { name: "personnel_reference", type: "varchar", length: 64 },
    status: { type: "enum", enum: ["ACTIVE", "PARTIALLY_RETURNED", "RETURNED", "CANCELLED"], default: "ACTIVE" },
    assignedBy: { name: "assigned_by", type: "uuid" },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 128, unique: true },
    returnedBy: { name: "returned_by", type: "uuid", nullable: true },
    assignedAt: { name: "assigned_at", type: "timestamptz" },
    returnedAt: { name: "returned_at", type: "timestamptz", nullable: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  relations: {
    asset: { type: "many-to-one", target: "Asset", joinColumn: { name: "asset_id" }, onDelete: "RESTRICT" },
    base: { type: "many-to-one", target: "Base", joinColumn: { name: "base_id" }, onDelete: "RESTRICT" },
    equipmentType: { type: "many-to-one", target: "EquipmentType", joinColumn: { name: "equipment_type_id" }, onDelete: "RESTRICT" },
  },
  indices: [
    { name: "idx_assignment_asset_status", columns: ["assetId", "status"] },
    { name: "idx_assignment_base", columns: ["baseId"] },
  ],
});
