/**
 * Instant Data is intentionally held out of sale until every required Hubtel
 * package mapping has been reviewed. Keep the switch server-side so disabling
 * the storefront also disables crafted API requests before the wallet moves.
 *
 * Enable later with:
 *   supabase secrets set INSTANT_DATA_SALES_ENABLED=true
 */
export const INSTANT_DATA_OUT_OF_STOCK_MESSAGE =
  'Instant Data is temporarily out of stock while provider mappings are being completed.';

export function instantDataSalesEnabled(): boolean {
  return String(Deno.env.get('INSTANT_DATA_SALES_ENABLED') || '').trim().toLowerCase() === 'true';
}
