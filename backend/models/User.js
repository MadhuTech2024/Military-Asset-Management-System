import { EntitySchema } from "typeorm";

export default new EntitySchema({
  name: "User",
  tableName: "app_user",
  columns: {
    id: { type: "uuid", primary: true, generated: "uuid" },
    email: { type: "varchar", length: 254, unique: true },
    passwordHash: { name: "password_hash", type: "varchar", length: 255 },
    fullName: { name: "full_name", type: "varchar", length: 128 },
    role: { type: "enum", enum: ["ADMIN", "BASE_COMMANDER", "LOGISTICS_OFFICER"] },
    baseId: { name: "base_id", type: "uuid", nullable: true },
    isActive: { name: "is_active", type: "boolean", default: true },
    createdAt: { name: "created_at", type: "timestamptz", createDate: true },
    updatedAt: { name: "updated_at", type: "timestamptz", updateDate: true },
  },
  relations: {
    base: {
      type: "many-to-one",
      target: "Base",
      joinColumn: { name: "base_id" },
      nullable: true,
      onDelete: "RESTRICT",
    },
  },
  indices: [
    { name: "idx_app_user_role", columns: ["role"] },
    { name: "idx_app_user_base", columns: ["baseId"] },
    { name: "idx_app_user_active", columns: ["isActive"] },
  ],
});
