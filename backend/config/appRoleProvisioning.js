import {
  APPLICATION_TABLES,
  APPLICATION_UPDATE_TABLES,
  validateApplicationRoutinePrivileges,
  validateApplicationSchemaInventory,
  validateApplicationSchemaPrivileges,
  revokeAndValidatePublicSchemaCreate,
  validateApplicationSequencePrivileges,
  validateApplicationTablePrivileges,
  validateMigrationOwnerObjectPrivileges,
  validateMigrationOwnerRole,
  validateRole,
  validateRuntimeAppendOnlyPrivileges,
  validateRuntimeRoleMembership,
  validateRuntimeTemporaryPrivilege,
} from "./appRoleRuntimeValidation.js";

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireRows(result, description) {
  if (!Array.isArray(result)) {
    throw new Error(`Could not verify ${description}.`);
  }

  return result;
}

export async function provisionApplicationRole(
  queryRunner,
  {
    applicationRoleName,
    runtimeLoginName,
    migrationOwnerName,
    runtimeDataSource,
    runtimeIdentity,
  },
) {
  for (const roleName of [
    applicationRoleName,
    runtimeLoginName,
    migrationOwnerName,
  ]) {
    if (!roleName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(roleName)) {
      throw new Error("A configured database role name is invalid.");
    }
  }

  await validateRuntimeTemporaryPrivilege(runtimeDataSource, runtimeIdentity);

  const applicationRoleRows = requireRows(
    await queryRunner.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [applicationRoleName],
    ),
    "application role",
  );
  if (applicationRoleRows.length !== 1) {
    throw new Error(
      "The application role must be created administratively before provisioning.",
    );
  }

  await validateApplicationSchemaInventory(queryRunner, applicationRoleName);
  await validateApplicationSchemaInventory(queryRunner, runtimeLoginName);
  await validateMigrationOwnerRole(queryRunner, migrationOwnerName);
  await validateMigrationOwnerObjectPrivileges(
    queryRunner,
    migrationOwnerName,
  );
  await validateRole(queryRunner, applicationRoleName, {
    loginExpected: false,
    migrationOwnerName,
  });
  await validateRole(queryRunner, runtimeLoginName, {
    loginExpected: true,
    migrationOwnerName,
  });
  await validateRuntimeRoleMembership(
    queryRunner,
    runtimeLoginName,
    applicationRoleName,
  );

  const quotedRole = quoteIdentifier(applicationRoleName);
  await queryRunner.query(
    `GRANT USAGE ON SCHEMA public TO ${quotedRole}`,
  );
  await queryRunner.query(
    `GRANT SELECT ON TABLE ${APPLICATION_TABLES
      .map(quoteIdentifier)
      .join(", ")} TO ${quotedRole}`,
  );
  await queryRunner.query(
    `GRANT INSERT ON TABLE ${APPLICATION_TABLES
      .map(quoteIdentifier)
      .join(", ")} TO ${quotedRole}`,
  );
  await queryRunner.query(
    `GRANT UPDATE ON TABLE ${APPLICATION_UPDATE_TABLES
      .map(quoteIdentifier)
      .join(", ")} TO ${quotedRole}`,
  );

  await validateRuntimeAppendOnlyPrivileges(queryRunner, runtimeLoginName);
  await validateApplicationTablePrivileges(queryRunner, applicationRoleName);
  await validateApplicationTablePrivileges(queryRunner, runtimeLoginName);
  await validateApplicationRoutinePrivileges(
    queryRunner,
    applicationRoleName,
  );
  await validateApplicationRoutinePrivileges(queryRunner, runtimeLoginName);
  await validateApplicationSequencePrivileges(queryRunner, applicationRoleName);
  await validateApplicationSequencePrivileges(queryRunner, runtimeLoginName);
  await revokeAndValidatePublicSchemaCreate(
    queryRunner,
    applicationRoleName,
    runtimeLoginName,
  );
  await validateApplicationSchemaPrivileges(queryRunner, applicationRoleName);
  await validateApplicationSchemaPrivileges(queryRunner, runtimeLoginName);
}

export async function runApplicationRoleProvisioningTransaction(
  queryRunner,
  configuration,
) {
  try {
    await queryRunner.startTransaction();
    await provisionApplicationRole(queryRunner, configuration);
    await queryRunner.commitTransaction();
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        throw new Error(
          "Application-role provisioning failed and rollback could not be confirmed.",
        );
      }
    }
    throw error;
  }
}
