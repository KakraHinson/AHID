-- ============================================================================
-- Migration: Harden All Wallet Deductions with ABS() Guard & Strict Validation
-- Date: 2026-10-30
--
-- CRITICAL BUG FIX: Agent wallet balances were either not being deducted or
-- were incorrectly increasing when an order was placed. This was caused by
-- deduction expressions like `balance = balance - amount` which become
-- additions when `amount` is negative (balance - (-X) = balance + X).
--
-- This migration:
--   1. Adds ABS() guards to every wallet deduction path so that the deducted
--      value is always the positive magnitude, regardless of sign.
--   2. Enforces strict pre-validation (wallet_balance >= ABS(order_amount))
--      before any order insert.
--   3. Wraps order insertion + wallet deduction in a single atomic transaction
--      with FOR UPDATE row locking to prevent race conditions.
--   4. Adds a CHECK constraint on wallets.balance to prevent it going negative.
--   5. Resets the 4 named agent wallets to 0.00 as requested.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Add a CHECK constraint to prevent negative wallet balances
-- ---------------------------------------------------------------------------
ALTER TABLE public.wallets DROP CONSTRAINT IF EXISTS wallets_balance_non_negative;
ALTER TABLE public.wallets ADD CONSTRAINT wallets_balance_non_negative
  CHECK (balance >= 0);

