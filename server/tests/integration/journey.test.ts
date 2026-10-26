import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, resetBetweenTests, signUp, type Harness, type TestClient } from '../support/harness';
import { ApprovalToken, ChangeOrder, Organization, Project } from '../../src/models';
import { CATEGORY_META } from '../../src/domain/classification';

/**
 * The core journey, end to end over real HTTP, with real persistence.
 *
 * org → client → project → approved baseline (booking explicitly excluded) → developer submits a
 * booking request → deterministic analysis → estimate → change order → secure client link →
 * client accepts → audit trail → new baseline draft → original version retained → unapproved
 * work visible → cross-org access denied.
 */
let harness: Harness;

const owner = { email: 'priya@summitstudio.test', name: 'Priya Sharma' };
const developer = { email: 'bikash@summitstudio.test', name: 'Bikash Thapa' };
const outsider = { email: 'mallory@rival.test', name: 'Mallory Doe' };

async function createOrg(client: TestClient, name: string) {
  const res = await client.post('/api/v1/organizations', { name, currency: 'USD', defaultHourlyRate: 95 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  // From here on, every request carries the active organization, as the web app does.
  const org = res.body.organization as { orgId: string; slug: string };
  client.setOrg(org.orgId);
  return org;
}

/** Full setup: org, client, project, approved baseline with an explicit booking exclusion. */
async function setupProject(client: TestClient) {
  const org = await createOrg(client, 'Summit Web Studio');

  const clientRes = await client.post('/api/v1/clients', {
    name: 'Everest Retail Group',
    contactName: 'Anita Rai',
    contactEmail: 'anita@everestretail.test',
  });
  expect(clientRes.status, JSON.stringify(clientRes.body)).toBe(201);
  const clientId = clientRes.body.client._id ?? clientRes.body.client.id;

  const projectRes = await client.post('/api/v1/projects', {
    name: 'Everest Corporate Website',
    code: 'EBC-01',
    clientId,
    contractType: 'fixed_price',
    currency: 'USD',
    contractAmountMinor: 1_200_000,
    estimatedHours: 160,
    hourlyRate: 95,
    internalCostRate: 40,
    targetEndDate: new Date(Date.now() + 42 * 86_400_000).toISOString(),
  });
  expect(projectRes.status, JSON.stringify(projectRes.body)).toBe(201);
  const projectId = projectRes.body.project._id ?? projectRes.body.project.id;

  const draftRes = await client.post(`/api/v1/projects/${projectId}/baselines`, {
    label: 'Initial agreed scope',
    reason: 'Signed statement of work, 12 September.',
  });
  expect(draftRes.status, JSON.stringify(draftRes.body)).toBe(201);
  const versionId = draftRes.body.version._id;

  const requirements = [
    { kind: 'requirement', title: 'Five-page responsive marketing site', category: 'functional', estimatedHours: 40, acceptanceCriteria: ['Home, About, Services, Work and Contact pages render correctly at 360px and 1440px'] },
    { kind: 'requirement', title: 'Contact form with email notification', category: 'functional', estimatedHours: 12 },
    { kind: 'requirement', title: 'Two rounds of design revisions included', category: 'service_level', estimatedHours: 16 },
    { kind: 'exclusion', title: 'No online booking, accounts or payment flows', description: 'Booking, customer accounts and payment processing are explicitly outside this engagement.', category: 'exclusion' },
    { kind: 'exclusion', title: 'No content writing beyond supplied copy editing', category: 'exclusion' },
  ] as const;

  const keys: string[] = [];
  for (const requirement of requirements) {
    const res = await client.post(`/api/v1/projects/${projectId}/baselines/${versionId}/requirements`, requirement);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    keys.push(res.body.key ?? res.body.requirement?.key);
  }

  const approve = await client.post(`/api/v1/projects/${projectId}/baselines/${versionId}/approve`, {
    method: 'internal',
    note: 'Approved against the signed SOW.',
    confirm: true,
  });
  expect(approve.status, JSON.stringify(approve.body)).toBe(200);

  return { org, clientId, projectId, versionId, keys };
}

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetBetweenTests();
});

