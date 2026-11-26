import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "EquipmentType",
  tableName: "equipment_type",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    code: { type: "varchar", length: 32, unique: true },
    name: { type: "varchar", length: 128, unique: true },
    category: { type: "varchar", length: 64 },
    description: { type: "text", nullable: true },
    isActive: { name: "is_active", type: "boolean", default: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  indices: [{ name: "idx_equipment_type_active", columns: ["isActive"] }],
});
