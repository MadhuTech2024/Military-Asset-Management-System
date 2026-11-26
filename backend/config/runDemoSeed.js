import "reflect-metadata";
import { loadEnvironment } from "./loadEnvironment.js";
import { getSafeDatabaseErrorCode } from "./dataSourceOptions.js";
import {
  assertLocalDemoSeedAllowed,
  seedDemoAccounts,
} from "./demoSeed.js";

const explicitOptIn = process.env.ENABLE_LOCAL_DEMO_SEED === "true";
let demoPassword = process.env.LOCAL_DEMO_SEED_PASSWORD;
let dataSource;

try {
  loadEnvironment();
  const seedEnvironment = {
    ...process.env,
    ENABLE_LOCAL_DEMO_SEED: explicitOptIn ? "true" : "",
  };
  assertLocalDemoSeedAllowed(seedEnvironment, {
    explicitOptIn,
    password: demoPassword,
  });

  const runtimeDatabase = await import("./db.js");
  dataSource = runtimeDatabase.AppDataSource;
  await dataSource.initialize();

  const { validateRuntimeDatabaseSecurity } = await import(
    "./appRoleRuntimeValidation.js"
  );
  await validateRuntimeDatabaseSecurity(
    dataSource,
    process.env.APP_DATABASE_ROLE,
  );

  const result = await seedDemoAccounts({
    dataSource,
    password: demoPassword,
    env: seedEnvironment,
    explicitOptIn,
  });
  console.log(
    `Local demo seed finished: ${result.created} account(s) created; ${result.skipped} existing account(s) left unchanged.`,
  );
} catch (error) {
  const code = getSafeDatabaseErrorCode(error);
  console.error(
    `Local demo seed refused or failed${code ? ` (database error ${code})` : ""}. Check local development configuration and schema readiness.`,
  );
  process.exitCode = 1;
} finally {
  demoPassword = undefined;
  if (Object.hasOwn(process.env, "LOCAL_DEMO_SEED_PASSWORD")) {
    process.env.LOCAL_DEMO_SEED_PASSWORD = "";
  }
  if (dataSource?.isInitialized) {
    try {
      await dataSource.destroy();
    } catch {
      console.error("Could not close the local demo database connection cleanly.");
      process.exitCode = 1;
    }
  }
}
