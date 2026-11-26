import test from "node:test";
import assert from "node:assert/strict";
import {
  APPLICATION_TABLES,
  APPLICATION_UPDATE_TABLES,
  APPLICATION_ROUTINES,
} from "./appRoleRuntimeValidation.js";
import {
  provisionApplicationRole,
  runApplicationRoleProvisioningTransaction,
} from "./appRoleProvisioning.js";

const runtimeIdentity = {
  databaseName: "kristallball_test",
  databaseOid: "16384",
  databaseMarker: "3f6587e8-492e-4678-8baa-239fb6d3ee27",
  loginRole: "runtime_login",
};

function createRuntimeDataSource(canCreateTemporary = false) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      return [{
        database_name: runtimeIdentity.databaseName,
        database_oid: runtimeIdentity.databaseOid,
        login_role: runtimeIdentity.loginRole,
        current_role: runtimeIdentity.loginRole,
        database_comment: `kristallball.identity=${runtimeIdentity.databaseMarker}`,
        can_create_temporary_objects: canCreateTemporary,
      }];
    },
  };
}

const configuration = {
  applicationRoleName: "app_group",
  runtimeLoginName: "runtime_login",
  migrationOwnerName: "migration_owner",
  runtimeDataSource: createRuntimeDataSource(),
  runtimeIdentity,
};

function applicationPrivilegeRows() {
  const updateTables = new Set(APPLICATION_UPDATE_TABLES);
  return [
    ...APPLICATION_TABLES.map((table_name) => ({
      table_name,
      relation_kind: "r",
      can_select: true,
      can_insert: true,
      can_update: updateTables.has(table_name),
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
      can_select_column: true,
      can_insert_column: true,
      can_update_column: updateTables.has(table_name),
      can_reference_column: false,
    })),
    {
      table_name: "typeorm_migrations",
      relation_kind: "r",
      can_select: false,
      can_insert: false,
      can_update: false,
      can_delete: false,
      can_truncate: false,
      can_reference: false,
      can_trigger: false,
      can_select_column: false,
      can_insert_column: false,
      can_update_column: false,
      can_reference_column: false,
    },
  ];
}

function applicationRoutineRows({ owner = false } = {}) {
  return APPLICATION_ROUTINES.map((routine_identity) => ({
    schema_name: "public",
    routine_identity,
    is_security_definer: false,
    can_execute: true,
    can_manage_owner: owner,
    extension_name: null,
  }));
}

function createQueryRunner({ runtimeHasCreate = false, missingRole = false } = {}) {
  const events = [];
  const queries = [];
  let transactionActive = false;

  return {
    events,
    queries,
    get isTransactionActive() {
      return transactionActive;
    },
    async startTransaction() {
      events.push("begin");
      transactionActive = true;
    },
    async commitTransaction() {
      events.push("commit");
      transactionActive = false;
    },
    async rollbackTransaction() {
      events.push("rollback");
      transactionActive = false;
    },
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql === "SELECT 1 FROM pg_roles WHERE rolname = $1") {
        return missingRole ? [] : [{ exists: 1 }];
      }
      if (sql.includes("SELECT rolsuper, rolbypassrls")) {
        return [{
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolcanlogin: true,
        }];
      }
      if (sql.includes("WITH RECURSIVE role_tree AS") && sql.includes("rolname = ANY")) {
        return [];
      }
      if (sql.includes("SELECT oid, rolsuper")) {
        return [{
          oid: 1,
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolcanlogin: parameters[0] !== configuration.applicationRoleName,
        }];
      }
      if (sql.includes("migration_owner_tree")) {
        return [];
      }
      if (sql.includes("FROM pg_class object")) {
        return [];
      }
      if (
        sql.includes("SELECT namespace.nspname AS schema_name") &&
        sql.includes("has_schema_privilege")
      ) {
        return [{
          schema_name: "public",
          can_use_schema: true,
          can_create_schema:
            parameters[0] === configuration.migrationOwnerName ||
            (parameters[0] === configuration.runtimeLoginName &&
              runtimeHasCreate),
          owns_schema: false,
          owns_database: false,
        }];
      }
      if (sql.includes("FROM pg_proc routine")) {
        return applicationRoutineRows({
          owner: sql.includes("pg_has_role($1, routine.proowner"),
        });
      }
      if (sql.includes("pg_has_role($1, relation.relowner")) {
        return [
          ...APPLICATION_TABLES.map((relation_name) => ({
            relation_name,
            relation_kind: "r",
            can_manage_owner: true,
          })),
          {
            relation_name: "typeorm_migrations",
            relation_kind: "r",
            can_manage_owner: true,
          },
        ];
      }
      if (sql.includes("has_database_privilege")) {
        return [{ can_create_schema: false }];
      }
      if (sql.includes("pg_has_role")) {
        return [{ inherits_application_role: true }];
      }
      if (sql.includes("AS has_forbidden_privilege")) {
        return [{ has_forbidden_privilege: false }];
      }
      if (
        sql.includes("has_table_privilege") &&
        sql.includes("FROM pg_class relation")
      ) {
        return applicationPrivilegeRows();
      }
      if (sql.includes("has_sequence_privilege")) {
        return [];
      }
      if (sql.includes("has_schema_privilege")) {
        return [{
          has_create_privilege:
            runtimeHasCreate && parameters[0] === configuration.runtimeLoginName,
        }];
      }
      return [];
    },
  };
}

