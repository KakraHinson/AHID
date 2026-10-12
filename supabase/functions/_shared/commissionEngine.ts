/**
 * Hubtel wallet top-up fees and bill-payment commission engine.
 *
 * Two independent calculators live here:
 *
 *  1. `calculateTopUpFeeQuote` — the fee Hubtel charges to top up an agent
 *     wallet, plus how that fee is borne (customer pays it, or it is deducted
 *     from the credited amount).
 *  2. `calculateCommission` — the commission Skaitech earns on a bill payment
 *     (airtime / data / TV / utility), looked up from the service matrix.
 *
 * The schedules are data, not code: edit `TOP_UP_TIERS` / `BILL_COMMISSIONS`
 * when Hubtel confirms new rates, and the calculators follow. Every money
 * value is rounded to two decimals with a single shared helper so the fee, the
 * charge and the credit can never disagree.
 */

export type TopUpChannel = 'MTN_MOMO' | 'TELECEL_CASH' | 'AT_MONEY' | 'BANK_TRANSFER';

/** Who absorbs the top-up fee. */
export type TopUpFeeStrategy =
  /** EXCLUSIVE: the customer pays the fee on top — Total Charged = amount + fee. */
  | 'EXCLUSIVE'
  /** INCLUSIVE: the fee comes out of the top-up — Wallet Credited = amount - fee. */
  | 'INCLUSIVE';

export type BillCategory = 'Data' | 'Airtime' | 'TV' | 'Utilities';

export type BillServiceKey =
  | 'DATA_AT'
  | 'DATA_TELECEL'
  | 'DATA_MTN'
  | 'AIRTIME_AT'
  | 'AIRTIME_TELECEL'
  | 'AIRTIME_GLO'
  | 'AIRTIME_MTN'
  | 'TV_GOTV'
  | 'TV_DSTV'
  | 'TV_STARTIMES'
  | 'UTILITY_ECG_PREPAID'
  | 'UTILITY_ECG_POSTPAID'
  | 'UTILITY_WATER';

/** Smallest top-up with a fee tier; anything smaller has no rate to apply. */
export const MIN_TOPUP_AMOUNT = 0.01;
/** Largest top-up the schedule accepts. */
export const MAX_TOPUP_AMOUNT = 30000;

export class InvalidAmountError extends Error {
  constructor(amount: number) {
    super(
      `Invalid amount GHS ${amount}. The amount must be greater than 0.00 and at most ${MAX_TOPUP_AMOUNT.toFixed(2)}.`,
    );
    this.name = 'InvalidAmountError';
  }
}

export class UnknownBillServiceError extends Error {
  constructor(service: string) {
    super(`No commission rate is configured for service "${service}".`);
    this.name = 'UnknownBillServiceError';
  }
}

/**
 * One row of the top-up fee schedule. `percent` tiers charge a percentage of
 * the principal; fixed tiers charge a flat fee, with an optional override for
 * the TELECEL_CASH channel.
 */
type TopUpTier = {
  min: number;
  max: number;
} & (
  | { kind: 'percent'; percent: number }
  | { kind: 'fixed'; fee: number; telecelFee?: number }
);

export const TOP_UP_TIERS: readonly TopUpTier[] = [
  { min: 0.01, max: 1.0, kind: 'fixed', fee: 0.01 },
  { min: 1.01, max: 10.0, kind: 'fixed', fee: 0.1 },
  { min: 10.01, max: 50.0, kind: 'fixed', fee: 0.5 },
  { min: 50.01, max: 500.0, kind: 'percent', percent: 1.0 },
  { min: 500.01, max: 1000.0, kind: 'fixed', fee: 5.0 },
  { min: 1000.01, max: MAX_TOPUP_AMOUNT, kind: 'fixed', fee: 10.0, telecelFee: 17.5 },
];

const TOP_UP_CHANNELS: readonly TopUpChannel[] = ['MTN_MOMO', 'TELECEL_CASH', 'AT_MONEY', 'BANK_TRANSFER'];

