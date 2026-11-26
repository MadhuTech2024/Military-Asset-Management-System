import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "ReturnOperation",
  tableName: "return_operation",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    assignmentId: { name: "assignment_id", type: "uuid" },
    assetId: { name: "asset_id", type: "uuid" },
    baseId: { name: "base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    quantity: { type: "integer" },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 128, unique: true },
    returnedBy: { name: "returned_by", type: "uuid" },
    returnedAt: { name: "returned_at", type: "timestamptz" },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
  },
  relations: {
    assignment: { type: "many-to-one", target: "Assignment", joinColumn: { name: "assignment_id" }, onDelete: "RESTRICT" },
    asset: { type: "many-to-one", target: "Asset", joinColumn: { name: "asset_id" }, onDelete: "RESTRICT" },
    base: { type: "many-to-one", target: "Base", joinColumn: { name: "base_id" }, onDelete: "RESTRICT" },
    equipmentType: { type: "many-to-one", target: "EquipmentType", joinColumn: { name: "equipment_type_id" }, onDelete: "RESTRICT" },
  },
  indices: [
    { name: "idx_return_operation_assignment", columns: ["assignmentId"] },
  ],
});
