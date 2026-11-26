import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_TABLES,
  APPLICATION_UPDATE_TABLES,
  APPLICATION_ROUTINES,
  APPLICATION_SCHEMAS,
  APPROVED_INFRASTRUCTURE_SCHEMAS,
  revokeAndValidatePublicSchemaCreate,
  validateApplicationTablePrivileges,
  validateApplicationRoutinePrivileges,
  validateApplicationSchemaInventory,
  validateApplicationSchemaPrivileges,
  validateApplicationSequencePrivileges,
  validateMigrationOwnerObjectPrivileges,
  validateMigrationOwnerRole,
  validateRole,
  validateRuntimeAppendOnlyPrivileges,
  validateRuntimeRoleMembership,
  validateRuntimeTemporaryPrivilege,
} from "./appRoleRuntimeValidation.js";

const migrationOwnerName = "migration_owner";
const runtimeIdentity = {
  databaseName: "kristallball_test",
  databaseOid: "16384",
  databaseMarker: "3f6587e8-492e-4678-8baa-239fb6d3ee27",
  loginRole: "runtime_login",
};

function runtimeTemporaryPrivilegeRow({
  canCreateTemporary = false,
  currentRole = runtimeIdentity.loginRole,
  databaseName = runtimeIdentity.databaseName,
  databaseOid = runtimeIdentity.databaseOid,
  loginRole = runtimeIdentity.loginRole,
  databaseComment = `kristallball.identity=${runtimeIdentity.databaseMarker}`,
} = {}) {
  return {
    database_name: databaseName,
    database_oid: databaseOid,
    login_role: loginRole,
    current_role: currentRole,
    database_comment: databaseComment,
    can_create_temporary_objects: canCreateTemporary,
  };
}

function createQueryDouble(results) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      const result = results.shift();
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function safeRole({ rolcanlogin = false } = {}) {
  return {
    oid: 1,
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolcanlogin,
  };
}

test("runtime TEMPORARY validation uses actual connection identity and effective database privilege", async () => {
  const client = createQueryDouble([[runtimeTemporaryPrivilegeRow()]]);

  const identity = await validateRuntimeTemporaryPrivilege(
    client,
    runtimeIdentity,
  );

  assert.deepEqual(identity, runtimeIdentity);
  assert.match(client.calls[0].text, /session_user::text AS login_role/);
  assert.match(client.calls[0].text, /current_user::text AS current_role/);
  assert.match(client.calls[0].text, /current_database\(\)/);
  assert.match(
    client.calls[0].text,
    /has_database_privilege\(\s*session_user,\s*database\.oid,\s*'TEMPORARY'\s*\)/,
  );
});

test("runtime TEMPORARY validation rejects effective privilege and unverifiable identity", async () => {
  await assert.rejects(
    validateRuntimeTemporaryPrivilege(
      createQueryDouble([[runtimeTemporaryPrivilegeRow({ canCreateTemporary: true })]]),
      runtimeIdentity,
    ),
    /has effective TEMPORARY privilege/,
  );

  for (const row of [
    runtimeTemporaryPrivilegeRow({ currentRole: "other_role" }),
    runtimeTemporaryPrivilegeRow({ databaseOid: "16385" }),
    runtimeTemporaryPrivilegeRow({ loginRole: "other_login" }),
    runtimeTemporaryPrivilegeRow({ databaseComment: null }),
  ]) {
    const client = createQueryDouble([[row]]);
    await assert.rejects(
      validateRuntimeTemporaryPrivilege(client, runtimeIdentity),
      /could not be verified|missing or has an invalid format/,
    );
  }

  await assert.rejects(
    validateRuntimeTemporaryPrivilege(createQueryDouble([undefined]), runtimeIdentity),
    /Could not verify runtime database identity and TEMPORARY privilege/,
  );
  await assert.rejects(
    validateRuntimeTemporaryPrivilege(createQueryDouble([[]]), runtimeIdentity),
    /Could not verify PostgreSQL database identity/,
  );
});

