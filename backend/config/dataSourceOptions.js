import Base from "../models/Base.js";
import User from "../models/User.js";
import EquipmentType from "../models/EquipmentType.js";
import Asset from "../models/Asset.js";
import Purchase from "../models/Purchase.js";
import Transfer from "../models/Transfer.js";
import Assignment from "../models/Assignment.js";
import Expenditure from "../models/Expenditure.js";
import AuditLog from "../models/AuditLog.js";
import InventoryMovement from "../models/InventoryMovement.js";
import ReturnOperation from "../models/ReturnOperation.js";
import { InitialKristallballSchema1763938800000 } from "./migrations/1763938800000-InitialKristallballSchema.js";
import { CorrectInventoryIntegrity1763939400000 } from "./migrations/1763939400000-CorrectInventoryIntegrity.js";
import { FixReturnTriggerCasting1763939500000 } from "./migrations/1763939500000-FixReturnTriggerCasting.js";
import { SanitizeAuditSnapshots1763939600000 } from "./migrations/1763939600000-SanitizeAuditSnapshots.js";
import { HardenTriggerSearchPath1795545540000 } from "./migrations/1795545540000-HardenTriggerSearchPath.js";
import { PreventNegativeInventoryBalance1795551900000 } from "./migrations/1795551900000-PreventNegativeInventoryBalance.js";
import { AddBusinessIdempotency1795552000000 } from "./migrations/1795552000000-AddBusinessIdempotency.js";
import { AlignInventoryBalanceTimeSemantics1795601814000 } from "./migrations/1795601814000-AlignInventoryBalanceTimeSemantics.js";

export function createDataSourceOptions(connectionString) {
  const isProduction = process.env.NODE_ENV === "production";
  const sslEnabled =
    process.env.DB_SSL === "true" ||
    Boolean(connectionString?.includes("sslmode=require"));

  return {
    type: "postgres",
    url: connectionString,
    entities: [
      Base,
      User,
      EquipmentType,
      Asset,
      Purchase,
      Transfer,
      Assignment,
      Expenditure,
      AuditLog,
      InventoryMovement,
      ReturnOperation,
    ],
    migrations: [
      InitialKristallballSchema1763938800000,
      CorrectInventoryIntegrity1763939400000,
      FixReturnTriggerCasting1763939500000,
      SanitizeAuditSnapshots1763939600000,
      HardenTriggerSearchPath1795545540000,
      PreventNegativeInventoryBalance1795551900000,
      AddBusinessIdempotency1795552000000,
      AlignInventoryBalanceTimeSemantics1795601814000,
    ],
    migrationsTableName: "typeorm_migrations",
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: "all",
    logging: isProduction ? ["error", "migration"] : ["error", "migration", "schema"],
    ssl: sslEnabled
      ? {
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
        }
      : false,
  };
}

export function requireConnectionString(value, environmentVariable) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required ${environmentVariable} configuration.`);
  }

  return value;
}

export function getSafeDatabaseErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : undefined;
}
