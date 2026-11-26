export class AlignInventoryBalanceTimeSemantics1795601814000 {
  name = "AlignInventoryBalanceTimeSemantics1795601814000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.validate_inventory_balance()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
      DECLARE
        v_opening_balance integer;
        v_current_balance numeric;
        v_projected_balance numeric;
      BEGIN
        IF NEW.occurred_at > pg_catalog.clock_timestamp() THEN
          RAISE EXCEPTION 'Inventory movement cannot be future-dated';
        END IF;

        SELECT CASE
                 WHEN asset.opening_at <= NEW.occurred_at
                 THEN asset.opening_balance
                 ELSE 0
               END
        INTO v_opening_balance
        FROM public.asset asset
        WHERE asset.id = NEW.asset_id
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory movement references a missing asset';
        END IF;

        SELECT COALESCE(
          pg_catalog.sum(
            CASE movement.direction
              WHEN 'IN' THEN movement.quantity::numeric
              ELSE -movement.quantity::numeric
            END
          ),
          0
        )
        INTO v_current_balance
        FROM public.inventory_movement movement
        WHERE movement.asset_id = NEW.asset_id
          AND movement.occurred_at <= NEW.occurred_at;

        v_projected_balance :=
          v_opening_balance
          + v_current_balance
          + CASE NEW.direction
              WHEN 'IN' THEN NEW.quantity::numeric
              ELSE -NEW.quantity::numeric
            END;

        IF v_projected_balance < 0 THEN
          RAISE EXCEPTION 'Inventory movement would make asset balance negative';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION public.validate_inventory_balance()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = pg_catalog, public, pg_temp
      AS $$
      DECLARE
        v_opening_balance integer;
        v_current_balance numeric;
        v_projected_balance numeric;
      BEGIN
        SELECT asset.opening_balance
        INTO v_opening_balance
        FROM public.asset asset
        WHERE asset.id = NEW.asset_id
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Inventory movement references a missing asset';
        END IF;

        SELECT COALESCE(
          pg_catalog.sum(
            CASE movement.direction
              WHEN 'IN' THEN movement.quantity::numeric
              ELSE -movement.quantity::numeric
            END
          ),
          0
        )
        INTO v_current_balance
        FROM public.inventory_movement movement
        WHERE movement.asset_id = NEW.asset_id;

        v_projected_balance :=
          v_opening_balance
          + v_current_balance
          + CASE NEW.direction
              WHEN 'IN' THEN NEW.quantity::numeric
              ELSE -NEW.quantity::numeric
            END;

        IF v_projected_balance < 0 THEN
          RAISE EXCEPTION 'Inventory movement would make asset balance negative';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
  }
}
