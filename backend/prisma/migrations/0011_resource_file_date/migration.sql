-- Parsed form of the free-text "Date" value in source_metadata.
-- App writes this on every save/update; column is DATE (no time component).
ALTER TABLE "resources" ADD COLUMN "file_date" DATE;

-- Backfill from existing rows. The source value is entered by hand and comes
-- in inconsistent shapes — most commonly "DD-Mon-YY" ("23-Apr-25") and
-- "DD-Mon-YYYY" ("23-Apr-2025"). Anything else stays NULL.
--
-- We loop with a per-row EXCEPTION handler so a bad value (invalid month
-- abbreviation, day out of range for the month, etc.) doesn't abort the
-- whole migration.
DO $$
DECLARE
  r RECORD;
  raw TEXT;
  parsed DATE;
BEGIN
  FOR r IN
    SELECT id, source_metadata->>'date' AS d
    FROM resources
    WHERE source_metadata ? 'date'
      AND (source_metadata->>'date') IS NOT NULL
      AND btrim(source_metadata->>'date') <> ''
  LOOP
    raw := btrim(r.d);
    BEGIN
      IF raw ~ '^[0-9]{1,2}-[A-Za-z]{3}-[0-9]{4}$' THEN
        parsed := to_date(raw, 'FMDD-Mon-YYYY');
      ELSIF raw ~ '^[0-9]{1,2}-[A-Za-z]{3}-[0-9]{2}$' THEN
        parsed := to_date(raw, 'FMDD-Mon-YY');
      ELSE
        parsed := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      parsed := NULL;
    END;

    IF parsed IS NOT NULL THEN
      UPDATE resources SET file_date = parsed WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
