import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "Asset",
  tableName: "asset",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    baseId: { name: "base_id", type: "uuid" },
    equipmentTypeId: { name: "equipment_type_id", type: "uuid" },
    openingBalance: { name: "opening_balance", type: "integer", default: 0 },
    openingAt: { name: "opening_at", type: "timestamptz" },
    isActive: { name: "is_active", type: "boolean", default: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  uniques: [
    { name: "uq_asset_base_equipment", columns: ["baseId", "equipmentTypeId"] },
  ],
  relations: {
    base: {
      type: "many-to-one",
      target: "Base",
      joinColumn: { name: "base_id" },
      onDelete: "RESTRICT",
    },
    equipmentType: {
      type: "many-to-one",
      target: "EquipmentType",
      joinColumn: { name: "equipment_type_id" },
      onDelete: "RESTRICT",
    },
  },
  indices: [
    { name: "idx_asset_base", columns: ["baseId"] },
    { name: "idx_asset_equipment", columns: ["equipmentTypeId"] },
  ],
});
