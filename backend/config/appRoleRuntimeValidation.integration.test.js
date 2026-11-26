import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import {
  APPLICATION_TABLES,
  APPLICATION_ROUTINES,
  validateApplicationSequencePrivileges,
  validateApplicationTablePrivileges,
  validateApplicationRoutinePrivileges,
  validateApplicationSchemaInventory,
  validateApplicationSchemaPrivileges,
  validateMigrationOwnerObjectPrivileges,
  validateMigrationOwnerRole,
  validateRole,
  validateRuntimeAppendOnlyPrivileges,
  validateRuntimeTemporaryPrivilege,
} from "./appRoleRuntimeValidation.js";
import { runApplicationRoleProvisioningTransaction } from "./appRoleProvisioning.js";
import {
  runAfterDatabaseIdentityVerification,
  verifyDatabaseIdentity,
} from "./databaseIdentity.js";
import { InitialKristallballSchema1763938800000 } from "./migrations/1763938800000-InitialKristallballSchema.js";
import { CorrectInventoryIntegrity1763939400000 } from "./migrations/1763939400000-CorrectInventoryIntegrity.js";
import { FixReturnTriggerCasting1763939500000 } from "./migrations/1763939500000-FixReturnTriggerCasting.js";
import { SanitizeAuditSnapshots1763939600000 } from "./migrations/1763939600000-SanitizeAuditSnapshots.js";
import { HardenTriggerSearchPath1795545540000 } from "./migrations/1795545540000-HardenTriggerSearchPath.js";
import { PreventNegativeInventoryBalance1795551900000 } from "./migrations/1795551900000-PreventNegativeInventoryBalance.js";
import { AddBusinessIdempotency1795552000000 } from "./migrations/1795552000000-AddBusinessIdempotency.js";
import { AlignInventoryBalanceTimeSemantics1795601814000 } from "./migrations/1795601814000-AlignInventoryBalanceTimeSemantics.js";

const isolatedUrl = process.env.KRISTALLBALL_ISOLATED_TEST_DATABASE_URL;

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function makeDataSource(url) {
  return new DataSource({
    type: "postgres",
    url,
    ssl: false,
    synchronize: false,
    migrationsRun: false,
    logging: false,
  });
}

