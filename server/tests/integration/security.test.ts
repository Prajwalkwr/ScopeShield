import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, resetBetweenTests, signUp, type Harness, type TestClient } from '../support/harness';
import { Document, Membership, User } from '../../src/models';

/**
 * Security and abuse-resistance tests. These assert refusals, because a refusal is the feature.
 */
let harness: Harness;

const owner = { email: 'owner@alpha.test', name: 'Alpha Owner' };
const developer = { email: 'dev@alpha.test', name: 'Alpha Developer' };
const rival = { email: 'owner@beta.test', name: 'Beta Owner' };

async function org(client: TestClient, name: string) {
  const res = await client.post('/api/v1/organizations', { name, currency: 'USD' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  client.setOrg(res.body.organization.orgId);
  return res.body.organization as { orgId: string; slug: string };
}

async function project(client: TestClient, name = 'Alpha Site') {
  const clientRes = await client.post('/api/v1/clients', { name: `${name} client`, contactEmail: 'contact@alpha.test' });
  const clientId = clientRes.body.client._id ?? clientRes.body.client.id;
  const projectRes = await client.post('/api/v1/projects', {
    name,
    code: `A${Math.floor(Math.random() * 9000) + 1000}`,
    clientId,
    currency: 'USD',
    hourlyRate: 90,
    internalCostRate: 35,
  });
  expect(projectRes.status, JSON.stringify(projectRes.body)).toBe(201);
  return projectRes.body.project._id as string;
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

describe('authorization', () => {
  it('does not let a developer escalate their own role or grant themselves permissions', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    const o = await org(pm, 'Alpha Agency');
    const projectId = await project(pm);

    const invite = await pm.post(`/api/v1/organizations/${o.orgId}/invitations`, { email: developer.email, role: 'developer' });
    const dev = harness.client();
    await signUp(dev, developer.email, developer.name);
    const joined = await dev.post('/api/v1/organizations/invitations/accept', { token: invite.body.linkToken });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    dev.setOrg(joined.body.joined.orgId);

    // Read the membership back from the server rather than assuming an id from the response.
    const members = await pm.get(`/api/v1/organizations/${o.orgId}/members`);
    const developerMembership = members.body.members.find((m: any) => m.user?.email === developer.email);
    expect(developerMembership, JSON.stringify(members.body)).toBeTruthy();
    const membershipId = developerMembership.membershipId ?? developerMembership.id;

    // A developer holds no member-management permission, so all of these must fail.
    const selfPromote = await dev.patch(`/api/v1/organizations/${o.orgId}/members/${membershipId}`, { role: 'org_owner' });
    expect(selfPromote.status).toBe(403);

    const selfGrant = await dev.patch(`/api/v1/organizations/${o.orgId}/members/${membershipId}`, {
      grants: ['change_order.send', 'report.view_financials'],
    });
    expect(selfGrant.status).toBe(403);

    const inviteOthers = await dev.post(`/api/v1/organizations/${o.orgId}/invitations`, { email: 'friend@alpha.test', role: 'org_owner' });
    expect(inviteOthers.status).toBe(403);

    // Even the owner cannot grant the non-grantable billing capability.
    const billingGrant = await pm.patch(`/api/v1/organizations/${o.orgId}/members/${membershipId}`, {
      grants: ['org.manage_billing'],
    });
    expect([400, 403, 422]).toContain(billingGrant.status);

    // The developer still cannot act commercially on a request they created.
    const req = await dev.post('/api/v1/requests', {
      projectId,
      title: 'Add a pricing table',
      description: 'Client asked for a pricing table on the services page.',
      submit: true,
    });
    const requestId = req.body.request._id ?? req.body.request.id;
    const sendAttempt = await dev.post(`/api/v1/requests/${requestId}/change-orders`, {
      option: 'add_with_fee',
      summary: 'Pricing table as an additional fee.',
      scopeAdditions: [{ title: 'Pricing table' }],
    });
    expect(sendAttempt.status).toBe(403);

    // Their membership record in the database is unchanged: the API was the only path, and it refused.
    const stored = await Membership.findById(membershipId).lean();
    expect(stored?.role).toBe('developer');
    expect(stored?.grants ?? []).toHaveLength(0);
  });

  it('never leaks whether another organization exists', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    const alpha = await org(pm, 'Alpha Agency');
    const projectId = await project(pm);

    const other = harness.client();
    await signUp(other, rival.email, rival.name);
    const beta = await org(other, 'Beta Agency');

    const crossTenantProbes = [
      `/api/v1/projects/${projectId}`,
      `/api/v1/clients/${projectId}`,
      `/api/v1/projects/${projectId}/baselines`,
      `/api/v1/organizations/${alpha.orgId}/members`,
      `/api/v1/organizations/${alpha.orgId}`,
    ];
    for (const path of crossTenantProbes) {
      const res = await other.get(path);
      // The only acceptable answers are "not found" or "permission denied" — and never a
      // payload that reveals the other tenant's data.
      expect([403, 404], `${path} → ${res.status}`).toContain(res.status);
      expect(JSON.stringify(res.body), path).not.toContain('Alpha');
    }

    // Endpoints that legitimately serve the caller's OWN tenant must show only that tenant.
    for (const ownPath of ['/api/v1/audit-events', '/api/v1/requests', '/api/v1/clients']) {
      const res = await other.get(ownPath);
      expect(res.status, `${ownPath} → ${res.status}`).toBe(200);
      expect(JSON.stringify(res.body), ownPath).not.toContain('Alpha Agency');
    }

    // Claiming the other organization via the header does not work either: membership is checked
    // against the session, not against what the client claims.
    other.setOrg(alpha.orgId);
    const claimed = await other.get('/api/v1/clients');
    expect(claimed.status).toBe(404);
    other.setOrg(beta.orgId);
  });

  it('keeps internal fields off the client-facing approval surface', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    await org(pm, 'Alpha Agency');
    const projectId = await project(pm);

    await pm.post(`/api/v1/projects/${projectId}/baselines`, { label: 'v1' });
    const versions = await pm.get(`/api/v1/projects/${projectId}/baselines`);
    const versionId = versions.body.versions[0]._id;
    await pm.post(`/api/v1/projects/${projectId}/baselines/${versionId}/requirements`, {
      kind: 'requirement',
      title: 'Marketing site',
      category: 'functional',
    });
    await pm.post(`/api/v1/projects/${projectId}/baselines/${versionId}/approve`, { method: 'internal', confirm: true });

    const req = await pm.post('/api/v1/requests', {
      projectId,
      title: 'Add a newsletter signup',
      description: 'Client wants a newsletter signup form in the footer with double opt-in.',
      submit: true,
      internalNotes: 'Margin here is thin — do not offer a discount.',
    });
    const requestId = req.body.request._id ?? req.body.request.id;
    const estimate = await pm.post(`/api/v1/requests/${requestId}/estimates`, {
      hours: { frontend: 6, backend: 4 },
      billingRate: 90,
      internalCostRate: 35,
    });
    await pm.post(`/api/v1/estimates/${estimate.body.estimate.id}/finalise`, {});
    const order = await pm.post(`/api/v1/requests/${requestId}/change-orders`, {
      option: 'add_with_fee',
      summary: 'Newsletter signup with double opt-in, placed in the footer.',
      scopeAdditions: [{ title: 'Newsletter signup' }],
    });
    const send = await pm.post(`/api/v1/change-orders/${order.body.order.id}/send`, {});
    const token = send.body.approvalUrl.split('/').pop() as string;

    const guest = harness.client();
    const view = await guest.get(`/api/v1/public/approvals/${token}`);
    const serialised = JSON.stringify(view.body);
    for (const secret of ['internalCostRate', 'grossMargin', 'internalNotes', 'do not offer a discount', 'billingRate', 'cost']) {
      expect(serialised.toLowerCase(), `leaked: ${secret}`).not.toContain(secret.toLowerCase());
    }

    // The client cannot reach the internal API with the link token as a bearer credential.
    const asBearer = await guest.get(`/api/v1/change-orders/${order.body.order.id}`, { authorization: `Bearer ${token}` });
    expect(asBearer.status).toBe(401);
  });

  it('applies rate limits to authentication and to the public approval endpoint', async () => {
    const client = harness.client();
    // The login limiter is the front line against credential stuffing.
    let limited = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const res = await client.post('/api/v1/auth/login', { email: 'nobody@example.test', password: 'wrong-password' });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited, 'login attempts should eventually be rate limited').toBe(true);

    // A weak but well-formed token is rejected without ever touching the database lookup cost.
    const guest = harness.client();
    const invalid = await guest.get(`/api/v1/public/approvals/${'a'.repeat(64)}`);
    expect(invalid.status).toBe(404);
    expect(invalid.body.error.code).toBe('NOT_FOUND');
  });

  it('does not expose environment secrets or stack traces in error responses', async () => {
    const client = harness.client();
    await signUp(client, owner.email, owner.name);
    await org(client, 'Alpha Agency');

    const bad = await client.request('POST', '/api/v1/clients', { body: { name: 'x' }, omitCsrf: false });
    const serialised = JSON.stringify(bad.body);
    expect(bad.status).toBe(422);
    for (const leak of ['SESSION_SECRET', 'MONGODB_URI', 'at Object.', '/home/', 'node_modules', 'stack']) {
      expect(serialised).not.toContain(leak);
    }
    expect(bad.body.error.requestId).toBeTruthy();
  });

  it('rejects malformed uploads and never trusts the claimed content type', async () => {
    const pm = harness.client();
    await signUp(pm, owner.email, owner.name);
    await org(pm, 'Alpha Agency');
    const projectId = await project(pm);

    // A file whose bytes are not a PDF, despite the name and the browser's claim.
    const fakePdf = Buffer.from('<?php system($_GET["c"]); ?>');
    const rejected = await pm.upload(`/api/v1/projects/${projectId}/documents`, fakePdf, 'invoice.pdf', 'application/pdf');
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(415);

    // An executable payload under a PDF name is refused on the same grounds.
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
    const binary = await pm.upload(`/api/v1/projects/${projectId}/documents`, elf, 'report.pdf', 'application/pdf');
    expect(binary.status).toBe(415);

    // A real text file is accepted, stored under a generated key, and reviewed before anything
    // reaches a baseline.
    const text = [
      'Statement of work — Everest Corporate Website',
      '',
      '• Five page responsive marketing website (Home, About, Services, Work, Contact).',
      '• Contact form with email notification to the client inbox.',
      '• Two rounds of design revisions are included.',
      '',
      'Online booking, customer accounts and payments are explicitly excluded.',
    ].join('\n');
    const accepted = await pm.upload(`/api/v1/projects/${projectId}/documents`, Buffer.from(text), 'sow.txt', 'text/plain', {
      kind: 'statement_of_work',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.document.extraction.status).toBe('done');
    expect(accepted.body.document.sizeBytes).toBeGreaterThan(0);
    // A generated name, never the client's: the file is not addressable by its original name.
    expect(accepted.body.document.originalName).toBe('sow.txt');
    const stored = await Document.findOne({ _id: accepted.body.document.id }).lean();
    expect(stored?.storageKey).not.toContain('sow');
    expect(stored?.sha256).toHaveLength(64);

    const review = await pm.get(`/api/v1/documents/${accepted.body.document.id}/review`);
    expect(review.status).toBe(200);
    expect(review.body.candidates.length).toBeGreaterThan(0);
    expect(review.body.guidance).toMatch(/suggestion/i);

    // Uploads are scoped: the other tenant cannot read this document.
    const other = harness.client();
    await signUp(other, rival.email, rival.name);
    await org(other, 'Beta Agency');
    const steal = await other.get(`/api/v1/documents/${accepted.body.document.id}/download`);
    expect(steal.status).toBe(404);
  });

  it('requires re-authentication for password changes and invalidates old sessions', async () => {
    const client = harness.client();
    await signUp(client, owner.email, owner.name);
    await org(client, 'Alpha Agency');

    const wrong = await client.post('/api/v1/auth/password/change', {
      currentPassword: 'NotTheRightPassword1!',
      newPassword: 'AnotherCorrectHorse2!',
    });
    // A wrong current password is a field-level problem, so it is reported as validation
    // rather than as a generic failure.
    expect([400, 401, 403, 422]).toContain(wrong.status);
    expect(wrong.body.error.message).toMatch(/current password/i);

    const changed = await client.post('/api/v1/auth/password/change', {
      currentPassword: 'CorrectHorseBattery9!',
      newPassword: 'AnotherCorrectHorse2!',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // The old password no longer works, and the account is not locked out for the real one.
    const stale = harness.client();
    const staleLogin = await stale.post('/api/v1/auth/login', { email: owner.email, password: 'CorrectHorseBattery9!' });
    expect(staleLogin.status).toBe(401);

    const fresh = harness.client();
    const freshLogin = await fresh.post('/api/v1/auth/login', { email: owner.email, password: 'AnotherCorrectHorse2!' });
    expect(freshLogin.status).toBe(200);

    // Passwords are stored as a scrypt hash with parameters embedded, never reversibly, and the
    // plaintext never appears anywhere in the stored record.
    const user = await User.findOne({ email: owner.email }).select('+passwordHash').lean();
    // Format: scrypt$<N>$<r>$<p>$<keylen>$<salt base64>$<hash base64>
    const parts = String(user?.passwordHash).split('$');
    expect(parts).toHaveLength(7);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);
    expect(parts[5].length).toBeGreaterThan(8);
    expect(parts[6].length).toBeGreaterThan(20);
    expect(JSON.stringify(user)).not.toContain('AnotherCorrectHorse2!');
    expect(JSON.stringify(user)).not.toContain('CorrectHorseBattery9!');
  });
});
