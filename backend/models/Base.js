import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "Base",
  tableName: "base",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    code: { type: "varchar", length: 32, unique: true },
    name: { type: "varchar", length: 128, unique: true },
    locationName: { name: "location_name", type: "varchar", length: 128, nullable: true },
    isActive: { name: "is_active", type: "boolean", default: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  indices: [
    { name: "idx_base_active", columns: ["isActive"] },
  ],
});
