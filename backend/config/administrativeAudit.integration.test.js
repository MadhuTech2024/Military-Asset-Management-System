import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { createBaseController } from "../controllers/baseController.js";
import { createEquipmentTypeController } from "../controllers/equipmentTypeController.js";
import { createInventoryController } from "../controllers/assetController.js";
import { createUserController } from "../controllers/userController.js";
import { InitialKristallballSchema1763938800000 } from "./migrations/1763938800000-InitialKristallballSchema.js";
import { CorrectInventoryIntegrity1763939400000 } from "./migrations/1763939400000-CorrectInventoryIntegrity.js";
import { FixReturnTriggerCasting1763939500000 } from "./migrations/1763939500000-FixReturnTriggerCasting.js";
import { SanitizeAuditSnapshots1763939600000 } from "./migrations/1763939600000-SanitizeAuditSnapshots.js";
import { HardenTriggerSearchPath1795545540000 } from "./migrations/1795545540000-HardenTriggerSearchPath.js";
import { PreventNegativeInventoryBalance1795551900000 } from "./migrations/1795551900000-PreventNegativeInventoryBalance.js";
import { AddBusinessIdempotency1795552000000 } from "./migrations/1795552000000-AddBusinessIdempotency.js";
import { AlignInventoryBalanceTimeSemantics1795601814000 } from "./migrations/1795601814000-AlignInventoryBalanceTimeSemantics.js";

