/**
 * Resolves what an agent is charged for a service.
 *
 * Order of truth: the service_pricing table (so the price can be shown on the
 * page and changed with one SQL UPDATE), falling back to the
 * <SERVICE>_FEE_AMOUNT edge-function secret, then to a hard default.
 *
 * The result is always server-side: callers must never accept a price from the
 * request body.
 */

type PriceRow = { price: number } | null;

// PromiseLike, not Promise: the supabase query builder is thenable but does not
// implement the full Promise interface, so a Promise return type made every
// caller that passes a real client fail to typecheck.
type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => PromiseLike<{ data: PriceRow }>;
      };
    };
  };
};

export async function resolveServicePrice(
  service: string,
  options: { supabase?: unknown; envVar?: string; fallback?: number } = {},
): Promise<number> {
  const { supabase, envVar, fallback = 0 } = options;

  if (supabase) {
    try {
      const { data } = await (supabase as SupabaseLike)
        .from('service_pricing')
        .select('price')
        .eq('service', service)
        .maybeSingle();
      const price = Number(data?.price);
      if (Number.isFinite(price) && price >= 0) {
        return Math.round(price * 100) / 100;
      }
    } catch (err) {
      console.warn(`Could not read ${service} price from service_pricing:`, err);
    }
  }

  if (envVar) {
    const fromEnv = Number(Deno.env.get(envVar));
    if (Number.isFinite(fromEnv) && fromEnv >= 0) {
      return Math.round(fromEnv * 100) / 100;
    }
  }

  return fallback;
}

export type AgentPricingLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => PromiseLike<{ data: PriceRow }>;
        };
      };
    };
  };
};

/**
 * The admin Store > Pricing tab writes to agent_pricing under keys like
 * price_mtn_1gb, but the data order functions used to read a hardcoded catalog
 * instead, so editing a price there changed nothing. This looks up the agent's
 * own price for a bundle and falls back to the catalog.
 *
 * Only whole-GB bundles have a pricing key; the small MB bundles keep the
 * catalog price.
 */
export async function resolveAgentBundlePrice(
  supabase: AgentPricingLike,
  agentId: string,
  networkType: string,
  volumeInMB: number,
  fallback: number,
): Promise<number> {
  const gb = volumeInMB / 1024;
  if (!Number.isInteger(gb) || gb <= 0) return fallback;

  const key = `price_${String(networkType).toLowerCase()}_${gb}gb`;
  try {
    const { data } = await supabase
      .from('agent_pricing')
      .select('price')
      .eq('agent_id', agentId)
      .eq('pricing_key', key)
      .maybeSingle();
    const price = Number(data?.price);
    if (Number.isFinite(price) && price > 0) {
      return Math.round(price * 100) / 100;
    }
  } catch (err) {
    console.warn(`Could not read agent price for ${key}:`, err);
  }
  return fallback;
}

// Agent profit rates (%) per data network, mirroring the Service Commission
// Calculator in STORE.JS. Used to price the "share my profit with customers"
// discount an agent can offer on their storefront.
export const DATA_PROFIT_RATES: Record<string, number> = {
  mtn: 6,
  telecel: 4,
  airteltigo: 5,
};

/**
 * Reads the percent of commission profit an agent chose to share with
 * customers (stored under the reserved agent_pricing key). Missing/invalid
 * values mean "no discount".
 */
export async function resolveAgentProfitShare(
  supabase: AgentPricingLike,
  agentId: string,
): Promise<number> {
  try {
    const { data } = await supabase
      .from('agent_pricing')
      .select('price')
      .eq('agent_id', agentId)
      .eq('pricing_key', 'customer_discount_percent')
      .maybeSingle();
    const value = Number(data?.price);
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 100);
  } catch (err) {
    console.warn('Could not read agent profit share:', err);
    return 0;
  }
}

/**
 * Applies the shared-profit discount to a selling price. Commission is derived
 * with the same multiplier formula used across the platform, the agent's share
 * is 35% of that commission, and the customer discount is `sharePercent` of the
 * agent's share. No rate (e.g. non-data service) means the price is untouched.
 */
export function customerPriceWithProfitShare(
  price: number,
  networkType: string,
  sharePercent: number,
): number {
  const base = Math.round(Number(price) * 100) / 100;
  const rate = DATA_PROFIT_RATES[String(networkType || '').toLowerCase()];
  const share = Number(sharePercent);
  if (!rate || !Number.isFinite(share) || share <= 0) return base;

  const commission = base - base / (1 + rate / 100);
  const agentProfit = commission * 0.35;
  const discount = (Math.min(share, 100) / 100) * agentProfit;
  return Math.round((base - discount) * 100) / 100;
}
