export class AddBusinessIdempotency1795552000000 {
  name = "AddBusinessIdempotency1795552000000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE public.business_idempotency (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key varchar(128) NOT NULL UNIQUE,
        actor_user_id uuid NOT NULL
          REFERENCES public.app_user(id) ON DELETE RESTRICT,
        operation varchar(64) NOT NULL CHECK (
          operation IN (
            'PURCHASE_CREATE',
            'TRANSFER_INITIATE',
            'TRANSFER_APPROVE',
            'TRANSFER_REJECT',
            'TRANSFER_COMPLETE',
            'ASSIGNMENT_CREATE',
            'ASSIGNMENT_RETURN',
            'EXPENDITURE_RECORD'
          )
        ),
        request_fingerprint char(64) NOT NULL CHECK (
          request_fingerprint ~ '^[0-9a-f]{64}$'
        ),
        entity_type varchar(64) NOT NULL,
        entity_id uuid NOT NULL,
        http_status smallint NOT NULL CHECK (http_status BETWEEN 200 AND 299),
        response_payload jsonb NOT NULL CHECK (
          jsonb_typeof(response_payload) = 'object'
        ),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX idx_business_idempotency_actor
        ON public.business_idempotency(actor_user_id, created_at);

      CREATE TRIGGER trg_business_idempotency_append_only
      BEFORE UPDATE OR DELETE ON public.business_idempotency
      FOR EACH ROW EXECUTE FUNCTION public.prevent_append_only_mutation();
    `);
  }

  async down() {
    throw new Error(
      "Business idempotency records are permanent; use a forward migration.",
    );
  }
}
