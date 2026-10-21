-- Graph sendMail accepts with HTTP202 and no message ID. Preserve truthful receipts only.
BEGIN;
-- Ask PostgreSQL to deparse both known contracts identically, rather than guessing anonymous
-- constraint names or replacing an unknown schema. These tables hold no data and disappear.
CREATE TEMP TABLE personal_receipt_contract (state text,receipt jsonb,
  CONSTRAINT known_old CHECK (receipt IS NULL OR (
    (state='accepted' AND receipt=jsonb_build_object('state',state,'providerReceiptId',receipt->>'providerReceiptId')
      AND jsonb_typeof(receipt->'providerReceiptId')='string'
      AND length(receipt->>'providerReceiptId') BETWEEN 1 AND 256
      AND receipt->>'providerReceiptId' ~ '^[A-Za-z0-9._:@/+=-]+$') OR
    (state='rejected' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('provider_refused','invalid_recipient','rate_limited')) OR
    (state='not_dispatched' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('authority_changed','expired','policy_refused','credential_unavailable')) OR
    (state='unknown' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('transport_uncertain','process_interrupted'))
  )),
  CONSTRAINT known_new CHECK (receipt IS NULL OR (
    (state='accepted' AND receipt=jsonb_build_object('state',state,'providerReceiptId',receipt->>'providerReceiptId')
      AND jsonb_typeof(receipt->'providerReceiptId')='string'
      AND length(receipt->>'providerReceiptId') BETWEEN 1 AND 256
      AND receipt->>'providerReceiptId' ~ '^[A-Za-z0-9._:@/+=-]+$') OR
    (state='accepted' AND receipt->'providerStatus'='202'::jsonb AND (
      receipt=jsonb_build_object('state',state,'providerStatus',202) OR
      (receipt=jsonb_build_object('state',state,'providerStatus',202,'providerReceiptId',receipt->>'providerReceiptId')
        AND jsonb_typeof(receipt->'providerReceiptId')='string'
        AND length(receipt->>'providerReceiptId') BETWEEN 1 AND 256
        AND receipt->>'providerReceiptId' ~ '^[A-Za-z0-9._:@/+=-]+$'))) OR
    (state='rejected' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('provider_refused','invalid_recipient','rate_limited')) OR
    (state='not_dispatched' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('authority_changed','expired','policy_refused','credential_unavailable')) OR
    (state='unknown' AND receipt=jsonb_build_object('state',state,'code',receipt->>'code')
      AND jsonb_typeof(receipt->'code')='string'
      AND receipt->>'code' IN ('transport_uncertain','process_interrupted'))
  ))
) ON COMMIT DROP;
DO $$
DECLARE old_expression text; new_expression text; existing_name text; matches integer;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO old_expression FROM pg_constraint
    WHERE conrelid='pg_temp.personal_receipt_contract'::regclass AND conname='known_old';
  SELECT pg_get_expr(conbin,conrelid) INTO new_expression FROM pg_constraint
    WHERE conrelid='pg_temp.personal_receipt_contract'::regclass AND conname='known_new';
  SELECT count(*),min(conname) INTO matches,existing_name FROM pg_constraint
    WHERE conrelid='personal_actions'::regclass AND contype='c'
      AND pg_get_expr(conbin,conrelid) IN (old_expression,new_expression);
  IF matches<>1 THEN RAISE EXCEPTION 'Unknown personal action receipt contract'; END IF;
  IF existing_name<>'personal_actions_receipt_check_v2' THEN
    EXECUTE format('ALTER TABLE personal_actions DROP CONSTRAINT %I',existing_name);
    EXECUTE format('ALTER TABLE personal_actions ADD CONSTRAINT personal_actions_receipt_check_v2 CHECK (%s)',new_expression);
  ELSIF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='personal_actions'::regclass
    AND conname=existing_name AND pg_get_expr(conbin,conrelid)=new_expression) THEN
    RAISE EXCEPTION 'Unknown personal action receipt contract';
  END IF;
END $$;
COMMIT;