test(
  "isolated PostgreSQL validates role CTEs, effective privileges, and transactional rollback",
  { skip: !isolatedUrl },
  async () => {
    const url = new URL(isolatedUrl);
    if (
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.port === "5432" ||
      url.pathname !== "/postgres" ||
      url.username !== "postgres" ||
      url.password
    ) {
      throw new Error(
        "Integration tests require a password-free, non-default loopback PostgreSQL test URL.",
      );
    }

    const admin = makeDataSource(isolatedUrl);
    let maintenance;
    let runtimeIdentityDataSource;
    let mismatchedIdentityDataSource;
    let queryRunner;
    let migrationRunner;
    let originalSchemaOwner;
    let originalDatabaseComment;
    let publicTemporaryPrivilegeWasGranted;
    let identityDatabaseName;
    let schemaOwnerChanged = false;
    const roles = [];
    const schemas = [];
    const tables = [];
    const views = [];
    const sequences = [];
    const routines = [];

    try {
      await admin.initialize();
      const [identity] = await admin.query(
        `SELECT current_database() AS database_name,
                current_setting('data_directory') AS data_directory,
                current_user AS current_user,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                  AS is_superuser`,
      );
      assert.equal(identity.database_name, "postgres");
      assert.equal(identity.is_superuser, true);
      assert.match(
        identity.data_directory.toLowerCase(),
        /kristallball-step1-pg-/,
        "integration test must use the dedicated disposable cluster",
      );
      const [temporaryAcl] = await admin.query(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_database database,
                LATERAL aclexplode(
                  COALESCE(
                    database.datacl,
                    acldefault('d', database.datdba)
                  )
                ) AS privilege
           WHERE database.datname = current_database()
             AND privilege.grantee = 0
             AND privilege.privilege_type = 'TEMPORARY'
         ) AS public_has_temporary`,
      );
      publicTemporaryPrivilegeWasGranted = temporaryAcl.public_has_temporary;

      const [schema] = await admin.query(
        `SELECT role.rolname AS owner_name
         FROM pg_namespace namespace
         JOIN pg_roles role ON role.oid = namespace.nspowner
         WHERE namespace.nspname = 'public'`,
      );
      assert.ok(schema?.owner_name);
      originalSchemaOwner = schema.owner_name;

      const [databaseComment] = await admin.query(
        `SELECT shobj_description(oid, 'pg_database') AS database_comment
         FROM pg_database
         WHERE datname = current_database()`,
      );
      originalDatabaseComment = databaseComment?.database_comment ?? null;

      const suffix = randomUUID().replaceAll("-", "");
      const appRole = `step1_app_${suffix}`;
      const runtimeLogin = `step1_runtime_${suffix}`;
      const migrationOwner = `step1_migrator_${suffix}`;
      const extraRole = `step1_extra_${suffix}`;
      const sharedRole = `step1_shared_${suffix}`;
      const identityDatabase = randomUUID();
      identityDatabaseName = `step1_identity_${suffix}`;
      const allRoles = [appRole, runtimeLogin, migrationOwner, extraRole, sharedRole];
      assert.notEqual(schema.owner_name, migrationOwner);

      await admin.query(
        `COMMENT ON DATABASE postgres IS ${quoteLiteral(`kristallball.identity=${identityDatabase}`)}`,
      );
      await admin.query(
        `CREATE DATABASE ${quoteIdentifier(identityDatabaseName)}`,
      );
      await admin.query(
        `COMMENT ON DATABASE ${quoteIdentifier(identityDatabaseName)}
         IS ${quoteLiteral(`kristallball.identity=${randomUUID()}`)}`,
      );

      for (const role of allRoles) {
        await admin.query(
          `CREATE ROLE ${quoteIdentifier(role)}
             NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );
        roles.push(role);
      }
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(runtimeLogin)} LOGIN`,
      );
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(migrationOwner)} LOGIN`,
      );
      await admin.query(
        `GRANT ${quoteIdentifier(appRole)} TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE postgres TO ${quoteIdentifier(migrationOwner)}`,
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE postgres TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(identityDatabaseName)}
         TO ${quoteIdentifier(runtimeLogin)}, ${quoteIdentifier(migrationOwner)}`,
      );

      migrationRunner = admin.createQueryRunner();
      await migrationRunner.connect();
      for (const migration of [
        new InitialKristallballSchema1763938800000(),
        new CorrectInventoryIntegrity1763939400000(),
        new FixReturnTriggerCasting1763939500000(),
        new SanitizeAuditSnapshots1763939600000(),
        new HardenTriggerSearchPath1795545540000(),
        new PreventNegativeInventoryBalance1795551900000(),
        new AddBusinessIdempotency1795552000000(),
        new AlignInventoryBalanceTimeSemantics1795601814000(),
      ]) {
        await migration.up(migrationRunner);
      }
      await migrationRunner.release();
      migrationRunner = undefined;

      const [businessIdempotencyTable] = await admin.query(
        "SELECT to_regclass('public.business_idempotency') IS NOT NULL AS exists",
      );
      assert.equal(
        businessIdempotencyTable.exists,
        true,
        "business_idempotency migration must run before ownership checks",
      );

      await admin.query(`
        DO $$
        DECLARE extension_routine record;
        BEGIN
          FOR extension_routine IN
            SELECT routine.oid::regprocedure AS signature
            FROM pg_proc routine
            JOIN pg_depend dependency
              ON dependency.classid = 'pg_proc'::regclass
             AND dependency.objid = routine.oid
             AND dependency.refclassid = 'pg_extension'::regclass
             AND dependency.deptype = 'e'
            JOIN pg_extension extension
              ON extension.oid = dependency.refobjid
            JOIN pg_namespace namespace
              ON namespace.oid = routine.pronamespace
            WHERE extension.extname = 'pgcrypto'
              AND namespace.nspname = 'public'
              AND routine.proname <> 'gen_random_uuid'
          LOOP
            EXECUTE format(
              'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
              extension_routine.signature
            );
          END LOOP;
        END
        $$;
      `);

      for (const table of [...APPLICATION_TABLES, "typeorm_migrations"]) {
        if (table === "typeorm_migrations") {
          await admin.query(
            `CREATE TABLE public.typeorm_migrations (id uuid PRIMARY KEY)`,
          );
        }
        tables.push(table);
        await admin.query(
          `ALTER TABLE public.${quoteIdentifier(table)} OWNER TO ${quoteIdentifier(migrationOwner)}`,
        );
      }

      for (const routineIdentity of APPLICATION_ROUTINES) {
        const openingParen = routineIdentity.indexOf("(");
        const routineName = routineIdentity.slice(0, openingParen);
        const argumentTypes = routineIdentity.slice(openingParen + 1, -1);
        routines.push({ name: routineName, arguments: argumentTypes });
        await admin.query(
          `ALTER FUNCTION public.${quoteIdentifier(routineName)}(${argumentTypes})
           OWNER TO ${quoteIdentifier(migrationOwner)}`,
        );
      }

      await admin.query(
        `GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(migrationOwner)} WITH GRANT OPTION`,
      );
      await admin.query(
        `GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(runtimeLogin)}`,
      );

      const maintenanceUrl = new URL(isolatedUrl);
      maintenanceUrl.username = migrationOwner;
      maintenance = makeDataSource(maintenanceUrl.toString());
      await maintenance.initialize();

      const runtimeIdentityUrl = new URL(isolatedUrl);
      runtimeIdentityUrl.username = runtimeLogin;
      runtimeIdentityDataSource = makeDataSource(runtimeIdentityUrl.toString());
      await runtimeIdentityDataSource.initialize();

      const identityDatabaseUrl = new URL(maintenanceUrl);
      identityDatabaseUrl.pathname = `/${identityDatabaseName}`;
      mismatchedIdentityDataSource = makeDataSource(
        identityDatabaseUrl.toString(),
      );
      await mismatchedIdentityDataSource.initialize();

      const verifiedIdentity = await verifyDatabaseIdentity(
        runtimeIdentityDataSource,
        maintenance,
      );
      assert.equal(verifiedIdentity.runtimeIdentity.databaseName, "postgres");
      assert.equal(publicTemporaryPrivilegeWasGranted, true);
      assert.notEqual(
        verifiedIdentity.runtimeIdentity.loginRole,
        verifiedIdentity.maintenanceIdentity.loginRole,
      );

      const [publicTemporary] = await admin.query(
        `SELECT has_database_privilege(
           $1, current_database(), 'TEMPORARY'
         ) AS can_create_temporary`,
        [runtimeLogin],
      );
      assert.equal(publicTemporary.can_create_temporary, true);
      await assert.rejects(
        validateRuntimeTemporaryPrivilege(
          runtimeIdentityDataSource,
          verifiedIdentity.runtimeIdentity,
        ),
        /has effective TEMPORARY privilege/,
      );

      await admin.query(
        `REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC`,
      );
      await validateRuntimeTemporaryPrivilege(
        runtimeIdentityDataSource,
        verifiedIdentity.runtimeIdentity,
      );
      const runtimeTemporaryRunner =
        runtimeIdentityDataSource.createQueryRunner();
      await runtimeTemporaryRunner.connect();
      try {
        await assert.rejects(
          runtimeTemporaryRunner.query(
            "CREATE TEMPORARY TABLE temp_access_probe (id integer)",
          ),
          { code: "42501" },
        );

        await admin.query(
          `GRANT TEMPORARY ON DATABASE postgres TO ${quoteIdentifier(appRole)}`,
        );
        await assert.rejects(
          validateRuntimeTemporaryPrivilege(
            runtimeIdentityDataSource,
            verifiedIdentity.runtimeIdentity,
          ),
          /has effective TEMPORARY privilege/,
        );
        await runtimeTemporaryRunner.query(
          "CREATE TEMPORARY TABLE temp_inherited_probe (id integer)",
        );
        await runtimeTemporaryRunner.query(
          "DROP TABLE pg_temp.temp_inherited_probe",
        );
        await admin.query(
          `REVOKE TEMPORARY ON DATABASE postgres FROM ${quoteIdentifier(appRole)}`,
        );
        await validateRuntimeTemporaryPrivilege(
          runtimeIdentityDataSource,
          verifiedIdentity.runtimeIdentity,
        );
      } finally {
        await runtimeTemporaryRunner.release();
      }

      let mismatchedProvisioningStarted = false;
      await assert.rejects(
        runAfterDatabaseIdentityVerification(
          runtimeIdentityDataSource,
          mismatchedIdentityDataSource,
          async () => {
            mismatchedProvisioningStarted = true;
          },
        ),
        /do not target the same PostgreSQL database/,
      );
      assert.equal(mismatchedProvisioningStarted, false);

      queryRunner = maintenance.createQueryRunner();
      await queryRunner.connect();
      const provisioningConfiguration = {
        applicationRoleName: appRole,
        runtimeLoginName: runtimeLogin,
        migrationOwnerName: migrationOwner,
        runtimeDataSource: runtimeIdentityDataSource,
        runtimeIdentity: verifiedIdentity.runtimeIdentity,
      };
      await queryRunner.query(
        `GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(appRole)}`,
      );

      await admin.query(
        `GRANT UPDATE (id) ON TABLE public.audit_log TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        runApplicationRoleProvisioningTransaction(
          queryRunner,
          provisioningConfiguration,
        ),
        /has UPDATE, DELETE, or TRUNCATE privileges/,
      );
      const [columnRollback] = await admin.query(
        `SELECT has_table_privilege($1, 'public.base', 'SELECT') AS group_select,
                has_column_privilege($2, 'public.audit_log', 'id', 'UPDATE')
                  AS column_update`,
        [appRole, runtimeLogin],
      );
      assert.equal(columnRollback.group_select, false);
      assert.equal(columnRollback.column_update, true);
      await admin.query(
        `REVOKE UPDATE (id) ON TABLE public.audit_log FROM ${quoteIdentifier(runtimeLogin)}`,
      );

      await assert.rejects(
        runApplicationRoleProvisioningTransaction(
          queryRunner,
          provisioningConfiguration,
        ),
        /runtime login retains or could not be verified to lack CREATE/,
      );
      const [rolledBack] = await admin.query(
        `SELECT has_table_privilege($1, 'public.base', 'SELECT') AS group_select,
                has_schema_privilege($1, 'public', 'CREATE') AS group_create,
                has_schema_privilege($2, 'public', 'CREATE') AS runtime_create`,
        [appRole, runtimeLogin],
      );
      assert.equal(rolledBack.group_select, false);
      assert.equal(rolledBack.group_create, true);
      assert.equal(rolledBack.runtime_create, true);

      await admin.query(
        `REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(runtimeLogin)}`,
      );
      await runApplicationRoleProvisioningTransaction(
        queryRunner,
        provisioningConfiguration,
      );

      const [effective] = await admin.query(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS group_create,
                has_schema_privilege($2, 'public', 'CREATE') AS runtime_create,
                has_table_privilege($2, 'public.base', 'SELECT') AS runtime_select,
                has_table_privilege($2, 'public.inventory_movement', 'INSERT')
                  AS movement_insert,
                has_table_privilege($2, 'public.inventory_movement', 'UPDATE')
                  AS movement_update,
                has_table_privilege($2, 'public.audit_log', 'DELETE') AS audit_delete,
                has_table_privilege($2, 'public.typeorm_migrations', 'SELECT')
                  AS migration_metadata_select`,
        [appRole, runtimeLogin],
      );
      assert.deepEqual(effective, {
        group_create: false,
        runtime_create: false,
        runtime_select: true,
        movement_insert: true,
        movement_update: false,
        audit_delete: false,
        migration_metadata_select: false,
      });

      await validateMigrationOwnerRole(queryRunner, migrationOwner);
      await validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner);
      await validateApplicationRoutinePrivileges(
        runtimeIdentityDataSource,
        runtimeLogin,
      );
      await validateApplicationSchemaPrivileges(
        runtimeIdentityDataSource,
        runtimeLogin,
      );

      const unexpectedSchema = `step1_unexpected_${suffix}`;
      await admin.query(
        `CREATE SCHEMA ${quoteIdentifier(unexpectedSchema)}`,
      );
      schemas.push(unexpectedSchema);
      await admin.query(
        `GRANT USAGE, CREATE ON SCHEMA ${quoteIdentifier(unexpectedSchema)}
         TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        validateApplicationSchemaInventory(
          runtimeIdentityDataSource,
          runtimeLogin,
        ),
        /unexpected non-system schema/,
      );
      await admin.query(
        `DROP SCHEMA ${quoteIdentifier(unexpectedSchema)}`,
      );
      schemas.splice(schemas.indexOf(unexpectedSchema), 1);

      await admin.query(
        `GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        validateApplicationSchemaPrivileges(
          runtimeIdentityDataSource,
          runtimeLogin,
        ),
        /unsafe effective schema privileges/,
      );
      await admin.query(
        `REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(runtimeLogin)}`,
      );

      await queryRunner.query(
        `REVOKE USAGE ON SCHEMA public
         FROM ${quoteIdentifier(appRole)}, ${quoteIdentifier(runtimeLogin)}`,
      );
      const schemaOwnerRunner = admin.createQueryRunner();
      try {
        await schemaOwnerRunner.connect();
        await schemaOwnerRunner.query(
          `SET ROLE ${quoteIdentifier(originalSchemaOwner)}`,
        );
        await schemaOwnerRunner.query(
          `REVOKE USAGE ON SCHEMA public FROM PUBLIC`,
        );
      } finally {
        try {
          await schemaOwnerRunner.query("RESET ROLE");
        } finally {
          await schemaOwnerRunner.release();
        }
      }
      const [revokedUsage] = await admin.query(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS group_usage,
                has_schema_privilege($2, 'public', 'USAGE') AS runtime_usage
         `,
        [appRole, runtimeLogin],
      );
      assert.deepEqual(revokedUsage, {
        group_usage: false,
        runtime_usage: false,
      });
      await assert.rejects(
        validateApplicationSchemaPrivileges(
          runtimeIdentityDataSource,
          runtimeLogin,
        ),
        /unsafe effective schema privileges/,
      );
      await admin.query(`GRANT USAGE ON SCHEMA public TO PUBLIC`);

      await admin.query(
        `GRANT ${quoteIdentifier(extraRole)} TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION public.digest(text, text)
         TO ${quoteIdentifier(extraRole)}`,
      );
      const [inheritedCryptoExecute] = await admin.query(
        `SELECT has_function_privilege(
           $1, 'public.digest(text, text)', 'EXECUTE'
         ) AS can_execute`,
        [runtimeLogin],
      );
      assert.equal(inheritedCryptoExecute.can_execute, true);
      await assert.rejects(
        validateApplicationRoutinePrivileges(
          runtimeIdentityDataSource,
          runtimeLogin,
        ),
        /unexpected effective EXECUTE/,
      );
      await admin.query(
        `REVOKE EXECUTE ON FUNCTION public.digest(text, text)
         FROM ${quoteIdentifier(extraRole)}`,
      );
      await admin.query(
        `REVOKE ${quoteIdentifier(extraRole)} FROM ${quoteIdentifier(runtimeLogin)}`,
      );

      await admin.query(
        `GRANT UPDATE (id) ON TABLE public.audit_log TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        validateRuntimeAppendOnlyPrivileges(queryRunner, runtimeLogin),
        /has UPDATE, DELETE, or TRUNCATE privileges/,
      );
      await assert.rejects(
        validateApplicationTablePrivileges(queryRunner, runtimeLogin),
        /unexpected effective table privileges/,
      );
      await admin.query(
        `REVOKE UPDATE (id) ON TABLE public.audit_log FROM ${quoteIdentifier(runtimeLogin)}`,
      );

      await admin.query(
        `GRANT ${quoteIdentifier(extraRole)} TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await admin.query(
        `GRANT UPDATE (id) ON TABLE public.inventory_movement TO ${quoteIdentifier(extraRole)}`,
      );
      await assert.rejects(
        validateRuntimeAppendOnlyPrivileges(queryRunner, runtimeLogin),
        /has UPDATE, DELETE, or TRUNCATE privileges/,
      );
      await assert.rejects(
        validateApplicationTablePrivileges(queryRunner, runtimeLogin),
        /unexpected effective table privileges/,
      );
      await admin.query(
        `REVOKE UPDATE (id) ON TABLE public.inventory_movement FROM ${quoteIdentifier(extraRole)}`,
      );

      for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        await admin.query(
          `GRANT ${privilege} (id) ON TABLE public.typeorm_migrations TO ${quoteIdentifier(extraRole)}`,
        );
        await assert.rejects(
          validateApplicationTablePrivileges(queryRunner, runtimeLogin),
          /unexpected effective table privileges/,
          privilege,
        );
        await admin.query(
          `REVOKE ${privilege} (id) ON TABLE public.typeorm_migrations FROM ${quoteIdentifier(extraRole)}`,
        );
      }

      const unexpectedRoutine = `step1_unexpected_fn_${suffix}`;
      await admin.query(
        `CREATE FUNCTION public.${quoteIdentifier(unexpectedRoutine)}()
         RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$`,
      );
      routines.push({ name: unexpectedRoutine, arguments: "" });
      await admin.query(
        `GRANT EXECUTE ON FUNCTION public.${quoteIdentifier(unexpectedRoutine)}()
         TO ${quoteIdentifier(extraRole)}`,
      );
      const [inheritedExecute] = await admin.query(
        `SELECT has_function_privilege($1, $2, 'EXECUTE') AS can_execute`,
        [runtimeLogin, `public.${unexpectedRoutine}()`],
      );
      assert.equal(inheritedExecute.can_execute, true);
      await assert.rejects(
        validateApplicationRoutinePrivileges(
          runtimeIdentityDataSource,
          runtimeLogin,
        ),
        /unexpected routine/,
      );
      await assert.rejects(
        validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner),
        /unexpected routine/,
      );

      await admin.query(
        `ALTER FUNCTION public.${quoteIdentifier(unexpectedRoutine)}()
         OWNER TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        validateRole(queryRunner, runtimeLogin, {
          loginExpected: true,
          migrationOwnerName: migrationOwner,
        }),
        /owns an application database object/,
      );
      await admin.query(
        `ALTER FUNCTION public.${quoteIdentifier(unexpectedRoutine)}()
         OWNER TO postgres`,
      );
      await admin.query(
        `DROP FUNCTION public.${quoteIdentifier(unexpectedRoutine)}()`,
      );
      routines.splice(
        routines.findIndex((routine) => routine.name === unexpectedRoutine),
        1,
      );

      const unsafeDefinerRoutine = `step1_unsafe_definer_${suffix}`;
      await admin.query(
        `CREATE FUNCTION public.${quoteIdentifier(unsafeDefinerRoutine)}()
         RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$`,
      );
      routines.push({ name: unsafeDefinerRoutine, arguments: "" });
      await assert.rejects(
        validateApplicationRoutinePrivileges(
          runtimeIdentityDataSource,
          runtimeLogin,
        ),
        /SECURITY DEFINER/,
      );
      await admin.query(
        `DROP FUNCTION public.${quoteIdentifier(unsafeDefinerRoutine)}()`,
      );
      routines.splice(
        routines.findIndex((routine) => routine.name === unsafeDefinerRoutine),
        1,
      );

      await admin.query(
        `REVOKE ${quoteIdentifier(extraRole)} FROM ${quoteIdentifier(runtimeLogin)}`,
      );

      await admin.query(
        `CREATE TABLE public.${quoteIdentifier(`step1_unlisted_${suffix}`)} (id uuid)`,
      );
      const unlistedTable = `step1_unlisted_${suffix}`;
      tables.push(unlistedTable);
      await assert.rejects(
        validateApplicationTablePrivileges(queryRunner, runtimeLogin),
        /Could not verify effective application table privileges/,
      );
      await admin.query(
        `DROP TABLE public.${quoteIdentifier(unlistedTable)}`,
      );
      tables.splice(tables.indexOf(unlistedTable), 1);

      await admin.query(
        `CREATE SEQUENCE public.${quoteIdentifier(`step1_sequence_${suffix}`)}`,
      );
      const sequence = `step1_sequence_${suffix}`;
      sequences.push(sequence);
      await admin.query(
        `ALTER SEQUENCE public.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(migrationOwner)}`,
      );
      await validateApplicationSequencePrivileges(queryRunner, runtimeLogin);
      await admin.query(
        `ALTER SEQUENCE public.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(appRole)}`,
      );
      await assert.rejects(
        validateRole(queryRunner, appRole, {
          loginExpected: false,
          migrationOwnerName: migrationOwner,
        }),
        /owns an application database object/,
      );
      await admin.query(
        `ALTER SEQUENCE public.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(migrationOwner)}`,
      );
      await admin.query(
        `ALTER SEQUENCE public.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner),
        /must effectively own every public sequence/,
      );
      await admin.query(
        `ALTER SEQUENCE public.${quoteIdentifier(sequence)} OWNER TO ${quoteIdentifier(migrationOwner)}`,
      );

      await admin.query(
        `REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(migrationOwner)}`,
      );
      await assert.rejects(
        validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner),
        /must have effective USAGE and CREATE/,
      );
      await admin.query(
        `GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(migrationOwner)} WITH GRANT OPTION`,
      );
      await admin.query(
        `ALTER SCHEMA public OWNER TO ${quoteIdentifier(migrationOwner)}`,
      );
      schemaOwnerChanged = true;
      await assert.rejects(
        validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner),
        /owns a protected schema/,
      );
      await admin.query(
        `ALTER SCHEMA public OWNER TO ${quoteIdentifier(originalSchemaOwner)}`,
      );
      schemaOwnerChanged = false;
      await admin.query(
        `GRANT USAGE, CREATE ON SCHEMA public TO ${quoteIdentifier(migrationOwner)} WITH GRANT OPTION`,
      );

      await admin.query(
        `GRANT ${quoteIdentifier(extraRole)} TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await admin.query(
        `GRANT USAGE ON SEQUENCE public.${quoteIdentifier(sequence)} TO ${quoteIdentifier(extraRole)}`,
      );
      await assert.rejects(
        validateApplicationSequencePrivileges(queryRunner, runtimeLogin),
        /unexpected effective sequence privileges/,
      );
      await admin.query(
        `REVOKE USAGE ON SEQUENCE public.${quoteIdentifier(sequence)} FROM ${quoteIdentifier(extraRole)}`,
      );
      await admin.query(
        `GRANT UPDATE ON TABLE public.inventory_movement TO ${quoteIdentifier(runtimeLogin)}`,
      );
      await assert.rejects(
        validateRuntimeAppendOnlyPrivileges(queryRunner, runtimeLogin),
        /has UPDATE, DELETE, or TRUNCATE privileges/,
      );
      await admin.query(
        `REVOKE UPDATE ON TABLE public.inventory_movement FROM ${quoteIdentifier(runtimeLogin)}`,
      );
      await admin.query(
        `GRANT UPDATE ON TABLE public.audit_log TO ${quoteIdentifier(extraRole)}`,
      );
      await assert.rejects(
        validateRuntimeAppendOnlyPrivileges(queryRunner, runtimeLogin),
        /has UPDATE, DELETE, or TRUNCATE privileges/,
      );
      await assert.rejects(
        validateApplicationTablePrivileges(queryRunner, runtimeLogin),
        /unexpected effective table privileges/,
      );
      await admin.query(
        `REVOKE UPDATE ON TABLE public.audit_log FROM ${quoteIdentifier(extraRole)}`,
      );
      await admin.query(
        `REVOKE ${quoteIdentifier(extraRole)} FROM ${quoteIdentifier(runtimeLogin)}`,
      );

      await admin.query(
        `ALTER TABLE public.base OWNER TO ${quoteIdentifier(appRole)}`,
      );
      await assert.rejects(
        validateRole(queryRunner, appRole, {
          loginExpected: false,
          migrationOwnerName: migrationOwner,
        }),
        /owns an application database object/,
      );
      await admin.query(
        `ALTER TABLE public.base OWNER TO ${quoteIdentifier(migrationOwner)}`,
      );
      await admin.query(
        `ALTER TABLE public.base OWNER TO ${quoteIdentifier(appRole)}`,
      );
      await assert.rejects(
        validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner),
        /must effectively own public relation base/,
      );
      await admin.query(
        `ALTER TABLE public.base OWNER TO ${quoteIdentifier(migrationOwner)}`,
      );

      const unlistedView = `step1_unlisted_view_${suffix}`;
      await admin.query(
        `CREATE VIEW public.${quoteIdentifier(unlistedView)} AS
         SELECT id FROM public.base`,
      );
      views.push(unlistedView);
      await admin.query(
        `ALTER VIEW public.${quoteIdentifier(unlistedView)} OWNER TO ${quoteIdentifier(appRole)}`,
      );
      await assert.rejects(
        validateRole(queryRunner, appRole, {
          loginExpected: false,
          migrationOwnerName: migrationOwner,
        }),
        /owns an application database object/,
      );
      await assert.rejects(
        validateMigrationOwnerObjectPrivileges(queryRunner, migrationOwner),
        /unexpected or unverified migration relation/,
      );
      await admin.query(
        `DROP VIEW public.${quoteIdentifier(unlistedView)}`,
      );
      views.splice(views.indexOf(unlistedView), 1);

      await admin.query(
        `ALTER SCHEMA public OWNER TO ${quoteIdentifier(runtimeLogin)}`,
      );
      schemaOwnerChanged = true;
      await assert.rejects(
        validateRole(queryRunner, runtimeLogin, {
          loginExpected: true,
          migrationOwnerName: migrationOwner,
        }),
        /owns an application database object/,
      );
      await admin.query(
        `ALTER SCHEMA public OWNER TO ${quoteIdentifier(originalSchemaOwner)}`,
      );
      schemaOwnerChanged = false;

      await admin.query(
        `ALTER ROLE ${quoteIdentifier(migrationOwner)} CREATEROLE`,
      );
      await assert.rejects(
        validateMigrationOwnerRole(queryRunner, migrationOwner),
        /unsafe attributes/,
      );
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(migrationOwner)} NOCREATEROLE`,
      );
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(extraRole)} CREATEROLE`,
      );
      await admin.query(
        `GRANT ${quoteIdentifier(extraRole)} TO ${quoteIdentifier(migrationOwner)}`,
      );
      await assert.rejects(
        validateMigrationOwnerRole(queryRunner, migrationOwner),
        /inherits unsafe privileges/,
      );
      await admin.query(
        `REVOKE ${quoteIdentifier(extraRole)} FROM ${quoteIdentifier(migrationOwner)}`,
      );
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(extraRole)} NOCREATEROLE`,
      );

      await admin.query(
        `GRANT ${quoteIdentifier(sharedRole)} TO ${quoteIdentifier(migrationOwner)}`,
      );
      await admin.query(
        `GRANT ${quoteIdentifier(sharedRole)} TO ${quoteIdentifier(appRole)}`,
      );
      await assert.rejects(
        validateRole(queryRunner, appRole, {
          loginExpected: false,
          migrationOwnerName: migrationOwner,
        }),
        /inherits unexpected privileges/,
      );
    } finally {
      if (migrationRunner) {
        await migrationRunner.release();
      }
      if (queryRunner) {
        if (queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
        await queryRunner.release();
      }
      if (maintenance?.isInitialized) {
        await maintenance.destroy();
      }
      if (runtimeIdentityDataSource?.isInitialized) {
        await runtimeIdentityDataSource.destroy();
      }
      if (mismatchedIdentityDataSource?.isInitialized) {
        await mismatchedIdentityDataSource.destroy();
      }
      if (admin.isInitialized) {
        if (roles.length > 0) {
          const [appRole, runtimeLogin, migrationOwner, extraRole, sharedRole] =
            roles;
          if (sharedRole) {
            await admin.query(
              `REVOKE ${quoteIdentifier(sharedRole)} FROM ${quoteIdentifier(migrationOwner)}, ${quoteIdentifier(appRole)}`,
            );
          }
          if (extraRole) {
            await admin.query(
              `REVOKE ${quoteIdentifier(extraRole)} FROM ${quoteIdentifier(runtimeLogin)}`,
            );
          }
          if (appRole && runtimeLogin) {
            await admin.query(
              `REVOKE ${quoteIdentifier(appRole)} FROM ${quoteIdentifier(runtimeLogin)}`,
            );
          }
        }
        for (const sequence of sequences) {
          await admin.query(
            `DROP SEQUENCE IF EXISTS public.${quoteIdentifier(sequence)}`,
          );
        }
        for (const view of views) {
          await admin.query(
            `DROP VIEW IF EXISTS public.${quoteIdentifier(view)}`,
          );
        }
        for (const table of tables) {
          await admin.query(
            `DROP TABLE IF EXISTS public.${quoteIdentifier(table)} CASCADE`,
          );
        }
        for (const routine of routines) {
          await admin.query(
            `DROP FUNCTION IF EXISTS public.${quoteIdentifier(routine.name)}(${routine.arguments})`,
          );
        }
        for (const schema of schemas) {
          await admin.query(
            `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
          );
        }
        if (schemaOwnerChanged && originalSchemaOwner) {
          await admin.query(
            `ALTER SCHEMA public OWNER TO ${quoteIdentifier(originalSchemaOwner)}`,
          );
        }
        for (const role of roles) {
          await admin.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
        }
        for (const typeName of [
          "movement_direction",
          "movement_type",
          "assignment_status",
          "transfer_status",
          "purchase_status",
          "user_role",
        ]) {
          await admin.query(
            `DROP TYPE IF EXISTS public.${quoteIdentifier(typeName)} CASCADE`,
          );
        }
        for (const role of [...roles].reverse()) {
          await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
        }
        if (publicTemporaryPrivilegeWasGranted === true) {
          await admin.query(
            `GRANT TEMPORARY ON DATABASE postgres TO PUBLIC`,
          );
        } else if (publicTemporaryPrivilegeWasGranted === false) {
          await admin.query(
            `REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC`,
          );
        }
        if (originalDatabaseComment === null) {
          await admin.query(`COMMENT ON DATABASE postgres IS NULL`);
        } else {
          await admin.query(
            `COMMENT ON DATABASE postgres IS ${quoteLiteral(originalDatabaseComment)}`,
          );
        }
        if (identityDatabaseName) {
          await admin.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(identityDatabaseName)}`,
          );
        }
        await admin.destroy();
      }
    }
  },
);
