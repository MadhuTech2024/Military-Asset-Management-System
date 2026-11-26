const TRIGGER_SEARCH_PATH = "pg_catalog, public, pg_temp";

export class HardenTriggerSearchPath1795545540000 {
  name = "HardenTriggerSearchPath1795545540000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.prevent_append_only_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = ${TRIGGER_SEARCH_PATH}
      AS $$
      BEGIN
        RAISE EXCEPTION 'Append-only table records cannot be updated or deleted';
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.validate_inventory_movement()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = ${TRIGGER_SEARCH_PATH}
      AS $$
      DECLARE
        v_asset public.asset%ROWTYPE;
        v_purchase public.purchase%ROWTYPE;
        v_transfer public.transfer%ROWTYPE;
        v_assignment public.assignment%ROWTYPE;
        v_expenditure public.expenditure%ROWTYPE;
        v_return_operation public.return_operation%ROWTYPE;
      BEGIN
        SELECT * INTO v_asset
        FROM public.asset
        WHERE id = NEW.asset_id
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory movement references a missing asset';
        END IF;
        IF NEW.base_id <> v_asset.base_id
          OR NEW.equipment_type_id <> v_asset.equipment_type_id THEN
          RAISE EXCEPTION 'Inventory movement does not match its asset position';
        END IF;

        IF NEW.movement_type = 'PURCHASE' THEN
          SELECT * INTO v_purchase
          FROM public.purchase
          WHERE id = NEW.purchase_id;
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
          SELECT * INTO v_transfer
          FROM public.transfer
          WHERE id = NEW.transfer_id;
          IF NOT FOUND OR v_transfer.status <> 'COMPLETED' THEN
            RAISE EXCEPTION 'Transfer movement requires a completed transfer';
          END IF;
          IF NEW.equipment_type_id <> v_transfer.equipment_type_id
            OR NEW.quantity <> v_transfer.quantity THEN
            RAISE EXCEPTION 'Transfer movement is inconsistent with its transfer';
          END IF;
          IF NEW.movement_type = 'TRANSFER_OUT'
            AND (NEW.direction <> 'OUT'
              OR NEW.base_id <> v_transfer.source_base_id) THEN
            RAISE EXCEPTION 'Transfer-out movement does not match source base';
          END IF;
          IF NEW.movement_type = 'TRANSFER_IN'
            AND (NEW.direction <> 'IN'
              OR NEW.base_id <> v_transfer.destination_base_id) THEN
            RAISE EXCEPTION 'Transfer-in movement does not match destination base';
          END IF;
        END IF;

        IF NEW.movement_type = 'ASSIGNMENT' THEN
          SELECT * INTO v_assignment
          FROM public.assignment
          WHERE id = NEW.assignment_id;
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
          SELECT * INTO v_expenditure
          FROM public.expenditure
          WHERE id = NEW.expenditure_id;
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
          FROM public.return_operation
          WHERE id = NEW.return_operation_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Return movement requires a valid return operation';
          END IF;
          SELECT * INTO v_assignment
          FROM public.assignment
          WHERE id = v_return_operation.assignment_id;
          IF NEW.direction <> 'IN'
            OR NEW.quantity <> v_return_operation.quantity
            OR NEW.assignment_id IS DISTINCT FROM v_return_operation.assignment_id
            OR NEW.asset_id <> v_return_operation.asset_id
            OR NEW.base_id <> v_return_operation.base_id
            OR NEW.equipment_type_id <> v_return_operation.equipment_type_id
            OR v_return_operation.asset_id <> v_assignment.asset_id
            OR v_return_operation.base_id <> v_assignment.base_id
            OR v_return_operation.equipment_type_id
              <> v_assignment.equipment_type_id THEN
            RAISE EXCEPTION 'Return movement is inconsistent with its return operation';
          END IF;
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.validate_return_operation()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = ${TRIGGER_SEARCH_PATH}
      AS $$
      DECLARE
        v_assignment public.assignment%ROWTYPE;
        v_total_returned integer;
      BEGIN
        IF NEW.quantity <= 0 THEN
          RAISE EXCEPTION 'Returned quantity must be positive';
        END IF;

        SELECT * INTO v_assignment
        FROM public.assignment
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

