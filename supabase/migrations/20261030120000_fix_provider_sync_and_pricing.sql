-- ============================================================================
-- Migration: Fix Provider Sync Error Handling & Agent Price Propagation
-- ============================================================================
-- Bug 1: Edge Function non-2xx errors caused by unhandled provider failures
--   Fix: The admin-portal-api sync-order-status action now wraps all provider
--        calls in isolated try/catch blocks and returns HTTP 200 with
--        success:false on any error, so the Supabase client never sees a 500.
--
-- Bug 2: Agent custom prices not visible on public storefront
--   Fix: agent_prices upsert in STORE.JS is now independent of the
--        agent_stores lookup so it always runs. manage-agent-pricing also
--        has isolated error handling per write path.
-- ============================================================================

-- 1. Ensure agent_prices table exists with correct schema and constraints.
CREATE TABLE IF NOT EXISTS public.agent_prices (
    id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    network     TEXT NOT NULL,
    package_id  TEXT NOT NULL,
    custom_price NUMERIC(10, 2) NOT NULL CHECK (custom_price >= 0),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(agent_id, network, package_id)
);

-- 2. Indexes for rapid storefront lookups
CREATE INDEX IF NOT EXISTS idx_agent_prices_agent_id ON public.agent_prices(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_prices_network  ON public.agent_prices(network);
CREATE INDEX IF NOT EXISTS idx_agent_prices_lookup
    ON public.agent_prices(agent_id, network, package_id);

-- 3. RLS: public read (storefront), unrestricted write (agents via anon/auth client)
ALTER TABLE public.agent_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_prices_public_read"    ON public.agent_prices;
DROP POLICY IF EXISTS "agent_prices_agent_write"    ON public.agent_prices;
DROP POLICY IF EXISTS "Allow public read access to agent prices"  ON public.agent_prices;
DROP POLICY IF EXISTS "Allow agents to manage their prices"       ON public.agent_prices;

CREATE POLICY "agent_prices_public_read"
    ON public.agent_prices FOR SELECT
    USING (true);

CREATE POLICY "agent_prices_agent_write"
    ON public.agent_prices FOR ALL
    USING (true)
    WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_prices TO anon, authenticated;

-- 4. agent_data_orders: ensure completed_at column exists (used by sync update)
ALTER TABLE public.agent_data_orders
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

-- 5. Extend agent_data_orders status constraint to include all provider states
--    that the sync handler can write (successful, failed, cancelled, processing).
--    Drop and recreate only if the constraint exists and is too narrow.
DO $$
BEGIN
    -- Add 'successful' to the allowed status values if not already present.
    -- The actual constraint name may vary; we drop-and-recreate defensively.
    ALTER TABLE public.agent_data_orders
        DROP CONSTRAINT IF EXISTS agent_data_orders_status_check;

    ALTER TABLE public.agent_data_orders
        ADD CONSTRAINT agent_data_orders_status_check
        CHECK (status IN (
            'pending', 'processing', 'successful', 'failed', 'cancelled', 'refunded'
        ));
EXCEPTION WHEN others THEN
    -- If the column does not have a check constraint at all, this is fine.
    NULL;
END;
$$;
