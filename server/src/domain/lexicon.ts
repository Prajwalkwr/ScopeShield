/**
 * Domain lexicon. This is *deterministic domain knowledge*, not AI: curated keyword
 * groups used to (a) boost matching, (b) suggest scrutiny questions, and (c) propose a
 * starting effort shape that a human must confirm.
 *
 * All suggested hours are explicitly labelled SUGGESTED_UNVERIFIED in the API response —
 * they are never written into a client-facing price without a human finalising them.
 */

export interface ConceptRule {
  id: string;
  label: string;
  /** Stemmed keywords; matched against tokenised request text. */
  keywords: string[];
  /** Scrutiny questions a reviewer should resolve before estimating. */
  questions: string[];
  /** Suggested effort shape (hours). Marked unverified in UI. */
  suggestedHours: Partial<Record<EffortCategory, number>>;
}

export type EffortCategory =
  | 'analysis'
  | 'design'
  | 'frontend'
  | 'backend'
  | 'testing'
  | 'pm'
  | 'integration'
  | 'deployment'
  | 'other';

export const EFFORT_CATEGORIES: EffortCategory[] = [
  'analysis', 'design', 'frontend', 'backend', 'testing', 'pm', 'integration', 'deployment', 'other',
];

export const CONCEPTS: ConceptRule[] = [
  {
    id: 'booking',
    label: 'Scheduling / booking',
    keywords: ['book', 'booking', 'appointment', 'reservation', 'reserve', 'schedul', 'slot', 'availability', 'calend'],
    questions: [
      'Which calendar or provider supplies availability (internal, Google Calendar, Calendly, other)?',
      'How long is a slot, and how many bookings may overlap?',
      'What happens on no-show, cancellation and rescheduling?',
      'Which confirmation channels are required (email, SMS, WhatsApp)?',
      'Is a deposit or payment required to complete a booking?',
    ],
    suggestedHours: { analysis: 2, design: 4, frontend: 10, backend: 14, testing: 6, pm: 2, integration: 6 },
  },
  {
    id: 'authentication',
    label: 'Accounts / authentication',
    keywords: ['login', 'log', 'signup', 'register', 'registration', 'password', 'auth', 'account', 'sso', 'otp', 'session', 'role', 'permission'],
    questions: [
      'Do all visitors need accounts, or only a restricted group?',
      'How are password resets delivered, and is 2FA required?',
      'Which roles exist and what may each role see or do?',
      'Is email verification required before first sign-in?',
      'Are social or single-sign-on providers expected?',
    ],
    suggestedHours: { analysis: 3, design: 4, frontend: 12, backend: 18, testing: 8, pm: 2 },
  },
  {
    id: 'payments',
    label: 'Payments / commerce',
    keywords: [
      'payment', 'pay', 'checkout', 'cart', 'stripe', 'paypal', 'invoice', 'card', 'gateway', 'esewa', 'khalti',
      'refund', 'subscription', 'price', 'billing',
      // Deposits, advances and no-show fees are payment flows even when the word "payment" never appears.
      'deposit', 'prepay', 'advance payment', 'no-show fee',
    ],
    questions: [
      'Which payment provider and currency are required?',
      'Is the charge one-off, recurring or usage-based?',
      'Who bears transaction fees, and how are refunds handled?',
      'Are invoices or receipts required, and who issues them?',
      'Which tax rules apply to the transaction?',
    ],
    suggestedHours: { analysis: 4, design: 3, frontend: 10, backend: 16, testing: 8, pm: 2, integration: 8 },
  },
  {
    id: 'dashboard',
    label: 'Admin dashboard / CMS',
    keywords: ['dashboard', 'admin', 'panel', 'cms', 'backend', 'manage', 'crud', 'report', 'analytic', 'chart'],
    questions: [
      'Which exact records must be creatable, editable and deletable?',
      'Which roles can access each area of the dashboard?',
      'What reporting or export formats are needed?',
      'Is an audit trail of changes required?',
      'Do you need bulk actions or import?',
    ],
    suggestedHours: { analysis: 3, design: 6, frontend: 20, backend: 20, testing: 8, pm: 3 },
  },
  {
    id: 'content_pages',
    label: 'Additional content pages',
    keywords: ['page', 'section', 'content', 'copy', 'text', 'blog', 'article', 'faq', 'landing', 'pricing'],
    questions: [
      'How many pages, and who supplies the copy and imagery?',
      'Does each page need a custom layout or an existing template?',
      'Is the content editable by your team after launch?',
      'Are SEO fields (title, description, slug) required per page?',
    ],
    suggestedHours: { design: 3, frontend: 6, backend: 2, testing: 2, pm: 1 },
  },
  {
    id: 'localisation',
    label: 'Localisation / multi-language',
    keywords: [
      'language', 'translat', 'localis', 'localiz', 'multilingual', 'locale', 'nepali', 'english', 'spanish', 'arabic',
      'french', 'german', 'hindi', 'i18n', 'language switcher', 'bilingual',
    ],
    questions: [
      'Which languages, and who supplies reviewed translations?',
      'Must all content be translatable, or only static interface text?',
      'Is right-to-left layout support required?',
      'Should URL structure change per language, and how does SEO handle it?',
    ],
    suggestedHours: { analysis: 4, design: 4, frontend: 12, backend: 10, testing: 5, pm: 2 },
  },
  {
    id: 'integrations',
    label: 'Third-party integration',
    keywords: [
      'integrat', 'api', 'webhook', 'sync', 'connect', 'crm', 'erp', 'mailchimp', 'hubspot', 'zapier',
      'export', 'import', 'newsletter', 'third-party', 'third party', 'webhook',
    ],
    questions: [
      'Which system, which endpoint and who owns its credentials?',
      'Is the integration one-way or two-way, and how often must it sync?',
      'What happens when the third party is unavailable or rate-limits us?',
      'Is there a sandbox environment available for testing?',
      'Who is responsible for failures originating in the third-party system?',
    ],
    suggestedHours: { analysis: 4, backend: 16, testing: 6, pm: 2, integration: 10 },
  },
  {
    id: 'notifications',
    label: 'Notifications / messaging',
    keywords: ['notif', 'email', 'sms', 'whatsapp', 'push', 'reminder', 'alert', 'newsletter', 'messaging'],
    questions: [
      'Which events trigger a message, and who receives it?',
      'Which channels, and do you have an account with the provider?',
      'Do the messages need templates, branding or localisation?',
      'Is opt-in/consent evidence required for each recipient?',
    ],
    suggestedHours: { analysis: 2, design: 2, backend: 8, testing: 4, pm: 1 },
  },
  {
    id: 'mobile_app',
    label: 'Native mobile application',
    keywords: ['ios', 'android', 'mobile app', 'native', 'app store', 'play store', 'flutter', 'react native'],
    questions: [
      'Are you requesting a native app in addition to the responsive website?',
      'Which platforms, and who owns store accounts and review submissions?',
      'Which features must work offline?',
      'How will releases be maintained after launch?',
    ],
    suggestedHours: { analysis: 8, design: 16, frontend: 60, backend: 24, testing: 20, pm: 8, deployment: 8 },
  },
  {
    id: 'search',
    label: 'Search / filtering',
    keywords: ['search', 'filter', 'facet', 'sort', 'query', 'autocomplete'],
    questions: [
      'What must be searchable, and what fields are filterable?',
      'How should results rank, and is fuzzy matching expected?',
      'What result volume must remain fast?',
    ],
    suggestedHours: { analysis: 2, frontend: 8, backend: 10, testing: 4, pm: 1 },
  },
  {
    id: 'media',
    label: 'Media uploads / gallery',
    keywords: ['upload', 'gallery', 'image', 'photo', 'video', 'media', 'file', 'attachment'],
    questions: [
      'Which file types and maximum sizes must be supported?',
      'Is resizing, cropping or transcoding required?',
      'Who may upload, and is moderation needed?',
      'Where should assets be hosted and for how long?',
    ],
    suggestedHours: { design: 3, frontend: 8, backend: 8, testing: 4, pm: 1 },
  },
  {
    id: 'analytics',
    label: 'Analytics / reporting',
    keywords: ['analytic', 'tracking', 'gtag', 'ga4', 'metric', 'kpi', 'report', 'export', 'csv', 'pdf'],
    questions: [
      'Which questions must the reporting answer?',
      'Which date ranges and groupings are needed?',
      'What export formats are required, and who may export?',
      'Is dashboard access role-restricted?',
    ],
    suggestedHours: { analysis: 3, frontend: 10, backend: 12, testing: 5, pm: 2 },
  },
  {
    id: 'performance',
    label: 'Performance work',
    keywords: ['performance', 'speed', 'optimi', 'lighthouse', 'core web vitals', 'slow', 'cache'],
    questions: [
      'What is the current measured baseline, and on which connection/device?',
      'Which target metric and threshold define success?',
      'Which pages are in scope for optimisation?',
    ],
    suggestedHours: { analysis: 3, frontend: 8, backend: 6, testing: 4, pm: 1 },
  },
  {
    id: 'design_change',
    label: 'Design / visual revision',
    keywords: ['colour', 'color', 'font', 'typography', 'logo', 'brand', 'layout', 'spacing', 'style', 'redesign', 'theme', 'hero', 'banner', 'icon'],
    questions: [
      'Is this a tweak to the approved design, or a new direction?',
      'Which pages or components are affected?',
      'Are reference examples available for the desired result?',
      'How many rounds should be assumed for this change?',
    ],
    suggestedHours: { design: 4, frontend: 4, testing: 1, pm: 1 },
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    keywords: ['accessib', 'wcag', 'aria', 'screen reader', 'contrast', 'keyboard'],
    questions: [
      'Which standard and level must be met (e.g. WCAG 2.2 AA)?',
      'Is an audit report or VPAT required as a deliverable?',
      'Which assistive technologies must be tested?',
    ],
    suggestedHours: { analysis: 3, design: 4, frontend: 10, testing: 8, pm: 1 },
  },
  {
    id: 'seo',
    label: 'SEO',
    keywords: ['seo', 'meta', 'sitemap', 'robots', 'schema', 'structured data', 'canonical', 'redirect'],
    questions: [
      'Which pages and keywords matter most?',
      'Is structured data or sitemap work required?',
      'Who owns analytics and search-console accounts?',
    ],
    suggestedHours: { analysis: 2, frontend: 6, backend: 3, testing: 2, pm: 1 },
  },
  {
    id: 'hosting_infra',
    label: 'Hosting / infrastructure',
    keywords: ['hosting', 'deploy', 'server', 'domain', 'dns', 'ssl', 'backup', 'environment', 'ci', 'docker'],
    questions: [
      'Who owns the domain, DNS and hosting account?',
      'Which environments are required (staging, production)?',
      'What backup, monitoring and uptime expectations apply?',
      'Who is responsible for ongoing running costs?',
    ],
    suggestedHours: { analysis: 2, backend: 6, testing: 3, pm: 2, deployment: 6 },
  },
];

