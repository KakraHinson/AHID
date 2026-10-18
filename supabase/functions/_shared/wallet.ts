import { adminClient } from './supabase.ts';

export class WalletError extends Error {
  readonly code: 'insufficient' | 'other';
  constructor(message: string, code: 'insufficient' | 'other' = 'other') {
    super(message);
    this.code = code;
  }
}

/**
 * Atomically debits an agent wallet and records the ledger entry.
 * Returns the new wallet balance.
 */
export async function chargeWallet(
  agentId: string,
  reference: string,
  amount: number,
  description = 'Service purchase',
  meta: Record<string, unknown> = {},
): Promise<number> {
  const { data, error } = await adminClient().rpc('charge_agent_wallet', {
    p_agent_id: agentId,
    p_reference: reference,
    p_amount: amount,
    p_description: description,
    p_meta: meta,
  });
  if (error) {
    if (String(error.message || '').toLowerCase().includes('insufficient')) {
      throw new WalletError(String(error.message), 'insufficient');
    }
    throw new WalletError(String(error.message || 'Failed to charge wallet.'));
  }
  return Number(data);
}

/**
 * Atomically reverses a previous wallet debit. Idempotent.
 * Returns the new wallet balance.
 */
export async function refundWallet(
  agentId: string,
  debitReference: string,
  amount: number,
  reason = 'Refund for failed service',
): Promise<number> {
  const { data, error } = await adminClient().rpc('refund_agent_wallet', {
    p_agent_id: agentId,
    p_debit_reference: debitReference,
    p_amount: amount,
    p_reason: reason,
  });
  if (error) {
    throw new WalletError(String(error.message || 'Failed to refund wallet.'));
  }
  return Number(data);
}

/**
 * Atomically credits an agent wallet (e.g. for store sales profit) and records the ledger entry.
 * Returns the new wallet balance.
 */
export async function creditWallet(
  agentId: string,
  reference: string,
  amount: number,
  description = 'Store profit commission',
  meta: Record<string, unknown> = {},
): Promise<number> {
  if (amount <= 0) {
    return await getWalletBalance(agentId);
  }
  const admin = adminClient();
  const { data, error } = await admin.rpc('credit_agent_wallet', {
    p_agent_id: agentId,
    p_reference: reference,
    p_amount: amount,
    p_description: description,
    p_meta: meta,
  });

  if (error) {
    // Resilient fallback if RPC is not present
    const { data: wallet } = await admin
      .from('wallets')
      .select('balance')
      .eq('id', agentId)
      .maybeSingle();
    const current = Number(wallet?.balance || 0);
    const balanceAfter = Math.round((current + amount) * 100) / 100;

    await admin.from('wallets').upsert({
      id: agentId,
      balance: balanceAfter,
      updated_at: new Date().toISOString(),
    });

    await admin.from('wallet_transactions').insert({
      agent_id: agentId,
      reference,
      type: 'credit',
      description,
      amount,
      balance_after: balanceAfter,
      status: 'settled',
      meta,
    });

    return balanceAfter;
  }
  return Number(data);
}

export async function getWalletBalance(agentId: string): Promise<number> {
  const { data, error } = await adminClient()
    .from('wallets')
    .select('balance')
    .eq('id', agentId)
    .maybeSingle();
  if (error) return Number.NaN;
  return Number(data?.balance ?? 0);
}