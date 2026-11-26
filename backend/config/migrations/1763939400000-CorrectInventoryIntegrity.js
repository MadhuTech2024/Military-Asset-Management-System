export class CorrectInventoryIntegrity1763939400000 {
  name = "CorrectInventoryIntegrity1763939400000";

  async up(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE app_user
        DROP CONSTRAINT IF EXISTS chk_user_base_scope,
        ADD CONSTRAINT chk_user_base_scope CHECK (
          (role = 'ADMIN' AND base_id IS NULL)
          OR (role = 'BASE_COMMANDER' AND base_id IS NOT NULL)
          OR (role = 'LOGISTICS_OFFICER' AND base_id IS NOT NULL)
        );
    `);

    await queryRunner.query(`
      CREATE TABLE return_operation (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id uuid NOT NULL REFERENCES assignment(id) ON DELETE RESTRICT,
        asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE RESTRICT,
        base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        quantity integer NOT NULL,
        idempotency_key varchar(128) UNIQUE NOT NULL,
        returned_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
        returned_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_return_operation_quantity CHECK (quantity > 0)
      );
      CREATE INDEX idx_return_operation_assignment ON return_operation(assignment_id);
    `);

    await queryRunner.query(`
      ALTER TABLE inventory_movement
        ADD COLUMN return_operation_id uuid REFERENCES return_operation(id) ON DELETE RESTRICT;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_movement_purchase_per_purchase
        ON inventory_movement(purchase_id)
        WHERE movement_type = 'PURCHASE' AND purchase_id IS NOT NULL;

      CREATE UNIQUE INDEX uq_movement_transfer_leg
        ON inventory_movement(transfer_id, movement_type)
        WHERE transfer_id IS NOT NULL
          AND movement_type IN ('TRANSFER_IN', 'TRANSFER_OUT');

      CREATE UNIQUE INDEX uq_movement_assignment_initial
        ON inventory_movement(assignment_id)
        WHERE movement_type = 'ASSIGNMENT' AND assignment_id IS NOT NULL;

      CREATE UNIQUE INDEX uq_movement_expenditure_per_expenditure
        ON inventory_movement(expenditure_id)
        WHERE movement_type = 'EXPENDITURE' AND expenditure_id IS NOT NULL;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION validate_inventory_movement()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        v_asset asset%ROWTYPE;
        v_purchase purchase%ROWTYPE;
        v_transfer transfer%ROWTYPE;
        v_assignment assignment%ROWTYPE;
        v_expenditure expenditure%ROWTYPE;
        v_return_operation return_operation%ROWTYPE;
      BEGIN
        SELECT * INTO v_asset FROM asset WHERE id = NEW.asset_id FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory movement references a missing asset';
        END IF;
        IF NEW.base_id <> v_asset.base_id
          OR NEW.equipment_type_id <> v_asset.equipment_type_id THEN
          RAISE EXCEPTION 'Inventory movement does not match its asset position';
        END IF;

        IF NEW.movement_type = 'PURCHASE' THEN
          SELECT * INTO v_purchase FROM purchase WHERE id = NEW.purchase_id;
          IF NOT FOUND OR v_purchase.status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Purchase movement requires a completed purchase';
          END IF;
          IF NEW.direction <> 'IN'
            OR NEW.base_id <> v_purchase.base_id
            OR NEW.equipment_type_id <> v_purchase.equipment_type_id
            OR NEW.quantity <> v_purchase.quantity THEN
            RAISE EXCEPTION 'Purchase movement is inconsistent with its purchase';
          END IF;
        END IF;

        IF NEW.movement_type IN ('TRANSFER_IN', 'TRANSFER_OUT') THEN
          SELECT * INTO v_transfer FROM transfer WHERE id = NEW.transfer_id;
          IF NOT FOUND OR v_transfer.status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Transfer movement requires a completed transfer';
          END IF;
          IF NEW.equipment_type_id <> v_transfer.equipment_type_id
            OR NEW.quantity <> v_transfer.quantity THEN
            RAISE EXCEPTION 'Transfer movement is inconsistent with its transfer';
          END IF;
          IF NEW.movement_type = 'TRANSFER_OUT'
            AND (NEW.direction <> 'OUT' OR NEW.base_id <> v_transfer.source_base_id) THEN
            RAISE EXCEPTION 'Transfer-out movement does not match source base';
          END IF;
          IF NEW.movement_type = 'TRANSFER_IN'
            AND (NEW.direction <> 'IN' OR NEW.base_id <> v_transfer.destination_base_id) THEN
            RAISE EXCEPTION 'Transfer-in movement does not match destination base';
          END IF;
        END IF;

        IF NEW.movement_type = 'ASSIGNMENT' THEN
          SELECT * INTO v_assignment FROM assignment WHERE id = NEW.assignment_id;
          IF NOT FOUND OR v_assignment.status = 'CANCELLED' THEN
            RAISE EXCEPTION 'Assignment movement requires a valid assignment';
          END IF;
          IF NEW.direction <> 'OUT'
            OR NEW.quantity <> v_assignment.quantity
            OR NEW.base_id <> v_assignment.base_id
            OR NEW.equipment_type_id <> v_assignment.equipment_type_id
            OR NEW.asset_id <> v_assignment.asset_id THEN
            RAISE EXCEPTION 'Assignment movement is inconsistent with its assignment';
          END IF;
        END IF;

        IF NEW.movement_type = 'EXPENDITURE' THEN
          SELECT * INTO v_expenditure FROM expenditure WHERE id = NEW.expenditure_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Expenditure movement requires a valid expenditure';
          END IF;
          IF NEW.direction <> 'OUT'
            OR NEW.quantity <> v_expenditure.quantity
            OR NEW.base_id <> v_expenditure.base_id
            OR NEW.equipment_type_id <> v_expenditure.equipment_type_id
            OR NEW.asset_id <> v_expenditure.asset_id THEN
            RAISE EXCEPTION 'Expenditure movement is inconsistent with its expenditure';
          END IF;
        END IF;

        IF NEW.movement_type = 'RETURN' THEN
          SELECT * INTO v_return_operation
          FROM return_operation WHERE id = NEW.return_operation_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Return movement requires a valid return operation';
          END IF;
          SELECT * INTO v_assignment
          FROM assignment WHERE id = v_return_operation.assignment_id;
          IF NEW.direction <> 'IN'
            OR NEW.quantity <> v_return_operation.quantity
            OR NEW.assignment_id IS DISTINCT FROM v_return_operation.assignment_id
            OR NEW.asset_id <> v_return_operation.asset_id
            OR NEW.base_id <> v_return_operation.base_id
            OR NEW.equipment_type_id <> v_return_operation.equipment_type_id
            OR v_return_operation.asset_id <> v_assignment.asset_id
            OR v_return_operation.base_id <> v_assignment.base_id
            OR v_return_operation.equipment_type_id <> v_assignment.equipment_type_id THEN
            RAISE EXCEPTION 'Return movement is inconsistent with its return operation';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_inventory_movement
      BEFORE INSERT OR UPDATE ON inventory_movement
      FOR EACH ROW EXECUTE FUNCTION validate_inventory_movement();
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION validate_return_operation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        v_assignment assignment%ROWTYPE;
        v_total_returned integer;
      BEGIN
        IF NEW.quantity <= 0 THEN
          RAISE EXCEPTION 'Returned quantity must be positive';
        END IF;

        SELECT * INTO v_assignment
        FROM assignment
        WHERE id = NEW.assignment_id
        FOR UPDATE;

        IF NOT FOUND OR v_assignment.status = 'CANCELLED' THEN
          RAISE EXCEPTION 'Return operation requires a valid assignment';
        END IF;
        IF NEW.asset_id <> v_assignment.asset_id
          OR NEW.base_id <> v_assignment.base_id
          OR NEW.equipment_type_id <> v_assignment.equipment_type_id THEN
          RAISE EXCEPTION 'Return operation does not match its assignment';
        END IF;

        SELECT COALESCE(SUM(quantity), 0) INTO v_total_returned
        FROM return_operation
        WHERE assignment_id = NEW.assignment_id;

        IF v_total_returned + NEW.quantity > v_assignment.quantity THEN
          RAISE EXCEPTION 'Returned quantity exceeds assigned quantity';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_return_operation
      BEFORE INSERT ON return_operation
      FOR EACH ROW EXECUTE FUNCTION validate_return_operation();

      CREATE OR REPLACE FUNCTION process_return_operation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        v_total_returned integer;
      BEGIN
        INSERT INTO inventory_movement (
          asset_id, base_id, equipment_type_id, movement_type, quantity,
          direction, occurred_at, idempotency_key, assignment_id,
          return_operation_id, created_by
        ) VALUES (
          NEW.asset_id, NEW.base_id, NEW.equipment_type_id, 'RETURN', NEW.quantity,
          'IN', NEW.returned_at,
          'return-operation:' || NEW.id::text || ':movement',
          NEW.assignment_id, NEW.id, NEW.returned_by
        );

        SELECT COALESCE(SUM(quantity), 0) INTO v_total_returned
        FROM return_operation
        WHERE assignment_id = NEW.assignment_id;

        UPDATE assignment
        SET returned_quantity = v_total_returned,
            status = CASE
              WHEN v_total_returned = quantity THEN 'RETURNED'
              ELSE 'PARTIALLY_RETURNED'
            END,
            returned_by = NEW.returned_by,
            returned_at = NEW.returned_at,
            updated_at = now()
        WHERE id = NEW.assignment_id;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_process_return_operation
      AFTER INSERT ON return_operation
      FOR EACH ROW EXECUTE FUNCTION process_return_operation();
    `);

    await queryRunner.query(`
      ALTER TABLE inventory_movement
        DROP CONSTRAINT IF EXISTS chk_movement_integrity,
        ADD CONSTRAINT chk_movement_integrity CHECK (
          (movement_type = 'PURCHASE' AND direction = 'IN' AND purchase_id IS NOT NULL
            AND transfer_id IS NULL AND assignment_id IS NULL
            AND expenditure_id IS NULL AND return_operation_id IS NULL)
          OR
          (movement_type IN ('TRANSFER_IN', 'TRANSFER_OUT') AND transfer_id IS NOT NULL
            AND purchase_id IS NULL AND assignment_id IS NULL
            AND expenditure_id IS NULL AND return_operation_id IS NULL
            AND ((movement_type = 'TRANSFER_IN' AND direction = 'IN')
              OR (movement_type = 'TRANSFER_OUT' AND direction = 'OUT')))
          OR
          (movement_type = 'ASSIGNMENT' AND direction = 'OUT' AND assignment_id IS NOT NULL
            AND purchase_id IS NULL AND transfer_id IS NULL
            AND expenditure_id IS NULL AND return_operation_id IS NULL)
          OR
          (movement_type = 'RETURN' AND direction = 'IN' AND assignment_id IS NOT NULL
            AND return_operation_id IS NOT NULL
            AND purchase_id IS NULL AND transfer_id IS NULL AND expenditure_id IS NULL)
          OR
          (movement_type = 'EXPENDITURE' AND direction = 'OUT' AND expenditure_id IS NOT NULL
            AND purchase_id IS NULL AND transfer_id IS NULL
            AND assignment_id IS NULL AND return_operation_id IS NULL)
        );
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_process_return_operation ON return_operation`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_validate_return_operation ON return_operation`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS process_return_operation`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS validate_return_operation`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_validate_inventory_movement ON inventory_movement`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS validate_inventory_movement`);
    await queryRunner.query(`ALTER TABLE inventory_movement DROP COLUMN IF EXISTS return_operation_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS return_operation CASCADE`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_movement_purchase_per_purchase`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_movement_transfer_leg`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_movement_assignment_initial`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_movement_expenditure_per_expenditure`);
    await queryRunner.query(`
      ALTER TABLE app_user
        DROP CONSTRAINT IF EXISTS chk_user_base_scope,
        ADD CONSTRAINT chk_user_base_scope CHECK (
          (role = 'ADMIN' AND base_id IS NULL)
          OR (role = 'BASE_COMMANDER' AND base_id IS NOT NULL)
          OR (role = 'LOGISTICS_OFFICER')
        );
    `);
  }
}
