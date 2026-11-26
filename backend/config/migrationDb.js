import "reflect-metadata";
import { DataSource } from "typeorm";
import { loadEnvironment } from "./loadEnvironment.js";
import {
  createDataSourceOptions,
  requireConnectionString,
} from "./dataSourceOptions.js";

loadEnvironment();

export function createMigrationDataSource() {
  const connectionString = requireConnectionString(
    process.env.MIGRATION_DATABASE_URL,
    "MIGRATION_DATABASE_URL for database maintenance",
  );

  return new DataSource(createDataSourceOptions(connectionString));
}