const isolatedUrl = process.env.KRISTALLBALL_ISOLATED_TEST_DATABASE_URL;

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

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function captureResponse() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test(
  "isolated PostgreSQL keeps administrative mutations atomic with audit writes",
  { skip: !isolatedUrl },
  async () => {
    const clusterUrl = new URL(isolatedUrl);
    if (
      clusterUrl.protocol !== "postgres:" &&
      clusterUrl.protocol !== "postgresql:"
    ) {
      throw new Error("Administrative audit integration requires PostgreSQL.");
    }
    if (
      clusterUrl.hostname !== "127.0.0.1" ||
      !clusterUrl.port ||
      clusterUrl.port === "5432" ||
      clusterUrl.pathname !== "/postgres" ||
      clusterUrl.username !== "postgres" ||
      clusterUrl.password ||
      clusterUrl.search ||
      clusterUrl.hash
    ) {
      throw new Error(
        "Administrative audit integration requires a password-free, non-default loopback URL to the postgres maintenance database.",
      );
    }

    const clusterAdmin = makeDataSource(isolatedUrl);
    let targetAdmin;
    let migrationRunner;
    let targetDatabaseName;
    let databaseCreated = false;
    try {
      await clusterAdmin.initialize();
      const [cluster] = await clusterAdmin.query(
        `SELECT current_database() AS database_name,
                current_setting('data_directory') AS data_directory,
                current_setting('server_version_num') AS version_number,
                session_user::text AS login_role`,
      );
      assert.equal(cluster.database_name, "postgres");
      assert.equal(cluster.login_role, "postgres");
      assert.equal(Math.floor(Number(cluster.version_number) / 10000), 18);
      assert.match(
        cluster.data_directory.toLowerCase(),
        /kristallball-step1-pg-/,
        "administrative audit tests require the dedicated disposable PostgreSQL cluster",
      );

      targetDatabaseName = `step1_admin_audit_${randomUUID().replaceAll("-", "")}`;
      await clusterAdmin.query(
        `CREATE DATABASE ${quoteIdentifier(targetDatabaseName)} OWNER postgres`,
      );
      databaseCreated = true;
      const targetUrl = new URL(isolatedUrl);
      targetUrl.pathname = `/${targetDatabaseName}`;
      targetAdmin = makeDataSource(targetUrl.toString());
      await targetAdmin.initialize();

      migrationRunner = targetAdmin.createQueryRunner();
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

      const actorId = randomUUID();
      const existingBaseId = randomUUID();
      const userBaseId = randomUUID();
      const statusBaseId = randomUUID();
      const existingEquipmentTypeId = randomUUID();
      const existingUserId = randomUUID();
      await targetAdmin.query(
        `INSERT INTO public.base (id, code, name)
         VALUES ($1, 'SYN-AUDIT-BASE', 'Synthetic Audit Base')`,
        [existingBaseId],
      );
      await targetAdmin.query(
        `INSERT INTO public.base (id, code, name)
         VALUES ($1, 'SYN-AUDIT-USER-BASE', 'Synthetic Audit User Base')`,
        [userBaseId],
      );
      await targetAdmin.query(
        `INSERT INTO public.base (id, code, name)
         VALUES ($1, 'SYN-AUDIT-STATUS-BASE', 'Synthetic Audit Status Base')`,
        [statusBaseId],
      );
      await targetAdmin.query(
        `INSERT INTO public.equipment_type (id, code, name, category)
         VALUES ($1, 'SYN-AUDIT-EQ', 'Synthetic Audit Equipment', 'Synthetic')`,
        [existingEquipmentTypeId],
      );
      await targetAdmin.query(
        `INSERT INTO public.app_user
           (id, email, password_hash, full_name, role)
         VALUES ($1, 'audit-admin@example.test', 'synthetic-hash', 'Synthetic Admin', 'ADMIN')`,
        [actorId],
      );
      await targetAdmin.query(
        `INSERT INTO public.app_user
           (id, email, password_hash, full_name, role, base_id)
         VALUES (
           $1, 'audit-user@example.test', 'synthetic-hash',
           'Synthetic User', 'LOGISTICS_OFFICER', $2
         )`,
        [existingUserId, userBaseId],
      );

      const userController = createUserController({
        dataSource: targetAdmin,
        passwordHasher: {
          async hash() {
            return "synthetic-hash";
          },
        },
      });
      const baseController = createBaseController({ dataSource: targetAdmin });
      const equipmentTypeController = createEquipmentTypeController({
        dataSource: targetAdmin,
      });
      const inventoryController = createInventoryController({
        dataSource: targetAdmin,
      });
      const actorRequest = { currentUser: { id: actorId } };

      const createdUserResponse = captureResponse();
      await userController.create(
        {
          ...actorRequest,
          validatedBody: {
            email: "created-audit-user@example.test",
            name: "Synthetic Created User",
            password: "synthetic-password-value",
            role: "LOGISTICS_OFFICER",
            baseId: userBaseId,
          },
        },
        createdUserResponse,
      );
      assert.equal(createdUserResponse.statusCode, 201);

      const updatedUserResponse = captureResponse();
      await userController.update(
        {
          ...actorRequest,
          params: { id: existingUserId },
          validatedBody: {
            name: "Synthetic Updated User",
            role: "BASE_COMMANDER",
            baseId: existingBaseId,
          },
        },
        updatedUserResponse,
      );
      assert.equal(updatedUserResponse.statusCode, 200);

      for (const isActive of [false, true]) {
        const userStatusResponse = captureResponse();
        await userController.setActive(
          {
            ...actorRequest,
            params: { id: existingUserId },
            validatedBody: { isActive },
          },
          userStatusResponse,
        );
        assert.equal(userStatusResponse.statusCode, 200);
        assert.equal(userStatusResponse.body.data.user.isActive, isActive);
      }

      const createdBaseResponse = captureResponse();
      await baseController.create(
        {
          ...actorRequest,
          validatedBody: {
            code: "SYN-AUDIT-NEW",
            name: "Synthetic Created Base",
            locationName: "Synthetic Location",
          },
        },
        createdBaseResponse,
      );
      assert.equal(createdBaseResponse.statusCode, 201);

      const updatedBaseResponse = captureResponse();
      await baseController.update(
        {
          ...actorRequest,
          params: { id: createdBaseResponse.body.data.base.id },
          validatedBody: {
            name: "Synthetic Updated Base",
            locationName: "Synthetic Updated Location",
          },
        },
        updatedBaseResponse,
      );
      assert.equal(updatedBaseResponse.statusCode, 200);

      for (const isActive of [false, true]) {
        const baseStatusResponse = captureResponse();
        await baseController.setActive(
          {
            ...actorRequest,
            params: { id: createdBaseResponse.body.data.base.id },
            validatedBody: { isActive },
          },
          baseStatusResponse,
        );
        assert.equal(baseStatusResponse.statusCode, 200);
        assert.equal(baseStatusResponse.body.data.base.isActive, isActive);
      }

      const createdEquipmentResponse = captureResponse();
      await equipmentTypeController.create(
        {
          ...actorRequest,
          validatedBody: {
            code: "SYN-AUDIT-NEW-EQ",
            name: "Synthetic Created Equipment",
            category: "Synthetic Category",
            description: "Synthetic description must not be audited",
          },
        },
        createdEquipmentResponse,
      );
      assert.equal(createdEquipmentResponse.statusCode, 201);

      const updatedEquipmentResponse = captureResponse();
      await equipmentTypeController.update(
        {
          ...actorRequest,
          params: { id: createdEquipmentResponse.body.data.equipmentType.id },
          validatedBody: {
            name: "Synthetic Updated Equipment",
            category: "Synthetic Updated Category",
          },
        },
        updatedEquipmentResponse,
      );
      assert.equal(updatedEquipmentResponse.statusCode, 200);

      for (const isActive of [false, true]) {
        const equipmentStatusResponse = captureResponse();
        await equipmentTypeController.setActive(
          {
            ...actorRequest,
            params: { id: createdEquipmentResponse.body.data.equipmentType.id },
            validatedBody: { isActive },
          },
          equipmentStatusResponse,
        );
        assert.equal(equipmentStatusResponse.statusCode, 200);
        assert.equal(
          equipmentStatusResponse.body.data.equipmentType.isActive,
          isActive,
        );
      }

      const searchedUsers = captureResponse();
      await userController.list(
        {
          validatedQuery: {
            limit: 50,
            offset: 0,
            search: "created-audit-user",
            role: null,
            isActive: true,
          },
        },
        searchedUsers,
      );
      assert.equal(searchedUsers.statusCode, 200);
      assert.equal(searchedUsers.body.meta.total, 1);
      assert.equal(
        searchedUsers.body.data.users[0].email,
        "created-audit-user@example.test",
      );

      const searchedBases = captureResponse();
      await baseController.list(
        {
          authorizedBaseId: null,
          validatedQuery: {
            limit: 50,
            offset: 0,
            search: "SYN-AUDIT-NEW",
            isActive: null,
          },
        },
        searchedBases,
      );
      assert.equal(searchedBases.statusCode, 200);
      assert.equal(searchedBases.body.meta.total, 1);
      assert.equal(searchedBases.body.data.bases[0].code, "SYN-AUDIT-NEW");

      const searchedEquipmentTypes = captureResponse();
      await equipmentTypeController.list(
        {
          validatedQuery: {
            limit: 50,
            offset: 0,
            search: "synthetic updated equipment",
            isActive: true,
          },
        },
        searchedEquipmentTypes,
      );
      assert.equal(searchedEquipmentTypes.statusCode, 200);
      assert.equal(searchedEquipmentTypes.body.meta.total, 1);
      assert.equal(
        searchedEquipmentTypes.body.data.equipmentTypes[0].name,
        "Synthetic Updated Equipment",
      );
      assert.equal(
        searchedEquipmentTypes.body.data.equipmentTypes[0].code,
        "SYN-AUDIT-NEW-EQ",
      );

      const openingStockResponse = captureResponse();
      await inventoryController.createOpeningStock(
        {
          ...actorRequest,
          validatedBody: {
            baseId: existingBaseId,
            equipmentTypeId: existingEquipmentTypeId,
            openingBalance: 23,
          },
        },
        openingStockResponse,
      );
      assert.equal(openingStockResponse.statusCode, 201);
      assert.equal(
        openingStockResponse.body.data.openingStock.openingBalance,
        23,
      );
      assert.ok(openingStockResponse.body.data.openingStock.openingAt);

      const inventoryListResponse = captureResponse();
      await inventoryController.list(
        {
          authorizedBaseId: null,
          validatedQuery: {
            baseId: existingBaseId,
            equipmentTypeId: existingEquipmentTypeId,
            limit: 50,
            offset: 0,
          },
        },
        inventoryListResponse,
      );
      assert.equal(inventoryListResponse.statusCode, 200);
      assert.equal(inventoryListResponse.body.meta.total, 1);
      assert.equal(
        inventoryListResponse.body.data.inventory[0].openingBalance,
        23,
      );

      const duplicateOpeningStockResponse = captureResponse();
      await inventoryController.createOpeningStock(
        {
          ...actorRequest,
          validatedBody: {
            baseId: existingBaseId,
            equipmentTypeId: existingEquipmentTypeId,
            openingBalance: 99,
          },
        },
        duplicateOpeningStockResponse,
      );
      assert.equal(duplicateOpeningStockResponse.statusCode, 409);

      const successfulEvents = await targetAdmin.query(
        `SELECT action, entity_type, entity_id, correlation_id, base_id,
                created_at, before_data, after_data
         FROM public.audit_log
         WHERE actor_user_id = $1
         ORDER BY action`,
        [actorId],
      );
      assert.equal(successfulEvents.length, 13);
      for (const action of [
        "USER_CREATED",
        "USER_UPDATED",
        "USER_ACTIVATED",
        "USER_DEACTIVATED",
        "BASE_CREATED",
        "BASE_UPDATED",
        "BASE_ACTIVATED",
        "BASE_DEACTIVATED",
        "EQUIPMENT_TYPE_CREATED",
        "EQUIPMENT_TYPE_UPDATED",
        "EQUIPMENT_TYPE_ACTIVATED",
        "EQUIPMENT_TYPE_DEACTIVATED",
        "OPENING_STOCK_CREATED",
      ]) {
        assert.equal(
          successfulEvents.filter((event) => event.action === action).length,
          1,
          `${action} must be recorded exactly once`,
        );
      }
      const createdUserEvent = successfulEvents.find(
        ({ action }) => action === "USER_CREATED",
      );
      const updatedUserEvent = successfulEvents.find(
        ({ action }) => action === "USER_UPDATED",
      );
      const createdBaseEvent = successfulEvents.find(
        ({ action }) => action === "BASE_CREATED",
      );
      const updatedBaseEvent = successfulEvents.find(
        ({ action }) => action === "BASE_UPDATED",
      );
      const deactivatedBaseEvent = successfulEvents.find(
        ({ action }) => action === "BASE_DEACTIVATED",
      );
      const createdEquipmentEvent = successfulEvents.find(
        ({ action }) => action === "EQUIPMENT_TYPE_CREATED",
      );
      const updatedEquipmentEvent = successfulEvents.find(
        ({ action }) => action === "EQUIPMENT_TYPE_UPDATED",
      );
      const openingStockEvent = successfulEvents.find(
        ({ action }) => action === "OPENING_STOCK_CREATED",
      );
      assert.ok(createdUserEvent.correlation_id);
      assert.ok(successfulEvents.every((event) => event.correlation_id));
      assert.ok(successfulEvents.every((event) => event.created_at));
      assert.equal(createdUserEvent.entity_type, "user");
      assert.equal(createdUserEvent.base_id, userBaseId);
      assert.equal(createdUserEvent.after_data.role, "LOGISTICS_OFFICER");
      assert.equal("email" in createdUserEvent.after_data, false);
      assert.equal("password" in createdUserEvent.after_data, false);
      assert.equal(updatedUserEvent.entity_type, "user");
      assert.equal(updatedUserEvent.base_id, existingBaseId);
      assert.equal(updatedUserEvent.after_data.role, "BASE_COMMANDER");
      assert.equal(updatedUserEvent.after_data.baseId, existingBaseId);
      assert.deepEqual(
        updatedUserEvent.after_data.changedFields.sort(),
        ["baseId", "name", "role"],
      );
      assert.equal("email" in updatedUserEvent.after_data, false);
      assert.equal(
        JSON.stringify(updatedUserEvent).includes("Synthetic Updated User"),
        false,
      );
      assert.equal(createdBaseEvent.entity_type, "base");
      assert.equal(createdBaseEvent.base_id, createdBaseResponse.body.data.base.id);
      assert.equal(updatedBaseEvent.entity_type, "base");
      assert.equal(updatedBaseEvent.base_id, createdBaseResponse.body.data.base.id);
      assert.equal(deactivatedBaseEvent.entity_type, "base");
      assert.equal(createdEquipmentEvent.entity_type, "equipment_type");
      assert.equal("description" in createdEquipmentEvent.after_data, false);
      assert.equal(updatedEquipmentEvent.entity_type, "equipment_type");
      assert.equal(openingStockEvent.entity_type, "asset");
      assert.equal(openingStockEvent.base_id, existingBaseId);
      assert.equal(openingStockEvent.after_data.openingBalance, 23);

      await targetAdmin.query(`
        CREATE FUNCTION public.reject_test_audit_log_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'injected audit insert failure';
        END;
        $$;
        CREATE TRIGGER trg_test_reject_audit_log_insert
        BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.reject_test_audit_log_insert();
      `);

      const failedUserCreate = captureResponse();
      await userController.create(
        {
          ...actorRequest,
          validatedBody: {
            email: "rolled-back-audit-user@example.test",
            name: "Synthetic Rolled Back User",
            password: "synthetic-password-value",
            role: "LOGISTICS_OFFICER",
            baseId: userBaseId,
          },
        },
        failedUserCreate,
      );
      assert.equal(failedUserCreate.statusCode, 500);

      const failedBaseCreate = captureResponse();
      await baseController.create(
        {
          ...actorRequest,
          validatedBody: {
            code: "SYN-AUDIT-ROLLBACK",
            name: "Synthetic Rolled Back Base",
          },
        },
        failedBaseCreate,
      );
      assert.equal(failedBaseCreate.statusCode, 500);

      const failedEquipmentCreate = captureResponse();
      await equipmentTypeController.create(
        {
          ...actorRequest,
          validatedBody: {
            code: "SYN-AUDIT-ROLLBACK-EQ",
            name: "Synthetic Rolled Back Equipment",
            category: "Synthetic",
          },
        },
        failedEquipmentCreate,
      );
      assert.equal(failedEquipmentCreate.statusCode, 500);

      const failedUserUpdate = captureResponse();
      await userController.update(
        {
          ...actorRequest,
          params: { id: existingUserId },
          validatedBody: { name: "Synthetic Failed Update" },
        },
        failedUserUpdate,
      );
      assert.equal(failedUserUpdate.statusCode, 500);

      const failedBaseUpdate = captureResponse();
      await baseController.update(
        {
          ...actorRequest,
          params: { id: existingBaseId },
          validatedBody: { name: "Synthetic Failed Base Update" },
        },
        failedBaseUpdate,
      );
      assert.equal(failedBaseUpdate.statusCode, 500);

      const failedEquipmentUpdate = captureResponse();
      await equipmentTypeController.update(
        {
          ...actorRequest,
          params: { id: existingEquipmentTypeId },
          validatedBody: { name: "Synthetic Failed Equipment Update" },
        },
        failedEquipmentUpdate,
      );
      assert.equal(failedEquipmentUpdate.statusCode, 500);

      const failedUserStatus = captureResponse();
      await userController.setActive(
        {
          ...actorRequest,
          params: { id: existingUserId },
          validatedBody: { isActive: false },
        },
        failedUserStatus,
      );
      assert.equal(failedUserStatus.statusCode, 500);

      const failedBaseStatus = captureResponse();
      await baseController.setActive(
        {
          ...actorRequest,
          params: { id: statusBaseId },
          validatedBody: { isActive: false },
        },
        failedBaseStatus,
      );
      assert.equal(failedBaseStatus.statusCode, 500);

      const failedEquipmentStatus = captureResponse();
      await equipmentTypeController.setActive(
        {
          ...actorRequest,
          params: { id: existingEquipmentTypeId },
          validatedBody: { isActive: false },
        },
        failedEquipmentStatus,
      );
      assert.equal(failedEquipmentStatus.statusCode, 500);

      const failedOpeningStock = captureResponse();
      await inventoryController.createOpeningStock(
        {
          ...actorRequest,
          validatedBody: {
            baseId: userBaseId,
            equipmentTypeId: existingEquipmentTypeId,
            openingBalance: 31,
          },
        },
        failedOpeningStock,
      );
      assert.equal(
        failedOpeningStock.statusCode,
        500,
        JSON.stringify(failedOpeningStock.body),
      );

      const [rolledBack] = await targetAdmin.query(
        `SELECT
           (SELECT count(*) FROM public.app_user
            WHERE email = 'rolled-back-audit-user@example.test') AS user_count,
           (SELECT count(*) FROM public.base
            WHERE code = 'SYN-AUDIT-ROLLBACK') AS base_count,
           (SELECT count(*) FROM public.equipment_type
            WHERE code = 'SYN-AUDIT-ROLLBACK-EQ') AS equipment_type_count,
           (SELECT full_name FROM public.app_user WHERE id = $1) AS user_name,
           (SELECT name FROM public.base WHERE id = $2) AS base_name,
           (SELECT name FROM public.equipment_type WHERE id = $3) AS equipment_type_name,
           (SELECT is_active FROM public.app_user WHERE id = $1) AS user_active,
           (SELECT is_active FROM public.base WHERE id = $2) AS base_active,
           (SELECT is_active FROM public.equipment_type WHERE id = $3)
             AS equipment_type_active,
           (SELECT count(*) FROM public.audit_log WHERE actor_user_id = $4)
             AS audit_count,
           (SELECT count(*) FROM public.asset
            WHERE base_id = $5 AND equipment_type_id = $6) AS opening_asset_count`,
        [
          existingUserId,
          statusBaseId,
          existingEquipmentTypeId,
          actorId,
          userBaseId,
          existingEquipmentTypeId,
        ],
      );
      assert.equal(Number(rolledBack.user_count), 0);
      assert.equal(Number(rolledBack.base_count), 0);
      assert.equal(Number(rolledBack.equipment_type_count), 0);
      assert.equal(rolledBack.user_name, "Synthetic Updated User");
      assert.equal(rolledBack.base_name, "Synthetic Audit Status Base");
      assert.equal(rolledBack.equipment_type_name, "Synthetic Audit Equipment");
      assert.equal(rolledBack.user_active, true);
      assert.equal(rolledBack.base_active, true);
      assert.equal(rolledBack.equipment_type_active, true);
      assert.equal(Number(rolledBack.audit_count), 13);
      assert.equal(Number(rolledBack.opening_asset_count), 0);
    } finally {
      if (migrationRunner) {
        await migrationRunner.release();
      }
      if (targetAdmin?.isInitialized) {
        await targetAdmin.destroy();
      }
      if (databaseCreated && clusterAdmin.isInitialized) {
        await clusterAdmin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(targetDatabaseName)} WITH (FORCE)`,
        );
      }
      if (clusterAdmin.isInitialized) {
        await clusterAdmin.destroy();
      }
    }
  },
);
