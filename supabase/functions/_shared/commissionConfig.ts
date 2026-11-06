export interface CommissionConfig {
  service: string;
  label: string;
  ratePercent: number;
  agentSharePercent: number;
  platformSharePercent: number;
}

export interface CommissionQuote extends CommissionConfig {
  transactionAmount: number;
  commissionAmount: number;
  agentCommissionAmount: number;
  platformCommissionAmount: number;
  walletChargeAmount: number;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function airtimeCommissionService(network: string): string {
  switch (String(network || '').toLowerCase()) {
    case 'mtn': return 'mtn_airtime';
    case 'telecel': return 'telecel_airtime';
    case 'at': return 'airteltigo_airtime';
    default: return `${String(network || 'unknown').toLowerCase()}_airtime`;
  }
}

export function utilityCommissionService(billType: string): string {
  const service = String(billType || '').toLowerCase();
  return service === 'ecg' ? 'ecg_prepaid' : service;
}

/**
 * Reads the admin-controlled rate on every purchase. Missing configuration is
 * deliberately a zero-benefit fallback so a stale/partial deployment never
 * gives an agent an unrecorded free purchase.
 */
export async function resolveCommissionConfig(
  admin: ReturnType<typeof import('./supabase.ts').adminClient>,
  service: string,
): Promise<CommissionConfig> {
  const fallback: CommissionConfig = {
    service,
    label: service,
    ratePercent: 0,
    agentSharePercent: 0,
    platformSharePercent: 100,
  };

  try {
    const { data, error } = await admin
      .from('service_commission_rates')
      .select('service, label, commission_percent, agent_share_percent, merchant_share_percent, hubtel_share_percent')
      .eq('service', service)
      .maybeSingle();
    if (error) {
      console.error('Commission configuration read failed:', error);
      return fallback;
    }

    const ratePercent = Number(data?.commission_percent);
    const agentSharePercent = Number(data?.agent_share_percent ?? data?.merchant_share_percent);
    const platformSharePercent = Number(data?.hubtel_share_percent);
    return {
      service,
      label: String(data?.label || service),
      ratePercent: Number.isFinite(ratePercent) ? Math.min(Math.max(ratePercent, 0), 100) : 0,
      agentSharePercent: Number.isFinite(agentSharePercent) ? Math.min(Math.max(agentSharePercent, 0), 100) : 0,
      platformSharePercent: Number.isFinite(platformSharePercent)
        ? Math.min(Math.max(platformSharePercent, 0), 100)
        : 100,
    };
  } catch (error) {
    console.error('Commission configuration read failed:', error);
    return fallback;
  }
}

export function commissionQuote(amount: number, config: CommissionConfig): CommissionQuote {
  const transactionAmount = round2(Math.max(0, Number(amount) || 0));
  const commissionAmount = round2(transactionAmount * config.ratePercent / 100);
  const agentCommissionAmount = round2(commissionAmount * config.agentSharePercent / 100);
  const platformCommissionAmount = round2(Math.max(0, commissionAmount - agentCommissionAmount));
  const walletChargeAmount = round2(Math.max(0, transactionAmount - agentCommissionAmount));
  return {
    ...config,
    transactionAmount,
    commissionAmount,
    agentCommissionAmount,
    platformCommissionAmount,
    walletChargeAmount,
  };
}
