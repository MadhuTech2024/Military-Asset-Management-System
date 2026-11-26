import "reflect-metadata";
import { DataSource } from "typeorm";
import { loadEnvironment } from "./loadEnvironment.js";
import {
  createDataSourceOptions,
  requireConnectionString,
} from "./dataSourceOptions.js";

loadEnvironment();

export function validateRuntimeDatabaseConfiguration() {
  return requireConnectionString(
    process.env.DATABASE_URL,
    "DATABASE_URL for the restricted application runtime account",
  );
}

const runtimeDatabaseUrl = validateRuntimeDatabaseConfiguration();

export const AppDataSource = new DataSource(
  createDataSourceOptions(runtimeDatabaseUrl),
);