        SELECT COALESCE(pg_catalog.sum(quantity), 0)
        INTO v_total_returned
        FROM public.return_operation
        WHERE assignment_id = NEW.assignment_id;

        IF v_total_returned + NEW.quantity > v_assignment.quantity THEN
          RAISE EXCEPTION 'Returned quantity exceeds assigned quantity';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.process_return_operation()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = ${TRIGGER_SEARCH_PATH}
      AS $$
      DECLARE
        v_total_returned integer;
      BEGIN
        INSERT INTO public.inventory_movement (
          asset_id, base_id, equipment_type_id, movement_type, quantity,
          direction, occurred_at, idempotency_key, assignment_id,
          return_operation_id, created_by
        ) VALUES (
          NEW.asset_id, NEW.base_id, NEW.equipment_type_id, 'RETURN', NEW.quantity,
          'IN', NEW.returned_at,
          'return-operation:' || NEW.id::text || ':movement',
          NEW.assignment_id, NEW.id, NEW.returned_by
        );

        SELECT COALESCE(pg_catalog.sum(quantity), 0)
        INTO v_total_returned
        FROM public.return_operation
        WHERE assignment_id = NEW.assignment_id;

        UPDATE public.assignment
        SET returned_quantity = v_total_returned,
            status = CASE
              WHEN v_total_returned = quantity
                THEN 'RETURNED'::public.assignment_status
              ELSE 'PARTIALLY_RETURNED'::public.assignment_status
            END,
            returned_by = NEW.returned_by,
            returned_at = NEW.returned_at,
            updated_at = pg_catalog.now()
        WHERE id = NEW.assignment_id;

        RETURN NEW;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.sanitize_audit_json(value jsonb)
      RETURNS jsonb
      LANGUAGE plpgsql
      IMMUTABLE
      SECURITY INVOKER
      SET search_path = ${TRIGGER_SEARCH_PATH}
      AS $$
      DECLARE
        result jsonb := '{}'::jsonb;
        element jsonb;
        key text;
        normalized text;
        is_sensitive boolean;
      BEGIN
        IF value IS NULL THEN
          RETURN NULL;
        END IF;
        IF pg_catalog.jsonb_typeof(value) = 'array' THEN
          result := '[]'::jsonb;
          FOR element IN
            SELECT item.value
            FROM pg_catalog.jsonb_array_elements(value) AS item(value)
          LOOP
            result := result || public.sanitize_audit_json(element);
          END LOOP;
          RETURN result;
        END IF;
        IF pg_catalog.jsonb_typeof(value) <> 'object' THEN
          RETURN value;
        END IF;

        FOR key IN SELECT pg_catalog.jsonb_object_keys(value)
        LOOP
          normalized := pg_catalog.lower(
            pg_catalog.regexp_replace(
              key, '[^a-zA-Z0-9]', '', 'g'
            )
          );
          is_sensitive :=
            normalized IN (
              'password','passwordhash','passwd','token','accesstoken',
              'refreshtoken','jwt','jwttoken','secret','authorization',
              'cookie','apikey','apisecret','credential','credentials'
            )
            OR normalized LIKE '%password%'
            OR normalized LIKE '%passwd%'
            OR normalized LIKE '%token%'
            OR normalized LIKE '%secret%'
            OR normalized LIKE '%authorization%'
            OR normalized LIKE '%cookie%'
            OR normalized LIKE '%apikey%'
            OR normalized LIKE '%credential%';

          IF NOT is_sensitive THEN
            result := pg_catalog.jsonb_set(
              result,
              ARRAY[key],
              public.sanitize_audit_json(value -> key),
              true
            );
          END IF;
        END LOOP;
        RETURN result;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.sanitize_audit_log_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = ${TRIGGER_SEARCH_PATH}
      AS $$
      BEGIN
        NEW.before_data := public.sanitize_audit_json(NEW.before_data);
        NEW.after_data := public.sanitize_audit_json(NEW.after_data);
        NEW.ip_address := NEW.ip_address;
        NEW.user_agent := CASE
          WHEN NEW.user_agent IS NULL THEN NULL
          ELSE pg_catalog.substr(NEW.user_agent, 1, 512)
        END;
        RETURN NEW;
      END;
      $$;
    `);
  }

  async down() {
    throw new Error(
      "This security migration is forward-only; reverting would restore unsafe trigger-function resolution.",
    );
  }
}
