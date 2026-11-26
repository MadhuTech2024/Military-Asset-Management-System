import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import {
  APPLICATION_TABLES,
  APPLICATION_UPDATE_TABLES,
  validateRuntimeTemporaryPrivilege,
} from "./appRoleRuntimeValidation.js";
import {
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
import { createBusinessOperationsController } from "../controllers/businessOperationsController.js";
import { createInventoryController } from "../controllers/assetController.js";
import { createReportController } from "../controllers/reportController.js";

const isolatedUrl = process.env.KRISTALLBALL_ISOLATED_TEST_DATABASE_URL;
const APPLICATION_ROUTINE_NAMES = [
  "prevent_append_only_mutation",
  "validate_inventory_movement",
  "validate_inventory_balance",
  "validate_return_operation",
  "process_return_operation",
  "sanitize_audit_json",
  "sanitize_audit_log_insert",
];

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function withSyntheticAuditFailure(
  targetAdmin,
  action,
  entityId,
  operation,
) {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `test_fail_audit_${suffix}`;
  const triggerName = `test_fail_audit_${suffix}`;
  const quotedFunctionName = quoteIdentifier(functionName);
  const quotedTriggerName = quoteIdentifier(triggerName);
  let functionCreated = false;
  let triggerCreated = false;

  try {
    await targetAdmin.query(
      `CREATE FUNCTION public.${quotedFunctionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         IF NEW.action = TG_ARGV[0]
            AND (
              TG_ARGV[1] = '*'
              OR NEW.entity_id::text = TG_ARGV[1]
            ) THEN
           RAISE EXCEPTION 'synthetic audit failure for transaction rollback test'
             USING ERRCODE = 'P0001';
         END IF;
         RETURN NEW;
       END;
       $function$`,
    );
    functionCreated = true;
    await targetAdmin.query(
      `CREATE TRIGGER ${quotedTriggerName}
       BEFORE INSERT ON public.audit_log
       FOR EACH ROW
       EXECUTE FUNCTION public.${quotedFunctionName}(
         ${quoteLiteral(action)},
         ${quoteLiteral(entityId)}
       )`,
    );
    triggerCreated = true;
    return await operation();
  } finally {
    try {
      if (triggerCreated) {
        await targetAdmin.query(
          `DROP TRIGGER IF EXISTS ${quotedTriggerName}
           ON public.audit_log`,
        );
      }
    } finally {
      if (functionCreated) {
        await targetAdmin.query(
          `DROP FUNCTION IF EXISTS public.${quotedFunctionName}()`,
        );
      }
    }
  }
}

function captureDatabaseError(queryErrors, error, query) {
  const driverError = error?.driverError;
  queryErrors.push({
    code: error?.code ?? driverError?.code ?? "UNKNOWN",
    message: String(
      driverError?.message ?? error?.message ?? error,
    ).replace(/[\r\n]+/gu, " "),
    query: String(
      query ?? error?.query ?? driverError?.query ?? "(query unavailable)",
    ).replace(/\s+/gu, " ").trim(),
  });
}

function makeDataSource(url, queryErrors) {
  const options = {
    type: "postgres",
    url,
    ssl: false,
    synchronize: false,
    migrationsRun: false,
    logging: false,
  };
  if (queryErrors) {
    options.logging = ["error"];
    options.logger = {
      logQuery() {},
      logQueryError(error, query) {
        captureDatabaseError(queryErrors, error, query);
      },
      logQuerySlow() {},
      logSchemaBuild() {},
      logMigration() {},
      log() {},
    };
  }
  return new DataSource(options);
}

async function applyProductionMigrations(queryRunner) {
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
    await migration.up(queryRunner);
  }
}

async function inTransaction(queryRunner, operation) {
  await queryRunner.startTransaction();
  try {
    const result = await operation();
    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    throw error;
  }
}

async function insertMovement(queryRunner, movement) {
  return queryRunner.query(
    `INSERT INTO public.inventory_movement (
       asset_id, base_id, equipment_type_id, movement_type, quantity,
       direction, occurred_at, idempotency_key, purchase_id, transfer_id,
       assignment_id, expenditure_id, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       COALESCE($7::timestamptz, pg_catalog.now()),
       $8, $9, $10, $11, $12, $13
     ) RETURNING id`,
    [
      movement.assetId,
      movement.baseId,
      movement.equipmentTypeId,
      movement.type,
      movement.quantity,
      movement.direction,
      movement.occurredAt ?? null,
      movement.idempotencyKey,
      movement.purchaseId ?? null,
      movement.transferId ?? null,
      movement.assignmentId ?? null,
      movement.expenditureId ?? null,
      movement.createdBy,
    ],
  );
}

async function getAssetBalance(queryRunner, assetId) {
  const [row] = await queryRunner.query(
    `SELECT CASE
              WHEN asset.opening_at <= pg_catalog.clock_timestamp()
              THEN asset.opening_balance
              ELSE 0
            END
              + COALESCE(
                  pg_catalog.sum(
                    CASE movement.direction
                      WHEN 'IN' THEN movement.quantity
                      ELSE -movement.quantity
                    END
                  )::integer,
                  0
                ) AS balance
     FROM public.asset asset
     LEFT JOIN public.inventory_movement movement
       ON movement.asset_id = asset.id
      AND movement.occurred_at <= pg_catalog.clock_timestamp()
     WHERE asset.id = $1
     GROUP BY asset.opening_balance, asset.opening_at`,
    [assetId],
  );
  return row.balance;
}

function makeBusinessResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function invokeBusinessHandler(
  handler,
  request,
  queryErrors = [],
  queryResults = [],
) {
  const firstErrorIndex = queryErrors.length;
  const firstQueryResultIndex = queryResults.length;
  const response = makeBusinessResponse();
  await handler(request, response);
  response.databaseErrors = queryErrors.slice(firstErrorIndex);
  response.databaseQueryResults = queryResults.slice(firstQueryResultIndex);
  return response;
}

function businessResponseDiagnostics(operation, response) {
  const databaseErrors = (response.databaseErrors ?? []).map(
    ({ code, message, query }) =>
      `${code}: ${message}; SQL (parameters omitted): ${query}`,
  );
  const queryResults = (response.databaseQueryResults ?? []).map(
    ({ query, rowCount, returnedStatuses }) =>
      `${query}; returned rows=${rowCount}; statuses=${returnedStatuses.join(",") || "none"}`,
  );
  return `${operation} returned HTTP ${response.statusCode}; ` +
    `response=${JSON.stringify(response.body)}; ` +
    `PostgreSQL=${databaseErrors.length > 0 ? databaseErrors.join(" | ") : "no query error captured"}; ` +
    `query results=${queryResults.length > 0 ? queryResults.join(" | ") : "none captured"}`;
}

function assertBusinessStatus(response, expectedStatus, operation) {
  assert.equal(
    response.statusCode,
    expectedStatus,
    `${businessResponseDiagnostics(operation, response)}; expected HTTP ${expectedStatus}`,
  );
}

function businessRequest(actor, validatedBody, idempotencyKey, params = {}) {
  return {
    currentUser: actor,
    validatedBody,
    idempotencyKey,
    params,
  };
}

