export class SanitizeAuditSnapshots1763939600000 {
  name = "SanitizeAuditSnapshots1763939600000";

  async up(queryRunner) {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION sanitize_audit_json(value jsonb)
      RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
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
        IF jsonb_typeof(value) = 'array' THEN
          result := '[]'::jsonb;
          FOR element IN SELECT * FROM jsonb_array_elements(value)
          LOOP
            result := result || sanitize_audit_json(element);
          END LOOP;
          RETURN result;
        END IF;
        IF jsonb_typeof(value) <> 'object' THEN
          RETURN value;
        END IF;

        FOR key IN SELECT jsonb_object_keys(value)
        LOOP
          normalized := lower(regexp_replace(key, '[^a-zA-Z0-9]', '', 'g'));
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
            result := jsonb_set(
              result,
              ARRAY[key],
              sanitize_audit_json(value -> key),
              true
            );
          END IF;
        END LOOP;
        RETURN result;
      END;
      $$;

      CREATE OR REPLACE FUNCTION sanitize_audit_log_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.before_data := sanitize_audit_json(NEW.before_data);
        NEW.after_data := sanitize_audit_json(NEW.after_data);
        NEW.ip_address := NEW.ip_address;
        NEW.user_agent := CASE
          WHEN NEW.user_agent IS NULL THEN NULL
          ELSE substr(NEW.user_agent, 1, 512)
        END;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_sanitize_audit_log_insert ON audit_log;
      CREATE TRIGGER trg_sanitize_audit_log_insert
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION sanitize_audit_log_insert();
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_sanitize_audit_log_insert ON audit_log;
      DROP FUNCTION IF EXISTS sanitize_audit_log_insert();
      DROP FUNCTION IF EXISTS sanitize_audit_json(jsonb);
    `);
  }
}