test("recursive CTE base and recursive terms return the same ordered role columns", async () => {
  const source = await readFile(
    new URL("./appRoleRuntimeValidation.js", import.meta.url),
    "utf8",
  );
  const roleTree = source.match(
    /WITH RECURSIVE role_tree AS \(([\s\S]*?)\),\s*migration_owner_tree/,
  )?.[1];
  assert.ok(roleTree, "role_tree CTE must be present");

  const baseColumns = roleTree
    .match(/SELECT([\s\S]*?)FROM pg_roles/)?.[1]
    ?.split(",")
    .map((column) => column.trim().split(".").pop());
  const recursiveColumns = roleTree
    .match(/UNION([\s\S]*?)FROM pg_auth_members/)?.[1]
    ?.split(",")
    .map((column) => column.trim().split(".").pop());

  assert.deepEqual(recursiveColumns, baseColumns);
  assert.deepEqual(baseColumns, [
    "oid",
    "rolname",
    "rolsuper",
    "rolbypassrls",
    "rolcreaterole",
    "rolcreatedb",
    "rolreplication",
  ]);
});

test("configured role rejects unsafe role attributes", async () => {
  const client = createQueryDouble([
    [{ ...safeRole(), rolsuper: true }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /unsafe role attributes/,
  );
  assert.equal(client.calls.length, 1);
});

test("configured role rejects BYPASSRLS, CREATEROLE, CREATEDB, and replication attributes", async () => {
  for (const attribute of [
    "rolbypassrls",
    "rolcreaterole",
    "rolcreatedb",
    "rolreplication",
  ]) {
    const role = { ...safeRole(), [attribute]: true };
    const client = createQueryDouble([[role]]);

    await assert.rejects(
      validateRole(client, "app_group", {
        loginExpected: false,
        migrationOwnerName,
      }),
      /unsafe role attributes/,
      attribute,
    );
  }
});

test("configured application role must remain NOLOGIN", async () => {
  const client = createQueryDouble([
    [{ ...safeRole({ rolcanlogin: true }) }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /unsafe role attributes/,
  );
});

test("configured role rejects membership in privileged roles", async () => {
  const client = createQueryDouble([
    [safeRole()],
    [{ unexpected_privilege: 1 }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /inherits unexpected privileges/,
  );
});

test("configured role rejects protected table or schema ownership", async () => {
  const client = createQueryDouble([
    [safeRole()],
    [],
    [{ protected_owner: 1 }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /owns an application database object/,
  );
  assert.match(
    client.calls[2].text,
    /object\.relkind IN \('r', 'p', 'v', 'm', 'S', 'f'\)/,
  );
  assert.match(client.calls[2].text, /schema\.nspname = ANY\(\$2::text\[\]\)/);
  assert.doesNotMatch(client.calls[2].text, /object\.relname IN/);
});

test("configured role validation fails closed when a query result is unavailable", async () => {
  const client = createQueryDouble([undefined]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /Could not verify configured database role/,
  );
});

test("configured role rejects membership in the migration-owner role", async () => {
  const client = createQueryDouble([
    [safeRole()],
    [{ inherited_migration_owner: 1 }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /inherits unexpected privileges/,
  );
  assert.match(client.calls[1].text, /migration_owner_tree/);
  assert.match(client.calls[1].text, /migration_role\.oid = candidate\.oid/);
  assert.deepEqual(client.calls[1].values.slice(0, 2), [
    "app_group",
    migrationOwnerName,
  ]);
  assert.ok(client.calls[1].values[2].includes("pg_write_all_data"));
});

test("configured role passes when attributes, memberships, ownership, and database CREATE are safe", async () => {
  const client = createQueryDouble([
    [safeRole()],
    [],
    [],
    [{ can_create_schema: false }],
  ]);

  await validateRole(client, "app_group", {
    loginExpected: false,
    migrationOwnerName,
  });
  assert.equal(client.calls.length, 4);
});

test("configured role rejects effective database CREATE privilege", async () => {
  const client = createQueryDouble([
    [safeRole()],
    [],
    [],
    [{ can_create_schema: true }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /database CREATE privilege/,
  );
});

test("migration-owner login must exist and have safe non-superuser attributes", async () => {
  const client = createQueryDouble([
    [
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
      },
    ],
    [],
  ]);

  await validateMigrationOwnerRole(client, migrationOwnerName);
  assert.equal(client.calls.length, 2);
});

test("migration-owner validation rejects missing or unsafe roles", async () => {
  for (const result of [
    [],
    [
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: true,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
      },
    ],
  ]) {
    const client = createQueryDouble([result]);
    await assert.rejects(
      validateMigrationOwnerRole(client, migrationOwnerName),
      /migration-owner role/,
    );
  }
});

test("migration-owner validation rejects inherited unsafe role attributes", async () => {
  const client = createQueryDouble([
    [{
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolcanlogin: true,
    }],
    [{ unsafe_membership: true }],
  ]);

  await assert.rejects(
    validateMigrationOwnerRole(client, migrationOwnerName),
    /inherits unsafe privileges/,
  );
  assert.match(client.calls[1].text, /WITH RECURSIVE role_tree/);
});

function migrationOwnerRelations({ relationOwner = true, sequenceOwner = true } = {}) {
  return [
    ...[...APPLICATION_TABLES, "typeorm_migrations"].map((relation_name) => ({
      relation_name,
      relation_kind: "r",
      can_manage_owner: relationOwner,
    })),
    {
      relation_name: "typeorm_migrations_id_seq",
      relation_kind: "S",
      can_manage_owner: sequenceOwner,
    },
  ];
}

function migrationOwnerRoutines({ routineOwner = true } = {}) {
  return APPLICATION_ROUTINES.map((routine_identity) => ({
    schema_name: "public",
    routine_identity,
    is_security_definer: false,
    can_manage_owner: routineOwner,
    extension_name: null,
  }));
}

test("migration owner must have effective schema DDL rights and own every required relation", async () => {
  const client = createQueryDouble([
    [{
      schema_name: "public",
      can_use_schema: true,
      can_create_schema: true,
      owns_schema: false,
      owns_database: false,
    }],
    migrationOwnerRelations(),
    migrationOwnerRoutines(),
  ]);

  await validateMigrationOwnerObjectPrivileges(client, migrationOwnerName);

  assert.match(client.calls[0].text, /has_schema_privilege/);
  assert.match(client.calls[1].text, /pg_has_role\(\$1, relation\.relowner, 'USAGE'\)/);
  assert.match(client.calls[1].text, /relation\.relkind IN \('r', 'p', 'v', 'm', 'S', 'f'\)/);
  assert.match(client.calls[2].text, /pg_has_role\(\$1, routine\.proowner, 'USAGE'\)/);
  assert.match(client.calls[2].text, /extension\.extname/);
});

test("migration-owner object validation rejects missing schema rights, ownership, or relations", async () => {
  const cases = [
    [
      [{
        schema_name: "public",
        can_use_schema: true,
        can_create_schema: false,
        owns_schema: false,
        owns_database: false,
      }],
      migrationOwnerRelations(),
      /effective USAGE and CREATE/,
    ],
    [
      [{
        schema_name: "public",
        can_use_schema: true,
        can_create_schema: true,
        owns_schema: true,
        owns_database: false,
      }],
      migrationOwnerRelations(),
      /owns a protected schema/,
    ],
    [
      [{
        schema_name: "public",
        can_use_schema: true,
        can_create_schema: true,
        owns_schema: false,
        owns_database: true,
      }],
      migrationOwnerRelations(),
      /without owning the schema or database/,
    ],
    [
      [{
        schema_name: "public",
        can_use_schema: true,
        can_create_schema: true,
        owns_schema: false,
        owns_database: false,
      }],
      migrationOwnerRelations({ relationOwner: false }),
      /must effectively own public relation/,
    ],
    [
      [{
        schema_name: "public",
        can_use_schema: true,
        can_create_schema: true,
        owns_schema: false,
        owns_database: false,
      }],
      migrationOwnerRelations({ sequenceOwner: false }),
      /must effectively own every public sequence/,
    ],
    [
      [{
        schema_name: "public",
        can_use_schema: true,
        can_create_schema: true,
        owns_schema: false,
        owns_database: false,
      }],
      migrationOwnerRelations().slice(1),
      /every required application relation/,
    ],
  ];

  for (const [schemaRows, relationRows, expectedError] of cases) {
    const client = createQueryDouble([schemaRows, relationRows]);
    await assert.rejects(
      validateMigrationOwnerObjectPrivileges(client, migrationOwnerName),
      expectedError,
    );
  }
});

test("schema inventory explicitly permits only application and approved infrastructure schemas", async () => {
  const client = createQueryDouble([[
    {
      schema_name: "public",
      can_use_schema: true,
      can_create_schema: false,
      owns_schema: false,
      owns_database: false,
    },
  ]]);

  const rows = await validateApplicationSchemaInventory(client, "runtime_login");

  assert.deepEqual(rows.map((row) => row.schema_name), [
    ...APPLICATION_SCHEMAS,
  ]);
  assert.deepEqual(APPROVED_INFRASTRUCTURE_SCHEMAS, []);
  assert.match(client.calls[0].text, /pg_temp_/);
  assert.match(client.calls[0].text, /pg_toast/);
  assert.match(client.calls[0].text, /has_schema_privilege/);
});

test("schema inventory rejects unexpected, missing, or owned schemas", async () => {
  for (const [rows, expectedError] of [
    [
      [{
        schema_name: "customer_data",
        owns_schema: false,
      }],
      /unexpected non-system schema/,
    ],
    [
      [],
      /required application schema is missing/,
    ],
    [
      [{
        schema_name: "public",
        owns_schema: true,
      }],
      /owns a protected schema/,
    ],
  ]) {
    const client = createQueryDouble([rows]);
    await assert.rejects(
      validateApplicationSchemaInventory(client, "runtime_login"),
      expectedError,
    );
  }
});

test("runtime schema privileges require USAGE and forbid CREATE and ownership", async () => {
  const client = createQueryDouble([[
    {
      schema_name: "public",
      can_use_schema: true,
      can_create_schema: false,
      owns_schema: false,
      owns_database: false,
    },
  ]]);

  await validateApplicationSchemaPrivileges(client, "runtime_login");

  const denied = createQueryDouble([[
    {
      schema_name: "public",
      can_use_schema: false,
      can_create_schema: true,
      owns_schema: false,
      owns_database: false,
    },
  ]]);
  await assert.rejects(
    validateApplicationSchemaPrivileges(denied, "runtime_login"),
    /unsafe effective schema privileges/,
  );
});

function expectedRoutinePrivileges() {
  return [
    ...APPLICATION_ROUTINES.map((routine_identity) => ({
      schema_name: "public",
      routine_identity,
      is_security_definer: false,
      can_execute: true,
      extension_name: null,
    })),
    {
      schema_name: "public",
      routine_identity: "gen_random_uuid()",
      is_security_definer: false,
      can_execute: true,
      extension_name: "pgcrypto",
    },
    {
      schema_name: "public",
      routine_identity: "digest(text, text)",
      is_security_definer: false,
      can_execute: false,
      extension_name: "pgcrypto",
    },
  ];
}

test("effective routine EXECUTE validation accepts the explicit application and pgcrypto allowlists", async () => {
  const client = createQueryDouble([expectedRoutinePrivileges()]);

  await validateApplicationRoutinePrivileges(client, "runtime_login");

  assert.match(client.calls[0].text, /has_function_privilege/);
  assert.match(client.calls[0].text, /routine\.prosecdef/);
  assert.match(client.calls[0].text, /pg_depend/);
  assert.match(client.calls[0].text, /pg_extension/);
  assert.deepEqual(client.calls[0].values, [
    "runtime_login",
    [...APPLICATION_SCHEMAS, ...APPROVED_INFRASTRUCTURE_SCHEMAS],
  ]);
});

test("effective routine validation rejects inherited EXECUTE on an unexpected routine", async () => {
  const rows = expectedRoutinePrivileges();
  rows.push({
    schema_name: "public",
    routine_identity: "unexpected_privileged_fn()",
    is_security_definer: false,
    can_execute: true,
    extension_name: null,
  });
  const client = createQueryDouble([rows]);

  await assert.rejects(
    validateApplicationRoutinePrivileges(client, "runtime_login"),
    /unexpected routine/,
  );
  assert.match(client.calls[0].text, /has_function_privilege/);
});

test("effective routine validation rejects SECURITY DEFINER and excessive pgcrypto EXECUTE", async () => {
  const definerRows = expectedRoutinePrivileges();
  definerRows[0].is_security_definer = true;
  await assert.rejects(
    validateApplicationRoutinePrivileges(
      createQueryDouble([definerRows]),
      "runtime_login",
    ),
    /SECURITY DEFINER/,
  );

  const excessCryptoRows = expectedRoutinePrivileges();
  excessCryptoRows.find(
    (row) => row.routine_identity === "digest(text, text)",
  ).can_execute = true;
  await assert.rejects(
    validateApplicationRoutinePrivileges(
      createQueryDouble([excessCryptoRows]),
      "runtime_login",
    ),
    /unexpected effective EXECUTE/,
  );
});

test("migration-owner routine validation rejects unexpected, unowned, or SECURITY DEFINER routines", async () => {
  const schemaRows = [{
    schema_name: "public",
    can_use_schema: true,
    can_create_schema: true,
    owns_schema: false,
    owns_database: false,
  }];
  const expectedRelations = migrationOwnerRelations();
  const cases = [
    [
      migrationOwnerRoutines({ routineOwner: false }),
      /must effectively own routine/,
    ],
    [
      [
        ...migrationOwnerRoutines(),
        {
          schema_name: "public",
          routine_identity: "unlisted_fn()",
          is_security_definer: false,
          can_manage_owner: true,
          extension_name: null,
        },
      ],
      /unexpected routine/,
    ],
    [
      migrationOwnerRoutines().map((row, index) =>
        index === 0 ? { ...row, is_security_definer: true } : row,
      ),
      /SECURITY DEFINER/,
    ],
  ];

  for (const [routineRows, expectedError] of cases) {
    const client = createQueryDouble([
      schemaRows,
      expectedRelations,
      routineRows,
    ]);
    await assert.rejects(
      validateMigrationOwnerObjectPrivileges(client, migrationOwnerName),
      expectedError,
    );
  }
});

test("configured role rejects shared inherited migration-owner roles", async () => {
  const client = createQueryDouble([
    [safeRole()],
    [{ shared_migration_role: 1 }],
  ]);

  await assert.rejects(
    validateRole(client, "app_group", {
      loginExpected: false,
      migrationOwnerName,
    }),
    /inherits unexpected privileges/,
  );
  assert.match(client.calls[1].text, /migration_owner_tree/);
});

test("configured role rejects being the migration-owner role", async () => {
  const client = createQueryDouble([]);

  await assert.rejects(
    validateRole(client, migrationOwnerName, {
      loginExpected: true,
      migrationOwnerName,
    }),
    /separate from the migration owner/,
  );
  assert.equal(client.calls.length, 0);
});

test("runtime login must effectively inherit the configured application role", async () => {
  const client = createQueryDouble([[{ inherits_application_role: true }]]);

  await validateRuntimeRoleMembership(client, "runtime_login", "app_group");

  assert.match(client.calls[0].text, /pg_has_role\(\$1, \$2, 'USAGE'\)/);
  assert.deepEqual(client.calls[0].values, ["runtime_login", "app_group"]);
});

test("runtime membership validation rejects missing effective inheritance", async () => {
  const client = createQueryDouble([[{ inherits_application_role: false }]]);

  await assert.rejects(
    validateRuntimeRoleMembership(client, "runtime_login", "app_group"),
    /runtime login must inherit APP_DATABASE_ROLE/,
  );
});

test("runtime membership validation fails closed on missing query rows", async () => {
  const client = createQueryDouble([[]]);

  await assert.rejects(
    validateRuntimeRoleMembership(client, "runtime_login", "app_group"),
    /runtime login must inherit APP_DATABASE_ROLE/,
  );
});

test("runtime append-only validation checks all protected effective privileges", async () => {
  const client = createQueryDouble([[{ has_forbidden_privilege: false }]]);

  await validateRuntimeAppendOnlyPrivileges(client, "runtime_login");

  assert.match(client.calls[0].text, /has_table_privilege/);
  for (const table of ["inventory_movement", "audit_log"]) {
    assert.match(client.calls[0].text, new RegExp(`public\\.${table}`));
  }
  for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
    assert.match(client.calls[0].text, new RegExp(`'${privilege}'`));
  }
  assert.deepEqual(client.calls[0].values, ["runtime_login"]);
  assert.match(client.calls[0].text, /public\.business_idempotency/);
});

test("runtime append-only validation rejects effective forbidden privileges", async () => {
  const client = createQueryDouble([[{ has_forbidden_privilege: true }]]);

  await assert.rejects(
    validateRuntimeAppendOnlyPrivileges(client, "runtime_login"),
    /runtime login has UPDATE, DELETE, or TRUNCATE privileges/,
  );
});

test("runtime append-only validation fails closed when privileges cannot be verified", async () => {
  const client = createQueryDouble([[]]);

  await assert.rejects(
    validateRuntimeAppendOnlyPrivileges(client, "runtime_login"),
    /could not be verified/,
  );
});

test("runtime append-only validation fails closed when the database query fails", async () => {
  const client = createQueryDouble([new Error("database query failed")]);

  await assert.rejects(
    validateRuntimeAppendOnlyPrivileges(client, "runtime_login"),
    /database query failed/,
  );
});

function expectedApplicationPrivileges() {
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

test("effective application table privileges match the configured runtime allowlist", async () => {
  const client = createQueryDouble([expectedApplicationPrivileges()]);

  await validateApplicationTablePrivileges(client, "runtime_login");

  assert.match(client.calls[0].text, /has_table_privilege/);
  assert.match(client.calls[0].text, /has_any_column_privilege/);
  assert.match(client.calls[0].text, /schema\.nspname = 'public'/);
  assert.doesNotMatch(client.calls[0].text, /relname = ANY/);
  assert.deepEqual(client.calls[0].values, ["runtime_login"]);
});

test("effective application table validation rejects column-level access to migration metadata", async () => {
  for (const privilege of [
    "can_select_column",
    "can_insert_column",
    "can_update_column",
    "can_reference_column",
  ]) {
    const rows = expectedApplicationPrivileges();
    rows.find((row) => row.table_name === "typeorm_migrations")[privilege] = true;
    const client = createQueryDouble([rows]);

    await assert.rejects(
      validateApplicationTablePrivileges(client, "runtime_login"),
      /unexpected effective table privileges/,
      privilege,
    );
  }
});

test("effective application table validation rejects column-level append-only UPDATE", async () => {
  for (const tableName of ["inventory_movement", "audit_log"]) {
    const rows = expectedApplicationPrivileges();
    rows.find((row) => row.table_name === tableName).can_update_column = true;
    const client = createQueryDouble([rows]);

    await assert.rejects(
      validateApplicationTablePrivileges(client, "runtime_login"),
      /unexpected effective table privileges/,
      tableName,
    );
  }
});

test("effective application table validation rejects unexpected public tables", async () => {
  const rows = expectedApplicationPrivileges();
  rows.push({
    table_name: "unlisted_public_table",
    can_select: false,
    can_insert: false,
    can_update: false,
    can_delete: false,
    can_truncate: false,
    can_reference: false,
    can_trigger: false,
  });
  const client = createQueryDouble([rows]);

  await assert.rejects(
    validateApplicationTablePrivileges(client, "runtime_login"),
    /Could not verify effective application table privileges/,
  );
});

test("effective application table privilege validation rejects inherited excess grants", async () => {
  const rows = expectedApplicationPrivileges();
  rows.find((row) => row.table_name === "asset").can_delete = true;
  const client = createQueryDouble([rows]);

  await assert.rejects(
    validateApplicationTablePrivileges(client, "runtime_login"),
    /unexpected effective table privileges/,
  );
});

test("effective application table validation rejects append-only UPDATE grants", async () => {
  for (const tableName of ["inventory_movement", "audit_log"]) {
    const rows = expectedApplicationPrivileges();
    rows.find((row) => row.table_name === tableName).can_update = true;
    const client = createQueryDouble([rows]);

    await assert.rejects(
      validateApplicationTablePrivileges(client, "app_group"),
      /unexpected effective table privileges/,
      tableName,
    );
  }
});

test("effective application table privilege validation fails closed on missing rows", async () => {
  const client = createQueryDouble([[]]);

  await assert.rejects(
    validateApplicationTablePrivileges(client, "runtime_login"),
    /Could not verify effective application table privileges/,
  );
});

test("effective application sequence validation requires no runtime sequence privileges", async () => {
  const client = createQueryDouble([
    [
      {
        sequence_name: "typeorm_migrations_id_seq",
        can_use: false,
        can_select: false,
        can_update: false,
      },
    ],
  ]);

  await validateApplicationSequencePrivileges(client, "runtime_login");

  assert.match(client.calls[0].text, /has_sequence_privilege/);
  assert.deepEqual(client.calls[0].values, ["runtime_login"]);
});

test("effective application sequence validation rejects inherited sequence access", async () => {
  const client = createQueryDouble([
    [
      {
        sequence_name: "typeorm_migrations_id_seq",
        can_use: true,
        can_select: false,
        can_update: false,
      },
    ],
  ]);

  await assert.rejects(
    validateApplicationSequencePrivileges(client, "runtime_login"),
    /unexpected effective sequence privileges/,
  );
});

test("effective application sequence validation fails closed on query errors", async () => {
  const client = createQueryDouble([new Error("sequence check failed")]);

  await assert.rejects(
    validateApplicationSequencePrivileges(client, "runtime_login"),
    /sequence check failed/,
  );
});

test("public schema CREATE is revoked and verified for group and runtime login", async () => {
  const client = createQueryDouble([
    [],
    [{ has_create_privilege: false }],
    [{ has_create_privilege: false }],
  ]);

  await revokeAndValidatePublicSchemaCreate(
    client,
    "app_group",
    "runtime_login",
  );

  assert.match(
    client.calls[0].text,
    /^REVOKE CREATE ON SCHEMA public FROM "app_group"$/,
  );
  assert.deepEqual(client.calls.slice(1).map((call) => call.values), [
    ["app_group"],
    ["runtime_login"],
  ]);
});

test("public schema CREATE validation rejects a remaining effective grant", async () => {
  const client = createQueryDouble([
    [],
    [{ has_create_privilege: true }],
  ]);

  await assert.rejects(
    revokeAndValidatePublicSchemaCreate(client, "app_group", "runtime_login"),
    /application role retains/,
  );
});

test("public schema CREATE validation fails closed if the result is unavailable", async () => {
  const client = createQueryDouble([[], []]);

  await assert.rejects(
    revokeAndValidatePublicSchemaCreate(client, "app_group", "runtime_login"),
    /application role retains or could not be verified/,
  );
});

test("role provisioning uses the shared maintenance DataSource and no pg.Client", async () => {
  const [source, provisioning] = await Promise.all([
    readFile(new URL("./apply-app-role.js", import.meta.url), "utf8"),
    readFile(new URL("./appRoleProvisioning.js", import.meta.url), "utf8"),
  ]);

  assert.match(source, /import \{ createMigrationDataSource \} from "\.\/migrationDb\.js"/);
  assert.match(source, /createMigrationDataSource\(\)/);
  assert.match(source, /await import\("\.\/db\.js"\)/);
  assert.match(source, /runtimeDataSource\.initialize\(\)/);
  assert.match(source, /migrationDataSource\.createQueryRunner\(\)/);
  assert.match(source, /runAfterDatabaseIdentityVerification/);
  assert.ok(
    source.indexOf("await runAfterDatabaseIdentityVerification") <
      source.lastIndexOf("await runApplicationRoleProvisioningTransaction"),
  );
  assert.match(source, /runApplicationRoleProvisioningTransaction/);
  assert.match(source, /queryRunner\.release\(\)/);
  assert.match(source, /migrationDataSource\.initialize\(\)/);
  assert.match(source, /migrationDataSource\.destroy\(\)/);
  assert.match(source, /runtimeDataSource\.destroy\(\)/);
  assert.doesNotMatch(source, /from ["']pg["']/);
  assert.doesNotMatch(source, /\bnew\s+Client\b|\bclient\.connect\(/);
  assert.doesNotMatch(source, /process\.env\.MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(source, /new\s+DataSource|connectionString\s*:/);
  assert.doesNotMatch(provisioning, /CREATE ROLE/);
  assert.doesNotMatch(provisioning, /REVOKE ALL PRIVILEGES/);
  assert.doesNotMatch(provisioning, /GRANT\s+\$\{quotedRole\}\s+TO/);
});

test("role provisioning fails safely when MIGRATION_DATABASE_URL is missing", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "kristallball-role-test-"));
  try {
    await writeFile(join(workingDirectory, ".env"), "");
    const environment = {
      ...process.env,
      APP_DATABASE_ROLE: "test_app_group",
      DATABASE_URL: "postgresql://runtime_test@127.0.0.1:1/kristallball_test",
    };
    delete environment.MIGRATION_DATABASE_URL;
    delete environment.DOTENV_CONFIG_PATH;

    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./apply-app-role.js", import.meta.url))],
      {
        cwd: workingDirectory,
        env: environment,
        encoding: "utf8",
        timeout: 5000,
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Application-role permission update failed/);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /postgresql:\/\/|runtime_test|127\.0\.0\.1/,
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