export const BILL_COMMISSIONS: Record<BillServiceKey, { category: BillCategory; ratePercent: number }> = {
  DATA_AT: { category: 'Data', ratePercent: 7.0 },
  DATA_TELECEL: { category: 'Data', ratePercent: 7.0 },
  DATA_MTN: { category: 'Data', ratePercent: 5.5 },
  AIRTIME_AT: { category: 'Airtime', ratePercent: 7.0 },
  AIRTIME_TELECEL: { category: 'Airtime', ratePercent: 7.0 },
  AIRTIME_GLO: { category: 'Airtime', ratePercent: 7.0 },
  AIRTIME_MTN: { category: 'Airtime', ratePercent: 5.5 },
  TV_GOTV: { category: 'TV', ratePercent: 1.0 },
  TV_DSTV: { category: 'TV', ratePercent: 1.0 },
  TV_STARTIMES: { category: 'TV', ratePercent: 0.95 },
  UTILITY_ECG_PREPAID: { category: 'Utilities', ratePercent: 1.9 },
  UTILITY_ECG_POSTPAID: { category: 'Utilities', ratePercent: 1.9 },
  UTILITY_WATER: { category: 'Utilities', ratePercent: 1.0 },
};

export interface TopUpFeeRequest {
  amount: number;
  channel: TopUpChannel;
  /** Defaults to EXCLUSIVE (customer pays the fee). */
  strategy?: TopUpFeeStrategy;
}

export interface TopUpFeeResult {
  amount: number;
  channel: TopUpChannel;
  strategy: TopUpFeeStrategy;
  fee: number;
  /** What the customer is actually charged for the top-up. */
  totalCharged: number;
  /** What lands in the agent wallet. */
  walletCredited: number;
}

export interface CommissionRequest {
  service: BillServiceKey;
  amount: number;
}

export interface CommissionResult {
  service: BillServiceKey;
  category: BillCategory;
  ratePercent: number;
  amount: number;
  commission: number;
}

/**
 * Rounds to two decimals, half away from zero. The epsilon nudge keeps binary
 * float representations (e.g. 1.005) from rounding down a cent.
 */
export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assertValidAmount(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new InvalidAmountError(amount);
  }
  if (amount <= 0 || amount > MAX_TOPUP_AMOUNT) {
    throw new InvalidAmountError(amount);
  }
  const principal = roundCurrency(amount);
  // Below the smallest tier there is no fee to apply, so treat it as invalid.
  if (principal < MIN_TOPUP_AMOUNT) throw new InvalidAmountError(amount);
  return principal;
}

function assertValidChannel(channel: TopUpChannel): void {
  if (!TOP_UP_CHANNELS.includes(channel)) {
    throw new Error(`Unknown top-up channel "${String(channel)}".`);
  }
}

function feeForTier(principal: number, channel: TopUpChannel, tier: (typeof TOP_UP_TIERS)[number]): number {
  if (tier.kind === 'percent') return roundCurrency(principal * (tier.percent / 100));
  if (channel === 'TELECEL_CASH' && tier.telecelFee !== undefined) return roundCurrency(tier.telecelFee);
  return roundCurrency(tier.fee);
}

/**
 * The Hubtel fee, in GHS, for topping up `amount` through `channel`.
 * Throws `InvalidAmountError` for amounts outside (0, 30,000].
 */
export function calculateTopUpFee(amount: number, channel: TopUpChannel): number {
  const principal = assertValidAmount(amount);
  assertValidChannel(channel);
  for (const tier of TOP_UP_TIERS) {
    if (principal >= tier.min && principal <= tier.max) return feeForTier(principal, channel, tier);
  }
  // assertValidAmount guarantees a matching tier; this is a belt-and-braces guard.
  throw new InvalidAmountError(amount);
}

/**
 * Full top-up breakdown: the fee plus the customer charge and wallet credit for
 * the chosen strategy. EXCLUSIVE adds the fee on top; INCLUSIVE deducts it from
 * the credited amount.
 */
export function calculateTopUpFeeQuote(request: TopUpFeeRequest): TopUpFeeResult {
  const strategy: TopUpFeeStrategy = request.strategy ?? 'EXCLUSIVE';
  const amount = assertValidAmount(request.amount);
  const fee = calculateTopUpFee(amount, request.channel);

  return {
    amount,
    channel: request.channel,
    strategy,
    fee,
    totalCharged: strategy === 'EXCLUSIVE' ? roundCurrency(amount + fee) : amount,
    walletCredited: strategy === 'EXCLUSIVE' ? amount : roundCurrency(amount - fee),
  };
}

/**
 * Commission Skaitech earns on a bill payment. Throws `UnknownBillServiceError`
 * for a service outside the matrix and `InvalidAmountError` for a bad amount.
 */
export function calculateCommission(request: CommissionRequest): CommissionResult {
  const amount = assertValidAmount(request.amount);
  const rate = BILL_COMMISSIONS[request.service];
  if (!rate) throw new UnknownBillServiceError(String(request.service));

  return {
    service: request.service,
    category: rate.category,
    ratePercent: rate.ratePercent,
    amount,
    commission: roundCurrency(amount * (rate.ratePercent / 100)),
  };
}
