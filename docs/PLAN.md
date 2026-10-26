# ScopeShield — Research Findings, Architecture & Implementation Plan

**Project:** ScopeShield — evidence-driven scope-change management for web/software agencies
**Tagline:** *Know what was agreed. Catch what changes. Protect every hour.*
**Prepared:** 14 October 2026
**Status of this document:** Phase 0 deliverable. Implementation of Phases 1–3 follows in the same work session.

---

## 0. ⚠️ Naming collision — read this first

A product called **ScopeShield** already exists: an AI scope-detection MVP for freelancers, launched ~February 2026 at ~$20/month (AI contract analysis, email gateway, ambiguity detection, limited integrations).
Sources: [MicroGaps competitive gap report, 2026-02-18](https://www.microgaps.com/gaps/2026-02-18-ai-scope-creep-detector-freelancers), [Turbostarter idea brief](https://www.turbostarter.dev/ideas/ai/scopeshield).

Also active in the same space: **ScopePilot** ([getscopepilot.com](https://getscopepilot.com), $14.99/mo, SOW builder + revision limits + client e-sign portal), **ScopeAuditor** ([scopeauditor.com](https://scopeauditor.com/blog/best-scope-creep-tools)), **ManyRequests** ([manyrequests.com](https://manyrequests.com/blog/managing-scope-creep-in-project-management)).

**Decision made here:** build as ScopeShield as you specified, but position it as the *agency-grade* tier (teams, roles, client portal, immortal baselines, audit trail) rather than the freelancer single-player tier. The product name lives in exactly one place in the codebase (`server/src/config/brand.ts` + package names), so a rename is a 5-minute change if you want one later. Alternatives worth a trademark check: *Scopewright*, *ChangeGuard*, *Baseline*, *ScopeLedger*.

---

## 1. Understanding of ScopeShield

**Thesis.** Agencies do not lose margin because clients are malicious; they lose it because *nobody can say quickly and credibly whether a request was already agreed*. The intake channel (WhatsApp, a call, a "quick" email) has no memory, and the contract has no index. So the only cheap resolution is to just do the work — repeatedly — until the project is unprofitable and the relationship is resentful.

**ScopeShield's job** is to collapse the distance between "a client asked for something" and "here is the evidence, the cost, the schedule impact, and a decision the client can approve in one click."

**Product principle (non-negotiable, enforced in code):**

> ScopeShield assists a human decision. It never decides that a client owes money. It never treats "the AI said so" as approval. A defect is never silently reclassified as billable work. Nothing enters the billable/approved state without a recorded human (internal) and client decision.

Three consequences that shape the design:
1. **The baseline must be immortal.** An approved scope version is never edited; it is superseded. Every later claim is measured against a specific version hash.
2. **Every claim must carry evidence.** A classification without a link to requirement/exclusion text is not shipped to the UI.
3. **The system must be useful with zero AI.** The deterministic engine is the product; the model is an accelerant that degrades gracefully.

**Target users:** digital/web/software agencies (3–60 people), studio owners, PMs/account managers, developers, and — as a *restricted, read-mostly* actor — the client.

---

## 2. What I could actually inspect (and what I could not)

### 2.1 Available

| Artefact | Access | Method |
|---|---|---|
| Portfolio site | ✅ Rendered page | `fetch_page` |
| GitHub **source** for UdyogConnect | ✅ Public repo, file tree + raw files | GitHub REST + raw.githubusercontent |
| Live app `udyog-connect-lyart.vercel.app/customer` | ✅ Rendered page (auth-gated dashboard) | `fetch_page` |
| Your local machine / any private repo | ❌ No access | — |
| Other student projects (Cafe-Management, Employee-Management, SamanKinam) | ✅ Public, not inspected in depth | — |

**Limitations, stated plainly:** I read the *source tree and a sample of files* of UdyogConnect (`Prajwalkwr/UdyogConnect`, last push 2026-10-04). I did not clone it, run it, or read all 282 files. Claims below are anchored to specific file paths I actually fetched. I have not inspected any private repository, your local project, or the production database. No runtime/backend behaviour is asserted beyond what the source shows.

### 2.2 Evidence-based findings on UdyogConnect

**Patterns worth keeping (concepts, not code):**

| Finding | Evidence | How ScopeShield uses it |
|---|---|---|
| Vertical domain modules on the server (`auth/`, `billing/`, `payments/`, `chat/`, `orders/`, `ai/`) | repo tree | Adopt: `modules/<domain>/` slices with routes → controller → service → model |
| Middleware separation for auth/role/security | `server/middleware/{authMiddleware,roleMiddleware,security}.js` | Adopt the separation, replace the semantics (see below) |
| Server-side AI with *documented graceful degradation* when no key is present | `.env.example`: "Without a key the assistant still answers from live marketplace search" | Adopt directly — this is exactly the right instinct for ScopeShield's AI layer |
| Secrets discipline in env docs, incl. explicit "never put this key in a VITE_ variable" | `.env.example` | Adopt, and extend to per-provider docs |
| Rate limiting + request protection utilities | `server/utils/windowLimiter.js`, `client/src/utils/submitProtection.js` | Adopt concept, centralise on the server |
| Broad test suite incl. security-focused tests | `tests/security.test.js`, `tests/productionGuards.test.js`, 18 files | Adopt, add integration tests against a real DB + E2E journey |
| Deployment artefacts: Dockerfile, render.yaml, vercel.json, docker-compose | repo tree | Adopt for ScopeShield |

**Weaknesses — explicitly not repeated:**

| Weakness | Evidence | ScopeShield's response |
|---|---|---|
| **Flat-file "database" committed to git.** `server/.data/*.json` contains User/Order/Booking records; `server/db.js` runs a dual-mode storage layer (Mongo *or* JSON files behind an `isMongo` flag) | `server/.data/*.json`, `server/db.js` | Real MongoDB + Mongoose only, one code path, transactions, indexes. **No data files in git.** |
| **Monolithic data layer.** `db.js` mixes connection bootstrap, file-mode fallback, demo seeding with hardcoded passwords, and model/validator definitions | `server/db.js` head (validators + `DEMO_USERS` in the same file) | Split: `config/db.ts`, `models/*.model.ts`, `seed/*` (seed refuses to run in production unless `ALLOW_PROD_SEED`) |
| **Bearer token in Web Storage.** `TOKEN_KEY='token'` in `sessionStorage`, with tab-adoption and localStorage migration logic | `client/src/utils/sessionAuth.js` | HttpOnly + Secure + SameSite cookie sessions, refresh rotation, CSRF double-submit + origin check. Nothing token-shaped in `localStorage`/`sessionStorage`. |
| **Coarse single-role authorization.** `requireRole(roles)` checks `req.user.role` only | `server/middleware/roleMiddleware.js` | Two-axis authz: **organization membership** (tenant) × **permission** (capability), plus explicit resource-ownership assertions. Frontend guards are UX only. |
| **No per-resource ownership check pattern visible** at middleware level | `roleMiddleware.js` is 6 lines | Every repository query is tenant-scoped by construction (`orgId` in the filter), and a `assertProjectAccess()` guard runs before any project-scoped mutation. IDOR test suite included. |
| **JavaScript + CommonJS, `require()`**, no `typecheck`/`lint`/`test` scripts in `server/package.json` (only `dev`/`start`) | `server/package.json` | TypeScript strict end-to-end; `typecheck`, `lint`, `test`, `test:e2e`, `build` scripts gate every phase |
| **Large monolithic components** (`Marketplace.jsx`, `SellerDashboard.jsx`, `AdminDashboard.jsx`, `ChatAndAI.jsx`) | repo tree | Small composable components, feature folders, server state via TanStack Query, business logic out of JSX |
| **Uploads written to repo-tracked `server/uploads/`** with real images committed | repo tree | Private storage dir outside git, randomized storage keys, MIME sniffing, authorized download endpoints |
| **No CI workflow visible** (no `.github/workflows`) | repo tree | GitHub Actions workflow: typecheck + lint + unit + integration on push |

**Net lesson:** your previous project is strong on *product breadth* and *deployment awareness*, weak on *data integrity, tenant isolation, and type safety*. ScopeShield deliberately trades breadth for those three.

---

## 3. Competitive landscape (verified vs assumed)

### 3.1 Comparison matrix

| Product | Target user | Scope/change capability | AI scope analysis | Client approval of changes | Tenant/roles | Reporting & financials | Pricing (as sourced) |
|---|---|---|---|---|---|---|---|
| **Jira / Jira Service Management** | Software & IT teams | Configurable change workflow, CAB approval steps, custom issue types & fields ([docs](https://confluence.atlassian.com/servicedeskcloud/managing-changes-with-your-it-service-desk-817562147.html)) | ❌ none native for scope-vs-contract | Approval steps + customer portal, but approval is of a *request*, not a priced change order ([docs](https://confluence.atlassian.com/servicemanagementserver/setting-up-approvals-939926369.html)) | Strong projects/roles; multi-org via tenants (paid) | Time tracking; financials need marketplace apps | Not verified here |
| **ClickUp** | Cross-functional teams | Broad PM; scope control depends on user-built workflows | ❌ | Client-facing sharing exists; not change-order-centric | Roles + guests | Dashboards; financials via add-ons | Not verified here |
| **Teamwork.com** | Agencies | Client portals, retainer management, billable time linked to budgets, "Proofs" for creative approvals, profitability per project/client ([vendor page](https://www.teamwork.com/teams/agencies/)) | ❌ | ✅ client portal + approval of creative proofs | ✅ agency roles/guests | ✅ strong (profitability, retainer burn) | Not verified here |
| **Productive.io** | Agencies | Budgets/scope creep tooling, "price every request before work starts", scope-creep content marketing ([blog](https://productive.io/blog/scope-creep-in-project-management/)) | ⚠️ analytics, not semantic analysis | ⚠️ limited | ✅ | ✅ excellent agency financials | Not verified here |
| **ScopeShield (existing OSS-namesake MVP)** | Freelancers | AI contract analysis, email gateway, ambiguity detection | ✅ | ⚠️ minimal | ❌ single-player | ❌ | ~$20/mo ([source](https://www.microgaps.com/gaps/2026-02-18-ai-scope-creep-detector-freelancers)) |
| **ScopePilot** | Freelancers | SOW builder, revision limits, auto change orders on limit breach, e-sign portal ([thread](https://www.reddit.com/r/Entrepreneurs/comments/1sdz6g9/80_of_freelance_projects_get_scopecreeped_i_built/)) | ⚠️ rule-based | ✅ | ❌ | ⚠️ basic | $14.99/mo (stated by founder) |
| **ScopeAuditor** | Freelancers/small agencies | AI detection vs baseline SOW, 1-click PDF change orders, email templates ([vendor blog](https://scopeauditor.com/blog/best-scope-creep-tools)) | ✅ | ⚠️ | ❌ | ⚠️ "unbilled drift" | Not verified |
| **ManyRequests** | Agencies | Structured intake forms, service packages as boundaries, per-request conversation record ([blog](https://manyrequests.com/blog/managing-scope-creep-in-project-management)) | ❌ | ✅ | ✅ | ⚠️ | Not verified |
| **Harvest / Toggl / Bonsai / Harlow** | Freelancers/SMB | Reactive time tracking or contract *templates* | ❌ | ❌ | ❌ | ✅ time/billing | $24–39/mo (per MicroGaps) |

**Honesty markers:** rows marked ❌/⚠️ come from vendor documentation or, where the vendor is silent, are marked *not verified* rather than asserted. Pricing is only quoted where I read it in a cited source in this session.

### 3.2 Underserved workflows (the actual opportunity)

1. **Defect vs. change is a first-class decision, not an afterthought.** Every competitor pushes toward "detected → change order." The agency that bills a client for its own regression loses the account. Nobody models this boundary explicitly.
2. **Trade-offs beyond money.** Defer / substitute / extend-the-deadline-with-fee / goodwill — a menu, not a yes-no.
3. **Unapproved work visibility.** Nobody surfaces "hours already burned against a request that has no decision" as a *first-class metric with a dollar figure attached to a warning, not revenue*.
4. **Evidence-linked classification for agencies with a team.** Detection tools are single-player; PM tools have no semantics. The intersection (evidence + team workflow + client portal + immutable baseline) is thinly served.
5. **Immutable, hashable baseline versions.** Reviews mention re-baselining as best practice; nobody ships "the version you signed, byte for byte, forever."
6. **Dispute-preparation export.** A chronological evidence pack generated on demand.

**Differentiation is a hypothesis, not a fact.** It survives only if agencies actually feel the defect-vs-change and unapproved-work problems more acutely than generic scope detection. Validation plan: put the demo seed in front of 5 agencies; the metric that matters is whether they recognise the *unapproved work* number as their own pain.

---

## 4. Recommended architecture

### 4.1 Shape

```
scopeshield/
├── server/                     # Node 20 · Express 5 · TypeScript (strict) · Mongoose 8 · Zod 4
│   └── src/
│       ├── config/             # env, db, logger, brand, constants
│       ├── domain/             # pure logic — no I/O, 100% unit-testable
│       │   ├── classification/ # deterministic rule engine + precedence table
│       │   ├── money.ts        # integer-minor-unit arithmetic, rounding, tax
│       │   ├── schedule.ts     # working-day calendar, capacity-aware impact
│       │   ├── stateMachine.ts # change-request lifecycle + allowed transitions
│       │   ├── health.ts       # explainable scope-health score
│       │   └── similarity.ts   # trigram/token similarity for dedupe & match
│       ├── models/             # Mongoose schemas + indexes + invariants
│       ├── modules/            # vertical slices: routes → controller → service → repo
│       │   ├── auth/ orgs/ members/ clients/ projects/ baselines/ requirements/
│       │   ├── documents/ requests/ analysis/ estimates/ changeOrders/
│       │   ├── approvals/ timeEntries/ reports/ notifications/ audit/ integrations/
│       ├── ai/                 # provider interface + openai/anthropic/heuristic adapters
│       ├── platform/           # mail, pdf, storage, jobs, crypto — swappable adapters
│       ├── middleware/         # authn, tenant, permission, validate, error, rateLimit, upload
│       └── seed/               # labelled demo data (Summit Web Studio)
├── web/                        # React 19 · TS · Vite · Tailwind v4 · TanStack Query 5
│   └── src/{app,pages,features,components/ui,lib}
├── docs/                       # PLAN, ARCHITECTURE, API, SECURITY, ROADMAP, openapi.yaml
├── tests/                      # unit + integration (vitest + supertest) · e2e (playwright)
└── .github/workflows/ci.yml
```

**Why not the easy alternatives:** no Redis/queue/vector-DB/microservices. The workload (hundreds of requests per agency, not millions) is served by MongoDB indexes and one process. Semantic work uses the model provider directly; no embedding store until the retrieval quality demands it (documented in ROADMAP as a deliberate deferral).

### 4.2 Key technical decisions

| Decision | Rationale | Trade-off accepted |
|---|---|---|
| **Real MongoDB** (embedded server for local/dev sandbox; Atlas/self-host for prod) | Transactions, indexes, real queries; removes the flat-file trap | Local dev needs a running mongod or the bundled memory-server binary |
| **TypeScript strict, both sides, shared domain types** | A contract-shaped product needs type-checked rule tables | Slower to write than JS |
| **Two-axis authz: membership × permission** | Tenant isolation is the #1 security requirement here | More ceremony than `requireRole` |
| **HttpOnly cookie sessions + rotated refresh tokens** | No bearer token in Web Storage (fixing the observed weakness) | Needs CSRF story (double-submit + origin check) |
| **Deterministic engine first, AI as an optional enhancer behind an interface** | Product must work with no API key; AI must never be the authority | Two code paths, both tested; UI must show which one spoke |
| **Scrypt (`node:crypto`) for password hashing** | Zero native deps, OWASP-accepted parameters | Not bcrypt-ecosystem compatible (documented) |
| **PDF via `pdfkit` server-side** | Change orders are deliverables; generation must be server-authoritative and hashed | Styling is imperative, not HTML |
| **Approval tokens: 32-byte random, SHA-256 at rest, single-change-order scope, expiring, revocable, version-bound** | Prevents replay and approving a superseded proposal | Client needs the link (no account required) |

### 4.3 AI architecture (provider abstraction + guardrails)

- `AiProvider` interface: `analyzeScope(input)`, `draftRequirements(input)`, `assist(input)`, `usage()`.
- Adapters: `openai-compatible` (OpenAI, Groq, OpenRouter, local llama.cpp — all via `baseUrl`), `anthropic`, and **`heuristic`** (no network, always available, keyword+similarity based). Server refuses to enable a networked provider without a key and logs the fallback explicitly.
- Every AI response is: **schema-validated (Zod)** → **evidence-verified** (every cited `REQ-`/`EXC-` key must exist in the baseline, else the citation is dropped and the analysis is marked degraded) → **stored append-only** with provider, model, tokens, latency, cost.
- **Prompt-injection posture:** uploaded documents and client messages are tagged as untrusted data in the system prompt; instruction-like content is neutralised in the heuristic path and never granted authority in the AI path; the analysis model has no tools; authorization is computed *before* any AI call and is unaffected by AI output.
- **Redaction:** contact details, payment identifiers and unrelated free-text are stripped before transmission; org admins can switch to heuristic-only mode in settings.

---

## 5. Data model (entities & relationships)

```
User ──< Membership >── Organization ──< Invitation
                          │
                          ├──< Client ──< Project ──< Milestone
                          │                 │
                          │                 ├──< ScopeBaselineVersion ──< Requirement (REQ-/EXC-, deps[], acceptance criteria)
                          │                 │        (immutable; parent→child chain; snapshot hash)
                          │                 ├──< Document (proposal/SOW/evidence; private storage)
                          │                 ├──< ChangeRequest ──< ScopeAnalysis (append-only)
                          │                 │        │            └─ EffortEstimate (versioned)
                          │                 │        └──< ChangeOrder ──< ApprovalToken ──< ApprovalDecision (append-only)
                          │                 ├──< TimeEntry (billable/not; request-linked ⇒ unapproved-work metric)
                          │                 └──< RevisionUsage (deliverable, round, request)
                          ├──< Notification
                          ├──< AuditEvent (append-only, hash-chained)
                          ├──< IntegrationConnection (interface only)
                          └──< AiUsageRecord
Session (refresh rotation) · IdempotencyKey (approval POSTs)
```

**Embedded vs referenced:** requirements are *embedded as a snapshot* inside each `ScopeBaselineVersion` **and** mirrored as first-class `Requirement` docs for the current baseline (snapshot = immutability; docs = queryability). Acceptance criteria, dependencies and exclusions are **arrays inside** `Requirement` (no separate collection for what is always read with its parent). Estimates and analyses are **separate append-only collections** — they are evidence, and evidence is never overwritten. Time entries and audit events are always separate.

**Indexes / constraints (highlights):** `users.email` unique; `organizations.slug` unique; `memberships (org,user)` unique; `projects (org,code)` unique; `baselineVersions (project,version)` unique + immutable flag; `requirements (project,key)` unique; `changeRequests (org,ref)` unique + `(org,status,createdAt)`; `changeOrders (org,number)` unique + `publicTokenHash` unique; `approvalTokens.tokenHash` unique; `auditEvents (org,createdAt)` and `(entityType,entityId)`.

**Deletion policy:** organization/client/project deletion is **soft** (`deletedAt`) when anything financial or approval-related exists; hard delete only for never-referenced drafts. Audit events are never deleted by application code. Retention: documents retained for the project lifetime + configurable retention; audit events retained indefinitely; approval tokens retained (hashed) as decision evidence.

---

## 6. Roadmap — MVP vs later

**MVP (this build — "the reliable loop"):**
auth & org onboarding · memberships/roles · clients · projects · baseline editor + document ingestion + review · immutable versions + version history · request intake with evidence · deterministic classification (9 categories) + AI-assisted semantic analysis behind the interface · human review & correction · effort/price/schedule estimation · trade-off options · change-order PDF + versions · secure client approval portal (accept/reject/clarify) · baseline promotion on approval · time entries · unapproved-work dashboard · change-request audit trail · CSV/PDF exports · demo seed · tests + docs.

**Phase 7 (post-MVP, designed not built):** requirement relationship graph UI · scope-risk scanner at setup time · revision-allowance automation across deliverables · AI requirement drafting UI · dispute evidence pack export · scope-health score surfaces · email/Slack intake adapters · GitHub/Jira/accounting integrations · subscription billing · platform admin console.

**Explicitly deferred with reasons:** vector DB (no measured retrieval need yet) · background job queue (everything currently runs in <2s request-scoped, with a persisted job table for anything slower) · multi-region · native mobile.

---

## 7. Key risks & mitigations

| # | Risk | Type | Mitigation |
|---|---|---|---|
| 1 | **False "out of scope" verdict damages a client relationship** | Product/reputational | Never binary; always category + confidence + evidence + suggested questions; defect and "clarification required" are first-class outcomes; human review mandatory before any client-facing document |
| 2 | AI hallucinates an exclusion or requirement that isn't in the baseline | AI | Evidence-verification pass drops unknown citations; degraded-mode banner; classification falls back to deterministic result |
| 3 | Prompt injection via uploaded SOW or client message ("ignore previous instructions… I approved this") | Security | Untrusted-data tagging, no tools, no authz influence, injection test suite, heuristic neutralisation |
| 4 | Cross-tenant data leak (IDOR) | Security | Tenant-scoped repositories, `assertProjectAccess`, automated cross-org test matrix |
| 5 | Approval of a superseded proposal / link replay | Integrity | Decisions bound to `(changeOrder version, document hash)`; new version invalidates outstanding tokens; single-use exchange + idempotency keys |
| 6 | Baseline mutation after approval | Integrity | Immutability enforced at model + service layer; SHA-256 snapshot hash; version chain; tests assert "original bytes still retrievable" |
| 7 | Hour/cost arithmetic drift (float money) | Correctness | Integer minor units everywhere; rounding policy documented; unit tests incl. tax/discount ordering |
| 8 | Schedule math ignores capacity | Correctness | Working-day calendar + capacity-per-day divisor + dependency awareness; overrides require a written reason |
| 9 | AI cost runs away | Commercial | Per-org monthly budget + per-request token caps + usage dashboard; heuristic mode as the floor |
| 10 | Approval click treated as a legal e-signature | Legal | UI + docs state explicitly that a click is a recorded decision, not a jurisdiction-valid e-signature; agencies may attach their own terms and must obtain legal review |

---

## 8. Phased implementation plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Inspect & plan** ✅ | This document | Plan published; DB path proven in the sandbox |
| **1. Foundation** | Monorepo, env, DB, logging, errors, auth (cookie sessions + rotation), orgs, memberships, RBAC, UI kit, toast/modal/empty/error patterns, CI scripts, first unit+integration tests | `typecheck` + `test` green; a user can register, create an org, invite |
| **2. Core project mgmt** | Clients, projects, baseline editor, requirement/exclusion CRUD, versions & immutability, document upload + text extraction + review-before-save | Baseline v1 approvable and immutable; extraction review works |
| **3. Change management** | Request intake + evidence, 9-category deterministic engine, review/correction workflow, state machine, audit events | Seeded requests classify correctly and are traceable end-to-end |
| **4. AI assistance** | Provider interface + heuristic + OpenAI-compatible + Anthropic adapters, structured output validation, evidence verification, usage/cost tracking, degraded mode | Works with zero keys; key-enabled path schema-validated; injection tests pass |
| **5. Orders & approval** | Change-order PDF + versions, tokens, client portal, accept/reject/clarify, baseline promotion, approval audit trail | Full E2E journey passes incl. negative cases |
| **6. Financial visibility** | Time entries, planned vs actual, unapproved-work metric, org/project reports, CSV + PDF export | Unapproved work surfaces with dollar figure clearly labelled *not revenue* |
| **7. Advanced** | Health score, risk scanner, relationship graph, integrations interfaces | Documented as partial where partial |
| **8. Production readiness** | Security review, indexes, E2E suite, deploy docs, monitoring hooks, backups, demo data, smoke tests | README + docs complete; known limitations listed |

**Cadence rule:** every phase ends with a written status: complete / not complete / tests run / limitations / next.

---

## 9. First milestone (Phase 1) — acceptance criteria

1. `npm run typecheck`, `npm run lint`, `npm test` all pass from a clean clone (with the documented DB bootstrap).
2. Register → verify password policy → create organization → receive owner membership → invite a teammate by email (mail captured to a dev outbox).
3. Login sets an HttpOnly cookie; a second login from another client rotates the refresh token; the old refresh token is rejected (rotation theft detection).
4. `GET /api/v1/me` returns user + memberships + resolved permissions; an unauthenticated call gets 401, a non-member gets 403.
5. Cross-org access to another org's project returns 404/403 — asserted by an automated test.
6. Health endpoint, structured request logs with request IDs, central error handler with typed error codes, rate limiting on auth routes.
7. A React shell renders brand + navigation with real data from `/me`, with loading/empty/error states.

---

## 10. What I will *not* claim

- I will not claim AI accuracy figures — none have been measured against a labelled dataset yet. The engine ships with a documented evaluation harness plan instead.
- I will not claim legal validity of approvals in any jurisdiction.
- I will not claim integration support that is only an interface.
- I will not claim marketplace or revenue validation for ScopeShield; the differentiation is a hypothesis (§3.2).
