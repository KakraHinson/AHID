import {
  BILL_COMMISSIONS,
  InvalidAmountError,
  type BillServiceKey,
  type TopUpChannel,
  UnknownBillServiceError,
  calculateCommission,
  calculateTopUpFee,
  calculateTopUpFeeQuote,
  roundCurrency,
} from './commissionEngine.ts';

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message ? message + ': ' : ''}expected ${b}, got ${a}`);
  }
}

function assertThrows(fn: () => unknown, ctor: new (...args: never[]) => Error, message?: string): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof ctor) return;
    throw new Error(`${message ? message + ': ' : ''}expected ${ctor.name}, got ${String(err)}`);
  }
  throw new Error(`${message ? message + ': ' : ''}expected ${ctor.name}, but nothing was thrown`);
}

const NON_TELECEL: TopUpChannel[] = ['MTN_MOMO', 'AT_MONEY', 'BANK_TRANSFER'];

Deno.test('roundCurrency uses half-away-from-zero financial rounding', () => {
  assertEquals(roundCurrency(1.005), 1.01);
  assertEquals(roundCurrency(0.1 + 0.2), 0.3);
  assertEquals(roundCurrency(2.675), 2.68);
  assertEquals(roundCurrency(7.005), 7.01);
  assertEquals(roundCurrency(10), 10);
});

Deno.test('top-up fee tier: 0.01 - 1.00 is a fixed GHS 0.01', () => {
  for (const channel of [...NON_TELECEL, 'TELECEL_CASH' as TopUpChannel]) {
    assertEquals(calculateTopUpFee(0.01, channel), 0.01);
    assertEquals(calculateTopUpFee(0.5, channel), 0.01);
    assertEquals(calculateTopUpFee(1.0, channel), 0.01, `boundary 1.00 on ${channel}`);
  }
});

Deno.test('top-up fee tier: 1.01 - 10.00 is a fixed GHS 0.10', () => {
  assertEquals(calculateTopUpFee(1.01, 'MTN_MOMO'), 0.1, 'just above the 1.00 boundary');
  assertEquals(calculateTopUpFee(5, 'MTN_MOMO'), 0.1);
  assertEquals(calculateTopUpFee(10.0, 'MTN_MOMO'), 0.1, 'boundary 10.00');
});

Deno.test('top-up fee tier: 10.01 - 50.00 is a fixed GHS 0.50', () => {
  assertEquals(calculateTopUpFee(10.01, 'MTN_MOMO'), 0.5, 'just above the 10.00 boundary');
  assertEquals(calculateTopUpFee(50.0, 'MTN_MOMO'), 0.5, 'boundary 50.00');
});

Deno.test('top-up fee tier: 50.01 - 500.00 is 1.0% of the principal', () => {
  assertEquals(calculateTopUpFee(50.01, 'MTN_MOMO'), 0.5, '50.01 * 1% = 0.5001 -> 0.50');
  assertEquals(calculateTopUpFee(100, 'MTN_MOMO'), 1.0);
  assertEquals(calculateTopUpFee(500.0, 'MTN_MOMO'), 5.0, 'boundary 500.00 * 1% = 5.00');
});

Deno.test('top-up fee tier: 500.01 - 1,000.00 is a fixed GHS 5.00', () => {
  assertEquals(calculateTopUpFee(500.01, 'MTN_MOMO'), 5.0, 'just above the 500.00 boundary');
  assertEquals(calculateTopUpFee(1000.0, 'MTN_MOMO'), 5.0, 'boundary 1,000.00');
});

Deno.test('top-up fee tier: 1,000.01 - 30,000.00 is GHS 10.00, but GHS 17.50 for TELECEL_CASH', () => {
  assertEquals(calculateTopUpFee(1000.01, 'MTN_MOMO'), 10.0, 'just above the 1,000.00 boundary');
  assertEquals(calculateTopUpFee(30000, 'MTN_MOMO'), 10.0, 'upper boundary');
  assertEquals(calculateTopUpFee(1000.01, 'TELECEL_CASH'), 17.5);
  assertEquals(calculateTopUpFee(30000, 'TELECEL_CASH'), 17.5);
  for (const channel of NON_TELECEL) {
    assertEquals(calculateTopUpFee(5000, channel), 10.0, `non-Telecel channel ${channel}`);
  }
});

Deno.test('top-up fee rejects amounts outside (0, 30,000]', () => {
  assertThrows(() => calculateTopUpFee(0, 'MTN_MOMO'), InvalidAmountError);
  assertThrows(() => calculateTopUpFee(0.001, 'MTN_MOMO'), InvalidAmountError, 'below the smallest tier');
  assertThrows(() => calculateTopUpFee(-5, 'MTN_MOMO'), InvalidAmountError);
  assertThrows(() => calculateTopUpFee(30000.01, 'MTN_MOMO'), InvalidAmountError);
  assertThrows(() => calculateTopUpFee(Number.NaN, 'MTN_MOMO'), InvalidAmountError);
  assertThrows(() => calculateTopUpFee(100, 'CARD' as TopUpChannel), Error, 'unknown channel');
});

Deno.test('EXCLUSIVE strategy: customer pays amount + fee', () => {
  const quote = calculateTopUpFeeQuote({ amount: 100, channel: 'MTN_MOMO' });
  assertEquals(quote.strategy, 'EXCLUSIVE', 'default strategy');
  assertEquals(quote, {
    amount: 100,
    channel: 'MTN_MOMO',
    strategy: 'EXCLUSIVE',
    fee: 1.0,
    totalCharged: 101.0,
    walletCredited: 100.0,
  });
});

Deno.test('INCLUSIVE strategy: fee is deducted from the wallet credit', () => {
  const quote = calculateTopUpFeeQuote({ amount: 100, channel: 'MTN_MOMO', strategy: 'INCLUSIVE' });
  assertEquals(quote.fee, 1.0);
  assertEquals(quote.totalCharged, 100.0);
  assertEquals(quote.walletCredited, 99.0);
});

Deno.test('INCLUSIVE quote is rounded to two decimals', () => {
  const quote = calculateTopUpFeeQuote({ amount: 50.01, channel: 'MTN_MOMO', strategy: 'INCLUSIVE' });
  assertEquals(quote.fee, 0.5);
  assertEquals(quote.walletCredited, 49.51);
});

Deno.test('commission matrix matches every published rate', () => {
  const expected: Record<BillServiceKey, number> = {
    DATA_AT: 7.0,
    DATA_TELECEL: 7.0,
    DATA_MTN: 5.5,
    AIRTIME_AT: 7.0,
    AIRTIME_TELECEL: 7.0,
    AIRTIME_GLO: 7.0,
    AIRTIME_MTN: 5.5,
    TV_GOTV: 1.0,
    TV_DSTV: 1.0,
    TV_STARTIMES: 0.95,
    UTILITY_ECG_PREPAID: 1.9,
    UTILITY_ECG_POSTPAID: 1.9,
    UTILITY_WATER: 1.0,
  };
  for (const [service, ratePercent] of Object.entries(expected)) {
    assertEquals(BILL_COMMISSIONS[service as BillServiceKey].ratePercent, ratePercent, service);
  }
});

Deno.test('commission is the rate applied to the transaction value', () => {
  assertEquals(calculateCommission({ service: 'DATA_MTN', amount: 100 }).commission, 5.5);
  assertEquals(calculateCommission({ service: 'DATA_AT', amount: 100 }).commission, 7.0);
  assertEquals(calculateCommission({ service: 'AIRTIME_MTN', amount: 100 }).commission, 5.5);
  assertEquals(calculateCommission({ service: 'AIRTIME_GLO', amount: 100 }).commission, 7.0);
  assertEquals(calculateCommission({ service: 'TV_GOTV', amount: 100 }).commission, 1.0);
  assertEquals(calculateCommission({ service: 'TV_STARTIMES', amount: 100 }).commission, 0.95);
  assertEquals(calculateCommission({ service: 'UTILITY_ECG_PREPAID', amount: 100 }).commission, 1.9);
  assertEquals(calculateCommission({ service: 'UTILITY_WATER', amount: 100 }).commission, 1.0);
});

Deno.test('commission carries the category and rounds to two decimals', () => {
  const data = calculateCommission({ service: 'DATA_AT', amount: 99.99 });
  assertEquals(data.category, 'Data');
  assertEquals(data.ratePercent, 7.0);
  assertEquals(data.amount, 99.99);
  assertEquals(data.commission, 7.0, '99.99 * 7% = 6.9993 -> 7.00');
  assertEquals(calculateCommission({ service: 'UTILITY_ECG_POSTPAID', amount: 123.45 }).category, 'Utilities');
  assertEquals(calculateCommission({ service: 'TV_DSTV', amount: 150 }).category, 'TV');
});

Deno.test('commission rejects unknown services and invalid amounts', () => {
  assertThrows(() => calculateCommission({ service: 'DATA_VODAFONE' as BillServiceKey, amount: 10 }), UnknownBillServiceError);
  assertThrows(() => calculateCommission({ service: 'DATA_MTN', amount: 0 }), InvalidAmountError);
  assertThrows(() => calculateCommission({ service: 'DATA_MTN', amount: 30001 }), InvalidAmountError);
});