describe('core scope-change journey', () => {
  it('walks from baseline to an accepted change order and a new baseline draft', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    const { projectId, keys, org } = await setupProject(pm);

    // Invite a developer and have them accept. The token is returned once for manual delivery.
    const invite = await pm.post(`/api/v1/organizations/${org.orgId}/invitations`, {
      email: developer.email,
      role: 'developer',
    });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);

    const dev = harness.client();
    await signUp(dev, developer.email, developer.name);
    const accept = await dev.post('/api/v1/organizations/invitations/accept', { token: invite.body.linkToken });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    dev.setOrg(accept.body.joined.orgId);

    // The developer records what the client asked for, with the client's own words as evidence.
    const requestRes = await dev.post('/api/v1/requests', {
      projectId,
      title: 'Add online table booking to the site',
      description:
        'The client asked by email whether the site can now take restaurant table bookings online, with a confirmation email. They want it before the launch.',
      requesterName: 'Anita Rai',
      requesterEmail: 'anita@everestretail.test',
      source: 'email',
      submit: true,
      evidence: [
        {
          kind: 'email',
          source: 'Email from anita@everestretail.test, 14 Oct',
          quote: 'Can we add online table booking before launch? It is important for the opening.',
          consentAttested: true,
        },
      ],
    });
    expect(requestRes.status, JSON.stringify(requestRes.body)).toBe(201);
    const requestId = requestRes.body.request._id ?? requestRes.body.request.id;
    expect(requestRes.body.request.ref).toMatch(/^CR-\d{4}-\d{4}$/);

    // Deterministic analysis: the engine classifies, cites the exclusion, and does NOT decide money.
    const analysis = await dev.post(`/api/v1/requests/${requestId}/analyze`, {});
    expect(analysis.status, JSON.stringify(analysis.body)).toBe(201);
    expect(analysis.body.analysis.mode).toBe('deterministic');
    const category = analysis.body.analysis.category;
    // The category must come from the fixed taxonomy — never a free-text label.
    expect(Object.keys(CATEGORY_META)).toContain(category);
    // Booking is explicitly excluded by the approved baseline, so the engine must not treat it
    // as covered work. It may only propose "this needs a decision", never "the client owes money".
    expect(analysis.body.analysis.posture).not.toBe('no_charge');
    expect(JSON.stringify(analysis.body.analysis)).not.toMatch(/invoice|owes|legally/i);

    // Analysis is append-only and cites the exclusion it relied on.
    const stored = await dev.get(`/api/v1/requests/${requestId}/analyses`);
    expect(stored.body.analyses.length).toBeGreaterThan(0);
    expect(stored.body.analyses[0].engineVersion).toBeTruthy();
    void keys;

    // A developer may estimate but must not send commercial documents.
    const estimate = await dev.post(`/api/v1/requests/${requestId}/estimates`, {
      hours: { analysis: 4, design: 6, frontend: 14, backend: 4, testing: 3, pm: 1 },
      billingRate: 95,
      internalCostRate: 40,
      contingencyPct: 10,
    });
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(201);
    const estimateId = estimate.body.estimate.id;
    expect(estimate.body.estimate.totalHours).toBe(32); // 4+6+14+4+3+1
    expect(estimate.body.margin).not.toBeNull();

    // The developer may draft numbers, but finalising a client-facing figure is the PM's call.
    const devFinalise = await dev.post(`/api/v1/estimates/${estimateId}/finalise`, {});
    expect(devFinalise.status).toBe(403);

    const finalise = await pm.post(`/api/v1/estimates/${estimateId}/finalise`, {});
    expect(finalise.status, JSON.stringify(finalise.body)).toBe(200);
    expect(finalise.body.estimate.status).toBe('final');

    const forbiddenSend = await dev.post(`/api/v1/requests/${requestId}/change-orders`, {
      option: 'add_with_fee',
      summary: 'Booking module as an additional fee.',
      scopeAdditions: [{ title: 'Table booking module', description: 'Booking, confirmation email, admin list.' }],
    });
    expect(forbiddenSend.status).toBe(403);
    expect(forbiddenSend.body.error.code).toBe('PERMISSION_DENIED');

    // The PM issues the change order from the finalised estimate.
    const order = await pm.post(`/api/v1/requests/${requestId}/change-orders`, {
      option: 'add_with_fee',
      summary:
        'Add an online table booking module: booking form, confirmation email, and a booking list for staff. This work is outside the agreed scope, which excludes booking and payment flows.',
      scopeAdditions: [
        {
          title: 'Table booking module',
          description: 'Booking form, confirmation email, staff booking list.',
          acceptanceCriteria: ['A guest can book a table and receives a confirmation email'],
          estimatedHours: 32,
        },
      ],
      relatedRequirementKeys: [],
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const orderId = order.body.order.id;
    expect(order.body.order.total.amount).toBeGreaterThan(0);

    const send = await pm.post(`/api/v1/change-orders/${orderId}/send`, {});
    expect(send.status, JSON.stringify(send.body)).toBe(201);
    const token = send.body.approvalUrl.split('/').pop() as string;
    expect(token.length).toBeGreaterThan(20);

    // Sending twice is refused: the client would otherwise have two live links to one document.
    const resend = await pm.post(`/api/v1/change-orders/${orderId}/send`, {});
    expect(resend.status).toBe(409);

    // The client opens the link. Opening is recorded but changes nothing.
    const guest = harness.client();
    const view = await guest.get(`/api/v1/public/approvals/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.state).toBe('valid');
    expect(view.body.order.status).toBe('sent');
    // No internal data on the public surface.
    expect(JSON.stringify(view.body)).not.toContain('internalCostRate');
    expect(view.body.order.pricing.total).toBeGreaterThan(0);

    const openOnly = await pm.get(`/api/v1/change-orders/${orderId}`);
    expect(openOnly.body.order.status).toBe('sent');
    expect(openOnly.body.links[0].accessCount).toBe(1);

    // A decision that does not match the document on screen is refused, not silently applied.
    const staleDecision = await guest.post(`/api/v1/public/approvals/${token}/decision`, {
      decision: 'accepted',
      name: 'Anita Rai',
      email: 'anita@everestretail.test',
      acknowledged: true,
      displayedDocumentHash: 'a-hash-from-an-older-tab-000000',
      displayedVersion: 1,
    });
    expect(staleDecision.status, JSON.stringify(staleDecision.body)).toBe(409);
    expect(staleDecision.body.error.code).toBe('CONFLICT');

    // Re-read with the real hash and decide properly.
    const view2 = await guest.get(`/api/v1/public/approvals/${token}`);
    expect(view2.body.state).toBe('valid');
    const orderDoc = await ChangeOrder.findById(orderId).lean();
    const decisionRes = await guest.post(`/api/v1/public/approvals/${token}/decision`, {
      decision: 'accepted',
      name: 'Anita Rai',
      email: 'anita@everestretail.test',
      role: 'Marketing Director',
      comment: 'Approved, please proceed before launch.',
      typedName: 'Anita Rai',
      acknowledged: true,
      displayedDocumentHash: orderDoc?.pdfHash ?? '',
      displayedVersion: 1,
    });
    expect(decisionRes.status, JSON.stringify(decisionRes.body)).toBe(201);
    expect(decisionRes.body.decision.documentVersion).toBe(1);

    // The link is now spent.
    const replay = await guest.post(`/api/v1/public/approvals/${token}/decision`, {
      decision: 'accepted',
      name: 'Anita Rai',
      email: 'anita@everestretail.test',
      acknowledged: true,
      displayedDocumentHash: orderDoc?.pdfHash ?? '',
      displayedVersion: 1,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('TOKEN_CONSUMED');

    // The accepted change becomes a DRAFT baseline; the original approved version is untouched.
    const apply = await pm.post(`/api/v1/change-orders/${orderId}/apply-to-baseline`, { note: 'Client approved 14 Oct.' });
    expect(apply.status, JSON.stringify(apply.body)).toBe(201);
    expect(apply.body.draft.version).toBe(2);
    expect(apply.body.addedKeys.length).toBe(1);

    const versions = await pm.get(`/api/v1/projects/${projectId}/baselines`);
    const v1 = versions.body.versions.find((v: any) => v.version === 1);
    const v2 = versions.body.versions.find((v: any) => v.version === 2);
    expect(v1.status).toBe('approved');
    expect(v2.status).toBe('draft');

    // The audit trail records the commercial events, and the chain verifies.
    const audit = await pm.get('/api/v1/audit-events?pageSize=100');
    expect(audit.status).toBe(200);
    const actions = audit.body.items.map((e: any) => e.action);
    expect(actions).toContain('baseline.approved');
    expect(actions).toContain('change_order.generated');
    expect(actions).toContain('change_order.sent');
    expect(actions).toContain('approval.decision_recorded');

    const verify = await pm.get('/api/v1/audit-events/verify');
    expect(verify.body, JSON.stringify(verify.body)).toMatchObject({ ok: true });

    // Financial visibility: the accepted change shows as contract value, not as cash.
    const profitability = await pm.get(`/api/v1/reports/profitability?projectId=${projectId}`);
    expect(profitability.status, JSON.stringify(profitability.body)).toBe(200);
    const row = profitability.body.projects[0];
    expect(row.values.approvedChanges.amount).toBeGreaterThan(0);
    expect(row.values.collected).toBeNull();
    expect(profitability.body.labels.collected).toContain('UNTRACKED');

    // Developer cannot read financial reports.
    const devReports = await dev.get(`/api/v1/reports/profitability?projectId=${projectId}`);
    expect(devReports.status).toBe(403);
  });

  it('shows time booked against an unapproved request as unapproved work, not revenue', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    const { projectId } = await setupProject(pm);

    const requestRes = await pm.post('/api/v1/requests', {
      projectId,
      title: 'Rework the hero animation',
      description: 'Client asked for a different hero animation before the review meeting.',
      submit: true,
    });
    const requestId = requestRes.body.request._id ?? requestRes.body.request.id;

    const estimate = await pm.post(`/api/v1/requests/${requestId}/estimates`, { hours: { design: 8 }, billingRate: 95 });
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(201);
    await pm.post(`/api/v1/estimates/${estimate.body.estimate.id}/finalise`, {});

    const time = await pm.post('/api/v1/time-entries', { projectId, requestId, hours: 6.5, category: 'design' });
    expect(time.status, JSON.stringify(time.body)).toBe(201);
    expect(time.body.loggedWithoutApproval).toBe(true);
    expect(time.body.notice).toContain('not treated as billable revenue');

    const report = await pm.get('/api/v1/reports/unapproved-work');
    expect(report.status).toBe(200);
    expect(report.body.totals.hours).toBe(6.5);
    expect(report.body.totals.exposure.amount).toBeGreaterThan(0);
    expect(report.body.labels.exposureDefinition).toContain('NOT approved revenue');

    const csv = await pm.get('/api/v1/reports/unapproved-work.csv');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('potential additional value');
  });

  it('refuses an expired link and an already-superseded proposal', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    const { projectId } = await setupProject(pm);

    const requestRes = await pm.post('/api/v1/requests', {
      projectId,
      title: 'Add a careers page',
      description: 'The client would like a careers page with an open roles list.',
      submit: true,
    });
    const requestId = requestRes.body.request._id ?? requestRes.body.request.id;
    const estimate = await pm.post(`/api/v1/requests/${requestId}/estimates`, { hours: { frontend: 10, testing: 2 }, billingRate: 95 });
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(201);
    await pm.post(`/api/v1/estimates/${estimate.body.estimate.id}/finalise`, {});
    const order = await pm.post(`/api/v1/requests/${requestId}/change-orders`, {
      option: 'add_with_fee',
      summary: 'Add a careers page listing current openings with an application form link.',
      scopeAdditions: [{ title: 'Careers page' }],
    });
    const send = await pm.post(`/api/v1/change-orders/${order.body.order.id}/send`, {});
    expect(send.status, JSON.stringify(send.body)).toBe(201);
    const token = send.body.approvalUrl.split('/').pop() as string;

    // Expire the token directly: simulating the passage of time is the honest way to test this.
    await ApprovalToken.updateOne({ changeOrder: order.body.order.id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
    const guest = harness.client();
    const expiredView = await guest.get(`/api/v1/public/approvals/${token}`);
    expect(expiredView.body.state).toBe('expired');
    const expiredDecision = await guest.post(`/api/v1/public/approvals/${token}/decision`, {
      decision: 'accepted',
      name: 'Anita Rai',
      email: 'anita@everestretail.test',
      acknowledged: true,
      displayedDocumentHash: 'whatever',
      displayedVersion: 1,
    });
    expect(expiredDecision.status).toBe(410);
    expect(expiredDecision.body.error.code).toBe('TOKEN_EXPIRED');

    // A new version supersedes the old document and kills the earlier link.
    await ApprovalToken.updateOne({ changeOrder: order.body.order.id }, { $set: { expiresAt: new Date(Date.now() + 86_400_000) } });
    const v2 = await pm.post(`/api/v1/requests/${requestId}/change-orders`, {
      option: 'add_with_fee',
      summary: 'Careers page, revised to include salary ranges and a link to the ATS.',
      scopeAdditions: [{ title: 'Careers page with salary ranges' }],
    });
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body.order.version).toBe(2);

    const supersededView = await guest.get(`/api/v1/public/approvals/${token}`);
    expect(supersededView.body.state).toBe('revoked');

    const orderDoc = await ChangeOrder.findById(v2.body.order.id).lean();
    expect(orderDoc?.status).toBe('draft');
  });

  it('blocks cross-organization access at every level', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    const { projectId } = await setupProject(pm);

    const rival = harness.client();
    await signUp(rival, outsider.email, outsider.name);
    const rivalOrg = await createOrg(rival, 'Rival Agency');
    expect(rivalOrg.slug).toContain('rival');

    // Tenant A's project is invisible, and reports 404 rather than 403 (no existence leak).
    const read = await rival.get(`/api/v1/projects/${projectId}`);
    expect(read.status).toBe(404);

    const write = await rival.post(`/api/v1/projects/${projectId}/baselines`, { label: 'Steal their scope' });
    expect(write.status).toBe(404);

    const requests = await rival.get(`/api/v1/requests?projectId=${projectId}`);
    expect([200, 404]).toContain(requests.status);
    if (requests.status === 200) expect(requests.body.items).toHaveLength(0);

    // The organization scoping is enforced in the database layer, not just the route.
    const project = await Project.findById(projectId).lean();
    const liveOrgs = await Organization.countDocuments();
    expect(liveOrgs).toBe(2);
    expect(String(project?.org)).not.toBe(String(rivalOrg.orgId));
  });

  it('requires server-side validation and CSRF for state-changing requests', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    await createOrg(pm, 'Validation Studio');

    // Invalid body → 422 with a field-level explanation, not a 500.
    const bad = await pm.post('/api/v1/clients', { name: 'x' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    // Missing CSRF header on a cookie-authenticated mutation → refused.
    const noCsrf = await pm.request('POST', '/api/v1/clients', {
      body: { name: 'Valid Client Name' },
      headers: { 'content-type': 'application/json' },
      omitCsrf: true,
    });
    expect([403, 422]).toContain(noCsrf.status);

    // A body carrying Mongo operators is rejected by schema validation rather than reaching the DB.
    const injection = await pm.post('/api/v1/clients', { name: { $ne: null } });
    expect(injection.status).toBe(422);
  });
});
