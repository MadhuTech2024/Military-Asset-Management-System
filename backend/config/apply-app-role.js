import "reflect-metadata";
import { getSafeDatabaseErrorCode } from "./dataSourceOptions.js";
import { loadEnvironment } from "./loadEnvironment.js";
import { createMigrationDataSource } from "./migrationDb.js";
import { runApplicationRoleProvisioningTransaction } from "./appRoleProvisioning.js";
import { runAfterDatabaseIdentityVerification } from "./databaseIdentity.js";

loadEnvironment();

const roleName = process.env.APP_DATABASE_ROLE;
const runtimeDatabaseUrl = process.env.DATABASE_URL;

function getUsername(connectionString, environmentVariable) {
  try {
    return decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new Error(
      `${environmentVariable} must be a valid PostgreSQL connection URL.`,
    );
  }
}

if (!roleName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(roleName)) {
  console.error(
    "APP_DATABASE_ROLE must be set to a PostgreSQL role name containing only letters, digits, and underscores.",
  );
  process.exitCode = 1;
} else if (!runtimeDatabaseUrl) {
  console.error("DATABASE_URL is required to validate the restricted runtime account.");
  process.exitCode = 1;
} else {
  let runtimeDataSource;
  let migrationDataSource;
  let queryRunner;
  let provisioned = false;
  try {
    const runtimeLoginName = getUsername(runtimeDatabaseUrl, "DATABASE_URL");
    if (!runtimeLoginName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeLoginName)) {
      throw new Error("DATABASE_URL must use a supported PostgreSQL role name.");
    }

    const { AppDataSource } = await import("./db.js");
    runtimeDataSource = AppDataSource;
    migrationDataSource = createMigrationDataSource();
    await runtimeDataSource.initialize();
    await migrationDataSource.initialize();
    const migrationOwnerName = getUsername(
      migrationDataSource.options.url,
      "MIGRATION_DATABASE_URL",
    );
    if (!migrationOwnerName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(migrationOwnerName)) {
      throw new Error(
        "MIGRATION_DATABASE_URL must use a supported PostgreSQL role name.",
      );
    }

    await runAfterDatabaseIdentityVerification(
      runtimeDataSource,
      migrationDataSource,
      async ({ runtimeIdentity, maintenanceIdentity }) => {
        if (
          runtimeIdentity.loginRole !== runtimeLoginName ||
          maintenanceIdentity.loginRole !== migrationOwnerName
        ) {
          throw new Error(
            "Database connection roles do not match the configured runtime and maintenance roles.",
          );
        }

        queryRunner = migrationDataSource.createQueryRunner();
        await queryRunner.connect();
        await runApplicationRoleProvisioningTransaction(queryRunner, {
          applicationRoleName: roleName,
          runtimeLoginName,
          migrationOwnerName,
          runtimeDataSource,
          runtimeIdentity,
        });
      },
    );
    provisioned = true;
  } catch (error) {
    const code = getSafeDatabaseErrorCode(error);
    console.error(
      `Application-role permission update failed${code ? ` (database error ${code})` : ""}. Review role configuration and database availability.`,
    );
    process.exitCode = 1;
  } finally {
    if (queryRunner) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction().catch(() => {
          console.error("Application-role provisioning rollback could not be confirmed.");
          process.exitCode = 1;
        });
      }
      await queryRunner.release().catch(() => {
        console.error("Could not release the role-provisioning query runner.");
        process.exitCode = 1;
      });
    }

    if (migrationDataSource?.isInitialized) {
      await migrationDataSource.destroy().catch(() => {
        console.error("Could not close the migration database connection cleanly.");
        process.exitCode = 1;
      });
    }

    if (runtimeDataSource?.isInitialized) {
      await runtimeDataSource.destroy().catch(() => {
        console.error("Could not close the runtime database connection cleanly.");
        process.exitCode = 1;
      });
    }
  }

  if (provisioned && process.exitCode !== 1) {
    console.log(`Least-privilege permissions applied to role ${roleName}.`);
  }
}
