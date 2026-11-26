export class FixReturnTriggerCasting1763939500000 {
  name = "FixReturnTriggerCasting1763939500000";

  async up(queryRunner) {
    await queryRunner.query(`
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
              WHEN v_total_returned = quantity THEN 'RETURNED'::assignment_status
              ELSE 'PARTIALLY_RETURNED'::assignment_status
            END,
            returned_by = NEW.returned_by,
            returned_at = NEW.returned_at,
            updated_at = now()
        WHERE id = NEW.assignment_id;

        RETURN NEW;
      END;
      $$;
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`CREATE OR REPLACE FUNCTION process_return_operation()
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
        FROM return_operation WHERE assignment_id = NEW.assignment_id;
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
      $$`);
  }
}
