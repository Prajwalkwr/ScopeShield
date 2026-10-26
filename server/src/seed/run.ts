import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { BaselineVersion, ChangeOrder, Client, Membership, Organization, Project, User } from '../models';
import { hashPassword } from '../platform/crypto';
import { logger } from '../platform/logger';
import { createDraft, addRequirement, approveVersion } from '../modules/baselines/baselines.service';
import { createRequest, transitionRequest } from '../modules/requests/requests.service';
import { runAnalysis } from '../modules/analysis/analysis.service';
import { createEstimate, finaliseEstimate, logTime } from '../modules/estimates/estimates.service';
import { generateChangeOrder, sendChangeOrder } from '../modules/changeOrders/changeOrders.service';
import { recordDecision } from '../modules/approvals/approvals.service';
import { BASELINE_REQUIREMENTS, DEMO_EMAIL, DEMO_ORG_NAME, SEED_REQUESTS, SEED_TIME_ENTRIES } from './data';

/**
 * Demo seed.
 *
 * Safety rules, deliberately strict:
 *  - refuses to run with NODE_ENV=production;
 *  - refuses to run against a database that already contains non-demo organizations, unless
 *    --force is passed, so nobody wipes real records by accident;
 *  - every document it creates is marked isDemo, and the organization name is prefixed "Demo —"
 *    so demo records can never be confused with real client data;
 *  - it drives the same service functions the API uses, so what you see in the demo is the real
 *    workflow, not a fixture inserted behind the application's back.
 */
const args = new Set(process.argv.slice(2));
const isForce = args.has('--force');

