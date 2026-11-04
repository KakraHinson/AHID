import { supabase } from './supabaseClient.js';

const rows = new Map();

export const COMMISSION_SERVICE_FOR = Object.freeze({
  mtn: 'mtn_airtime',
  telecel: 'telecel_airtime',
  at: 'airteltigo_airtime',
  ecg: 'ecg_prepaid',
  ecg_prepaid: 'ecg_prepaid',
  ecg_postpaid: 'ecg_postpaid',
  ghana_water: 'ghana_water',
  startimes: 'startimes',
  gotv: 'gotv',
  dstv: 'dstv',
});

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export async function loadCommissionSettings() {
  const { data, error } = await supabase
    .from('service_commission_rates')
    .select('service, label, commission_percent, agent_share_percent, merchant_share_percent, hubtel_share_percent, updated_at');
  if (error) {
    console.warn('Commission settings could not be loaded:', error.message || error);
    return rows;
  }
  rows.clear();
  (data || []).forEach((row) => rows.set(String(row.service), row));
  return rows;
}

export function commissionServiceFor(service) {
  const key = String(service || '').toLowerCase();
  return COMMISSION_SERVICE_FOR[key] || key;
}

export function commissionQuote(amount, service) {
  const serviceKey = commissionServiceFor(service);
  const row = rows.get(serviceKey) || {};
  const transactionAmount = round2(Math.max(0, Number(amount) || 0));
  const ratePercent = Number(row.commission_percent) || 0;
  const agentSharePercent = Number(row.agent_share_percent ?? row.merchant_share_percent) || 0;
  const commissionAmount = round2(transactionAmount * ratePercent / 100);
  const agentCommissionAmount = round2(commissionAmount * Math.min(Math.max(agentSharePercent, 0), 100) / 100);
  return {
    service: serviceKey,
    ratePercent,
    agentSharePercent,
    commissionAmount,
    agentCommissionAmount,
    walletChargeAmount: round2(Math.max(0, transactionAmount - agentCommissionAmount)),
  };
}
