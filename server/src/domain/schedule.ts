/**
 * Working-calendar and capacity-aware schedule impact.
 *
 * Deliberately NOT "add all hours to the end date". Additional effort is divided by
 * realistic daily capacity for the people who can actually do the work, then projected
 * across working days only. When capacity or assignment data is missing, the estimate
 * says so instead of pretending to be precise.
 */

export interface CalendarConfig {
  /** ISO weekday numbers: 0 = Sunday … 6 = Saturday. Default Mon–Fri. */
  workingDays: number[];
  /** ISO dates (YYYY-MM-DD) that are non-working regardless of weekday. */
  holidays: string[];
}

export const DEFAULT_CALENDAR: CalendarConfig = { workingDays: [1, 2, 3, 4, 5], holidays: [] };

export interface ScheduleImpactInput {
  /** Hours of additional work. */
  additionalHours: number;
  /** Productive hours per person per day. Default 6 (meetings/admin excluded). */
  hoursPerPersonDay?: number;
  /** Number of people who can work on this in parallel. Default 1 (conservative). */
  people?: number;
  /** 0..1 fraction of those people's time actually available. Default 1. */
  availability?: number;
  startDate: Date;
  calendar?: CalendarConfig;
  /** Remaining float before the current committed target is breached. */
  floatDays?: number | null;
  /** Existing committed target date. */
  currentTargetDate?: Date | null;
}

export interface ScheduleImpact {
  additionalHours: number;
  /** Effective hours absorbable per working day. */
  capacityPerDay: number;
  /** Working days required, rounded up. */
  additionalWorkdays: number;
  projectedEndDate: string;
  currentTargetDate: string | null;
  /** Working days added beyond the current target (0 when float absorbs it). */
  slippageWorkdays: number;
  targetBreached: boolean;
  confidence: 'low' | 'medium' | 'high';
  /** Every figure a human might dispute, stated explicitly. */
  assumptions: string[];
  warnings: string[];
}

export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWorkingDay(date: Date, calendar: CalendarConfig): boolean {
  return calendar.workingDays.includes(date.getUTCDay()) && !calendar.holidays.includes(toDateOnly(date));
}

export function addWorkingDays(start: Date, days: number, calendar: CalendarConfig = DEFAULT_CALENDAR): Date {
  if (days <= 0) return new Date(start);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  let added = 0;
  // Bounded loop: 5 years of working days, to make a malformed calendar impossible to hang on.
  let guard = 0;
  while (added < days && guard < 5000) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkingDay(cursor, calendar)) added += 1;
    guard += 1;
  }
  return cursor;
}

export function countWorkingDays(from: Date, to: Date, calendar: CalendarConfig = DEFAULT_CALENDAR): number {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  if (end <= start) return 0;
  let count = 0;
  let guard = 0;
  while (start < end && guard < 5000) {
    start.setUTCDate(start.getUTCDate() + 1);
    if (isWorkingDay(start, calendar)) count += 1;
    guard += 1;
  }
  return count;
}

export function computeScheduleImpact(input: ScheduleImpactInput): ScheduleImpact {
  const calendar = input.calendar ?? DEFAULT_CALENDAR;
  const hoursPerPersonDay = input.hoursPerPersonDay ?? 6;
  const people = Math.max(1, input.people ?? 1);
  const availability = Math.min(Math.max(input.availability ?? 1, 0.05), 1);
  const assumptions: string[] = [];
  const warnings: string[] = [];

  if (input.additionalHours <= 0) {
    return {
      additionalHours: 0,
      capacityPerDay: hoursPerPersonDay * people * availability,
      additionalWorkdays: 0,
      projectedEndDate: toDateOnly(input.currentTargetDate ?? input.startDate),
      currentTargetDate: input.currentTargetDate ? toDateOnly(input.currentTargetDate) : null,
      slippageWorkdays: 0,
      targetBreached: false,
      confidence: 'high',
      assumptions: ['No additional effort was recorded, so no schedule change is projected.'],
      warnings: [],
    };
  }

  const capacityPerDay = Math.max(0.5, hoursPerPersonDay * people * availability);
  const additionalWorkdays = Math.ceil(input.additionalHours / capacityPerDay);

  assumptions.push(`${hoursPerPersonDay}h of productive work per person per day (administrative time excluded).`);
  assumptions.push(
    people === 1
      ? 'Assumes one person can work on this; no parallelism was configured.'
      : `Assumes ${people} people can work on this in parallel without contention.`,
  );
  if (availability < 1) assumptions.push(`Assumes ${(availability * 100).toFixed(0)}% of those people's time is available.`);
  assumptions.push(`Working days: ${calendar.workingDays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}${calendar.holidays.length ? `, excluding ${calendar.holidays.length} holiday(s)` : ''}.`);

  const projectionStart = input.currentTargetDate && input.currentTargetDate > input.startDate ? input.currentTargetDate : input.startDate;
  const projectedEndDate = addWorkingDays(projectionStart, additionalWorkdays, calendar);

  const float = input.floatDays ?? null;
  const slippageWorkdays = float === null ? additionalWorkdays : Math.max(0, additionalWorkdays - float);
  const targetBreached = slippageWorkdays > 0;

  if (float === null) {
    warnings.push('No schedule float is recorded for this project, so the full additional duration is shown as slippage.');
    assumptions.push('Slippage is measured from the current target date, not from today.');
  } else if (targetBreached) {
    warnings.push(`This would push delivery ${slippageWorkdays} working day(s) beyond the committed target.`);
  }

  if (people === 1 && additionalWorkdays > 10) {
    warnings.push('More than two weeks of projected work by a single person — check whether this should be split across the team or deferred.');
  }
  if (calendar.holidays.length === 0) {
    assumptions.push('No holidays are configured for this project calendar.');
  }

  const confidence: ScheduleImpact['confidence'] =
    people > 1 && float !== null && calendar.holidays.length > 0 ? 'high' : float !== null ? 'medium' : 'low';

  return {
    additionalHours: input.additionalHours,
    capacityPerDay: Number(capacityPerDay.toFixed(2)),
    additionalWorkdays,
    projectedEndDate: toDateOnly(projectedEndDate),
    currentTargetDate: input.currentTargetDate ? toDateOnly(input.currentTargetDate) : null,
    slippageWorkdays,
    targetBreached,
    confidence,
    assumptions,
    warnings,
  };
}
