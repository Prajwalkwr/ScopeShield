/**
 * Money is stored and computed in integer minor units (cents, paisa, …) to avoid
 * binary floating-point drift. Hours and percentages are decimals, but every
 * multiplication that produces money rounds through `roundHalfAwayFromZero` and the
 * rounding points are explicit in `priceEstimate` below.
 *
 * Pipeline order (documented because order changes the result):
 *   subtotal   = Σ round(hours_i × rate_i)
 *   contingency= round(subtotal × contingencyPct)      [added]
 *   discounted = round((subtotal + contingency) × (1 − discountPct))
 *   tax        = round(discounted × taxPct)            [added]
 *   total      = discounted + tax
 */

export interface Money {
  /** Integer amount in minor units. */
  amount: number;
  /** ISO 4217 code. */
  currency: string;
}

export const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF']);

export function minorUnitsPerUnit(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

export function toMinor(amount: number, currency: string): Money {
  return { amount: Math.round(amount * minorUnitsPerUnit(currency)), currency: currency.toUpperCase() };
}

export function toMajor(money: Money): number {
  return money.amount / minorUnitsPerUnit(money.currency);
}

export function roundHalfAwayFromZero(value: number): number {
  return value >= 0 ? Math.round(value) : -Math.round(-value);
}

export function money(amount: number, currency: string): Money {
  return { amount: roundHalfAwayFromZero(amount), currency: currency.toUpperCase() };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

/** Multiply a money value by a factor (hours × rate), rounding to minor units. */
export function multiplyMoney(a: Money, factor: number): Money {
  return money(a.amount * factor, a.currency);
}

export function sumMoney(values: Money[], currency: string): Money {
  return values.reduce((acc, v) => addMoney(acc, v), money(0, currency));
}

export interface PricedEstimate {
  currency: string;
  hoursTotal: number;
  /** Sum of hours × rate, before contingency/discount/tax. */
  subtotal: Money;
  contingency: Money;
  discount: Money;
  tax: Money;
  total: Money;
  effectiveHourlyRate: Money;
}

export interface PriceInput {
  currency: string;
  /** Per-category hours. */
  hoursByCategory: Record<string, number>;
  /** Hourly billing rate in major units (client-facing). */
  hourlyRate: number;
  contingencyPct?: number;
  discountPct?: number;
  taxPct?: number;
  /** Optional fixed-price override; when set it replaces the hours×rate subtotal. */
  fixedPrice?: number | null;
}

export function priceEstimate(input: PriceInput): PricedEstimate {
  const currency = input.currency.toUpperCase();
  const hoursTotal = Object.values(input.hoursByCategory).reduce((s, h) => s + (Number.isFinite(h) ? h : 0), 0);
  const rate = Math.max(0, input.hourlyRate);

  const subtotal =
    input.fixedPrice !== null && input.fixedPrice !== undefined
      ? toMinor(input.fixedPrice, currency)
      : toMinor(rate * hoursTotal, currency);

  const contingency = money(roundHalfAwayFromZero(subtotal.amount * ((input.contingencyPct ?? 0) / 100)), currency);
  const afterContingency = addMoney(subtotal, contingency);

  const discountPct = Math.min(Math.max(input.discountPct ?? 0, 0), 100);
  const discounted = money(
    roundHalfAwayFromZero(afterContingency.amount * (1 - discountPct / 100)),
    currency,
  );
  const discount = subMoney(afterContingency, discounted);

  const tax = money(roundHalfAwayFromZero(discounted.amount * ((input.taxPct ?? 0) / 100)), currency);
  const total = addMoney(discounted, tax);

  const effectiveHourlyRate =
    hoursTotal > 0 ? money(roundHalfAwayFromZero(discounted.amount / hoursTotal), currency) : money(0, currency);

  return { currency, hoursTotal, subtotal, contingency, discount, tax, total, effectiveHourlyRate };
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', NPR: 'रू', AUD: 'A$', CAD: 'C$' };

export function formatMoney(m: Money, locale = 'en-US'): string {
  const per = minorUnitsPerUnit(m.currency);
  const major = m.amount / per;
  const digits = per === 1 ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${SYMBOLS[m.currency] ?? ''}${major.toFixed(digits)} ${m.currency}`;
  }
}

/** Guard against absurd inputs reaching pricing (e.g. hours: 1e12). */
export const MAX_HOURS_PER_ESTIMATE = 10_000;
export const MAX_RATE = 10_000;
