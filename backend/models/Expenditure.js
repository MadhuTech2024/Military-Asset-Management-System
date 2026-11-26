import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "Expenditure",
  tableName: "expenditure",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    assetId: { name: "asset_id", type: "uuid" },
    baseId: { name: "base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    quantity: { type: "integer" },
    reasonCode: { name: "reason_code", type: "varchar", length: 64 },
    notes: { type: "text", nullable: true },
    recordedBy: { name: "recorded_by", type: "uuid" },
    expendedAt: { name: "expended_at", type: "timestamptz" },
    idempotencyKey: { name: "idempotency_key", type: "varchar", length: 128, unique: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  relations: {
    asset: { type: "many-to-one", target: "Asset", joinColumn: { name: "asset_id" }, onDelete: "RESTRICT" },
    base: { type: "many-to-one", target: "Base", joinColumn: { name: "base_id" }, onDelete: "RESTRICT" },
    equipmentType: { type: "many-to-one", target: "EquipmentType", joinColumn: { name: "equipment_type_id" }, onDelete: "RESTRICT" },
  },
  indices: [
    { name: "idx_expenditure_asset", columns: ["assetId"] },
    { name: "idx_expenditure_base", columns: ["baseId"] },
  ],
});