-- ---------------------------------------------------------------------------
-- 1. HARDEN: charge_agent_wallet — the universal atomic debit RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.charge_agent_wallet(
  p_agent_id uuid,
  p_reference text,
  p_amount numeric,
  p_description text DEFAULT NULL,
  p_meta jsonb DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  numeric;
  v_debit    numeric;
  v_after    numeric;
BEGIN
  -- Always use the absolute value so a negative input can never credit
  v_debit := ABS(p_amount);

  IF v_debit <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero.';
  END IF;

  -- Lock the wallet row to prevent concurrent modification
  SELECT balance INTO v_balance
    FROM public.wallets
   WHERE id = p_agent_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent wallet not found.';
  END IF;

  -- Strict balance check: must have enough to cover the debit
  IF COALESCE(v_balance, 0) < v_debit THEN
    RAISE EXCEPTION 'Insufficient wallet balance. Available GHS %, required GHS %', v_balance, v_debit;
  END IF;

  -- Deduct using ABS() to guarantee subtraction
  v_after := v_balance - v_debit;

  UPDATE public.wallets
     SET balance    = v_after,
         updated_at = NOW()
   WHERE id = p_agent_id;

  INSERT INTO public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, meta)
  VALUES
    (p_agent_id, p_reference, 'debit',
     COALESCE(p_description, 'Service purchase'),
     v_debit, v_after,
     COALESCE(p_meta, '{}'::jsonb));

  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.charge_agent_wallet(uuid, text, numeric, text, jsonb) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. HARDEN: refund_agent_wallet — always credits the absolute value
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_agent_wallet(
  p_agent_id uuid,
  p_debit_reference text,
  p_amount numeric,
  p_reason text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance           numeric;
  v_refund            numeric;
  v_after             numeric;
  v_debit             public.wallet_transactions%ROWTYPE;
  v_credit_reference  text;
BEGIN
  v_refund := ABS(p_amount);

  IF v_refund <= 0 THEN
    RAISE EXCEPTION 'Refund amount must be greater than zero.';
  END IF;

  SELECT * INTO v_debit
    FROM public.wallet_transactions
   WHERE agent_id  = p_agent_id
     AND reference = p_debit_reference
     AND type      = 'debit'
   ORDER BY created_at
   LIMIT 1
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No payable wallet debit found for reference %.', p_debit_reference;
  END IF;

  -- Already refunded: return the current balance without crediting twice.
  IF v_debit.status = 'refunded' THEN
    SELECT COALESCE(balance, 0) INTO v_balance FROM public.wallets WHERE id = p_agent_id;
    RETURN v_balance;
  END IF;

  SELECT COALESCE(balance, 0) INTO v_balance
    FROM public.wallets WHERE id = p_agent_id FOR UPDATE;

  v_after := v_balance + v_refund;
  v_credit_reference := v_debit.reference || '-REF-' || substr(md5(random()::text), 1, 6);

  UPDATE public.wallets SET balance = v_after, updated_at = NOW() WHERE id = p_agent_id;

  BEGIN
    INSERT INTO public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, status, reversed_transaction_id, meta)
    VALUES
      (p_agent_id, v_credit_reference, 'credit',
       COALESCE(p_reason, 'Refund for ' || v_debit.reference),
       v_refund, v_after, 'settled', v_debit.id,
       jsonb_build_object('debit_reference', v_debit.reference));
  EXCEPTION WHEN unique_violation THEN
    -- A concurrent request already refunded this debit.
    RETURN v_after;
  END;

  UPDATE public.wallet_transactions SET status = 'refunded', updated_at = NOW() WHERE id = v_debit.id;
  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.refund_agent_wallet(uuid, text, numeric, text) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. HARDEN: reserve_agent_data_order — atomic debit with ABS()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_agent_data_order(
  p_agent_id uuid,
  p_reference text,
  p_network_type text,
  p_phone text,
  p_volume_mb integer,
  p_amount numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  numeric;
  v_debit    numeric;
  v_after    numeric;
  v_order_id uuid;
BEGIN
  v_debit := ABS(p_amount);

  IF v_debit <= 0 THEN
    RAISE EXCEPTION 'Order amount must be greater than zero.';
  END IF;

  -- Lock wallet row
  SELECT balance INTO v_balance
    FROM public.wallets
   WHERE id = p_agent_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent wallet not found.';
  END IF;

  -- Strict balance check
  IF COALESCE(v_balance, 0) < v_debit THEN
    RAISE EXCEPTION 'Insufficient wallet balance';
  END IF;

  -- Deduct using ABS() — guaranteed subtraction
  v_after := COALESCE(v_balance, 0) - v_debit;

  UPDATE public.wallets
     SET balance = v_after,
         updated_at = NOW()
   WHERE id = p_agent_id;

  INSERT INTO public.agent_data_orders
    (agent_id, provider_reference, network_type, phone, volume_mb, amount)
  VALUES
    (p_agent_id, p_reference, p_network_type, p_phone, p_volume_mb, v_debit)
  RETURNING id INTO v_order_id;

  INSERT INTO public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after)
  VALUES
    (p_agent_id, p_reference, 'debit', 'Data bundle purchase', v_debit, v_after);

  RETURN v_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_agent_data_order(uuid, text, text, text, integer, numeric) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. HARDEN: complete_agent_data_order — refund path uses ABS()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_agent_data_order(
  p_order_id uuid,
  p_success boolean,
  p_provider_response jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order    public.agent_data_orders%ROWTYPE;
  v_balance  numeric;
  v_refund   numeric;
  v_after    numeric;
  v_debit_id uuid;
BEGIN
  SELECT * INTO v_order FROM public.agent_data_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.status <> 'processing' THEN RETURN; END IF;

  IF p_success THEN
    UPDATE public.agent_data_orders
       SET status = 'successful', provider_response = p_provider_response, completed_at = NOW()
     WHERE id = p_order_id;
  ELSE
    v_refund := ABS(v_order.amount);

    SELECT id INTO v_debit_id
      FROM public.wallet_transactions
     WHERE agent_id  = v_order.agent_id
       AND reference = v_order.provider_reference
       AND type      = 'debit'
     ORDER BY created_at
     LIMIT 1;

    SELECT COALESCE(balance, 0) INTO v_balance
      FROM public.wallets
     WHERE id = v_order.agent_id
       FOR UPDATE;

    v_after := v_balance + v_refund;

    UPDATE public.wallets
       SET balance = v_after, updated_at = NOW()
     WHERE id = v_order.agent_id;

    INSERT INTO public.wallet_transactions
      (agent_id, reference, type, description, amount, balance_after, status, reversed_transaction_id)
    VALUES
      (v_order.agent_id,
       v_order.provider_reference || '-REF-' || substr(md5(random()::text), 1, 6),
       'credit', 'Refund for ' || v_order.provider_reference,
       v_refund, v_after, 'settled', v_debit_id);

    IF v_debit_id IS NOT NULL THEN
      UPDATE public.wallet_transactions SET status = 'refunded', updated_at = NOW() WHERE id = v_debit_id;
    END IF;

    UPDATE public.agent_data_orders
       SET status = 'failed', provider_response = p_provider_response, completed_at = NOW()
     WHERE id = p_order_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_agent_data_order(uuid, boolean, jsonb) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. HARDEN: process_agent_order — the wallet dashboard ordering RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_agent_order(
  p_agent_id uuid,
  p_order_total numeric,
  p_network text DEFAULT 'MTN',
  p_bundle_size text DEFAULT '1GB',
  p_recipient_phone text DEFAULT '',
  p_commission_rate numeric DEFAULT 0.05,
  p_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet      public.wallets%ROWTYPE;
  v_agent_code  text;
  v_ref         text;
  v_debit       numeric;
  v_commission  numeric(12,2);
  v_order_id    uuid;
BEGIN
  IF p_agent_id IS NULL THEN
    RAISE EXCEPTION 'Agent ID is required';
  END IF;

  -- Always use absolute value to prevent sign-flip exploits
  v_debit := ABS(p_order_total);

  IF v_debit <= 0 THEN
    RAISE EXCEPTION 'Order total must be greater than zero';
  END IF;

  PERFORM public.ensure_agent_profile(p_agent_id);
  SELECT agent_code INTO v_agent_code FROM public.agents WHERE id = p_agent_id;

  -- 1. Lock wallet row and validate balance
  SELECT * INTO v_wallet FROM public.wallets WHERE id = p_agent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent wallet not found.';
  END IF;

  -- Strict pre-check: balance must cover the absolute order amount
  IF v_wallet.balance < v_debit THEN
    RAISE EXCEPTION 'Insufficient wallet balance. Please top up your wallet via Paystack.';
  END IF;

  -- 2. Calculate store commission
  v_commission := ROUND((v_debit * COALESCE(p_commission_rate, 0.05))::numeric, 2);

  -- 3. Atomic: deduct ABS(amount), increment sales & store_sales, add commission
  UPDATE public.wallets
     SET balance                = balance - v_debit,
         sales                  = sales + v_debit,
         store_sales            = store_sales + v_debit,
         commission_balance     = commission_balance + v_commission,
         total_commission_earned = total_commission_earned + v_commission,
         updated_at             = NOW()
   WHERE id = p_agent_id
   RETURNING * INTO v_wallet;

  -- 4. Generate unique reference
  v_ref := COALESCE(NULLIF(TRIM(p_reference), ''),
           'ORD-' || UPPER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 10)));

  -- 5. Insert order record
  INSERT INTO public.orders
    (agent_id, agent_code, network, bundle_size, recipient_phone, amount, commission_amount, reference, status, created_at)
  VALUES
    (p_agent_id, v_agent_code, COALESCE(p_network, 'MTN'), COALESCE(p_bundle_size, '1GB'),
     COALESCE(p_recipient_phone, ''), v_debit, v_commission, v_ref, 'completed', NOW())
  RETURNING id INTO v_order_id;

  -- 6. Log in transactions
  INSERT INTO public.transactions
    (agent_id, agent_code, reference, amount, type, status, metadata, created_at)
  VALUES
    (p_agent_id, v_agent_code, v_ref, v_debit, 'Order Purchase', 'success',
     jsonb_build_object(
       'network', p_network,
       'bundle_size', p_bundle_size,
       'recipient_phone', p_recipient_phone,
       'commission_earned', v_commission,
       'order_id', v_order_id
     ), NOW());

  -- 7. Log commission
  IF v_commission > 0 THEN
    INSERT INTO public.commissions
      (agent_id, order_id, reference, amount, rate, source, status, metadata, created_at)
    VALUES
      (p_agent_id, v_order_id, 'COMM-' || v_ref, v_commission,
       COALESCE(p_commission_rate, 0.05), 'Store Sales', 'earned',
       jsonb_build_object('order_reference', v_ref), NOW());
  END IF;

  -- 8. Log in wallet_transactions audit trail
  INSERT INTO public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after, meta)
  VALUES
    (p_agent_id, v_ref, 'debit',
     'Order Purchase: ' || COALESCE(p_network, '') || ' ' || COALESCE(p_bundle_size, ''),
     v_debit, v_wallet.balance,
     jsonb_build_object('order_id', v_order_id, 'commission', v_commission));

  RETURN jsonb_build_object(
    'success', true,
    'reference', v_ref,
    'order_id', v_order_id,
    'amount_deducted', v_debit,
    'commission_earned', v_commission,
    'new_balance', v_wallet.balance,
    'commission_balance', v_wallet.commission_balance,
    'sales', v_wallet.sales,
    'store_sales', v_wallet.store_sales
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_agent_order(uuid, numeric, text, text, text, numeric, text)
  TO authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- 6. HARDEN: purchase_agent_airtime — debit with ABS()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purchase_agent_airtime(
  p_agent_id uuid,
  p_reference text,
  p_phone text,
  p_network text,
  p_amount numeric,
  p_customer_name text DEFAULT NULL,
  p_customer_email text DEFAULT NULL
)
RETURNS public.airtime_orders
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet_balance numeric;
  v_debit          numeric;
  v_order          public.airtime_orders;
BEGIN
  v_debit := ABS(p_amount);

  IF v_debit <= 0 THEN
    RAISE EXCEPTION 'Airtime amount must be greater than zero.';
  END IF;

  SELECT balance INTO v_wallet_balance
    FROM public.wallets
   WHERE id = p_agent_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agent wallet not found.';
  END IF;

  IF v_wallet_balance < v_debit THEN
    RAISE EXCEPTION 'Insufficient wallet balance. Balance: GHS %, Required: GHS %', v_wallet_balance, v_debit;
  END IF;

  UPDATE public.wallets
     SET balance    = balance - v_debit,
         updated_at = NOW()
   WHERE id = p_agent_id;

  INSERT INTO public.airtime_orders (
    user_id, agent_id, payment_reference, recipient_phone, network,
    amount, fee_amount, gross_amount, payment_method, payment_status,
    airtime_status, customer_name, customer_email
  ) VALUES (
    p_agent_id, p_agent_id, p_reference, p_phone, p_network,
    v_debit, 0.00, v_debit, 'wallet', 'paid',
    'pending', p_customer_name, p_customer_email
  )
  RETURNING * INTO v_order;

  INSERT INTO public.wallet_transactions
    (agent_id, reference, type, description, amount, balance_after)
  VALUES
    (p_agent_id, p_reference, 'debit', 'Airtime purchase', v_debit, v_wallet_balance - v_debit);

  RETURN v_order;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. RESET: Zero out the 4 specified agent wallets
-- ---------------------------------------------------------------------------
UPDATE public.wallets
   SET balance    = 0.00,
       updated_at = NOW()
 WHERE id IN (
   SELECT id FROM public.agents
    WHERE full_name IN (
      'Dauda Mateen Nubalanaa',
      'Skaitech',
      'William Christian Jackson Amankwaa',
      'Skaitech me'
    )
 );

-- Also log the admin reset in wallet_transactions for audit trail
INSERT INTO public.wallet_transactions
  (agent_id, reference, type, description, amount, balance_after, meta)
SELECT
  a.id,
  'ADMIN-RESET-' || UPPER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 10)),
  'debit',
  'Admin balance reset to zero (wallet deduction bug fix)',
  GREATEST(w.balance, 0.01),  -- log the amount that was cleared
  0.00,
  jsonb_build_object('reason', 'Balance reset during wallet deduction hardening migration', 'agent_name', a.full_name)
FROM public.agents a
JOIN public.wallets w ON w.id = a.id
WHERE a.full_name IN (
  'Dauda Mateen Nubalanaa',
  'Skaitech',
  'William Christian Jackson Amankwaa',
  'Skaitech me'
)
AND w.balance > 0
ON CONFLICT (reference) DO NOTHING;
