import { describe, expect, it } from 'vitest';
import { addWorkingDays, computeScheduleImpact, countWorkingDays } from '../../src/domain/schedule';

const calendar = { workingDays: [1, 2, 3, 4, 5], holidays: ['2026-10-20'] };

describe('schedule impact', () => {
  it('skips weekends when adding working days', () => {
    // Friday 2026-10-16 + 1 working day = Monday 2026-10-19
    expect(addWorkingDays(new Date('2026-10-16T00:00:00Z'), 1, calendar).toISOString().slice(0, 10)).toBe('2026-10-19');
  });

  it('skips configured holidays', () => {
    // Monday 2026-10-19 + 1 working day would be the 20th, which is a holiday.
    expect(addWorkingDays(new Date('2026-10-19T00:00:00Z'), 1, calendar).toISOString().slice(0, 10)).toBe('2026-10-21');
  });

  it('counts the working days AFTER the start date, not including it', () => {
    // Monday to Friday = four remaining working days (Tue, Wed, Thu, Fri).
    expect(countWorkingDays(new Date('2026-10-12T00:00:00Z'), new Date('2026-10-16T00:00:00Z'), calendar)).toBe(4);
    expect(countWorkingDays(new Date('2026-10-16T00:00:00Z'), new Date('2026-10-16T00:00:00Z'), calendar)).toBe(0);
  });

  it('converts hours to days using real capacity, not a fantasy 8-hour day', () => {
    const impact = computeScheduleImpact({
      additionalHours: 24,
      hoursPerPersonDay: 6,
      people: 1,
      availability: 1,
      startDate: new Date('2026-10-12T00:00:00Z'),
      calendar,
      floatDays: 10,
      currentTargetDate: new Date('2026-11-30T00:00:00Z'),
    });
    expect(impact.capacityPerDay).toBe(6);
    // 24h at 6h/day = 4 working days, which fits inside the 10 days of float.
    expect(impact.additionalWorkdays).toBe(4);
    expect(impact.slippageWorkdays).toBe(0);
    expect(impact.targetBreached).toBe(false);
    expect(impact.assumptions.join(' ')).toMatch(/6h of productive work/);
  });

  it('absorbs work inside existing float and only reports slippage beyond it', () => {
    const impact = computeScheduleImpact({
      additionalHours: 30,
      startDate: new Date('2026-10-12T00:00:00Z'),
      calendar,
      floatDays: 10,
      currentTargetDate: new Date('2026-11-30T00:00:00Z'),
    });
    expect(impact.slippageWorkdays).toBe(0);
    expect(impact.targetBreached).toBe(false);
  });

  it('reports a breach when the added work exceeds the float', () => {
    const impact = computeScheduleImpact({
      additionalHours: 120,
      startDate: new Date('2026-10-12T00:00:00Z'),
      calendar,
      floatDays: 2,
      currentTargetDate: new Date('2026-10-20T00:00:00Z'),
    });
    expect(impact.slippageWorkdays).toBeGreaterThan(0);
    expect(impact.targetBreached).toBe(true);
    expect(impact.warnings.length).toBeGreaterThan(0);
  });

  it('states assumptions explicitly rather than presenting a guess as a fact', () => {
    const impact = computeScheduleImpact({ additionalHours: 12, startDate: new Date('2026-10-12T00:00:00Z') });
    expect(impact.assumptions.length).toBeGreaterThan(0);
    // Without a recorded float, the honest answer is "we do not know", and it says so.
    expect(impact.warnings.join(' ')).toMatch(/float/i);
    expect(impact.confidence).toBe('low');
  });
});
