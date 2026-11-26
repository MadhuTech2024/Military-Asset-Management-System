export class InitialKristallballSchema1763938800000 {
  name = "InitialKristallballSchema1763938800000";

  async up(queryRunner) {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await queryRunner.query(`CREATE TYPE user_role AS ENUM ('ADMIN', 'BASE_COMMANDER', 'LOGISTICS_OFFICER')`);
    await queryRunner.query(`CREATE TYPE purchase_status AS ENUM ('PENDING', 'COMPLETED', 'REJECTED')`);
    await queryRunner.query(`CREATE TYPE transfer_status AS ENUM ('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED')`);
    await queryRunner.query(`CREATE TYPE assignment_status AS ENUM ('ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED', 'CANCELLED')`);
    await queryRunner.query(`CREATE TYPE movement_type AS ENUM ('PURCHASE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ASSIGNMENT', 'RETURN', 'EXPENDITURE')`);
    await queryRunner.query(`CREATE TYPE movement_direction AS ENUM ('IN', 'OUT')`);

    await queryRunner.query(`
      CREATE TABLE base (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) UNIQUE NOT NULL,
        name varchar(128) UNIQUE NOT NULL,
        location_name varchar(128),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_base_active ON base(is_active);

      CREATE TABLE equipment_type (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code varchar(32) UNIQUE NOT NULL,
        name varchar(128) UNIQUE NOT NULL,
        category varchar(64) NOT NULL,
        description text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    await queryRunner.query(`
      CREATE TABLE app_user (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(254) UNIQUE NOT NULL,
        password_hash varchar(255) NOT NULL,
        full_name varchar(128) NOT NULL,
        role user_role NOT NULL,
        base_id uuid REFERENCES base(id) ON DELETE RESTRICT,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_user_base_scope CHECK (
          (role = 'ADMIN' AND base_id IS NULL)
          OR (role = 'BASE_COMMANDER' AND base_id IS NOT NULL)
          OR (role = 'LOGISTICS_OFFICER')
        )
      );
      CREATE INDEX idx_app_user_role ON app_user(role);
      CREATE INDEX idx_app_user_base ON app_user(base_id);
      CREATE INDEX idx_app_user_active ON app_user(is_active);
      CREATE INDEX idx_equipment_type_active ON equipment_type(is_active);
    `);

    await queryRunner.query(`
      CREATE TABLE asset (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        opening_balance integer NOT NULL DEFAULT 0,
        opening_at timestamptz NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_asset_base_equipment UNIQUE (base_id, equipment_type_id),
        CONSTRAINT chk_asset_opening_balance CHECK (opening_balance >= 0)
      );
      CREATE INDEX idx_asset_base ON asset(base_id);
      CREATE INDEX idx_asset_equipment ON asset(equipment_type_id);
    `);

    await queryRunner.query(`
      CREATE TABLE purchase (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        quantity integer NOT NULL,
        status purchase_status NOT NULL DEFAULT 'PENDING',
        reference_code varchar(64) UNIQUE,
        purchased_at timestamptz NOT NULL,
        created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
        idempotency_key varchar(128) UNIQUE NOT NULL,
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_purchase_quantity CHECK (quantity > 0),
        CONSTRAINT chk_purchase_completion CHECK (
          (status = 'COMPLETED' AND completed_at IS NOT NULL)
          OR (status <> 'COMPLETED' AND completed_at IS NULL)
        )
      );
      CREATE INDEX idx_purchase_base ON purchase(base_id);
      CREATE INDEX idx_purchase_equipment ON purchase(equipment_type_id);
      CREATE INDEX idx_purchase_status ON purchase(status);
    `);

    await queryRunner.query(`
      CREATE TABLE transfer (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source_base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        destination_base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        quantity integer NOT NULL,
        status transfer_status NOT NULL DEFAULT 'PENDING',
        idempotency_key varchar(128) UNIQUE NOT NULL,
        created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
        approved_by uuid REFERENCES app_user(id) ON DELETE RESTRICT,
        completed_by uuid REFERENCES app_user(id) ON DELETE RESTRICT,
        approved_at timestamptz,
        completed_at timestamptz,
        rejected_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_transfer_quantity CHECK (quantity > 0),
        CONSTRAINT chk_transfer_distinct_bases CHECK (source_base_id <> destination_base_id),
        CONSTRAINT chk_transfer_not_self_approved CHECK (approved_by IS NULL OR approved_by <> created_by)
      );
      CREATE INDEX idx_transfer_source_status ON transfer(source_base_id, status);
      CREATE INDEX idx_transfer_destination_status ON transfer(destination_base_id, status);
    `);

    await queryRunner.query(`
      CREATE TABLE assignment (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE RESTRICT,
        base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        quantity integer NOT NULL,
        returned_quantity integer NOT NULL DEFAULT 0,
        personnel_reference varchar(64) NOT NULL,
        status assignment_status NOT NULL DEFAULT 'ACTIVE',
        assigned_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
        returned_by uuid REFERENCES app_user(id) ON DELETE RESTRICT,
        assigned_at timestamptz NOT NULL,
        returned_at timestamptz,
        idempotency_key varchar(128) UNIQUE NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_assignment_quantity CHECK (quantity > 0),
        CONSTRAINT chk_assignment_returned CHECK (
          returned_quantity >= 0 AND returned_quantity <= quantity
        )
      );
      CREATE INDEX idx_assignment_asset_status ON assignment(asset_id, status);
      CREATE INDEX idx_assignment_base ON assignment(base_id);
    `);

    await queryRunner.query(`
      CREATE TABLE expenditure (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE RESTRICT,
        base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        quantity integer NOT NULL,
        reason_code varchar(64) NOT NULL,
        notes text,
        recorded_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
        expended_at timestamptz NOT NULL,
        idempotency_key varchar(128) UNIQUE NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_expenditure_quantity CHECK (quantity > 0)
      );
      CREATE INDEX idx_expenditure_asset ON expenditure(asset_id);
      CREATE INDEX idx_expenditure_base ON expenditure(base_id);
    `);

    await queryRunner.query(`
      CREATE TABLE inventory_movement (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE RESTRICT,
        base_id uuid NOT NULL REFERENCES base(id) ON DELETE RESTRICT,
        equipment_type_id uuid NOT NULL REFERENCES equipment_type(id) ON DELETE RESTRICT,
        movement_type movement_type NOT NULL,
        quantity integer NOT NULL,
        direction movement_direction NOT NULL,
        occurred_at timestamptz NOT NULL,
        idempotency_key varchar(128) UNIQUE NOT NULL,
        purchase_id uuid REFERENCES purchase(id) ON DELETE RESTRICT,
        transfer_id uuid REFERENCES transfer(id) ON DELETE RESTRICT,
        assignment_id uuid REFERENCES assignment(id) ON DELETE RESTRICT,
        expenditure_id uuid REFERENCES expenditure(id) ON DELETE RESTRICT,
        created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT chk_movement_quantity CHECK (quantity > 0),
        CONSTRAINT chk_movement_integrity CHECK (
          (movement_type = 'PURCHASE' AND direction = 'IN' AND purchase_id IS NOT NULL
            AND transfer_id IS NULL AND assignment_id IS NULL AND expenditure_id IS NULL)
          OR
          (movement_type IN ('TRANSFER_IN', 'TRANSFER_OUT') AND transfer_id IS NOT NULL
            AND purchase_id IS NULL AND assignment_id IS NULL AND expenditure_id IS NULL
            AND ((movement_type = 'TRANSFER_IN' AND direction = 'IN')
              OR (movement_type = 'TRANSFER_OUT' AND direction = 'OUT')))
          OR
          (movement_type IN ('ASSIGNMENT', 'RETURN') AND assignment_id IS NOT NULL
            AND purchase_id IS NULL AND transfer_id IS NULL AND expenditure_id IS NULL
            AND ((movement_type = 'ASSIGNMENT' AND direction = 'OUT')
              OR (movement_type = 'RETURN' AND direction = 'IN')))
          OR
          (movement_type = 'EXPENDITURE' AND direction = 'OUT' AND expenditure_id IS NOT NULL
            AND purchase_id IS NULL AND transfer_id IS NULL AND assignment_id IS NULL)
        )
      );
      CREATE INDEX idx_movement_asset_time ON inventory_movement(asset_id, occurred_at, id);
      CREATE INDEX idx_movement_base_equipment_time ON inventory_movement(base_id, equipment_type_id, occurred_at);
      CREATE INDEX idx_movement_transfer ON inventory_movement(transfer_id, movement_type);
      CREATE INDEX idx_movement_purchase ON inventory_movement(purchase_id, movement_type);
    `);

    await queryRunner.query(`
      CREATE TABLE audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id uuid REFERENCES app_user(id) ON DELETE RESTRICT,
        action varchar(64) NOT NULL,
        entity_type varchar(64) NOT NULL,
        entity_id uuid,
        correlation_id uuid NOT NULL,
        base_id uuid REFERENCES base(id) ON DELETE RESTRICT,
        before_data jsonb,
        after_data jsonb,
        ip_address inet,
        user_agent varchar(512),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
      CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);
      CREATE INDEX idx_audit_base ON audit_log(base_id);
      CREATE INDEX idx_audit_created ON audit_log(created_at);

      CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Append-only table records cannot be updated or deleted';
      END;
      $$;

      CREATE TRIGGER trg_inventory_movement_append_only
      BEFORE UPDATE OR DELETE ON inventory_movement
      FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

      CREATE TRIGGER trg_audit_log_append_only
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS audit_log CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS inventory_movement CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS expenditure CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS assignment CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS transfer CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS purchase CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS app_user CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS equipment_type CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS base CASCADE`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_append_only_mutation`);
    await queryRunner.query(`DROP TYPE IF EXISTS movement_direction`);
    await queryRunner.query(`DROP TYPE IF EXISTS movement_type`);
    await queryRunner.query(`DROP TYPE IF EXISTS assignment_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS transfer_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS purchase_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_role`);
  }
}
