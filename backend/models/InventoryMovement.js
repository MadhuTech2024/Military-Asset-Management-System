import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "InventoryMovement",
  tableName: "inventory_movement",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    assetId: { name: "asset_id", type: "uuid" },
    baseId: { name: "base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    movementType: {
      name: "movement_type",
      type: "enum",
      enum: ["PURCHASE", "TRANSFER_IN", "TRANSFER_OUT", "ASSIGNMENT", "RETURN", "EXPENDITURE"],
    },
    quantity: { type: "integer" },
    direction: { type: "enum", enum: ["IN", "OUT"] },
    occurredAt: { name: "occurred_at", type: "timestamptz" },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 128, unique: true },
    purchaseId: { name: "purchase_id", type: "uuid", nullable: true },
    transferId: { name: "transfer_id", type: "uuid", nullable: true },
    assignmentId: { name: "assignment_id", type: "uuid", nullable: true },
    expenditureId: { name: "expenditure_id", type: "uuid", nullable: true },
    returnOperationId: { name: "return_operation_id", type: "uuid", nullable: true },
    createdBy: { name: "created_by", type: "uuid" },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
  },
  relations: {
    asset: { type: "many-to-one", target: "Asset", joinColumn: { name: "asset_id" }, onDelete: "RESTRICT" },
    base: { type: "many-to-one", target: "Base", joinColumn: { name: "base_id" }, onDelete: "RESTRICT" },
    equipmentType: { type: "many-to-one", target: "EquipmentType", joinColumn: { name: "equipment_type_id" }, onDelete: "RESTRICT" },
  },
  indices: [
    { name: "idx_movement_asset_time", columns: ["assetId", "occurredAt"] },
    { name: "idx_movement_base_equipment_time", columns: ["baseId", "equipmentTypeId", "occurredAt"] },
  ],
});