/** Detects the concepts present in a piece of text. */
export function detectConcepts(text: string): ConceptRule[] {
  const tokens = new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map((t) => t.slice(0, 6)),
  );
  const flat = text.toLowerCase();
  return CONCEPTS.filter((concept) =>
    concept.keywords.some((kw) => {
      const key = kw.toLowerCase();
      if (key.includes(' ')) return flat.includes(key);
      // Prefix match on first 6 chars aligns "booking/bookings", "integrate/integration".
      return tokens.has(key.slice(0, 6)) || flat.includes(key.slice(0, Math.min(6, key.length)));
    }),
  );
}

// ── Language signals ─────────────────────────────────────────────────────────

/** Wording that indicates something previously agreed is not behaving as agreed. */
export const DEFECT_PATTERNS: RegExp[] = [
  /\bbroken\b/i,
  /\bnot work(ing)?\b/i,
  /\bdoes(?:n'?t| not) work\b/i,
  /\bdoesn'?t\b/i,
  /\bisn'?t\b/i,
  /\bfail(s|ed|ing)?\b/i,
  /\berror(s)?\b/i,
  /\bbug(s|gy)?\b/i,
  /\bcrash(es|ed|ing)?\b/i,
  /\bmissing\b/i,
  /\bdisappear(s|ed)?\b/i,
  /\bcan'?t\b/i,
  /\bcannot\b/i,
  /\bunable to\b/i,
  /\bnot receiv(ing|ed|e)\b/i,
  /\bstopped working\b/i,
  /\bregression\b/i,
  /\bdefect\b/i,
  /\bincorrect\b/i,
  /\bwrong (value|number|price|amount|total|date)\b/i,
  /\bglitch(es|y)?\b/i,
  /\bnot (loading|sending|saving|appearing|showing)\b/i,
  /\btakes too long to (load|open)\b/i,
];

/** Wording that indicates modifying something that already exists (revision-shaped). */
export const MODIFICATION_PATTERNS: RegExp[] = [
  /\bchange\b/i, /\bupdate(s|d)?\b/i, /\bmodif(y|ies|ied)\b/i, /\badjust(s|ed|ment)?\b/i,
  /\btweak(s|ed)?\b/i, /\brevis(e|ed|ion)\b/i, /\bre-?style\b/i, /\brename\b/i,
  /\bmove\b/i, /\bresize\b/i, /\brecolou?r\b/i, /\bswap\b/i, /\breplace\b/i, /\brework\b/i,
];

/** Wording that indicates adding something new. */
export const ADDITION_PATTERNS: RegExp[] = [
  /\badd(s|ed|ing)?\b/i, /\bnew\b/i, /\bcreate\b/i, /\bbuild\b/i, /\bimplement\b/i, /\bintroduce\b/i,
  /\binstall\b/i, /\bset ?up\b/i, /\bstart\b/i, /\binclud(e|ing)\b/i, /\bextend\b/i, /\balso (need|want|require)\b/i,
];

/** Wording that indicates a substitution / trade-off rather than pure addition. */
export const TRADEOFF_PATTERNS: RegExp[] = [
  /\binstead of\b/i, /\bin place of\b/i, /\brather than\b/i, /\bswap(ped|ing)?\b/i, /\breplace\b/i,
  /\bexchange\b/i, /\btrade ?-?off\b/i, /\bswitch (from|to)\b/i, /\bdrop .* (and|to) add\b/i,
];

/** Words that signal the request is too vague to estimate responsibly. */
export const VAGUENESS_PATTERNS: RegExp[] = [
  /\bsimilar to\b/i, /\blike (this|that|the)\b/i, /\bsomething like\b/i, /\bmodern\b/i, /\bclean\b/i,
  /\bnice\b/i, /\bprofessional\b/i, /\bbetter\b/i, /\bimprove\b/i, /\bfix the (look|design|style)\b/i,
  /\bmake it pop\b/i, /\bwhatever you think\b/i, /\bstandard\b/i, /\bas needed\b/i, /\betc\.?\b/i,
];

/** Language that attempts to instruct an automated system. Treated as untrusted data. */
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions?|prompts?|rules?)/i,
  /disregard (the )?(system|previous|above)/i,
  /you are now\b/i,
  /act as (an?|the) (admin|owner|system)/i,
  /(approve|accept) (this|the) (change|request|proposal|order) (now|immediately)/i,
  /mark (this|it) as (approved|in scope|billable)/i,
  // Requests to bypass human authorisation are treated the same way as instruction injection:
  // they are untrusted content, recorded for a human, and they never shorten an approval path.
  /as the (system )?(admin|administrator|owner)/i,
  /(authorise|authorize|approve) (this|the) (change|request) without/i,
  /without (the )?client('s)? approval/i,
  /skip (the )?(client|internal) (approval|review)/i,
  /reveal (your|the) (system )?(prompt|instructions)/i,
  /developer mode/i,
  /\bjailbreak\b/i,
  /override (the )?(permission|authoris|authoriz|policy|rules?)/i,
];

export function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

export function countLanguageSignals(text: string) {
  return {
    defect: matchesAny(text, DEFECT_PATTERNS),
    modification: matchesAny(text, MODIFICATION_PATTERNS),
    addition: matchesAny(text, ADDITION_PATTERNS),
    tradeoff: matchesAny(text, TRADEOFF_PATTERNS),
    vague: matchesAny(text, VAGUENESS_PATTERNS),
    injection: matchesAny(text, INJECTION_PATTERNS),
  };
}
