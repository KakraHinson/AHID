import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

interface OrderMatch {
  trackingId: string;
  shortCode?: string;
  type: string;
  network: string;
  package: string;
  price: string;
  name: string;
  phone: string;
  status: string;
  date: string;
}

const clean = (value: unknown) => String(value ?? '');
const money = (value: unknown) => `GHS ${Number(value).toFixed(2)}`;
const dateOf = (value: unknown) => value ? new Date(String(value)).toLocaleString() : '';

/**
 * Data bundles settle asynchronously, so a tracking lookup has to describe every
 * state. Collapsing anything that is not 'successful' into "Processing" would
 * report a failed or refunded order as still on its way.
 */
function dataOrderLabel(status: unknown): string {
  const value = String(status ?? '').trim().toLowerCase();
  if (value === 'successful') return 'Successful';
  if (value === 'failed') return 'Failed';
  if (value === 'cancelled') return 'Cancelled';
  if (value === 'pending_payment') return 'Awaiting Payment';
  if (value === 'processing') return 'Processing';
  return 'Pending';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { reference } = await request.json();
    const raw = String(reference || '').trim();
    if (!raw) return json({ error: 'Please enter a valid tracking ID.' }, 400);
    // Customers quote the 5-character code, so accept it as well as the long
    // reference prefixes.
    const ref = raw.toUpperCase();
    const admin = adminClient();
    let match: OrderMatch | null = null;

    if (/^[A-Z0-9]{5}$/.test(ref)) {
      // 1. Check airtime orders
      const { data: airtimeData } = await admin
        .from('airtime_orders')
        .select('payment_reference, short_code, network, amount, customer_name, recipient_phone, payment_status, airtime_status, created_at')
        .eq('short_code', ref)
        .maybeSingle();
      if (airtimeData) {
        const status = airtimeData.airtime_status === 'delivered' ? 'Delivered'
          : airtimeData.airtime_status === 'failed' ? 'Failed'
          : airtimeData.payment_status === 'paid' ? 'Processing' : (airtimeData.payment_status || 'Pending');
        match = {
          trackingId: airtimeData.short_code,
          shortCode: airtimeData.short_code,
          type: 'airtime',
          network: (airtimeData.network || '').toUpperCase(),
          package: `Airtime (GHS ${Number(airtimeData.amount).toFixed(2)})`,
          price: money(airtimeData.amount),
          name: airtimeData.customer_name || 'Airtime',
          phone: airtimeData.recipient_phone || '',
          status,
          date: dateOf(airtimeData.created_at),
        };
      }

      // 2. Check agent data orders
      if (!match) {
        const { data, error } = await admin
          .from('agent_data_orders')
          .select('id, provider_reference, short_code, network_type, phone, volume_mb, amount, status, created_at')
          .eq('short_code', ref)
          .maybeSingle();
        if (!error && data) {
          match = {
            trackingId: data.provider_reference,
            shortCode: data.short_code,
            type: 'data',
            network: (data.network_type || '').toUpperCase(),
            package: `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`,
            price: money(data.amount),
            name: 'Agent Order',
            phone: data.phone || '',
            status: dataOrderLabel(data.status),
            date: dateOf(data.created_at),
          };
        }
      }

      // 3. Check utility orders
      if (!match) {
        const { data: utilData } = await admin
          .from('utility_orders')
          .select('payment_reference, short_code, bill_type, package_name, amount, customer_name, customer_phone, status, token_code, created_at')
          .eq('short_code', ref)
          .maybeSingle();
        if (utilData) {
          match = {
            trackingId: utilData.short_code,
            shortCode: utilData.short_code,
            type: 'utility',
            network: (utilData.bill_type || '').replaceAll('_', ' ').toUpperCase(),
            package: utilData.package_name ? `Utility ${utilData.package_name}` : 'Utility Bill',
            price: money(utilData.amount),
            name: utilData.customer_name || 'Customer',
            phone: utilData.customer_phone || '',
            status: utilData.status === 'completed' ? 'Completed' : utilData.status,
            date: dateOf(utilData.created_at),
          };
        }
      }
    }

    // Public data bundles
    if (ref.startsWith('PUB-')) {
      const { data, error } = await admin
        .from('public_data_orders')
        .select('payment_reference, short_code, network_type, volume_mb, sale_amount, customer_name, customer_phone, customer_email, status, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const packageLabel = `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`;
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'data',
          network: clean(data.network_type).toUpperCase(),
          package: packageLabel,
          price: money(data.sale_amount),
          name: data.customer_name || 'Customer',
          phone: data.customer_phone || '',
          status: dataOrderLabel(data.status),
          date: dateOf(data.created_at),
        };
      }
    }

    // Result checker orders
    if (ref.startsWith('RC-')) {
      const { data, error } = await admin
        .from('results_orders')
        .select('payment_reference, short_code, exam_type, quantity, amount, email, status, serial_pin, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'results',
          network: data.exam_type,
          package: `Results Checker x${data.quantity}`,
          price: money(data.amount),
          name: data.email,
          phone: '',
          status: data.status === 'paid' ? 'Completed' : data.status,
          date: dateOf(data.created_at),
        };
      }
    }

    // Agent data orders (agent dashboard tracking IDs)
    if (ref.startsWith('DATA-')) {
      const { data, error } = await admin
        .from('agent_data_orders')
        .select('provider_reference, short_code, network_type, phone, volume_mb, amount, status, created_at')
        .eq('provider_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.provider_reference,
          shortCode: data.short_code,
          type: 'data',
          network: (data.network_type || '').toUpperCase(),
          package: `${data.volume_mb >= 1024 ? `${(data.volume_mb / 1024)}GB` : `${data.volume_mb}MB`} ${clean(data.network_type).toUpperCase()}`,
          price: money(data.amount),
          name: 'Agent Order',
          phone: data.phone || '',
          status: dataOrderLabel(data.status),
          date: dateOf(data.created_at),
        };
      }
    }

    // Utility bill orders
    if (ref.startsWith('UTIL-')) {
      const { data, error } = await admin
        .from('utility_orders')
        .select('payment_reference, short_code, bill_type, package_name, amount, customer_name, customer_phone, status, token_code, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'utility',
          network: (data.bill_type || '').replaceAll('_', ' ').toUpperCase(),
          package: data.package_name ? `Utility ${data.package_name}` : 'Utility Bill',
          price: money(data.amount),
          name: data.customer_name || 'Customer',
          phone: data.customer_phone || '',
          status: data.status === 'completed' ? 'Completed' : data.status,
          date: dateOf(data.created_at),
        };
      }
    }

    // Airtime orders (public + agent)
    if (ref.startsWith('AIR-')) {
      const { data, error } = await admin
        .from('airtime_orders')
        .select('payment_reference, short_code, network, amount, customer_name, recipient_phone, payment_status, airtime_status, created_at')
        .eq('payment_reference', ref)
        .maybeSingle();
      if (!error && data) {
        const status = data.airtime_status === 'delivered' ? 'Delivered'
          : data.airtime_status === 'failed' ? 'Failed'
          : data.payment_status === 'paid' ? 'Processing' : (data.payment_status || 'Pending');
        match = {
          trackingId: data.payment_reference,
          shortCode: data.short_code,
          type: 'airtime',
          network: (data.network || '').toUpperCase(),
          package: `Airtime (GHS ${Number(data.amount).toFixed(2)})`,
          price: money(data.amount),
          name: data.customer_name || 'Airtime',
          phone: data.recipient_phone || '',
          status,
          date: dateOf(data.created_at),
        };
      }
    }

    if (!match) {
      return json({ error: 'No order found matching this tracking ID.' }, 404);
    }
    return json({ order: match });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unable to track order.' }, 500);
  }
});