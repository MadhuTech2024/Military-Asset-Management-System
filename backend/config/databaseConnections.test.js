import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeTestUrl =
  "postgresql://runtime_test:placeholder@127.0.0.1:55432/kristallball";
const migrationTestUrl =
  "postgresql://migration_test:placeholder@127.0.0.1:55432/kristallball";
const originalWorkingDirectory = process.cwd();
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalMigrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
const dotenvWorkingDirectory = await mkdtemp(
  join(tmpdir(), "kristallball-database-config-"),
);
let AppDataSource;
let validateRuntimeDatabaseConfiguration;
let createMigrationDataSource;

try {
  await writeFile(join(dotenvWorkingDirectory, ".env"), "");
  process.chdir(dotenvWorkingDirectory);
  process.env.DATABASE_URL = runtimeTestUrl;
  process.env.MIGRATION_DATABASE_URL = migrationTestUrl;

  ({ AppDataSource, validateRuntimeDatabaseConfiguration } = await import("./db.js"));
  ({ createMigrationDataSource } = await import("./migrationDb.js"));
} finally {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (originalMigrationDatabaseUrl === undefined) {
    delete process.env.MIGRATION_DATABASE_URL;
  } else {
    process.env.MIGRATION_DATABASE_URL = originalMigrationDatabaseUrl;
  }
  process.chdir(originalWorkingDirectory);
  await rm(dotenvWorkingDirectory, { recursive: true, force: true });
}

test("runtime DataSource uses only DATABASE_URL with schema synchronization disabled", () => {
  assert.equal(AppDataSource.options.url, runtimeTestUrl);
  assert.equal(AppDataSource.options.synchronize, false);
  assert.equal(AppDataSource.options.migrationsRun, false);
});

test("runtime configuration does not fall back to MIGRATION_DATABASE_URL", () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = migrationTestUrl;

  try {
    assert.throws(
      () => validateRuntimeDatabaseConfiguration(),
      /DATABASE_URL for the restricted application runtime account/,
    );
  } finally {
    if (runtimeUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = runtimeUrl;
    }
    if (migrationUrl === undefined) {
      delete process.env.MIGRATION_DATABASE_URL;
    } else {
      process.env.MIGRATION_DATABASE_URL = migrationUrl;
    }
  }
});

test("maintenance DataSource uses only MIGRATION_DATABASE_URL", () => {
  const runtimeUrl = process.env.DATABASE_URL;
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  process.env.DATABASE_URL = runtimeTestUrl;
  process.env.MIGRATION_DATABASE_URL = migrationTestUrl;
  try {
    const migrationDataSource = createMigrationDataSource();
    assert.equal(migrationDataSource.options.url, migrationTestUrl);
    assert.notEqual(migrationDataSource.options.url, AppDataSource.options.url);
  } finally {
    if (runtimeUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = runtimeUrl;
    }
    if (migrationUrl === undefined) {
      delete process.env.MIGRATION_DATABASE_URL;
    } else {
      process.env.MIGRATION_DATABASE_URL = migrationUrl;
    }
  }
});

test("maintenance configuration does not fall back to DATABASE_URL", () => {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  delete process.env.MIGRATION_DATABASE_URL;
  process.env.DATABASE_URL = runtimeTestUrl;

  try {
    assert.throws(
      () => createMigrationDataSource(),
      /MIGRATION_DATABASE_URL for database maintenance/,
    );
  } finally {
    if (migrationUrl === undefined) {
      delete process.env.MIGRATION_DATABASE_URL;
    } else {
      process.env.MIGRATION_DATABASE_URL = migrationUrl;
    }
    if (runtimeUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = runtimeUrl;
    }
  }
});

test("importing runtime DataSource fails safely without DATABASE_URL and never connects", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "kristallball-db-import-"));
  try {
    await writeFile(join(workingDirectory, ".env"), "");
    const environment = {
      ...process.env,
      MIGRATION_DATABASE_URL:
        "postgresql://migration_test@127.0.0.1:1/kristallball_test",
      TEST_DOTENV_DIR: workingDirectory,
    };
    environment.DATABASE_URL = "";
    delete environment.DOTENV_CONFIG_PATH;

    const dbModuleUrl = new URL("./db.js", import.meta.url).href;
    const probe = `
      import pg from "pg";
      let connectionAttempts = 0;
      pg.Pool.prototype.connect = function () {
        connectionAttempts += 1;
        throw new Error("DATABASE_CONNECTION_ATTEMPTED");
      };
      process.chdir(process.env.TEST_DOTENV_DIR);
      try {
        await import(${JSON.stringify(dbModuleUrl)});
        console.error("Unexpected successful runtime DataSource import");
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
        console.log("connection-attempts=" + connectionAttempts);
      }
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", probe],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        env: environment,
        encoding: "utf8",
        timeout: 10000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stderr,
      /Missing required DATABASE_URL for the restricted application runtime account configuration/,
    );
    assert.match(result.stdout, /connection-attempts=0/);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /DATABASE_CONNECTION_ATTEMPTED|127\.0\.0\.1/,
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
