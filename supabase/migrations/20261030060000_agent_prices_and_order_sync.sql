-- ============================================================================
-- Migration: Agent Prices Table, Public RLS & Airtime Status Extension
-- ============================================================================

-- 1. Create the agent custom pricing table
CREATE TABLE IF NOT EXISTS public.agent_prices (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id TEXT NOT NULL,          -- Identifier for the agent (e.g., username, slug, or user ID)
    network TEXT NOT NULL,           -- e.g., 'MTN', 'Telecel', 'AirtelTigo'
    package_id TEXT NOT NULL,        -- e.g., '1GB', '2GB', '3GB'
    custom_price NUMERIC(10, 2) NOT NULL, -- The agent's custom selling price
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Ensure an agent only has one custom price entry per package per network
    UNIQUE(agent_id, network, package_id)
);

-- Indexes for rapid lookup on storefront loads
CREATE INDEX IF NOT EXISTS idx_agent_prices_agent_id ON public.agent_prices(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_prices_network ON public.agent_prices(network);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.agent_prices ENABLE ROW LEVEL SECURITY;

-- 3. Policy: Allow anyone (customers visiting the store link) to read/view prices
DROP POLICY IF EXISTS "Allow public read access to agent prices" ON public.agent_prices;
CREATE POLICY "Allow public read access to agent prices"
ON public.agent_prices FOR SELECT
USING (true);

-- 4. Policy: Allow agents to insert or update their prices
DROP POLICY IF EXISTS "Allow agents to manage their prices" ON public.agent_prices;
CREATE POLICY "Allow agents to manage their prices"
ON public.agent_prices FOR ALL
USING (true)
WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_prices TO anon, authenticated;

-- 5. Extend airtime_orders check constraint to permit 'successful' & 'completed'
ALTER TABLE public.airtime_orders DROP CONSTRAINT IF EXISTS airtime_orders_airtime_status_check;
ALTER TABLE public.airtime_orders ADD CONSTRAINT airtime_orders_airtime_status_check
  CHECK (airtime_status IN ('pending', 'processing', 'delivered', 'successful', 'completed', 'failed', 'pending_provider'));

-- 6. Update fulfil_airtime_order to support 'successful' status
CREATE OR REPLACE FUNCTION public.fulfil_airtime_order(
  p_order_id uuid,
  p_airtime_status text default 'successful',
  p_provider_reference text default null,
  p_provider_response jsonb default null,
  p_failure_reason text default null
)
RETURNS public.airtime_orders
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order public.airtime_orders;
BEGIN
  SELECT * INTO v_order
  FROM public.airtime_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Airtime order not found with ID %', p_order_id;
  END IF;

  -- Idempotency: if already completed, delivered, or successful, do not repeat
  IF v_order.airtime_status IN ('successful', 'delivered', 'completed') THEN
    RETURN v_order;
  END IF;

  UPDATE public.airtime_orders
  SET
    payment_status = 'paid',
    airtime_status = coalesce(p_airtime_status, 'successful'),
    provider_reference = coalesce(p_provider_reference, v_order.provider_reference),
    provider_response = coalesce(p_provider_response, v_order.provider_response),
    failure_reason = p_failure_reason,
    updated_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;