function generatedPassword(): string {
  // Printed once on completion. Never a hardcoded literal in the repository.
  return `Demo-${crypto.randomBytes(6).toString('base64url')}!7`;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }

  const target = await connectDatabase();
  console.log(`Connected to ${target}`);

  const realOrgs = await Organization.countDocuments({ isDemo: { $ne: true } });
  if (realOrgs > 0 && !isForce) {
    console.error(
      `This database already contains ${realOrgs} non-demo organization(s).\n` +
        'Refusing to seed so that real data is not touched. Re-run with --force if this is a development database.',
    );
    await disconnectDatabase();
    process.exit(1);
  }

  const existing = await Organization.findOne({ name: DEMO_ORG_NAME, isDemo: true });
  if (existing && !isForce) {
    console.log('Demo organization already exists. Re-run with --force to rebuild it.');
    await disconnectDatabase();
    return;
  }
  if (existing && isForce) {
    const orgId = existing._id;
    const projects = await Project.find({ org: orgId }).select('_id').lean();
    const projectIds = projects.map((p) => p._id);
    await Promise.all([
      BaselineVersion.deleteMany({ org: orgId }),
      ChangeOrder.deleteMany({ org: orgId }),
      Client.deleteMany({ org: orgId }),
      Membership.deleteMany({ org: orgId }),
      Project.deleteMany({ org: orgId }),
    ]);
    const { ChangeRequest, ScopeAnalysis, EffortEstimate, TimeEntry, ApprovalToken, ApprovalDecision, AuditEvent, AuditChain, Document } =
      await import('../models');
    await Promise.all([
      ChangeRequest.deleteMany({ org: orgId }),
      ScopeAnalysis.deleteMany({ org: orgId }),
      EffortEstimate.deleteMany({ org: orgId }),
      TimeEntry.deleteMany({ org: orgId }),
      ApprovalToken.deleteMany({ org: orgId }),
      ApprovalDecision.deleteMany({ org: orgId }),
      Document.deleteMany({ org: orgId }),
      AuditEvent.deleteMany({ org: orgId }),
      AuditChain.deleteMany({ org: orgId }),
    ]);
    void projectIds;
    await Organization.deleteOne({ _id: orgId });
    await User.deleteOne({ email: DEMO_EMAIL });
    console.log('Removed the previous demo organization and its records.');
  }

  const password = process.env.DEMO_PASSWORD ?? generatedPassword();

  // ── People and organization ────────────────────────────────────────────────
  const owner = await User.create({
    name: 'Priya Sharma',
    email: DEMO_EMAIL,
    passwordHash: hashPassword(password),
    timezone: 'Asia/Kathmandu',
    jobTitle: 'Delivery lead',
    isDemo: true,
  });
  const developer = await User.create({
    name: 'Bikash Thapa',
    email: 'bikash@summitwebstudio.test',
    passwordHash: hashPassword(password),
    timezone: 'Asia/Kathmandu',
    jobTitle: 'Developer',
    isDemo: true,
  });

  const org = await Organization.create({
    name: DEMO_ORG_NAME,
    slug: `${DEMO_ORG_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${crypto.randomBytes(2).toString('hex')}`,
    currency: 'USD',
    defaultHourlyRate: 95,
    timezone: 'Asia/Kathmandu',
    approvalPolicy: { tokenTtlDays: 14, autoApproveUnderAmount: 0, requireEstimateBeforeInternalReview: true, warnOnUnapprovedWork: true },
    ai: { enabled: false, provider: 'heuristic', model: '', monthlyBudgetUsd: 25, allowDocumentText: false },
    termsText:
      'Work described in this change order is additional to the agreed scope. It begins once this document is accepted, subject to the agency’s master services agreement.',
    createdBy: owner._id,
    isDemo: true,
  });

  const ownerMembership = await Membership.create({
    org: org._id,
    user: owner._id,
    role: 'owner',
    status: 'active',
    joinedAt: new Date(),
    isDemo: true,
  });
  const devMembership = await Membership.create({
    org: org._id,
    user: developer._id,
    role: 'developer',
    status: 'active',
    joinedAt: new Date(),
    isDemo: true,
  });

  const actor = { userId: String(owner._id), name: owner.name, email: owner.email };
  const devActor = { userId: String(developer._id), name: developer.name, email: developer.email };
  void ownerMembership;
  void devMembership;

  // ── Client and project ─────────────────────────────────────────────────────
  const client = await Client.create({
    org: org._id,
    name: 'Everest Retail Group',
    company: 'Everest Retail Group Pvt. Ltd.',
    contactName: 'Anita Rai',
    contactEmail: 'anita@everestretail.test',
    contactPhone: '+977 1 555 0134',
    address: 'Durbar Marg, Kathmandu',
    internalNotes: 'Fast decision-maker; prefers a phone call before any written proposal.',
    currency: 'USD',
    tags: ['demo', 'hospitality'],
    createdBy: owner._id,
    isDemo: true,
  });

  const project = await Project.create({
    org: org._id,
    client: client._id,
    code: 'EBC-01',
    name: 'Everest Corporate Website',
    description:
      'Five-page corporate website for Everest Retail Group: responsive marketing pages, a contact form, and two rounds of design revisions.',
    manager: owner._id,
    members: [ownerMembership._id, devMembership._id],
    status: 'active',
    contractType: 'fixed_price',
    currency: 'USD',
    contractAmountMinor: 1_140_000,
    estimatedHours: 110,
    hourlyRate: 95,
    internalCostRate: 38,
    startDate: new Date(Date.now() - 40 * 86_400_000),
    targetEndDate: new Date(Date.now() + 25 * 86_400_000),
    targetEndDateSetBy: owner._id,
    workingDays: [1, 2, 3, 4, 5],
    holidays: ['2026-10-20', '2026-11-11'],
    hoursPerPersonDay: 6,
    floatDays: 6,
    revisionPolicies: [
      { deliverable: 'Home page design', included: 2, used: 2 },
      { deliverable: 'Inner page design', included: 2, used: 1 },
    ],
    createdBy: owner._id,
    isDemo: true,
  });
  console.log(`Project ${project.code} created.`);

  // ── Baseline v1: the agreed scope, approved and frozen ─────────────────────
  const draft = await createDraft({
    orgId: String(org._id),
    projectId: String(project._id),
    actor,
    label: 'Initial agreed scope',
    reason: 'Signed statement of work dated 5 September 2026.',
  });

  const keyByTitle = new Map<string, string>();
  for (const requirement of BASELINE_REQUIREMENTS) {
    const result = await addRequirement({
      orgId: String(org._id),
      projectId: String(project._id),
      versionId: String(draft._id),
      actor,
      requirement: {
        kind: requirement.kind,
        title: requirement.title,
        description: requirement.description ?? '',
        category: requirement.category ?? 'functional',
        priority: requirement.priority ?? 'must',
        estimatedHours: requirement.estimatedHours ?? 0,
        acceptanceCriteria: requirement.acceptanceCriteria ?? [],
      },
    });
    keyByTitle.set(requirement.title, result.key);
  }

  await approveVersion({
    orgId: String(org._id),
    projectId: String(project._id),
    versionId: String(draft._id),
    actor,
    evidence: { method: 'external_document', note: 'Uploaded the signed SOW and approved against it.' },
  });
  console.log(`Baseline v1 approved with ${keyByTitle.size} line items.`);

  // ── Change requests through the real workflow ──────────────────────────────
  const created: { ref: string; id: string; expects: string; category: string | null }[] = [];

  for (const seed of SEED_REQUESTS) {
    const request = await createRequest({
      orgId: String(org._id),
      projectId: String(project._id),
      actor: devActor,
      data: {
        projectId: String(project._id),
        title: seed.title,
        description: seed.description,
        requesterName: seed.requesterName,
        requesterEmail: seed.requesterEmail,
        source: seed.source,
        sourceDetail: seed.sourceDetail ?? '',
        priority: seed.priority ?? 'normal',
        businessReason: seed.businessReason ?? '',
        submit: true,
        evidence: (seed.evidence ?? []).map((e) => ({ ...e, occurredAt: new Date(Date.now() - 5 * 86_400_000) })),
      } as never,
    });

    let category: string | null = null;
    if (seed.analyse) {
      const analysis = await runAnalysis({
        orgId: String(org._id),
        requestId: String(request._id),
        actor: devActor,
        useAi: false,
      });
      category = analysis.analysis?.category ?? null;
      if (seed.desiredStatus !== 'submitted') {
        await transitionRequest({
          orgId: String(org._id),
          requestId: String(request._id),
          to: 'under_review',
          reason: 'Picked up in the weekly scope review.',
          actor,
        });
      }
      if (seed.desiredStatus === 'classified') {
        await transitionRequest({
          orgId: String(org._id),
          requestId: String(request._id),
          to: 'classified',
          reason: 'Classification reviewed and confirmed.',
          actor,
        });
      }
      if (seed.desiredStatus === 'clarification_required') {
        await transitionRequest({
          orgId: String(org._id),
          requestId: String(request._id),
          to: 'clarification_required',
          reason: 'The request is too subjective to price. Questions sent to the client.',
          actor,
        });
      }
    }

    // Estimates and change orders, always through the services that enforce the rules.
    if (seed.estimateHours) {
      const estimate = await createEstimate({
        orgId: String(org._id),
        requestId: String(request._id),
        actor,
        hours: seed.estimateHours,
        currency: 'USD',
        billingRate: 95,
        internalCostRate: 38,
        contingencyPct: 10,
        note: 'Reviewed with the delivery lead before finalising.',
        capacity: { hoursPerPersonDay: 6, people: 1, availability: 0.8, floatDays: 6 },
      });
      await finaliseEstimate({ orgId: String(org._id), estimateId: String(estimate.estimate._id), actor });

      if (seed.changeOrder) {
        const order = await generateChangeOrder({
          orgId: String(org._id),
          requestId: String(request._id),
          actor,
          option: seed.changeOrder.option,
          summary: seed.changeOrder.summary,
          scopeAdditions: seed.changeOrder.additions ?? [],
        });
        const sent = await sendChangeOrder({
          orgId: String(org._id),
          orderId: String(order.order._id),
          actor,
          recipientEmail: seed.requesterEmail,
        });

        if (seed.changeOrder.outcome === 'accepted') {
          // The decision is recorded through the same public code path the client would use.
          await recordDecision({
            rawToken: sent.token,
            decision: 'accepted',
            name: seed.requesterName,
            email: seed.requesterEmail,
            role: 'Marketing Director',
            comment: seed.changeOrder.decisionComment ?? '',
            typedName: seed.requesterName,
            acknowledged: true,
            displayedDocumentHash: sent.order.pdfHash ?? '',
            displayedVersion: sent.order.version,
            ctx: { ip: '203.0.113.10', userAgent: 'demo-seed' },
          });
        }
      }
    }

    created.push({ ref: request.ref, id: String(request._id), expects: seed.expectsCategory, category });
  }
  console.log(`Created ${created.length} change requests.`);

  // ── Time entries: approved work alongside unapproved work ──────────────────
  const requestByRef = new Map(created.map((c) => [c.ref, c.id]));
  let logged = 0;
  for (const entry of SEED_TIME_ENTRIES) {
    await logTime({
      orgId: String(org._id),
      actor: devActor,
      projectId: String(project._id),
      requestId: entry.requestRef ? (requestByRef.get(entry.requestRef) ?? null) : null,
      date: new Date(Date.now() - entry.daysAgo * 86_400_000).toISOString(),
      hours: entry.hours,
      category: entry.category,
      billable: entry.billable,
      note: entry.note,
    });
    logged += 1;
  }
  console.log(`Logged ${logged} time entries.`);

  const [requests, orders, estimates] = await Promise.all([
    mongoose.connection.db?.collection('change_requests').countDocuments({ org: org._id }),
    ChangeOrder.countDocuments({ org: org._id }),
    mongoose.connection.db?.collection('effort_estimates').countDocuments({ org: org._id }),
  ]);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('Demo data ready.');
  console.log(`  Organization : ${DEMO_ORG_NAME} (flagged isDemo)`);
  console.log(`  Project      : ${project.code} — ${project.name}`);
  console.log(`  Baseline     : v1 approved, ${keyByTitle.size} requirements and exclusions`);
  console.log(`  Records      : ${requests} requests, ${estimates} estimates, ${orders} change orders`);
  console.log(`  Sign in as   : ${DEMO_EMAIL}`);
  console.log(`  Password     : ${password}`);
  console.log('  This password is shown once. Change it after signing in.');
  console.log('──────────────────────────────────────────────────────────────\n');
  console.log('Documented taxonomy mapping for the seeded requests:');
  for (const row of created) {
    console.log(`  ${row.ref} → engine: ${row.category ?? '(not analysed)'}\n      expected: ${row.expects}`);
  }

  await disconnectDatabase();
}

main().catch(async (err) => {
  logger.error('seed.failed', { error: err instanceof Error ? err.message : String(err) });
  console.error(err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