test(
  "isolated PostgreSQL rejects runtime TEMPORARY privilege and protects production triggers",
  { skip: !isolatedUrl },
  async (t) => {
    const clusterUrl = new URL(isolatedUrl);
    if (
      clusterUrl.hostname !== "127.0.0.1" ||
      !clusterUrl.port ||
      clusterUrl.port === "5432" ||
      clusterUrl.pathname !== "/postgres" ||
      clusterUrl.username !== "postgres" ||
      clusterUrl.password
    ) {
      throw new Error(
        "Integration tests require a password-free, non-default loopback URL to the disposable test cluster.",
      );
    }

    const clusterAdmin = makeDataSource(isolatedUrl);
    let targetAdmin;
    let runtimeDataSource;
    let maintenanceDataSource;
    let runtimeQueryRunner;
    let migrationQueryRunner;
    let targetDatabaseName;
    let databaseCreated = false;
    const runtimeQueryErrors = [];
    const runtimeQueryResults = [];
    const inventoryEventObservations = [];
    const inventoryEventTimestampByRunner = new WeakMap();
    let observedInventoryAssetId;
    const roles = [];

    try {
      await clusterAdmin.initialize();
      const [cluster] = await clusterAdmin.query(
        `SELECT current_database() AS database_name,
                current_setting('data_directory') AS data_directory,
                session_user::text AS login_role`,
      );
      assert.equal(cluster.database_name, "postgres");
      assert.equal(cluster.login_role, "postgres");
      assert.match(
        cluster.data_directory.toLowerCase(),
        /kristallball-step1-pg-/,
        "integration test must use a newly initialized disposable cluster",
      );

      const suffix = randomUUID().replaceAll("-", "");
      targetDatabaseName = `step1_temp_${suffix}`;
      const applicationRole = `step1_temp_app_${suffix}`;
      const runtimeLogin = `step1_temp_runtime_${suffix}`;
      const maintenanceLogin = `step1_temp_maintenance_${suffix}`;
      const inheritedTempRole = `step1_temp_inherited_${suffix}`;

      for (const role of [
        applicationRole,
        runtimeLogin,
        maintenanceLogin,
        inheritedTempRole,
      ]) {
        await clusterAdmin.query(
          `CREATE ROLE ${quoteIdentifier(role)}
             NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );
        roles.push(role);
      }
      await clusterAdmin.query(
        `ALTER ROLE ${quoteIdentifier(applicationRole)} NOLOGIN`,
      );
      await clusterAdmin.query(
        `ALTER ROLE ${quoteIdentifier(runtimeLogin)} LOGIN INHERIT`,
      );
      await clusterAdmin.query(
        `ALTER ROLE ${quoteIdentifier(maintenanceLogin)} LOGIN INHERIT`,
      );
      await clusterAdmin.query(
        `GRANT ${quoteIdentifier(applicationRole)} TO ${quoteIdentifier(runtimeLogin)}`,
      );

      await clusterAdmin.query(
        `CREATE DATABASE ${quoteIdentifier(targetDatabaseName)} OWNER postgres`,
      );
      databaseCreated = true;
      const marker = randomUUID();
      await clusterAdmin.query(
        `COMMENT ON DATABASE ${quoteIdentifier(targetDatabaseName)}
         IS 'kristallball.identity=${marker}'`,
      );
      await clusterAdmin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(targetDatabaseName)}
         TO ${quoteIdentifier(runtimeLogin)}, ${quoteIdentifier(maintenanceLogin)}`,
      );

      const targetUrl = new URL(isolatedUrl);
      targetUrl.pathname = `/${targetDatabaseName}`;
      targetAdmin = makeDataSource(targetUrl.toString());
      await targetAdmin.initialize();
      migrationQueryRunner = targetAdmin.createQueryRunner();
      await migrationQueryRunner.connect();
      await applyProductionMigrations(migrationQueryRunner);
      await migrationQueryRunner.release();
      migrationQueryRunner = undefined;

      await targetAdmin.query(
        `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(applicationRole)}`,
      );
      await targetAdmin.query(
        `GRANT SELECT ON TABLE ${APPLICATION_TABLES
          .map((table) => `public.${quoteIdentifier(table)}`)
          .join(", ")} TO ${quoteIdentifier(applicationRole)}`,
      );
      await targetAdmin.query(
        `GRANT INSERT ON TABLE ${APPLICATION_TABLES
          .map((table) => `public.${quoteIdentifier(table)}`)
          .join(", ")} TO ${quoteIdentifier(applicationRole)}`,
      );
      await targetAdmin.query(
        `GRANT UPDATE ON TABLE ${APPLICATION_UPDATE_TABLES
          .map((table) => `public.${quoteIdentifier(table)}`)
          .join(", ")} TO ${quoteIdentifier(applicationRole)}`,
      );

      const runtimeUrl = new URL(targetUrl);
      runtimeUrl.username = runtimeLogin;
      runtimeDataSource = makeDataSource(
        runtimeUrl.toString(),
        runtimeQueryErrors,
      );
      await runtimeDataSource.initialize();
      const createRuntimeQueryRunner =
        runtimeDataSource.createQueryRunner.bind(runtimeDataSource);
      runtimeDataSource.createQueryRunner = (...args) => {
        const queryRunner = createRuntimeQueryRunner(...args);
        const runQuery = queryRunner.query.bind(queryRunner);
        queryRunner.query = async (...queryArgs) => {
          const [query, parameters = []] = queryArgs;
          const result = await runQuery(...queryArgs);
          if (observedInventoryAssetId && typeof query === "string") {
            if (
              query.includes(
                "SELECT pg_catalog.clock_timestamp()::text AS event_timestamp",
              )
            ) {
              const eventTimestamp = result[0]?.event_timestamp;
              inventoryEventTimestampByRunner.set(
                queryRunner,
                eventTimestamp,
              );
              inventoryEventObservations.push({
                stage: "capture",
                eventTimestamp,
              });
            } else if (
              query.includes("AS available") &&
              parameters[0] === observedInventoryAssetId
            ) {
              inventoryEventObservations.push({
                stage: "balance",
                eventTimestamp: parameters[1],
                capturedTimestamp:
                  inventoryEventTimestampByRunner.get(queryRunner),
              });
            } else if (
              /^\s*INSERT INTO public\.inventory_movement\b/iu.test(query) &&
              parameters[0] === observedInventoryAssetId
            ) {
              inventoryEventObservations.push({
                stage: "movement",
                eventTimestamp: parameters[6],
                capturedTimestamp:
                  inventoryEventTimestampByRunner.get(queryRunner),
                idempotencyKey: parameters[7],
              });
            }
          }
          if (
            typeof query === "string" &&
            /^\s*UPDATE\s+public\.transfer\b/iu.test(query)
          ) {
            runtimeQueryResults.push({
              query: query.replace(/\s+/gu, " ").trim(),
              rowCount: Array.isArray(result)
                ? Array.isArray(result[0])
                  ? result[0].length
                  : result.length
                : null,
              affectedRows:
                Array.isArray(result) && Number.isInteger(result[1])
                  ? result[1]
                  : null,
              returnedStatuses: Array.isArray(result)
                ? (Array.isArray(result[0]) ? result[0] : result)
                    .map((row) => row.status)
                    .filter(Boolean)
                : [],
            });
          }
          return result;
        };
        return queryRunner;
      };
      const runtimeTransaction = runtimeDataSource.transaction.bind(
        runtimeDataSource,
      );
      runtimeDataSource.transaction = async (...args) => {
        try {
          const result = await runtimeTransaction(...args);
          if (result?.kind === "database-error") {
            captureDatabaseError(runtimeQueryErrors, result.error);
          }
          return result;
        } catch (error) {
          captureDatabaseError(runtimeQueryErrors, error);
          throw error;
        }
      };
      const maintenanceUrl = new URL(targetUrl);
      maintenanceUrl.username = maintenanceLogin;
      maintenanceDataSource = makeDataSource(maintenanceUrl.toString());
      await maintenanceDataSource.initialize();
      const verifiedIdentity = await verifyDatabaseIdentity(
        runtimeDataSource,
        maintenanceDataSource,
      );
      assert.equal(
        verifiedIdentity.runtimeIdentity.databaseName,
        targetDatabaseName,
      );
      assert.notEqual(
        verifiedIdentity.runtimeIdentity.loginRole,
        verifiedIdentity.maintenanceIdentity.loginRole,
      );

      runtimeQueryRunner = runtimeDataSource.createQueryRunner();
      await runtimeQueryRunner.connect();

      await t.test("PUBLIC TEMPORARY is detected and revocation blocks temp tables", async () => {
        const [publicTemporary] = await targetAdmin.query(
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
        assert.equal(publicTemporary.public_has_temporary, true);
        await assert.rejects(
          validateRuntimeTemporaryPrivilege(
            runtimeDataSource,
            verifiedIdentity.runtimeIdentity,
          ),
          /has effective TEMPORARY privilege/,
        );

        const [beforeRevoke] = await targetAdmin.query(
          `SELECT has_database_privilege(
             $1, current_database(), 'TEMPORARY'
           ) AS can_create_temporary`,
          [runtimeLogin],
        );
        assert.equal(beforeRevoke.can_create_temporary, true);

        await clusterAdmin.query(
          `REVOKE TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabaseName)} FROM PUBLIC`,
        );
        await validateRuntimeTemporaryPrivilege(
          runtimeDataSource,
          verifiedIdentity.runtimeIdentity,
        );
        await assert.rejects(
          runtimeQueryRunner.query(
            "CREATE TEMPORARY TABLE temp_access_probe (id integer)",
          ),
          { code: "42501" },
        );
      });

      await t.test("inherited TEMPORARY is detected through the runtime login", async () => {
        await clusterAdmin.query(
          `GRANT TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabaseName)}
           TO ${quoteIdentifier(inheritedTempRole)}`,
        );
        await clusterAdmin.query(
          `GRANT ${quoteIdentifier(inheritedTempRole)}
           TO ${quoteIdentifier(runtimeLogin)}`,
        );
        const [effective] = await targetAdmin.query(
          `SELECT has_database_privilege(
             $1, current_database(), 'TEMPORARY'
           ) AS can_create_temporary`,
          [runtimeLogin],
        );
        assert.equal(effective.can_create_temporary, true);
        await assert.rejects(
          validateRuntimeTemporaryPrivilege(
            runtimeDataSource,
            verifiedIdentity.runtimeIdentity,
          ),
          /has effective TEMPORARY privilege/,
        );
        await runtimeQueryRunner.query(
          "CREATE TEMPORARY TABLE temp_inherited_probe (id integer)",
        );
        await runtimeQueryRunner.query(
          "DROP TABLE pg_temp.temp_inherited_probe",
        );
        await clusterAdmin.query(
          `REVOKE ${quoteIdentifier(inheritedTempRole)}
           FROM ${quoteIdentifier(runtimeLogin)}`,
        );
        await clusterAdmin.query(
          `REVOKE TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabaseName)}
           FROM ${quoteIdentifier(inheritedTempRole)}`,
        );
        await validateRuntimeTemporaryPrivilege(
          runtimeDataSource,
          verifiedIdentity.runtimeIdentity,
        );
      });

      const baseA = randomUUID();
      const baseB = randomUUID();
      const equipmentTypeId = randomUUID();
      const userA = randomUUID();
      const userB = randomUUID();
      const assetA = randomUUID();
      const assetB = randomUUID();
      const shadowPurchase = randomUUID();
      const purchaseA = randomUUID();
      const now = new Date().toISOString();

      await targetAdmin.query(
        `INSERT INTO public.base (id, code, name)
         VALUES ($1, 'TEMP-A', 'Temporary test base A'),
                ($2, 'TEMP-B', 'Temporary test base B')`,
        [baseA, baseB],
      );
      await targetAdmin.query(
        `INSERT INTO public.equipment_type (id, code, name, category)
         VALUES ($1, 'TEMP-EQ', 'Temporary test equipment', 'TEST')`,
        [equipmentTypeId],
      );
      await targetAdmin.query(
        `INSERT INTO public.app_user (id, email, password_hash, full_name, role)
         VALUES ($1, 'temp-a@example.test', 'synthetic', 'Test User A', 'ADMIN'),
                ($2, 'temp-b@example.test', 'synthetic', 'Test User B', 'ADMIN')`,
        [userA, userB],
      );
      await targetAdmin.query(
        `INSERT INTO public.asset (
           id, base_id, equipment_type_id, opening_balance, opening_at
         ) VALUES
           ($1, $2, $4, 10, $6),
           ($3, $5, $4, 0, $6)`,
        [assetA, baseA, assetB, equipmentTypeId, baseB, now],
      );
      await targetAdmin.query(
        `INSERT INTO public.purchase (
           id, base_id, equipment_type_id, quantity, status, purchased_at,
           created_by, idempotency_key, completed_at
         ) VALUES
           ($1, $2, $3, 2, 'COMPLETED', $6, $7, 'shadow-purchase', $6),
           ($4, $5, $3, 5, 'PENDING', $6, $7, 'purchase-a', NULL)`,
        [
          shadowPurchase,
          baseB,
          equipmentTypeId,
          purchaseA,
          baseA,
          now,
          userA,
        ],
      );

      const businessBaseA = randomUUID();
      const businessBaseB = randomUUID();
      const businessEquipmentType = randomUUID();
      const businessAssetA = randomUUID();
      const businessAssetB = randomUUID();
      const businessRequester = randomUUID();
      const businessApprover = randomUUID();
      const businessAlternateApprover = randomUUID();
      const businessCompleter = randomUUID();
      const businessCommanderA = randomUUID();
      await targetAdmin.query(
        `INSERT INTO public.base (id, code, name)
         VALUES ($1, 'BIZ-A', 'Synthetic Business Base A'),
                ($2, 'BIZ-B', 'Synthetic Business Base B')`,
        [businessBaseA, businessBaseB],
      );
      await targetAdmin.query(
        `INSERT INTO public.equipment_type (id, code, name, category)
         VALUES ($1, 'BIZ-EQ', 'Synthetic Business Equipment', 'TEST')`,
        [businessEquipmentType],
      );
      await targetAdmin.query(
        `INSERT INTO public.app_user (
           id, email, password_hash, full_name, role, base_id
         ) VALUES
           ($1, 'biz-requester@example.test', 'synthetic', 'Synthetic Requester', 'LOGISTICS_OFFICER', $2),
           ($3, 'biz-approver@example.test', 'synthetic', 'Synthetic Approver', 'BASE_COMMANDER', $4),
           ($5, 'biz-completer@example.test', 'synthetic', 'Synthetic Completer', 'LOGISTICS_OFFICER', $4),
           ($6, 'biz-commander-a@example.test', 'synthetic', 'Synthetic Commander A', 'BASE_COMMANDER', $2),
           ($7, 'biz-alternate-approver@example.test', 'synthetic', 'Synthetic Alternate Approver', 'BASE_COMMANDER', $4)`,
        [
          businessRequester,
          businessBaseA,
          businessApprover,
          businessBaseB,
          businessCompleter,
          businessCommanderA,
          businessAlternateApprover,
        ],
      );
      await targetAdmin.query(
        `INSERT INTO public.asset (
           id, base_id, equipment_type_id, opening_balance, opening_at
         ) VALUES
           ($1, $2, $4, 10, $6),
           ($3, $5, $4, 0, $6)`,
        [
          businessAssetA,
          businessBaseA,
          businessAssetB,
          businessEquipmentType,
          businessBaseB,
          now,
        ],
      );

      await t.test("actual hardened trigger resists temporary asset shadowing", async () => {
        await clusterAdmin.query(
          `GRANT TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabaseName)}
           TO ${quoteIdentifier(runtimeLogin)}`,
        );
        await assert.rejects(
          validateRuntimeTemporaryPrivilege(
            runtimeDataSource,
            verifiedIdentity.runtimeIdentity,
          ),
          /has effective TEMPORARY privilege/,
        );

        await runtimeQueryRunner.query(
          `CREATE TEMPORARY TABLE asset
           AS SELECT * FROM public.asset WHERE false`,
        );
        await runtimeQueryRunner.query(
          `INSERT INTO pg_temp.asset
           SELECT * FROM public.asset WHERE id = $1`,
          [assetA],
        );
        await runtimeQueryRunner.query(
          `UPDATE pg_temp.asset SET base_id = $2 WHERE id = $1`,
          [assetA, baseB],
        );

        await assert.rejects(
          insertMovement(runtimeQueryRunner, {
            assetId: assetA,
            baseId: baseB,
            equipmentTypeId,
            type: "PURCHASE",
            quantity: 2,
            direction: "IN",
            idempotencyKey: "shadow-attempt",
            purchaseId: shadowPurchase,
            createdBy: userA,
          }),
          /Inventory movement does not match its asset position/,
        );
        const [notInserted] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE idempotency_key = 'shadow-attempt'`,
        );
        assert.equal(notInserted.movement_count, 0);

        await runtimeQueryRunner.query("DROP TABLE pg_temp.asset");
        await clusterAdmin.query(
          `REVOKE TEMPORARY ON DATABASE ${quoteIdentifier(targetDatabaseName)}
           FROM ${quoteIdentifier(runtimeLogin)}`,
        );
        await validateRuntimeTemporaryPrivilege(
          runtimeDataSource,
          verifiedIdentity.runtimeIdentity,
        );

        const functionRows = await targetAdmin.query(
          `SELECT routine.proname AS name,
                  routine.prosecdef AS is_security_definer,
                  routine.proconfig AS function_settings,
                  pg_get_functiondef(routine.oid) AS definition
           FROM pg_proc routine
           JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
           WHERE namespace.nspname = 'public'
             AND routine.proname = ANY($1::text[])`,
          [APPLICATION_ROUTINE_NAMES],
        );
        assert.equal(functionRows.length, APPLICATION_ROUTINE_NAMES.length);
        for (const routine of functionRows) {
          assert.equal(routine.is_security_definer, false, routine.name);
          assert.ok(
            routine.function_settings.some(
              (setting) =>
                setting.replace(/\s/g, "") ===
                "search_path=pg_catalog,public,pg_temp",
            ),
            `unsafe search_path on ${routine.name}`,
          );
        }
        const definitions = new Map(
          functionRows.map((routine) => [routine.name, routine.definition]),
        );
        assert.match(definitions.get("validate_inventory_movement"), /FROM public\.asset/);
        assert.match(definitions.get("validate_inventory_movement"), /FROM public\.purchase/);
        assert.match(definitions.get("validate_inventory_movement"), /FROM public\.transfer/);
        assert.match(definitions.get("validate_inventory_movement"), /FROM public\.assignment/);
        assert.match(definitions.get("validate_inventory_movement"), /FROM public\.expenditure/);
        assert.match(definitions.get("validate_inventory_movement"), /FROM public\.return_operation/);
        assert.match(definitions.get("validate_inventory_balance"), /FOR UPDATE/);
        assert.match(definitions.get("validate_inventory_balance"), /v_projected_balance < 0/);
        assert.match(definitions.get("validate_return_operation"), /FROM public\.assignment/);
        assert.match(definitions.get("validate_return_operation"), /FROM public\.return_operation/);
        assert.match(definitions.get("process_return_operation"), /INSERT INTO public\.inventory_movement/);
        assert.match(definitions.get("process_return_operation"), /UPDATE public\.assignment/);
        assert.match(definitions.get("sanitize_audit_log_insert"), /public\.sanitize_audit_json/);
      });

      await t.test("purchase, transfer, assignment, return, and expenditure ledger flows remain consistent", async () => {
        await inTransaction(runtimeQueryRunner, async () => {
          await runtimeQueryRunner.query(
            `UPDATE public.purchase
             SET status = 'COMPLETED', completed_at = $2, updated_at = $2
             WHERE id = $1`,
            [purchaseA, now],
          );
          await insertMovement(runtimeQueryRunner, {
            assetId: assetA,
            baseId: baseA,
            equipmentTypeId,
            type: "PURCHASE",
            quantity: 5,
            direction: "IN",
            idempotencyKey: "purchase-a-movement",
            purchaseId: purchaseA,
            createdBy: userA,
          });
        });
        const [purchaseMovement] = await runtimeQueryRunner.query(
          `SELECT id FROM public.inventory_movement
           WHERE idempotency_key = 'purchase-a-movement'`,
        );
        assert.ok(purchaseMovement.id);
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetA), 15);

        const transferId = randomUUID();
        await runtimeQueryRunner.query(
          `INSERT INTO public.transfer (
             id, source_base_id, destination_base_id, equipment_type_id,
             quantity, status, idempotency_key, created_by
           ) VALUES ($1, $2, $3, $4, 4, 'PENDING', 'transfer-success', $5)`,
          [transferId, baseA, baseB, equipmentTypeId, userA],
        );
        await inTransaction(runtimeQueryRunner, async () => {
          await runtimeQueryRunner.query(
            `UPDATE public.transfer
             SET status = 'COMPLETED', approved_by = $2, approved_at = $3,
                 completed_by = $2, completed_at = $3, updated_at = $3
             WHERE id = $1`,
            [transferId, userB, now],
          );
          await insertMovement(runtimeQueryRunner, {
            assetId: assetA,
            baseId: baseA,
            equipmentTypeId,
            type: "TRANSFER_OUT",
            quantity: 4,
            direction: "OUT",
            idempotencyKey: "transfer-success-out",
            transferId,
            createdBy: userB,
          });
          await insertMovement(runtimeQueryRunner, {
            assetId: assetB,
            baseId: baseB,
            equipmentTypeId,
            type: "TRANSFER_IN",
            quantity: 4,
            direction: "IN",
            idempotencyKey: "transfer-success-in",
            transferId,
            createdBy: userB,
          });
        });
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetA), 11);
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetB), 4);

        const failedTransferId = randomUUID();
        await runtimeQueryRunner.query(
          `INSERT INTO public.transfer (
             id, source_base_id, destination_base_id, equipment_type_id,
             quantity, status, idempotency_key, created_by
           ) VALUES ($1, $2, $3, $4, 1, 'PENDING', 'transfer-failure', $5)`,
          [failedTransferId, baseA, baseB, equipmentTypeId, userA],
        );
        await assert.rejects(
          inTransaction(runtimeQueryRunner, async () => {
            await runtimeQueryRunner.query(
              `UPDATE public.transfer
               SET status = 'COMPLETED', approved_by = $2, approved_at = $3,
                   completed_by = $2, completed_at = $3, updated_at = $3
               WHERE id = $1`,
              [failedTransferId, userB, now],
            );
            await insertMovement(runtimeQueryRunner, {
              assetId: assetA,
              baseId: baseA,
              equipmentTypeId,
              type: "TRANSFER_OUT",
              quantity: 1,
              direction: "OUT",
              idempotencyKey: "transfer-failure-out",
              transferId: failedTransferId,
              createdBy: userB,
            });
            await insertMovement(runtimeQueryRunner, {
              assetId: assetA,
              baseId: baseA,
              equipmentTypeId,
              type: "TRANSFER_IN",
              quantity: 1,
              direction: "IN",
              idempotencyKey: "transfer-failure-in",
              transferId: failedTransferId,
              createdBy: userB,
            });
          }),
          /Transfer-in movement does not match destination base/,
        );
        const [rolledBackTransfer] = await runtimeQueryRunner.query(
          `SELECT transfer.status,
                  count(movement.id)::integer AS movement_count
           FROM public.transfer transfer
           LEFT JOIN public.inventory_movement movement
             ON movement.transfer_id = transfer.id
           WHERE transfer.id = $1
           GROUP BY transfer.status`,
          [failedTransferId],
        );
        assert.equal(rolledBackTransfer.status, "PENDING");
        assert.equal(rolledBackTransfer.movement_count, 0);

        const assignmentId = randomUUID();
        await runtimeQueryRunner.query(
          `INSERT INTO public.assignment (
             id, asset_id, base_id, equipment_type_id, quantity,
             personnel_reference, assigned_by, assigned_at, idempotency_key
           ) VALUES ($1, $2, $3, $4, 3, 'SYNTHETIC-REF', $5, $6, 'assignment-a')`,
          [assignmentId, assetA, baseA, equipmentTypeId, userA, now],
        );
        await insertMovement(runtimeQueryRunner, {
          assetId: assetA,
          baseId: baseA,
          equipmentTypeId,
          type: "ASSIGNMENT",
          quantity: 3,
          direction: "OUT",
          idempotencyKey: "assignment-a-movement",
          assignmentId,
          createdBy: userA,
        });
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetA), 8);

        const returnId = randomUUID();
        await runtimeQueryRunner.query(
          `INSERT INTO public.return_operation (
             id, assignment_id, asset_id, base_id, equipment_type_id,
             quantity, idempotency_key, returned_by, returned_at
           ) VALUES ($1, $2, $3, $4, $5, 1, 'partial-return-a', $6, $7)`,
          [returnId, assignmentId, assetA, baseA, equipmentTypeId, userB, now],
        );
        const [partialAssignment] = await runtimeQueryRunner.query(
          `SELECT returned_quantity, status
           FROM public.assignment WHERE id = $1`,
          [assignmentId],
        );
        assert.equal(partialAssignment.returned_quantity, 1);
        assert.equal(partialAssignment.status, "PARTIALLY_RETURNED");
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetA), 9);

        const expenditureId = randomUUID();
        await runtimeQueryRunner.query(
          `INSERT INTO public.expenditure (
             id, asset_id, base_id, equipment_type_id, quantity,
             reason_code, recorded_by, expended_at, idempotency_key
           ) VALUES ($1, $2, $3, $4, 2, 'SYNTHETIC-TEST', $5, $6, 'expenditure-a')`,
          [expenditureId, assetA, baseA, equipmentTypeId, userA, now],
        );
        await insertMovement(runtimeQueryRunner, {
          assetId: assetA,
          baseId: baseA,
          equipmentTypeId,
          type: "EXPENDITURE",
          quantity: 2,
          direction: "OUT",
          idempotencyKey: "expenditure-a-movement",
          expenditureId,
          createdBy: userA,
        });
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetA), 7);
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetB), 4);
      });

      await t.test("inventory movement rejects negative and concurrent overdraws", async () => {
        await assert.rejects(
          inTransaction(runtimeQueryRunner, async () => {
            const expenditureId = randomUUID();
            await runtimeQueryRunner.query(
              `INSERT INTO public.expenditure (
                 id, asset_id, base_id, equipment_type_id, quantity,
                 reason_code, recorded_by, expended_at, idempotency_key
               ) VALUES ($1, $2, $3, $4, 5, 'SYNTHETIC-TEST', $5, $6, $7)`,
              [
                expenditureId,
                assetB,
                baseB,
                equipmentTypeId,
                userB,
                now,
                `negative-expenditure-${expenditureId}`,
              ],
            );
            await insertMovement(runtimeQueryRunner, {
              assetId: assetB,
              baseId: baseB,
              equipmentTypeId,
              type: "EXPENDITURE",
              quantity: 5,
              direction: "OUT",
              idempotencyKey: `negative-movement-${expenditureId}`,
              expenditureId,
              createdBy: userB,
            });
          }),
          /Inventory movement would make asset balance negative/,
        );
        assert.equal(await getAssetBalance(runtimeQueryRunner, assetB), 4);

        const firstRunner = runtimeDataSource.createQueryRunner();
        const secondRunner = runtimeDataSource.createQueryRunner();
        let pendingSecondMovement;
        try {
          await firstRunner.connect();
          await secondRunner.connect();
          await firstRunner.startTransaction();

          const firstExpenditureId = randomUUID();
          await firstRunner.query(
            `INSERT INTO public.expenditure (
               id, asset_id, base_id, equipment_type_id, quantity,
               reason_code, recorded_by, expended_at, idempotency_key
             ) VALUES ($1, $2, $3, $4, 3, 'SYNTHETIC-TEST', $5, $6, $7)`,
            [
              firstExpenditureId,
              assetB,
              baseB,
              equipmentTypeId,
              userB,
              now,
              `concurrent-expenditure-a-${firstExpenditureId}`,
            ],
          );
          await insertMovement(firstRunner, {
            assetId: assetB,
            baseId: baseB,
            equipmentTypeId,
            type: "EXPENDITURE",
            quantity: 3,
            direction: "OUT",
            idempotencyKey: `concurrent-movement-a-${firstExpenditureId}`,
            expenditureId: firstExpenditureId,
            createdBy: userB,
          });

          await secondRunner.startTransaction();
          const [secondBackend] = await secondRunner.query(
            "SELECT pg_backend_pid() AS pid",
          );
          pendingSecondMovement = (async () => {
            const secondExpenditureId = randomUUID();
            await secondRunner.query(
              `INSERT INTO public.expenditure (
                 id, asset_id, base_id, equipment_type_id, quantity,
                 reason_code, recorded_by, expended_at, idempotency_key
               ) VALUES ($1, $2, $3, $4, 2, 'SYNTHETIC-TEST', $5, $6, $7)`,
              [
                secondExpenditureId,
                assetB,
                baseB,
                equipmentTypeId,
                userB,
                now,
                `concurrent-expenditure-b-${secondExpenditureId}`,
              ],
            );
            await insertMovement(secondRunner, {
              assetId: assetB,
              baseId: baseB,
              equipmentTypeId,
              type: "EXPENDITURE",
              quantity: 2,
              direction: "OUT",
              idempotencyKey: `concurrent-movement-b-${secondExpenditureId}`,
              expenditureId: secondExpenditureId,
              createdBy: userB,
            });
            return null;
          })().then(
            () => ({ error: null }),
            (error) => ({ error }),
          );

          let waitingForAssetLock = false;
          const lockWaitDeadline = Date.now() + 5000;
          while (Date.now() < lockWaitDeadline) {
            const [activity] = await targetAdmin.query(
              `SELECT wait_event_type
               FROM pg_stat_activity
               WHERE pid = $1`,
              [secondBackend.pid],
            );
            if (activity?.wait_event_type === "Lock") {
              waitingForAssetLock = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(waitingForAssetLock, true);

          await firstRunner.commitTransaction();
          const { error } = await pendingSecondMovement;
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /Inventory movement would make asset balance negative/,
          );
          await secondRunner.rollbackTransaction();
          assert.equal(await getAssetBalance(runtimeQueryRunner, assetB), 1);
        } finally {
          if (firstRunner.isTransactionActive) {
            await firstRunner.rollbackTransaction();
          }
          if (secondRunner.isTransactionActive) {
            await secondRunner.rollbackTransaction();
          }
          if (pendingSecondMovement) {
            await pendingSecondMovement;
          }
          await secondRunner.release();
          await firstRunner.release();
        }
      });

      await t.test("audit sanitization and append-only protections remain effective", async () => {
        const auditId = randomUUID();
        await runtimeQueryRunner.query(
          `INSERT INTO public.audit_log (
             id, actor_user_id, action, entity_type, entity_id,
             correlation_id, after_data
           ) VALUES (
             $1, $2, 'SYNTHETIC_TEST', 'asset', $3, $4, $5::jsonb
           )`,
          [
            auditId,
            userA,
            assetA,
            randomUUID(),
            JSON.stringify({ access_token: "synthetic-secret", safe: "retained" }),
          ],
        );
        const [sanitizedAudit] = await runtimeQueryRunner.query(
          `SELECT after_data FROM public.audit_log WHERE id = $1`,
          [auditId],
        );
        assert.deepEqual(sanitizedAudit.after_data, { safe: "retained" });

        await assert.rejects(
          runtimeQueryRunner.query(
            `UPDATE public.inventory_movement
             SET quantity = quantity + 1
             WHERE idempotency_key = 'purchase-a-movement'`,
          ),
          { code: "42501" },
        );
        await assert.rejects(
          runtimeQueryRunner.query(
            `DELETE FROM public.audit_log WHERE id = $1`,
            [auditId],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          targetAdmin.query(
            `UPDATE public.inventory_movement
             SET quantity = quantity + 1
             WHERE idempotency_key = 'purchase-a-movement'`,
          ),
          /Append-only table records/,
        );
        await assert.rejects(
          targetAdmin.query(
            `DELETE FROM public.audit_log WHERE id = $1`,
            [auditId],
          ),
          /Append-only table records/,
        );

        const idempotencyKey = `append-only-${randomUUID()}`;
        await runtimeQueryRunner.query(
          `INSERT INTO public.business_idempotency (
             idempotency_key, actor_user_id, operation,
             request_fingerprint, entity_type, entity_id, http_status,
             response_payload
           ) VALUES ($1, $2, 'PURCHASE_CREATE', $3, 'purchase', $4, 201, $5::jsonb)`,
          [
            idempotencyKey,
            userA,
            "a".repeat(64),
            purchaseA,
            JSON.stringify({ success: true, data: {} }),
          ],
        );
        await assert.rejects(
          runtimeQueryRunner.query(
            `UPDATE public.business_idempotency
             SET response_payload = '{}'::jsonb
             WHERE idempotency_key = $1`,
            [idempotencyKey],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          runtimeQueryRunner.query(
            `DELETE FROM public.business_idempotency
             WHERE idempotency_key = $1`,
            [idempotencyKey],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          targetAdmin.query(
            `UPDATE public.business_idempotency
             SET response_payload = '{}'::jsonb
             WHERE idempotency_key = $1`,
            [idempotencyKey],
          ),
          /Append-only table records/,
        );
      });

      await t.test("business API transactions preserve idempotency, ledger, and rollback invariants", async () => {
        const controller = createBusinessOperationsController({
          dataSource: runtimeDataSource,
        });
        const invokeBusiness = (handler, request) =>
          invokeBusinessHandler(
            handler,
            request,
            runtimeQueryErrors,
            runtimeQueryResults,
          );
        const adminActor = {
          id: userA,
          role: "ADMIN",
          baseId: null,
          isActive: true,
        };
        const requester = {
          id: businessRequester,
          role: "LOGISTICS_OFFICER",
          baseId: businessBaseA,
          isActive: true,
        };
        const approver = {
          id: businessApprover,
          role: "BASE_COMMANDER",
          baseId: businessBaseB,
          isActive: true,
        };
        const alternateApprover = {
          id: businessAlternateApprover,
          role: "BASE_COMMANDER",
          baseId: businessBaseB,
          isActive: true,
        };
        const completer = {
          id: businessCompleter,
          role: "LOGISTICS_OFFICER",
          baseId: businessBaseB,
          isActive: true,
        };
        const commander = {
          id: businessCommanderA,
          role: "BASE_COMMANDER",
          baseId: businessBaseA,
          isActive: true,
        };

        const futureOpeningBase = randomUUID();
        const futureMovementBase = randomUUID();
        const futureOpeningAsset = randomUUID();
        const futureMovementAsset = randomUUID();
        const futurePurchase = randomUUID();
        const futureTimestamp = new Date(
          Date.now() + 24 * 60 * 60 * 1000,
        ).toISOString();
        await targetAdmin.query(
          `INSERT INTO public.base (id, code, name)
           VALUES ($1, $2, 'Synthetic Future Opening Base'),
                  ($3, $4, 'Synthetic Future Movement Base')`,
          [
            futureOpeningBase,
            `FUT-OPEN-${randomUUID().slice(0, 8)}`,
            futureMovementBase,
            `FUT-MOVE-${randomUUID().slice(0, 8)}`,
          ],
        );
        await targetAdmin.query(
          `INSERT INTO public.asset (
             id, base_id, equipment_type_id, opening_balance, opening_at
           ) VALUES
             ($1, $2, $5, 5, $4),
             ($3, $6, $5, 0, $7)`,
          [
            futureOpeningAsset,
            futureOpeningBase,
            futureMovementAsset,
            futureTimestamp,
            businessEquipmentType,
            futureMovementBase,
            now,
          ],
        );
        await targetAdmin.query(
          `INSERT INTO public.purchase (
             id, base_id, equipment_type_id, quantity, status, purchased_at,
             created_by, idempotency_key, completed_at
           ) VALUES ($1, $2, $3, 5, 'COMPLETED', $4, $5, $6, $4)`,
          [
            futurePurchase,
            futureMovementBase,
            businessEquipmentType,
            futureTimestamp,
            businessRequester,
            `future-purchase-${randomUUID()}`,
          ],
        );
        const futureMovementKey = `future-purchase-movement-${randomUUID()}`;
        await assert.rejects(
          insertMovement(targetAdmin.manager, {
            assetId: futureMovementAsset,
            baseId: futureMovementBase,
            equipmentTypeId: businessEquipmentType,
            type: "PURCHASE",
            quantity: 5,
            direction: "IN",
            idempotencyKey: futureMovementKey,
            purchaseId: futurePurchase,
            createdBy: businessRequester,
            occurredAt: futureTimestamp,
          }),
          /Inventory movement cannot be future-dated/u,
        );
        const [rejectedFutureMovement] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE idempotency_key = $1`,
          [futureMovementKey],
        );
        assert.equal(rejectedFutureMovement.movement_count, 0);

        const inventoryController = createInventoryController({
          dataSource: runtimeDataSource,
        });
        const inventoryResponse = {
          statusCode: null,
          body: null,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(body) {
            this.body = body;
            return this;
          },
        };
        await inventoryController.summary(
          { authorizedBaseId: null },
          inventoryResponse,
        );
        assert.equal(inventoryResponse.statusCode, 200);
        for (const [assetId, baseId] of [
          [futureOpeningAsset, futureOpeningBase],
          [futureMovementAsset, futureMovementBase],
        ]) {
          const [currentInventory] = inventoryResponse.body.data.summary.filter(
            (entry) => entry.base.id === baseId,
          );
          assert.ok(currentInventory);
          assert.equal(currentInventory.closingBalance, 0);
          assert.equal(await getAssetBalance(runtimeQueryRunner, assetId), 0);

          const idempotencyKey = `future-outflow-${randomUUID()}`;
          const outflow = await invokeBusiness(
            controller.recordExpenditure,
            businessRequest(
              adminActor,
              {
                assetId,
                quantity: 1,
                reasonCode: "SYNTHETIC-FUTURE-STOCK",
                notes: null,
              },
              idempotencyKey,
            ),
          );
          assertBusinessStatus(
            outflow,
            409,
            "recordExpenditure (future stock is unavailable)",
          );
          assert.equal(outflow.body.error.code, "INSUFFICIENT_STOCK");
          const [rejectedOutflow] = await targetAdmin.query(
            `SELECT
               (SELECT count(*)::integer
                FROM public.expenditure
                WHERE idempotency_key = $1) AS expenditure_count,
               (SELECT count(*)::integer
                FROM public.business_idempotency
                WHERE idempotency_key = $1) AS idempotency_count`,
            [idempotencyKey],
          );
          assert.equal(rejectedOutflow.expenditure_count, 0);
          assert.equal(rejectedOutflow.idempotency_count, 0);

          const expenditureId = randomUUID();
          const movementKey = `future-trigger-outflow-${randomUUID()}`;
          await assert.rejects(
            targetAdmin.transaction(async (manager) => {
              await manager.query(
                `INSERT INTO public.expenditure (
                   id, asset_id, base_id, equipment_type_id, quantity,
                   reason_code, recorded_by, expended_at, idempotency_key
                 ) VALUES ($1, $2, $3, $4, 1, 'SYNTHETIC-FUTURE-STOCK', $5, $6, $7)`,
                [
                  expenditureId,
                  assetId,
                  baseId,
                  businessEquipmentType,
                  businessRequester,
                  now,
                  `future-expenditure-${randomUUID()}`,
                ],
              );
              await insertMovement(manager, {
                assetId,
                baseId,
                equipmentTypeId: businessEquipmentType,
                type: "EXPENDITURE",
                quantity: 1,
                direction: "OUT",
                idempotencyKey: movementKey,
                expenditureId,
                createdBy: businessRequester,
              });
            }),
            /Inventory movement would make asset balance negative/,
          );
          const [rolledBackOutflow] = await targetAdmin.query(
            `SELECT
               (SELECT count(*)::integer
                FROM public.expenditure WHERE id = $1) AS expenditure_count,
               (SELECT count(*)::integer
                FROM public.inventory_movement WHERE idempotency_key = $2)
                 AS movement_count`,
            [expenditureId, movementKey],
          );
          assert.equal(rolledBackOutflow.expenditure_count, 0);
          assert.equal(rolledBackOutflow.movement_count, 0);
        }

        const purchaseKey = `business-purchase-${randomUUID()}`;
        const purchaseRequest = businessRequest(
          adminActor,
          {
            baseId: businessBaseA,
            equipmentTypeId: businessEquipmentType,
            quantity: 3,
            referenceCode: null,
          },
          purchaseKey,
        );
        const [purchaseOne, purchaseTwo] = await Promise.all([
          invokeBusiness(controller.createPurchase, purchaseRequest),
          invokeBusiness(controller.createPurchase, purchaseRequest),
        ]);
        assertBusinessStatus(purchaseOne, 201, "createPurchase (first request)");
        assertBusinessStatus(purchaseTwo, 201, "createPurchase (replay request)");
        assert.deepEqual(purchaseTwo.body, purchaseOne.body);
        assert.equal(purchaseOne.body.data.purchase.status, "PENDING");
        const businessPurchaseId = purchaseOne.body.data.purchase.id;
        const [pendingPurchaseMovement] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE purchase_id = $1`,
          [businessPurchaseId],
        );
        assert.equal(pendingPurchaseMovement.movement_count, 0);
        const changedPayloadPurchase = await invokeBusiness(
          controller.createPurchase,
          businessRequest(
            adminActor,
            {
              baseId: businessBaseA,
              equipmentTypeId: businessEquipmentType,
              quantity: 4,
              referenceCode: null,
            },
            purchaseKey,
          ),
        );
        assertBusinessStatus(
          changedPayloadPurchase,
          409,
          "createPurchase (idempotency payload mismatch)",
        );
        assert.equal(
          changedPayloadPurchase.body.error.code,
          "IDEMPOTENCY_KEY_REUSED",
        );
        const [purchaseAudit] = await targetAdmin.query(
          `SELECT action, actor_user_id, entity_type, entity_id, base_id,
                  correlation_id, created_at
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'PURCHASE_CREATED'`,
          [businessPurchaseId],
        );
        assert.equal(purchaseAudit.action, "PURCHASE_CREATED");
        assert.equal(purchaseAudit.actor_user_id, adminActor.id);
        assert.equal(purchaseAudit.entity_type, "purchase");
        assert.equal(purchaseAudit.entity_id, businessPurchaseId);
        assert.equal(purchaseAudit.base_id, businessBaseA);
        assert.ok(purchaseAudit.correlation_id);
        assert.ok(purchaseAudit.created_at);
        const [purchaseCounts] = await targetAdmin.query(
          `SELECT
             (SELECT count(*)::integer FROM public.purchase
              WHERE idempotency_key = $1) AS purchases,
             (SELECT count(*)::integer FROM public.inventory_movement
              WHERE purchase_id = $2) AS movements,
             (SELECT count(*)::integer FROM public.audit_log
              WHERE action = 'PURCHASE_CREATED'
                AND entity_id = $2) AS audits,
             (SELECT count(*)::integer FROM public.business_idempotency
              WHERE idempotency_key = $1
                AND actor_user_id = $3
                AND operation = 'PURCHASE_CREATE') AS idempotency_records`,
          [purchaseKey, businessPurchaseId, adminActor.id],
        );
        assert.deepEqual(purchaseCounts, {
          purchases: 1,
          movements: 0,
          audits: 1,
          idempotency_records: 1,
        });

        const transferKey = `business-transfer-${randomUUID()}`;
        const transferRequest = businessRequest(
          requester,
          {
            sourceBaseId: businessBaseA,
            destinationBaseId: businessBaseB,
            equipmentTypeId: businessEquipmentType,
            quantity: 4,
          },
          transferKey,
        );
        const transferResponse = await invokeBusiness(
          controller.initiateTransfer,
          transferRequest,
        );
        assertBusinessStatus(transferResponse, 201, "initiateTransfer");
        const transferId = transferResponse.body.data.transfer.id;
        assert.equal(transferResponse.body.data.transfer.status, "PENDING");
        const transferReplay = await invokeBusiness(
          controller.initiateTransfer,
          transferRequest,
        );
        assertBusinessStatus(transferReplay, 201, "initiateTransfer (replay)");
        assert.deepEqual(transferReplay.body, transferResponse.body);
        const [pendingTransferMovements] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE transfer_id = $1`,
          [transferId],
        );
        assert.equal(pendingTransferMovements.movement_count, 0);
        const [transferAudit] = await targetAdmin.query(
          `SELECT action, actor_user_id, entity_type, entity_id, base_id,
                  correlation_id, created_at, after_data
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'TRANSFER_INITIATED'`,
          [transferId],
        );
        assert.equal(transferAudit.action, "TRANSFER_INITIATED");
        assert.equal(transferAudit.actor_user_id, requester.id);
        assert.equal(transferAudit.entity_type, "transfer");
        assert.equal(transferAudit.entity_id, transferId);
        assert.equal(transferAudit.base_id, businessBaseA);
        assert.ok(transferAudit.correlation_id);
        assert.ok(transferAudit.created_at);
        assert.equal(transferAudit.after_data.sourceBaseId, businessBaseA);
        assert.equal(
          transferAudit.after_data.destinationBaseId,
          businessBaseB,
        );
        const [transferCounts] = await targetAdmin.query(
          `SELECT
             (SELECT count(*)::integer FROM public.transfer
              WHERE idempotency_key = $1) AS transfers,
             (SELECT count(*)::integer FROM public.audit_log
              WHERE action = 'TRANSFER_INITIATED'
                AND entity_id = $2) AS audits,
             (SELECT count(*)::integer FROM public.business_idempotency
              WHERE idempotency_key = $1
                AND actor_user_id = $3
                AND operation = 'TRANSFER_INITIATE') AS idempotency_records`,
          [transferKey, transferId, requester.id],
        );
        assert.deepEqual(transferCounts, {
          transfers: 1,
          audits: 1,
          idempotency_records: 1,
        });

        const sourceBalanceBeforeApprovalFailure = await getAssetBalance(
          runtimeQueryRunner,
          businessAssetA,
        );
        const destinationBalanceBeforeApprovalFailure = await getAssetBalance(
          runtimeQueryRunner,
          businessAssetB,
        );
        const failedApprovalKey = `business-approve-failure-${randomUUID()}`;
        const failedApproval = await withSyntheticAuditFailure(
          targetAdmin,
          "TRANSFER_APPROVED",
          transferId,
          () =>
            invokeBusiness(
              controller.approveTransfer,
              businessRequest(approver, {}, failedApprovalKey, { transferId }),
            ),
        );
        assertBusinessStatus(
          failedApproval,
          500,
          "approveTransfer (injected audit failure)",
        );
        assert.ok(
          failedApproval.databaseErrors.some(
            ({ code, message }) =>
              code === "P0001" &&
              message.includes("synthetic audit failure"),
          ),
          businessResponseDiagnostics(
            "approveTransfer (injected audit failure)",
            failedApproval,
          ),
        );
        assert.ok(
          failedApproval.databaseQueryResults.some(({ returnedStatuses }) =>
            returnedStatuses.includes("APPROVED"),
          ),
          "approval UPDATE must succeed before the injected audit failure",
        );
        const [failedApprovalTransfer] = await targetAdmin.query(
          `SELECT status
           FROM public.transfer
           WHERE id = $1`,
          [transferId],
        );
        const [failedApprovalAudit] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'TRANSFER_APPROVED'`,
          [transferId],
        );
        const [failedApprovalIdempotency] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.business_idempotency
           WHERE idempotency_key = $1
             AND operation = 'TRANSFER_APPROVE'`,
          [failedApprovalKey],
        );
        const [failedApprovalMovements] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE transfer_id = $1`,
          [transferId],
        );
        assert.equal(failedApprovalTransfer.status, "PENDING");
        assert.equal(failedApprovalAudit.record_count, 0);
        assert.equal(failedApprovalIdempotency.record_count, 0);
        assert.equal(failedApprovalMovements.movement_count, 0);
        assert.equal(
          await getAssetBalance(runtimeQueryRunner, businessAssetA),
          sourceBalanceBeforeApprovalFailure,
        );
        assert.equal(
          await getAssetBalance(runtimeQueryRunner, businessAssetB),
          destinationBalanceBeforeApprovalFailure,
        );

        const approvalKey = `business-approve-${randomUUID()}`;
        const approvalRequest = businessRequest(
          approver,
          {},
          approvalKey,
          { transferId },
        );
        const [approvalOne, approvalTwo] = await Promise.all([
          invokeBusiness(controller.approveTransfer, approvalRequest),
          invokeBusiness(controller.approveTransfer, approvalRequest),
        ]);
        assertBusinessStatus(approvalOne, 200, "approveTransfer (first request)");
        assertBusinessStatus(approvalTwo, 200, "approveTransfer (replay request)");
        assert.deepEqual(approvalTwo.body, approvalOne.body);
        assert.equal(approvalOne.body.data.transfer.status, "APPROVED");
        const [successfulApprovalAudit] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'TRANSFER_APPROVED'`,
          [transferId],
        );
        const [successfulApprovalIdempotency] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.business_idempotency
           WHERE idempotency_key = $1
             AND operation = 'TRANSFER_APPROVE'
             AND actor_user_id = $2
             AND entity_id = $3
             AND http_status = 200`,
          [approvalKey, businessApprover, transferId],
        );
        assert.equal(successfulApprovalAudit.record_count, 1);
        assert.equal(successfulApprovalIdempotency.record_count, 1);

        const changedPayloadTransfer = await invokeBusiness(
          controller.initiateTransfer,
          businessRequest(
            requester,
            {
              sourceBaseId: businessBaseA,
              destinationBaseId: businessBaseB,
              equipmentTypeId: businessEquipmentType,
              quantity: 1,
            },
            `business-transfer-payload-${randomUUID()}`,
          ),
        );
        assertBusinessStatus(
          changedPayloadTransfer,
          201,
          "initiateTransfer (idempotency payload case)",
        );
        const changedPayloadApproval = await invokeBusiness(
          controller.approveTransfer,
          businessRequest(
            approver,
            {},
            approvalKey,
            { transferId: changedPayloadTransfer.body.data.transfer.id },
          ),
        );
        assertBusinessStatus(
          changedPayloadApproval,
          409,
          "approveTransfer (same actor, changed payload)",
        );
        assert.equal(
          changedPayloadApproval.body.error.code,
          "IDEMPOTENCY_KEY_REUSED",
        );
        const [unchangedChangedPayloadTransfer] = await targetAdmin.query(
          `SELECT status
           FROM public.transfer
           WHERE id = $1`,
          [changedPayloadTransfer.body.data.transfer.id],
        );
        assert.equal(unchangedChangedPayloadTransfer.status, "PENDING");

        const differentActorReplay = await invokeBusiness(
          controller.approveTransfer,
          businessRequest(
            alternateApprover,
            {},
            approvalKey,
            { transferId },
          ),
        );
        assertBusinessStatus(
          differentActorReplay,
          403,
          "approveTransfer (different actor replay)",
        );
        assert.equal(differentActorReplay.body.error.code, "FORBIDDEN");
        assert.notDeepEqual(differentActorReplay.body, approvalOne.body);

        await targetAdmin.query(
          `UPDATE public.app_user
           SET role = 'LOGISTICS_OFFICER'
           WHERE id = $1`,
          [businessApprover],
        );
        const roleChangedReplay = await invokeBusiness(
          controller.approveTransfer,
          approvalRequest,
        );
        await targetAdmin.query(
          `UPDATE public.app_user
           SET role = 'BASE_COMMANDER'
           WHERE id = $1`,
          [businessApprover],
        );
        assertBusinessStatus(
          roleChangedReplay,
          403,
          "approveTransfer (role changed before replay)",
        );
        assert.equal(roleChangedReplay.body.error.code, "FORBIDDEN");

        await targetAdmin.query(
          `UPDATE public.app_user
           SET base_id = $1
           WHERE id = $2`,
          [businessBaseA, businessApprover],
        );
        const baseChangedReplay = await invokeBusiness(
          controller.approveTransfer,
          approvalRequest,
        );
        await targetAdmin.query(
          `UPDATE public.app_user
           SET base_id = $1
           WHERE id = $2`,
          [businessBaseB, businessApprover],
        );
        assertBusinessStatus(
          baseChangedReplay,
          403,
          "approveTransfer (base changed before replay)",
        );
        assert.equal(baseChangedReplay.body.error.code, "FORBIDDEN");

        await targetAdmin.query(
          `UPDATE public.app_user
           SET is_active = false
           WHERE id = $1`,
          [businessApprover],
        );
        const inactiveActorReplay = await invokeBusiness(
          controller.approveTransfer,
          approvalRequest,
        );
        await targetAdmin.query(
          `UPDATE public.app_user
           SET is_active = true
           WHERE id = $1`,
          [businessApprover],
        );
        assertBusinessStatus(
          inactiveActorReplay,
          401,
          "approveTransfer (inactive actor replay)",
        );
        assert.equal(inactiveActorReplay.body.error.code, "UNAUTHENTICATED");

        const completionKey = `business-complete-${randomUUID()}`;
        const completionRequest = businessRequest(
          completer,
          {},
          completionKey,
          { transferId },
        );
        const failedCompletionKey = `business-complete-failure-${randomUUID()}`;
        const sourceBalanceBeforeFailure = await getAssetBalance(
          runtimeQueryRunner,
          businessAssetA,
        );
        const destinationBalanceBeforeFailure = await getAssetBalance(
          runtimeQueryRunner,
          businessAssetB,
        );
        const failedCompletion = await withSyntheticAuditFailure(
          targetAdmin,
          "TRANSFER_COMPLETED",
          transferId,
          () =>
            invokeBusiness(
              controller.completeTransfer,
              businessRequest(
                completer,
                {},
                failedCompletionKey,
                { transferId },
              ),
            ),
        );
        assertBusinessStatus(
          failedCompletion,
          500,
          "completeTransfer (injected audit failure)",
        );
        assert.ok(
          failedCompletion.databaseErrors.some(
            ({ code, message }) =>
              code === "P0001" &&
              message.includes("synthetic audit failure"),
          ),
          businessResponseDiagnostics(
            "completeTransfer (injected audit failure)",
            failedCompletion,
          ),
        );
        assert.ok(
          failedCompletion.databaseQueryResults.some(({ returnedStatuses }) =>
            returnedStatuses.includes("COMPLETED"),
          ),
          "completion UPDATE must succeed before the injected audit failure",
        );
        const [failedCompletionTransfer] = await targetAdmin.query(
          `SELECT status
           FROM public.transfer
           WHERE id = $1`,
          [transferId],
        );
        const [failedCompletionMovements] = await targetAdmin.query(
          `SELECT count(*) FILTER (
                   WHERE movement_type = 'TRANSFER_OUT'
                 )::integer AS source_legs,
                 count(*) FILTER (
                   WHERE movement_type = 'TRANSFER_IN'
                 )::integer AS destination_legs
           FROM public.inventory_movement
           WHERE transfer_id = $1`,
          [transferId],
        );
        const [failedCompletionAudit] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'TRANSFER_COMPLETED'`,
          [transferId],
        );
        const [failedCompletionIdempotency] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.business_idempotency
           WHERE idempotency_key = $1
             AND operation = 'TRANSFER_COMPLETE'`,
          [failedCompletionKey],
        );
        assert.equal(failedCompletionTransfer.status, "APPROVED");
        assert.equal(failedCompletionMovements.source_legs, 0);
        assert.equal(failedCompletionMovements.destination_legs, 0);
        assert.equal(failedCompletionAudit.record_count, 0);
        assert.equal(failedCompletionIdempotency.record_count, 0);
        assert.equal(
          await getAssetBalance(runtimeQueryRunner, businessAssetA),
          sourceBalanceBeforeFailure,
        );
        assert.equal(
          await getAssetBalance(runtimeQueryRunner, businessAssetB),
          destinationBalanceBeforeFailure,
        );

        const [completion, completionReplay] = await Promise.all([
          invokeBusiness(controller.completeTransfer, completionRequest),
          invokeBusiness(controller.completeTransfer, completionRequest),
        ]);
        assertBusinessStatus(completion, 200, "completeTransfer (first request)");
        assertBusinessStatus(completionReplay, 200, "completeTransfer (concurrent replay)");
        assert.equal(completion.body.data.transfer.status, "COMPLETED");
        assert.deepEqual(completionReplay.body, completion.body);
        const [completedMovementCounts] = await targetAdmin.query(
          `SELECT count(*) FILTER (
                   WHERE movement.movement_type = 'TRANSFER_OUT'
                 )::integer AS source_legs,
                 count(*) FILTER (
                   WHERE movement.movement_type = 'TRANSFER_IN'
                 )::integer AS destination_legs,
                 count(DISTINCT movement.occurred_at)::integer
                   AS distinct_event_times,
                 bool_and(movement.occurred_at = transfer.completed_at)
                   AS matches_completion_time
           FROM public.transfer transfer
           LEFT JOIN public.inventory_movement movement
             ON movement.transfer_id = transfer.id
           WHERE transfer.id = $1
           GROUP BY transfer.completed_at`,
          [transferId],
        );
        assert.equal(completedMovementCounts.source_legs, 1);
        assert.equal(completedMovementCounts.destination_legs, 1);
        assert.equal(completedMovementCounts.distinct_event_times, 1);
        assert.equal(completedMovementCounts.matches_completion_time, true);
        const [successfulCompletionAudit] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'TRANSFER_COMPLETED'`,
          [transferId],
        );
        const [successfulCompletionIdempotency] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.business_idempotency
           WHERE idempotency_key = $1
             AND operation = 'TRANSFER_COMPLETE'
             AND actor_user_id = $2
             AND entity_id = $3
             AND http_status = 200`,
          [completionKey, businessCompleter, transferId],
        );
        assert.equal(successfulCompletionAudit.record_count, 1);
        assert.equal(successfulCompletionIdempotency.record_count, 1);
        assert.equal(
          await getAssetBalance(runtimeQueryRunner, businessAssetA),
          sourceBalanceBeforeFailure - 4,
        );
        assert.equal(
          await getAssetBalance(runtimeQueryRunner, businessAssetB),
          destinationBalanceBeforeFailure + 4,
        );

        const rejectedTransfer = await invokeBusiness(
          controller.initiateTransfer,
          businessRequest(
            requester,
            {
              sourceBaseId: businessBaseA,
              destinationBaseId: businessBaseB,
              equipmentTypeId: businessEquipmentType,
              quantity: 1,
            },
            `business-reject-init-${randomUUID()}`,
          ),
        );
        assertBusinessStatus(rejectedTransfer, 201, "initiateTransfer (rejection case)");
        const rejectedTransferId = rejectedTransfer.body.data.transfer.id;
        const rejection = await invokeBusiness(
          controller.rejectTransfer,
          businessRequest(
            approver,
            {},
            `business-reject-${randomUUID()}`,
            { transferId: rejectedTransferId },
          ),
        );
        assertBusinessStatus(rejection, 200, "rejectTransfer");
        assert.equal(rejection.body.data.transfer.status, "REJECTED");
        const [rejectedMovementCount] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE transfer_id = $1`,
          [rejectedTransferId],
        );
        assert.equal(rejectedMovementCount.movement_count, 0);
        const [rejectionAudit] = await targetAdmin.query(
          `SELECT actor_user_id
           FROM public.audit_log
           WHERE entity_type = 'transfer'
             AND entity_id = $1
             AND action = 'TRANSFER_REJECTED'`,
          [rejectedTransferId],
        );
        assert.equal(rejectionAudit.actor_user_id, businessApprover);

        const insufficientTransfer = await invokeBusiness(
          controller.initiateTransfer,
          businessRequest(
            requester,
            {
              sourceBaseId: businessBaseA,
              destinationBaseId: businessBaseB,
              equipmentTypeId: businessEquipmentType,
              quantity: 7,
            },
            `business-insufficient-init-${randomUUID()}`,
          ),
        );
        assertBusinessStatus(insufficientTransfer, 201, "initiateTransfer (insufficient inventory case)");
        const insufficientTransferId =
          insufficientTransfer.body.data.transfer.id;
        const insufficientApproval = await invokeBusiness(
          controller.approveTransfer,
          businessRequest(
            approver,
            {},
            `business-insufficient-approve-${randomUUID()}`,
            { transferId: insufficientTransferId },
          ),
        );
        assertBusinessStatus(insufficientApproval, 200, "approveTransfer (insufficient inventory case)");
        const insufficientCompletion = await invokeBusiness(
          controller.completeTransfer,
          businessRequest(
            completer,
            {},
            `business-insufficient-complete-${randomUUID()}`,
            { transferId: insufficientTransferId },
          ),
        );
        assertBusinessStatus(insufficientCompletion, 409, "completeTransfer (insufficient inventory case)");
        const [unchangedTransfer] = await targetAdmin.query(
          `SELECT transfer.status,
                  count(movement.id)::integer AS movement_count
           FROM public.transfer transfer
           LEFT JOIN public.inventory_movement movement
             ON movement.transfer_id = transfer.id
           WHERE transfer.id = $1
           GROUP BY transfer.status`,
          [insufficientTransferId],
        );
        assert.equal(unchangedTransfer.status, "APPROVED");
        assert.equal(unchangedTransfer.movement_count, 0);

        const assignmentKey = `business-assignment-${randomUUID()}`;
        const assignmentRequest = businessRequest(
          adminActor,
          {
            assetId: businessAssetA,
            quantity: 2,
            personnelReference: "SYNTHETIC-REF",
          },
          assignmentKey,
        );
        const assignmentResponse = await invokeBusiness(
          controller.createAssignment,
          assignmentRequest,
        );
        assertBusinessStatus(assignmentResponse, 201, "createAssignment");
        const assignmentReplay = await invokeBusiness(
          controller.createAssignment,
          assignmentRequest,
        );
        assertBusinessStatus(assignmentReplay, 201, "createAssignment (replay)");
        assert.deepEqual(assignmentReplay.body, assignmentResponse.body);
        const assignmentId = assignmentResponse.body.data.assignment.id;
        const [assignmentAudit] = await targetAdmin.query(
          `SELECT action, actor_user_id, entity_type, entity_id, base_id,
                  correlation_id, created_at
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'ASSIGNMENT_CREATED'`,
          [assignmentId],
        );
        assert.equal(assignmentAudit.action, "ASSIGNMENT_CREATED");
        assert.equal(assignmentAudit.actor_user_id, adminActor.id);
        assert.equal(assignmentAudit.entity_type, "assignment");
        assert.equal(assignmentAudit.entity_id, assignmentId);
        assert.equal(assignmentAudit.base_id, businessBaseA);
        assert.ok(assignmentAudit.correlation_id);
        assert.ok(assignmentAudit.created_at);
        const [assignmentCounts] = await targetAdmin.query(
          `SELECT
             (SELECT count(*)::integer FROM public.assignment
              WHERE idempotency_key = $1) AS assignments,
             (SELECT count(*)::integer FROM public.inventory_movement
              WHERE assignment_id = $2
                AND movement_type = 'ASSIGNMENT') AS movements,
             (SELECT count(*)::integer FROM public.audit_log
              WHERE action = 'ASSIGNMENT_CREATED'
                AND entity_id = $2) AS audits,
             (SELECT count(*)::integer FROM public.business_idempotency
              WHERE idempotency_key = $1
                AND actor_user_id = $3
                AND operation = 'ASSIGNMENT_CREATE') AS idempotency_records`,
          [assignmentKey, assignmentId, adminActor.id],
        );
        assert.deepEqual(assignmentCounts, {
          assignments: 1,
          movements: 1,
          audits: 1,
          idempotency_records: 1,
        });
        const [assignmentEventTime] = await targetAdmin.query(
          `SELECT assignment.assigned_at = movement.occurred_at AS matches
           FROM public.assignment assignment
           JOIN public.inventory_movement movement
             ON movement.assignment_id = assignment.id
            AND movement.movement_type = 'ASSIGNMENT'
           WHERE assignment.id = $1`,
          [assignmentId],
        );
        assert.equal(assignmentEventTime.matches, true);
        assert.equal(
          Object.hasOwn(assignmentResponse.body.data.assignment, "personnelReference"),
          false,
        );
        const failedAssignmentKey = `business-assignment-audit-failure-${randomUUID()}`;
        const [assignmentAuditsBeforeFailure] = await targetAdmin.query(
          `SELECT count(*)::integer AS audits
           FROM public.audit_log
           WHERE action = 'ASSIGNMENT_CREATED'
             AND actor_user_id = $1`,
          [adminActor.id],
        );
        const failedAssignment = await withSyntheticAuditFailure(
          targetAdmin,
          "ASSIGNMENT_CREATED",
          "*",
          () =>
            invokeBusiness(
              controller.createAssignment,
              businessRequest(
                adminActor,
                {
                  assetId: businessAssetA,
                  quantity: 1,
                  personnelReference: "SYNTHETIC-FAILED-REF",
                },
                failedAssignmentKey,
              ),
            ),
        );
        assertBusinessStatus(
          failedAssignment,
          500,
          "createAssignment (audit failure rollback)",
        );
        assert.ok(
          failedAssignment.databaseErrors.some(
            ({ code, message }) =>
              code === "P0001" &&
              message.includes("synthetic audit failure"),
          ),
          businessResponseDiagnostics(
            "createAssignment (audit failure rollback)",
            failedAssignment,
          ),
        );
        const [failedAssignmentCounts] = await targetAdmin.query(
          `SELECT
             (SELECT count(*)::integer FROM public.assignment
              WHERE idempotency_key = $1) AS assignments,
             (SELECT count(*)::integer FROM public.inventory_movement
              WHERE assignment_id IN (
                SELECT id FROM public.assignment
                WHERE idempotency_key = $1
              )) AS movements,
             (SELECT count(*)::integer FROM public.audit_log
              WHERE action = 'ASSIGNMENT_CREATED'
                AND actor_user_id = $2) AS audits,
             (SELECT count(*)::integer FROM public.business_idempotency
              WHERE idempotency_key = $1
                AND operation = 'ASSIGNMENT_CREATE') AS idempotency_records`,
          [failedAssignmentKey, adminActor.id],
        );
        assert.equal(failedAssignmentCounts.assignments, 0);
        assert.equal(failedAssignmentCounts.movements, 0);
        assert.equal(
          failedAssignmentCounts.audits,
          assignmentAuditsBeforeFailure.audits,
        );
        assert.equal(failedAssignmentCounts.idempotency_records, 0);

        const expenditureResponse = await invokeBusiness(
          controller.recordExpenditure,
          businessRequest(
            adminActor,
            {
              assetId: businessAssetA,
              quantity: 1,
              reasonCode: "SYNTHETIC",
              notes: "synthetic note omitted from audit",
            },
            `business-expenditure-${randomUUID()}`,
          ),
        );
        assertBusinessStatus(expenditureResponse, 201, "recordExpenditure");
        assert.equal(
          Object.hasOwn(expenditureResponse.body.data.expenditure, "notes"),
          false,
        );
        const [expenditureAudit] = await targetAdmin.query(
          `SELECT after_data
           FROM public.audit_log
           WHERE entity_type = 'expenditure'
             AND entity_id = $1`,
          [expenditureResponse.body.data.expenditure.id],
        );
        assert.equal(
          Object.hasOwn(expenditureAudit.after_data, "notes"),
          false,
        );
        const [expenditureEventTime] = await targetAdmin.query(
          `SELECT expenditure.expended_at = movement.occurred_at AS matches
           FROM public.expenditure expenditure
           JOIN public.inventory_movement movement
             ON movement.expenditure_id = expenditure.id
           WHERE expenditure.id = $1`,
          [expenditureResponse.body.data.expenditure.id],
        );
        assert.equal(expenditureEventTime.matches, true);

        const returnKey = `business-return-${randomUUID()}`;
        const returnRequest = businessRequest(
          commander,
          { quantity: 1 },
          returnKey,
          { assignmentId },
        );
        const partialReturn = await invokeBusiness(
          controller.recordReturn,
          returnRequest,
        );
        assertBusinessStatus(partialReturn, 201, "recordReturn");
        const returnReplay = await invokeBusiness(
          controller.recordReturn,
          returnRequest,
        );
        assertBusinessStatus(returnReplay, 201, "recordReturn (replay)");
        assert.deepEqual(returnReplay.body, partialReturn.body);
        assert.equal(
          partialReturn.body.data.return.assignmentStatus,
          "PARTIALLY_RETURNED",
        );
        const returnId = partialReturn.body.data.return.id;
        const [returnAudit] = await targetAdmin.query(
          `SELECT action, actor_user_id, entity_type, entity_id, base_id,
                  correlation_id, created_at, after_data
           FROM public.audit_log
           WHERE entity_id = $1
             AND action = 'ASSIGNMENT_RETURN_RECORDED'`,
          [returnId],
        );
        assert.equal(returnAudit.action, "ASSIGNMENT_RETURN_RECORDED");
        assert.equal(returnAudit.actor_user_id, commander.id);
        assert.equal(returnAudit.entity_type, "return_operation");
        assert.equal(returnAudit.entity_id, returnId);
        assert.equal(returnAudit.base_id, businessBaseA);
        assert.ok(returnAudit.correlation_id);
        assert.ok(returnAudit.created_at);
        assert.equal(returnAudit.after_data.assignmentId, assignmentId);
        const [returnCounts] = await targetAdmin.query(
          `SELECT
             (SELECT count(*)::integer FROM public.return_operation
              WHERE idempotency_key = $1) AS returns,
             (SELECT count(*)::integer FROM public.inventory_movement
              WHERE return_operation_id = $2) AS movements,
             (SELECT count(*)::integer FROM public.audit_log
              WHERE action = 'ASSIGNMENT_RETURN_RECORDED'
                AND entity_id = $2) AS audits,
             (SELECT count(*)::integer FROM public.business_idempotency
              WHERE idempotency_key = $1
                AND actor_user_id = $3
                AND operation = 'ASSIGNMENT_RETURN') AS idempotency_records`,
          [returnKey, returnId, commander.id],
        );
        assert.deepEqual(returnCounts, {
          returns: 1,
          movements: 1,
          audits: 1,
          idempotency_records: 1,
        });
        const [returnMovementCount] = await targetAdmin.query(
          `SELECT count(*)::integer AS movement_count
           FROM public.inventory_movement
           WHERE return_operation_id = $1`,
          [partialReturn.body.data.return.id],
        );
        assert.equal(returnMovementCount.movement_count, 1);
        const [returnEventTime] = await targetAdmin.query(
          `SELECT operation.returned_at = movement.occurred_at AS matches
           FROM public.return_operation operation
           JOIN public.inventory_movement movement
             ON movement.return_operation_id = operation.id
           WHERE operation.id = $1`,
          [partialReturn.body.data.return.id],
        );
        assert.equal(returnEventTime.matches, true);

        const [beforeConcurrentOutflows] = await targetAdmin.query(
          `SELECT opening_balance
                  + COALESCE(sum(
                      CASE direction WHEN 'IN' THEN quantity ELSE -quantity END
                    ), 0)::integer AS balance
           FROM public.asset
           LEFT JOIN public.inventory_movement
             ON inventory_movement.asset_id = asset.id
           WHERE asset.id = $1
           GROUP BY opening_balance`,
          [businessAssetA],
        );
        assert.equal(beforeConcurrentOutflows.balance, 4);
        const outflowRequests = [0, 1].map((index) =>
          invokeBusiness(
            controller.recordExpenditure,
            businessRequest(
              adminActor,
              {
                assetId: businessAssetA,
                quantity: 3,
                reasonCode: "SYNTHETIC-RACE",
                notes: null,
              },
              `business-race-${index}-${randomUUID()}`,
            ),
          ),
        );
        const outflowResults = await Promise.all(outflowRequests);
        assert.deepEqual(
          outflowResults.map((result) => result.statusCode).sort(),
          [201, 409],
          outflowResults
            .map((result) => businessResponseDiagnostics("recordExpenditure", result))
            .join("\n"),
        );
        assert.equal(await getAssetBalance(runtimeQueryRunner, businessAssetA), 1);

        const failedAuditKey = `business-audit-failure-${randomUUID()}`;
        await targetAdmin.query(
          `REVOKE INSERT ON TABLE public.audit_log FROM ${quoteIdentifier(applicationRole)}`,
        );
        let failedAuditResponse;
        try {
          failedAuditResponse = await invokeBusiness(
            controller.createPurchase,
            businessRequest(
              adminActor,
              {
                baseId: businessBaseA,
                equipmentTypeId: businessEquipmentType,
                quantity: 1,
                referenceCode: null,
              },
              failedAuditKey,
            ),
          );
        } finally {
          await targetAdmin.query(
            `GRANT INSERT ON TABLE public.audit_log TO ${quoteIdentifier(applicationRole)}`,
          );
        }
        assertBusinessStatus(failedAuditResponse, 500, "createPurchase (audit rollback case)");
        assert.ok(
          failedAuditResponse.databaseErrors.some(
            ({ code, query }) =>
              code === "42501" &&
              query.includes("INSERT INTO public.audit_log"),
          ),
          businessResponseDiagnostics(
            "createPurchase (audit rollback case)",
            failedAuditResponse,
          ),
        );
        const [rolledBackPurchase] = await targetAdmin.query(
          `SELECT count(*)::integer AS purchase_count
           FROM public.purchase
           WHERE idempotency_key = $1`,
          [failedAuditKey],
        );
        const [rolledBackIdempotency] = await targetAdmin.query(
          `SELECT count(*)::integer AS record_count
           FROM public.business_idempotency
           WHERE idempotency_key = $1`,
          [failedAuditKey],
        );
        assert.equal(rolledBackPurchase.purchase_count, 0);
        assert.equal(rolledBackIdempotency.record_count, 0);

        await targetAdmin.query(
          `UPDATE public.asset SET is_active = false WHERE id = $1`,
          [businessAssetA],
        );
        await targetAdmin.query(
          `UPDATE public.equipment_type
           SET is_active = false
           WHERE id = $1`,
          [businessEquipmentType],
        );
        const inactiveResourceReturn = await invokeBusiness(
          controller.recordReturn,
          businessRequest(
            commander,
            { quantity: 1 },
            `business-inactive-return-${randomUUID()}`,
            { assignmentId },
          ),
        );
        assertBusinessStatus(inactiveResourceReturn, 201, "recordReturn (inactive asset case)");
        assert.equal(
          inactiveResourceReturn.body.data.return.assignmentStatus,
          "RETURNED",
        );
        assert.equal(await getAssetBalance(runtimeQueryRunner, businessAssetA), 2);
      });

      await t.test(
        "inventory operations use one wall-clock timestamp after asset locks",
        async () => {
          const eventBase = randomUUID();
          const beforeOpeningBase = randomUUID();
          const eventEquipment = randomUUID();
          const eventAsset = randomUUID();
          const beforeOpeningAsset = randomUUID();
          const eventSuffix = randomUUID().replaceAll("-", "");
          const actor = {
            id: userA,
            role: "ADMIN",
            baseId: null,
            isActive: true,
          };
          await targetAdmin.query(
            `INSERT INTO public.base (id, code, name)
             VALUES ($1, $2, 'Synthetic Event-Time Boundary Base'),
                    ($3, $4, 'Synthetic Before-Opening Base')`,
            [
              eventBase,
              `EVT-${eventSuffix.slice(0, 8)}`,
              beforeOpeningBase,
              `EVB-${eventSuffix.slice(0, 8)}`,
            ],
          );
          await targetAdmin.query(
            `INSERT INTO public.equipment_type (id, code, name, category)
             VALUES ($1, $2, $3, 'TEST')`,
            [
              eventEquipment,
              `EVT-EQ-${eventSuffix.slice(0, 8)}`,
              `Synthetic Event Equipment ${eventSuffix.slice(0, 8)}`,
            ],
          );
          let [eventAssetRow] = await targetAdmin.query(
            `INSERT INTO public.asset (
               id, base_id, equipment_type_id, opening_balance, opening_at
             ) VALUES (
               $1, $2, $3, 5,
               pg_catalog.clock_timestamp() + interval '1 hour'
             )
             RETURNING opening_at::text AS opening_at`,
            [eventAsset, eventBase, eventEquipment],
          );
          const [beforeOpeningRow] = await targetAdmin.query(
            `INSERT INTO public.asset (
               id, base_id, equipment_type_id, opening_balance, opening_at
             ) VALUES (
               $1, $2, $3, 5,
                 pg_catalog.clock_timestamp() + interval '1 hour'
             )
             RETURNING opening_at::text AS opening_at`,
            [beforeOpeningAsset, beforeOpeningBase, eventEquipment],
          );
          const controller = createBusinessOperationsController({
            dataSource: runtimeDataSource,
          });
          const lockRunner = targetAdmin.createQueryRunner();
          let operationPromise;
          let eventResponse;
          let waitingForAssetLock = false;
          let openingPassed = false;

          inventoryEventObservations.length = 0;
          observedInventoryAssetId = eventAsset;
          try {
            await lockRunner.connect();
            await lockRunner.startTransaction();
            await lockRunner.query(
              `SELECT id FROM public.asset WHERE id = $1 FOR UPDATE`,
              [eventAsset],
            );
            operationPromise = invokeBusinessHandler(
              controller.recordExpenditure,
              businessRequest(
                actor,
                {
                  assetId: eventAsset,
                  quantity: 2,
                  reasonCode: "SYNTHETIC-EVENT-TIME",
                  notes: null,
                },
                `event-time-${eventSuffix}`,
              ),
              runtimeQueryErrors,
              runtimeQueryResults,
            ).then(
              (response) => ({ response }),
              (error) => ({ error }),
            );

            const lockWaitDeadline = Date.now() + 10000;
            while (Date.now() < lockWaitDeadline) {
              const [activity] = await targetAdmin.query(
                `SELECT wait_event_type, query
                 FROM pg_catalog.pg_stat_activity
                 WHERE usename = $1
                   AND datname = $2
                   AND state = 'active'
                   AND query ILIKE '%FROM public.asset%'
                   AND query ILIKE '%FOR UPDATE%'`,
                [runtimeLogin, targetDatabaseName],
              );
              if (activity?.wait_event_type === "Lock") {
                waitingForAssetLock = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.equal(waitingForAssetLock, true);
            const [scheduledAssetRows] = await lockRunner.query(
              `UPDATE public.asset
               SET opening_at = pg_catalog.clock_timestamp() + interval '5 seconds'
               WHERE id = $1
               RETURNING opening_at::text AS opening_at`,
              [eventAsset],
            );
            assert.equal(
              scheduledAssetRows.length,
              1,
              "the locked synthetic asset must receive the scheduled opening time",
            );
            eventAssetRow = scheduledAssetRows[0];
            const [stillBeforeOpening] = await targetAdmin.query(
              `SELECT pg_catalog.clock_timestamp() < $1::timestamptz AS value`,
              [eventAssetRow.opening_at],
            );
            assert.equal(stillBeforeOpening.value, true);

            const openingDeadline = Date.now() + 10000;
            while (Date.now() < openingDeadline) {
              const [clock] = await targetAdmin.query(
                `SELECT pg_catalog.clock_timestamp() >= $1::timestamptz AS value`,
                [eventAssetRow.opening_at],
              );
              if (clock.value) {
                openingPassed = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.equal(openingPassed, true);
            await lockRunner.commitTransaction();

            const { error, response } = await operationPromise;
            assert.equal(error, undefined);
            eventResponse = response;
            assertBusinessStatus(response, 201, "recordExpenditure (opening boundary race)");
          } finally {
            observedInventoryAssetId = undefined;
            if (lockRunner.isTransactionActive) {
              await lockRunner.rollbackTransaction();
            }
            if (operationPromise) await operationPromise;
            await lockRunner.release();
          }

          const captures = inventoryEventObservations.filter(
            (entry) => entry.stage === "capture",
          );
          const balanceChecks = inventoryEventObservations.filter(
            (entry) => entry.stage === "balance",
          );
          const movements = inventoryEventObservations.filter(
            (entry) => entry.stage === "movement",
          );
          assert.equal(captures.length, 1);
          assert.equal(balanceChecks.length, 1);
          assert.equal(movements.length, 1);
          const eventTimestamp = captures[0].eventTimestamp;
          assert.equal(typeof eventTimestamp, "string");
          assert.equal(balanceChecks[0].eventTimestamp, eventTimestamp);
          assert.equal(balanceChecks[0].capturedTimestamp, eventTimestamp);
          assert.equal(movements[0].eventTimestamp, eventTimestamp);
          assert.equal(movements[0].capturedTimestamp, eventTimestamp);

          const [eventLedger] = await targetAdmin.query(
            `SELECT movement.id, movement.expenditure_id,
                    movement.occurred_at = $2::timestamptz AS same_event_time,
                    movement.occurred_at >= asset.opening_at AS at_or_after_opening,
                    movement.occurred_at::text AS occurred_at,
                    asset.opening_at::text AS opening_at
             FROM public.inventory_movement movement
             JOIN public.asset asset ON asset.id = movement.asset_id
             WHERE movement.asset_id = $1
               AND movement.idempotency_key = $3`,
            [eventAsset, eventTimestamp, movements[0].idempotencyKey],
          );
          assert.equal(eventLedger.same_event_time, true);
          assert.equal(eventLedger.at_or_after_opening, true);
          const eventExpenditureId =
            eventResponse.body.data.expenditure.id;
          assert.equal(eventLedger.expenditure_id, eventExpenditureId);

          const [eventAudit] = await targetAdmin.query(
            `SELECT count(*)::integer AS count
             FROM public.audit_log
             WHERE entity_type = 'expenditure'
               AND entity_id = $1
               AND action = 'EXPENDITURE_RECORDED'`,
            [eventExpenditureId],
          );
          const [eventIdempotency] = await targetAdmin.query(
            `SELECT count(*)::integer AS count
             FROM public.business_idempotency
             WHERE idempotency_key = $1
               AND actor_user_id = $2
               AND operation = 'EXPENDITURE_RECORD'
               AND entity_id = $3
               AND http_status = 201`,
            [`event-time-${eventSuffix}`, userA, eventExpenditureId],
          );
          assert.equal(eventAudit.count, 1);
          assert.equal(eventIdempotency.count, 1);
          assert.equal(await getAssetBalance(runtimeQueryRunner, eventAsset), 3);

          const reportController = createReportController({
            dataSource: runtimeDataSource,
          });
          const historicalResponse = makeBusinessResponse();
          await reportController.inventoryMovements(
            {
              currentUser: actor,
              validatedQuery: {
                baseId: eventBase,
                equipmentTypeId: eventEquipment,
                from: eventLedger.opening_at,
                to: eventLedger.occurred_at,
                limit: 100,
                offset: 0,
              },
            },
            historicalResponse,
          );
          assert.equal(historicalResponse.statusCode, 200);
          assert.deepEqual(historicalResponse.body.data.summary, {
            assetPositionCount: 1,
            openingBalance: 0,
            openingBalanceIntroduced: 5,
            purchases: 0,
            transfersIn: 0,
            transfersOut: 0,
            netMovement: 0,
            grossAssigned: 0,
            returned: 0,
            netAssigned: 0,
            expenditureQuantity: 2,
            closingBalance: 3,
          });
          assert.equal(
            historicalResponse.body.data.movements.some(
              (movement) => movement.id === eventLedger.id,
            ),
            true,
          );

          inventoryEventObservations.length = 0;
          observedInventoryAssetId = beforeOpeningAsset;
          let beforeOpeningResponse;
          try {
            beforeOpeningResponse = await invokeBusinessHandler(
              controller.recordExpenditure,
              businessRequest(
                actor,
                {
                  assetId: beforeOpeningAsset,
                  quantity: 1,
                  reasonCode: "SYNTHETIC-BEFORE-OPENING",
                  notes: null,
                },
                `before-opening-${eventSuffix}`,
              ),
              runtimeQueryErrors,
              runtimeQueryResults,
            );
          } finally {
            observedInventoryAssetId = undefined;
          }
          assertBusinessStatus(
            beforeOpeningResponse,
            409,
            "recordExpenditure (before opening)",
          );
          assert.equal(
            beforeOpeningResponse.body.error.code,
            "INSUFFICIENT_STOCK",
          );
          const beforeCaptures = inventoryEventObservations.filter(
            (entry) => entry.stage === "capture",
          );
          const beforeBalances = inventoryEventObservations.filter(
            (entry) => entry.stage === "balance",
          );
          assert.equal(beforeCaptures.length, 1);
          assert.equal(beforeBalances.length, 1);
          assert.equal(
            beforeBalances[0].eventTimestamp,
            beforeCaptures[0].eventTimestamp,
          );
          const [beforeOpeningCheck] = await targetAdmin.query(
            `SELECT $1::timestamptz < $2::timestamptz AS before_opening`,
            [
              beforeCaptures[0].eventTimestamp,
              beforeOpeningRow.opening_at,
            ],
          );
          assert.equal(beforeOpeningCheck.before_opening, true);
          const [beforeOpeningWrites] = await targetAdmin.query(
            `SELECT
               (SELECT count(*)::integer
                FROM public.expenditure
                WHERE idempotency_key = $1) AS expenditures,
               (SELECT count(*)::integer
                FROM public.inventory_movement
                WHERE asset_id = $2) AS movements,
               (SELECT count(*)::integer
                FROM public.audit_log
                WHERE action = 'EXPENDITURE_RECORDED'
                  AND entity_id IN (
                    SELECT id FROM public.expenditure
                    WHERE idempotency_key = $1
                  )) AS audits,
               (SELECT count(*)::integer
                FROM public.business_idempotency
                WHERE idempotency_key = $1) AS idempotency_records`,
            [`before-opening-${eventSuffix}`, beforeOpeningAsset],
          );
          assert.deepEqual(beforeOpeningWrites, {
            expenditures: 0,
            movements: 0,
            audits: 0,
            idempotency_records: 0,
          });
        },
      );
    } finally {
      if (runtimeQueryRunner) {
        if (runtimeQueryRunner.isTransactionActive) {
          await runtimeQueryRunner.rollbackTransaction();
        }
        await runtimeQueryRunner.release();
      }
      if (migrationQueryRunner) {
        await migrationQueryRunner.release();
      }
      if (maintenanceDataSource?.isInitialized) {
        await maintenanceDataSource.destroy();
      }
      if (runtimeDataSource?.isInitialized) {
        await runtimeDataSource.destroy();
      }
      if (targetAdmin?.isInitialized) {
        await targetAdmin.destroy();
      }
      if (databaseCreated) {
        await clusterAdmin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(targetDatabaseName)}`,
        );
      }
      if (roles.length > 0) {
        if (roles.length >= 2) {
          await clusterAdmin.query(
            `REVOKE ${quoteIdentifier(roles[0])} FROM ${quoteIdentifier(roles[1])}`,
          );
        }
        if (roles.length >= 4) {
          await clusterAdmin.query(
            `REVOKE ${quoteIdentifier(roles[3])} FROM ${quoteIdentifier(roles[1])}`,
          );
        }
        for (const role of [...roles].reverse()) {
          await clusterAdmin.query(
            `DROP ROLE IF EXISTS ${quoteIdentifier(role)}`,
          );
        }
      }
      if (clusterAdmin.isInitialized) {
        await clusterAdmin.destroy();
      }
    }
  },
);
