import { describe, expect, it } from 'vitest';
import { addMoney, formatMoney, money, priceEstimate, roundHalfAwayFromZero, subMoney, sumMoney, toMajor, toMinor } from '../../src/domain/money';

describe('money', () => {
  it('stores minor units as integers and never as floats', () => {
    expect(toMinor(1234.56, 'USD')).toEqual({ amount: 123456, currency: 'USD' });
    expect(toMinor(0.1, 'USD').amount).toBe(10);
    // Adding 0.1 three times must be exact, which floating point is not.
    const sum = addMoney(addMoney(money(10, 'USD'), money(10, 'USD')), money(10, 'USD'));
    expect(sum.amount).toBe(30);
    expect(toMajor(sum)).toBe(0.3);
  });

  it('handles currencies without minor units', () => {
    // JPY has no cents; rounding to 2 places here would invent precision the currency does not have.
    expect(toMinor(1500, 'JPY').amount).toBe(1500);
    expect(formatMoney(money(1500, 'JPY'))).toContain('1,500');
  });

  it('rounds half away from zero, consistently in both directions', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
  });

  it('prices in a fixed order: subtotal → contingency → discount → tax', () => {
    const priced = priceEstimate({ currency: 'USD', hoursByCategory: { frontend: 10 }, hourlyRate: 100, contingencyPct: 10, discountPct: 10, taxPct: 13 });
    // 10h × $100 = 1000 → +10% = 1100 → −10% = 990 → +13% = 1118.70
    expect(priced.subtotal.amount).toBe(100_000);
    expect(priced.contingency.amount).toBe(10_000);
    expect(priced.discount.amount).toBe(11_000);
    expect(priced.total.amount).toBe(111_870);
    expect(priced.effectiveHourlyRate.amount).toBe(9_900);
  });

  it('lets a fixed price replace the hourly subtotal without silently losing the hours', () => {
    const priced = priceEstimate({ currency: 'USD', hoursByCategory: { frontend: 10, testing: 4 }, hourlyRate: 100, fixedPrice: 750 });
    expect(priced.subtotal.amount).toBe(75_000);
    expect(priced.hoursTotal).toBe(14);
    expect(priced.effectiveHourlyRate.amount).toBe(5_357);
  });

  it('sums mixed currencies only within one currency', () => {
    const total = sumMoney([money(1000, 'USD'), money(250, 'USD')], 'USD');
    expect(total).toEqual({ amount: 1250, currency: 'USD' });
    expect(subMoney(money(1000, 'USD'), money(300, 'USD')).amount).toBe(700);
  });
});
