/**
 * Single source of truth for product identity.
 * Renaming the product is a one-line change here plus the two package.json "name" fields.
 */
export const BRAND = {
  name: 'ScopeShield',
  tagline: 'Know what was agreed. Catch what changes. Protect every hour.',
  domain: 'scopeshield.app',
  supportEmail: 'no-reply@example.com',
  /** Bump when the deterministic classification rule set changes in a way that alters outcomes. */
  engineVersion: '1.0.0',
} as const;