test("role provisioning validates then commits the exact allowed grants", async () => {
  const queryRunner = createQueryRunner();

  await runApplicationRoleProvisioningTransaction(queryRunner, configuration);

  assert.deepEqual(queryRunner.events, ["begin", "commit"]);
  const statements = queryRunner.queries.map(({ sql }) => sql);
  assert.ok(statements.some((sql) => sql.includes("GRANT INSERT ON TABLE")));
  assert.ok(statements.some((sql) => sql.includes("GRANT UPDATE ON TABLE")));
  assert.ok(statements.some((sql) => sql.includes("REVOKE CREATE ON SCHEMA public")));
  assert.ok(
    statements.every(
      (sql) =>
        !sql.includes("CREATE ROLE") &&
        !sql.includes("GRANT \"app_group\" TO") &&
        !sql.includes("REVOKE ALL PRIVILEGES"),
    ),
  );
});

test("role provisioning rolls back all grants when effective validation fails", async () => {
  const queryRunner = createQueryRunner({ runtimeHasCreate: true });

  await assert.rejects(
    runApplicationRoleProvisioningTransaction(queryRunner, configuration),
    /runtime login retains or could not be verified to lack CREATE/,
  );

  assert.deepEqual(queryRunner.events, ["begin", "rollback"]);
  assert.ok(
    queryRunner.queries.some(({ sql }) => sql.includes("GRANT SELECT ON TABLE")),
  );
  assert.ok(
    queryRunner.queries.some(({ sql }) => sql.includes("REVOKE CREATE ON SCHEMA public")),
  );
  assert.equal(queryRunner.events.includes("commit"), false);
});

test("role provisioning rejects effective TEMPORARY privilege before changing grants", async () => {
  const queryRunner = createQueryRunner();
  const runtimeDataSource = createRuntimeDataSource(true);

  await assert.rejects(
    runApplicationRoleProvisioningTransaction(queryRunner, {
      ...configuration,
      runtimeDataSource,
    }),
    /has effective TEMPORARY privilege/,
  );

  assert.deepEqual(queryRunner.events, ["begin", "rollback"]);
  assert.equal(queryRunner.queries.length, 0);
  assert.equal(runtimeDataSource.queries.length, 1);
});

test("missing pre-existing application role fails and rolls back", async () => {
  const queryRunner = createQueryRunner({ missingRole: true });

  await assert.rejects(
    runApplicationRoleProvisioningTransaction(queryRunner, configuration),
    /must be created administratively/,
  );
  assert.deepEqual(queryRunner.events, ["begin", "rollback"]);
  assert.equal(
    queryRunner.queries.some(({ sql }) => sql.includes("CREATE ROLE")),
    false,
  );
});

test("provisioning fails closed if rollback itself cannot be confirmed", async () => {
  const queryRunner = createQueryRunner({ runtimeHasCreate: true });
  queryRunner.rollbackTransaction = async () => {
    queryRunner.events.push("rollback-failed");
    throw new Error("unavailable");
  };

  await assert.rejects(
    runApplicationRoleProvisioningTransaction(queryRunner, configuration),
    /rollback could not be confirmed/,
  );
  assert.deepEqual(queryRunner.events, ["begin", "rollback-failed"]);
});

test("transactional grants and revokes are issued through the provided QueryRunner", async () => {
  const queryRunner = createQueryRunner();

  await provisionApplicationRole(queryRunner, configuration);

  assert.ok(queryRunner.queries.length > 0);
  assert.ok(
    queryRunner.queries.every(
      ({ sql }) => !sql.includes("new DataSource") && !sql.includes("pg.Client"),
    ),
  );
});
