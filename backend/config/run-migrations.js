import "reflect-metadata";
import {
  createMigrationDataSource,
} from "./migrationDb.js";
import { getSafeDatabaseErrorCode } from "./dataSourceOptions.js";

let migrationDataSource;
try {
  migrationDataSource = createMigrationDataSource();
  await migrationDataSource.initialize();
  const migrations = await migrationDataSource.runMigrations();
  console.log(`Applied ${migrations.length} migration(s).`);
} catch (error) {
  const code = getSafeDatabaseErrorCode(error);
  console.error(
    `Migration failed${code ? ` (database error ${code})` : ""}. Check MIGRATION_DATABASE_URL and database availability.`,
  );
  process.exitCode = 1;
} finally {
  if (migrationDataSource?.isInitialized) {
    try {
      await migrationDataSource.destroy();
    } catch {
      console.error("Could not close the migration database connection cleanly.");
      process.exitCode = 1;
    }
  }
}
