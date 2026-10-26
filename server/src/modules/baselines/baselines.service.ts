import mongoose from 'mongoose';
import { BaselineVersion, ChangeRequest, Project } from '../../models';
import { canonicalJson, sha256 } from '../../platform/crypto';
import { conflict, immutable, notFound, precondition, badRequest } from '../../platform/errors';
import { recordAudit } from '../../platform/audit';
import { AUDIT_ACTIONS } from '../../config/constants';
import { transitionsFrom } from '../../domain/stateMachine';

type ActorCtx = { userId: string; name: string; email: string; ip?: string; userAgent?: string };

export interface RequirementInput {
  key?: string;
  kind: 'requirement' | 'exclusion';
  title: string;
  description?: string;
  category?: string;
  priority?: 'must' | 'should' | 'could' | 'wont';
  acceptanceCriteria?: string[];
  deliverable?: string;
  estimatedHours?: number;
  dependsOn?: string[];
  tags?: string[];
  ambiguous?: boolean;
}

/** Subjective wording that makes a requirement impossible to verify objectively. */
const AMBIGUITY_PATTERNS = [
  /\bmodern\b/i, /\bclean\b/i, /\bnice\b/i, /\bprofessional\b/i, /\buser-?friendly\b/i, /\bintuitive\b/i,
  /\bseamless\b/i, /\brobust\b/i, /\bfast\b/i, /\bscalable\b/i, /\bquality\b/i, /\bappropriate\b/i,
  /\bproperly\b/i, /\bas needed\b/i, /\betc\.?\b/i, /\bbest practice\b/i,
];

export function detectAmbiguity(text: string): boolean {
  return AMBIGUITY_PATTERNS.some((re) => re.test(text));
}

/** Next free identifier of a given kind for this version (REQ-007 / EXC-003). */
export function nextKey(existing: string[], kind: 'requirement' | 'exclusion'): string {
  const prefix = kind === 'requirement' ? 'REQ' : 'EXC';
  const numbers = existing
    .filter((k) => k.startsWith(`${prefix}-`))
    .map((k) => Number(k.split('-')[1]))
    .filter((n) => Number.isFinite(n));
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

async function loadProject(orgId: string, projectId: string) {
  const project = await Project.findOne({ _id: projectId, org: orgId, deletedAt: null });
  if (!project) throw notFound('Project not found.');
  return project;
}

async function loadVersion(orgId: string, projectId: string, versionId: string) {
  const version = await BaselineVersion.findOne({ _id: versionId, org: orgId, project: projectId });
  if (!version) throw notFound('Baseline version not found.');
  return version;
}

export function summariseSnapshot(snapshot: {
  requirements: { kind: string; acceptanceCriteria?: unknown[] }[];
}) {
  const requirements = snapshot.requirements.filter((r) => r.kind === 'requirement');
  const exclusions = snapshot.requirements.filter((r) => r.kind === 'exclusion');
  return {
    requirementCount: requirements.length,
    exclusionCount: exclusions.length,
    withoutAcceptanceCriteria: requirements.filter((r) => (r.acceptanceCriteria?.length ?? 0) === 0).length,
  };
}

/** Creates a new draft version. Only one draft may exist per project (partial unique index). */
export async function createDraft(input: {
  orgId: string;
  projectId: string;
  actor: ActorCtx;
  label?: string;
  reason?: string;
  fromVersionId?: string;
  changeRequestId?: string;
  documentId?: string;
  sourceType?: 'manual' | 'document_import' | 'change_order' | 'api';
}) {
  const project = await loadProject(input.orgId, input.projectId);

  const existingDraft = await BaselineVersion.findOne({ project: project._id, status: 'draft' }).lean();
  if (existingDraft) {
    throw conflict(
      `A draft baseline (version ${existingDraft.version}) is already open for this project. Finish or discard it before starting another.`,
    );
  }

  const last = await BaselineVersion.findOne({ project: project._id }).sort({ version: -1 }).lean();
  const parentId = input.fromVersionId ?? (project.currentBaseline ? String(project.currentBaseline) : null);
  const parent = parentId ? await BaselineVersion.findById(parentId).lean() : null;

  const snapshot = parent
    ? JSON.parse(JSON.stringify(parent.snapshot))
    : { objectives: [], requirements: [], assumptions: [], dependencies: [], clientResponsibilities: [], supportBoundaries: [], milestones: [], budget: { amountMinor: project.contractAmountMinor, currency: project.currency, estimatedHours: project.estimatedHours } };

  const version = await BaselineVersion.create({
    org: project.org,
    project: project._id,
    version: (last?.version ?? 0) + 1,
    status: 'draft',
    parent: parent?._id ?? null,
    changeRequest: input.changeRequestId ? new mongoose.Types.ObjectId(input.changeRequestId) : null,
    label: input.label ?? (parent ? `Revision of v${parent.version}` : 'Initial agreed scope'),
    reason: input.reason ?? '',
    snapshot,
    source: {
      type: input.sourceType ?? (parent ? 'change_order' : 'manual'),
      document: input.documentId ? new mongoose.Types.ObjectId(input.documentId) : null,
      importedAt: input.documentId ? new Date() : null,
    },
    createdBy: input.actor.userId,
  });

  project.baselineVersionCount = version.version;
  await project.save();

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.baselineCreated,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'BaselineVersion', id: String(version._id), label: `v${version.version} draft` },
    meta: { basedOn: parent ? `v${parent.version}` : 'empty', fromChangeRequest: input.changeRequestId ?? null },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return version;
}

/** Draft-only mutation guard: approved versions are immutable, full stop. */
function assertEditable(version: { status: string; version: number }) {
  if (version.status === 'approved') {
    throw immutable(
      `Baseline v${version.version} is approved and cannot be edited. Create a new version from it instead — the approved record must stay exactly as it was agreed.`,
    );
  }
  if (version.status === 'superseded') throw immutable(`Baseline v${version.version} is superseded and is kept for history only.`);
}

export async function updateSnapshotMeta(
  input: { orgId: string; projectId: string; versionId: string; actor: ActorCtx; patch: Record<string, unknown> },
) {
  const version = await loadVersion(input.orgId, input.projectId, input.versionId);
  assertEditable(version);

  const allowed: (keyof typeof version.snapshot)[] = [
    'objectives', 'assumptions', 'dependencies', 'clientResponsibilities', 'supportBoundaries',
  ];
  for (const field of allowed) {
    if (input.patch[field] !== undefined) {
      (version.snapshot as unknown as Record<string, unknown>)[field] = input.patch[field];
    }
  }
  if (input.patch.budget) {
    const patch = input.patch.budget as { amountMinor?: number; currency?: string; estimatedHours?: number };
    const current = version.snapshot.budget ?? { amountMinor: 0, currency: 'USD', estimatedHours: 0 };
    version.snapshot.budget = {
      amountMinor: patch.amountMinor ?? current.amountMinor,
      currency: patch.currency ?? current.currency,
      estimatedHours: patch.estimatedHours ?? current.estimatedHours,
    };
  }
  if (input.patch.milestones) {
    version.snapshot.milestones = input.patch.milestones as typeof version.snapshot.milestones;
  }
  await version.save();
  return version;
}

export async function addRequirement(input: {
  orgId: string;
  projectId: string;
  versionId: string;
  actor: ActorCtx;
  requirement: RequirementInput;
}) {
  const version = await loadVersion(input.orgId, input.projectId, input.versionId);
  assertEditable(version);

  const existingKeys = version.snapshot.requirements.map((r) => r.key);
  const key = input.requirement.key?.toUpperCase() ?? nextKey(existingKeys, input.requirement.kind);
  if (existingKeys.includes(key)) throw conflict(`${key} already exists in this version.`);

  const text = `${input.requirement.title} ${input.requirement.description ?? ''}`;
  version.snapshot.requirements.push({
    key,
    kind: input.requirement.kind,
    title: input.requirement.title,
    description: input.requirement.description ?? '',
    category: input.requirement.category ?? (input.requirement.kind === 'exclusion' ? 'exclusion' : 'functional'),
    priority: input.requirement.priority ?? 'must',
    acceptanceCriteria: (input.requirement.acceptanceCriteria ?? []).map((text2, index) => ({
      id: `AC-${index + 1}`,
      text: text2,
    })),
    deliverable: input.requirement.deliverable ?? '',
    estimatedHours: input.requirement.estimatedHours ?? 0,
    dependsOn: input.requirement.dependsOn ?? [],
    tags: input.requirement.tags ?? [],
    ambiguous: input.requirement.ambiguous ?? detectAmbiguity(text),
  } as never);

  await version.save();
  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.requirementChanged,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'BaselineVersion', id: String(version._id), label: `v${version.version}` },
    changes: [{ field: key, from: '(added)', to: input.requirement.title.slice(0, 120) }],
    meta: { kind: input.requirement.kind, draftRevision: version.updatedAt },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });
  return { version, key };
}

export async function updateRequirement(input: {
  orgId: string;
  projectId: string;
  versionId: string;
  key: string;
  actor: ActorCtx;
  patch: Partial<RequirementInput>;
}) {
  const version = await loadVersion(input.orgId, input.projectId, input.versionId);
  assertEditable(version);
  const target = version.snapshot.requirements.find((r) => r.key === input.key.toUpperCase());
  if (!target) throw notFound(`${input.key} is not part of baseline v${version.version}.`);

  const changes: { field: string; from: string; to: string }[] = [];
  const assignments: [keyof RequirementInput, unknown][] = [
    ['title', input.patch.title], ['description', input.patch.description], ['category', input.patch.category],
    ['priority', input.patch.priority], ['deliverable', input.patch.deliverable],
    ['estimatedHours', input.patch.estimatedHours], ['tags', input.patch.tags], ['dependsOn', input.patch.dependsOn],
  ];
  for (const [field, value] of assignments) {
    if (value === undefined) continue;
    const before = (target as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(before) !== JSON.stringify(value)) {
      changes.push({ field: `${target.key}.${String(field)}`, from: String(before).slice(0, 100), to: String(value).slice(0, 100) });
      (target as unknown as Record<string, unknown>)[field] = value;
    }
  }
  if (input.patch.acceptanceCriteria) {
    target.acceptanceCriteria = input.patch.acceptanceCriteria.map((t, i) => ({ id: `AC-${i + 1}`, text: t })) as never;
    changes.push({ field: `${target.key}.acceptanceCriteria`, from: '(previous)', to: `${input.patch.acceptanceCriteria.length} criteria` });
  }
  const combined = `${target.title} ${target.description}`;
  target.ambiguous = input.patch.ambiguous ?? detectAmbiguity(combined);

  await version.save();
  if (changes.length) {
    await recordAudit({
      org: input.orgId,
      action: AUDIT_ACTIONS.requirementChanged,
      actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
      entity: { type: 'BaselineVersion', id: String(version._id), label: `v${version.version}` },
      changes,
      ip: input.actor.ip,
      userAgent: input.actor.userAgent,
    });
  }
  return { version, requirement: target };
}

export async function removeRequirement(input: {
  orgId: string;
  projectId: string;
  versionId: string;
  key: string;
  actor: ActorCtx;
  reason?: string;
}) {
  const version = await loadVersion(input.orgId, input.projectId, input.versionId);
  assertEditable(version);
  const upper = input.key.toUpperCase();
  const index = version.snapshot.requirements.findIndex((r) => r.key === upper);
  if (index === -1) throw notFound(`${upper} is not part of baseline v${version.version}.`);

  const removed = version.snapshot.requirements[index]!;
  // Removing a requirement others depend on would silently break the graph.
  const dependents = version.snapshot.requirements.filter((r) => (r.dependsOn ?? []).includes(upper));
  if (dependents.length > 0) {
    throw precondition(
      `${upper} is a dependency of ${dependents.map((d) => d.key).join(', ')}. Update those first.`,
      { dependents: dependents.map((d) => d.key) },
    );
  }
  version.snapshot.requirements.splice(index, 1);
  await version.save();
  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.requirementChanged,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'BaselineVersion', id: String(version._id), label: `v${version.version}` },
    changes: [{ field: upper, from: removed.title.slice(0, 120), to: '(removed)' }],
    meta: { reason: input.reason ?? '' },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });
  return version;
}

export function diffSnapshots(
  before: { requirements: { key: string; title: string; kind: string }[] } | null,
  after: { requirements: { key: string; title: string; kind: string }[] },
) {
  if (!before) {
    return {
      addedRequirements: after.requirements.filter((r) => r.kind === 'requirement').map((r) => r.key),
      removedRequirements: [],
      modifiedRequirements: [],
      addedExclusions: after.requirements.filter((r) => r.kind === 'exclusion').map((r) => r.key),
      removedExclusions: [],
    };
  }
  const beforeMap = new Map(before.requirements.map((r) => [r.key, r]));
  const afterMap = new Map(after.requirements.map((r) => [r.key, r]));
  const added = [...afterMap.keys()].filter((k) => !beforeMap.has(k));
  const removed = [...beforeMap.keys()].filter((k) => !afterMap.has(k));
  const modified: string[] = [];
  for (const [key, afterItem] of afterMap) {
    const beforeItem = beforeMap.get(key);
    if (beforeItem && (beforeItem.title !== afterItem.title || beforeItem.kind !== afterItem.kind)) modified.push(key);
  }
  return {
    addedRequirements: added.filter((k) => afterMap.get(k)?.kind === 'requirement'),
    removedRequirements: removed.filter((k) => beforeMap.get(k)?.kind === 'requirement'),
    modifiedRequirements: modified,
    addedExclusions: added.filter((k) => afterMap.get(k)?.kind === 'exclusion'),
    removedExclusions: removed.filter((k) => beforeMap.get(k)?.kind === 'exclusion'),
  };
}

/**
 * Approving a version freezes it: it is hashed, marked approved, made the project's
 * current baseline, and the previous approved version is superseded (never edited).
 */
export async function approveVersion(input: {
  orgId: string;
  projectId: string;
  versionId: string;
  actor: ActorCtx;
  evidence: { method: 'internal' | 'client_change_order' | 'external_document' | 'migration'; actorName?: string; actorEmail?: string; note?: string };
  changeRequestId?: string;
}) {
  const version = await loadVersion(input.orgId, input.projectId, input.versionId);
  if (version.status === 'approved' && version.snapshotHash) {
    // Idempotent: re-approving an approved version returns it unchanged.
    return { version, alreadyApproved: true as const };
  }
  if (version.status === 'superseded') throw immutable(`Baseline v${version.version} has been superseded by a newer version.`);

  if (version.snapshot.requirements.length === 0) {
    throw precondition('An empty baseline cannot be approved. Add at least one requirement or exclusion.');
  }
  const requirementCount = version.snapshot.requirements.filter((r) => r.kind === 'requirement').length;
  if (requirementCount === 0) {
    throw precondition('A baseline with no deliverables cannot be approved. It would prove nothing later.');
  }

  const parent = version.parent ? await BaselineVersion.findById(version.parent).lean() : null;
  const hash = sha256(canonicalJson(version.snapshot));

  const project = await loadProject(input.orgId, input.projectId);
  const previousId = project.currentBaseline ? String(project.currentBaseline) : null;

  version.status = 'approved';
  version.snapshotHash = hash;
  version.approvedBy = new mongoose.Types.ObjectId(input.actor.userId);
  version.approvedAt = new Date();
  version.approvalEvidence = {
    method: input.evidence.method,
    actorName: input.evidence.actorName ?? input.actor.name,
    actorEmail: input.evidence.actorEmail ?? input.actor.email,
    note: input.evidence.note ?? '',
    document: null,
  } as never;
  version.diff = diffSnapshots(parent ? (parent.snapshot as never) : null, version.snapshot as never);
  if (input.changeRequestId) version.changeRequest = new mongoose.Types.ObjectId(input.changeRequestId);
  await version.save();

  // Supersede the previous approved version rather than overwriting it.
  if (previousId && previousId !== String(version._id)) {
    const previous = await BaselineVersion.findById(previousId);
    if (previous && previous.status === 'approved') {
      previous.status = 'superseded';
      await previous.save();
    }
  }

  project.currentBaseline = version._id as mongoose.Types.ObjectId;
  await project.save();

  if (input.changeRequestId) {
    const request = await ChangeRequest.findOne({ _id: input.changeRequestId, org: input.orgId });
    if (request) {
      request.outcome = {
        ...(request.outcome ?? {}),
        baselineUpdatedTo: version._id,
      } as never;
      await request.save();
    }
  }

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.baselineApproved,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'BaselineVersion', id: String(version._id), label: `v${version.version}` },
    meta: {
      snapshotHash: hash,
      requirements: requirementCount,
      exclusions: version.snapshot.requirements.length - requirementCount,
      supersededVersion: previousId,
      changeRequest: input.changeRequestId ?? null,
      evidenceMethod: input.evidence.method,
    },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  if (previousId) {
    await recordAudit({
      org: input.orgId,
      action: AUDIT_ACTIONS.baselineSuperseded,
      actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
      entity: { type: 'BaselineVersion', id: previousId, label: 'previous version' },
      meta: { supersededBy: String(version._id) },
    });
  }

  return { version, alreadyApproved: false as const };
}

/** Why a client-facing change order may or may not be promoted into the baseline. */
export async function promotableFrom(orgId: string, changeOrderId: string) {
  const { ChangeOrder } = await import('../../models');
  const order = await ChangeOrder.findOne({ _id: changeOrderId, org: orgId }).lean();
  if (!order) throw notFound('Change order not found.');
  if (order.status !== 'accepted' || order.decision?.outcome !== 'accepted') {
    throw precondition('Only an accepted change order may be promoted into a new baseline version.');
  }
  return order;
}

export { transitionsFrom, badRequest };

/**
 * Turns an ACCEPTED change order into a new DRAFT baseline version.
 *
 * Why a draft and not a silent write: the client authorised the change, but a human still
 * reviews what it does to the agreed scope before it becomes the new frozen baseline. The
 * previous approved version is never edited and is superseded only when the new one is approved.
 */
export async function applyAcceptedChangeToBaseline(input: {
  orgId: string;
  changeOrderId: string;
  actor: ActorCtx;
  note?: string;
}) {
  const { ChangeOrder, ChangeRequest } = await import('../../models');
  const order = await ChangeOrder.findOne({ _id: input.changeOrderId, org: input.orgId });
  if (!order) throw notFound('Change order not found.');
  if (order.status !== 'accepted') {
    throw precondition('Only an accepted change order may be applied to the baseline.');
  }
  if (!order.decision?.decidedAt) {
    throw precondition('The change order has no recorded client decision, so it cannot update the baseline.');
  }

  const project = await Project.findOne({ _id: order.project, org: input.orgId });
  if (!project) throw notFound('Project not found.');

  const existingDraft = await BaselineVersion.findOne({ project: project._id, status: 'draft' }).lean();
  if (existingDraft) {
    throw conflict(
      `A draft baseline (version ${existingDraft.version}) is already open. Finish it before applying this change order.`,
    );
  }

  const draft = await createDraft({
    orgId: input.orgId,
    projectId: String(project._id),
    actor: input.actor,
    label: `${order.number} — client accepted v${order.version}`,
    reason:
      input.note?.trim() ||
      `Approved by ${order.decision.deciderName || 'the client'} on ${order.decision.decidedAt.toISOString().slice(0, 10)} under ${order.number} v${order.version}.`,
    changeRequestId: String(order.request),
    sourceType: 'change_order',
  });

  // Additions become new requirement entries; removals are annotated in place (the old text
  // stays visible so the diff shows exactly what left the agreed scope).
  let addedKeys: string[] = [];
  for (const addition of order.scopeAdditions) {
    const result = await addRequirement({
      orgId: input.orgId,
      projectId: String(project._id),
      versionId: String(draft._id),
      actor: input.actor,
      requirement: {
        kind: 'requirement',
        title: addition.title,
        description: addition.description ?? '',
        category: 'new_scope',
        priority: 'must',
        acceptanceCriteria: addition.acceptanceCriteria ?? [],
        estimatedHours: addition.estimatedHours ?? 0,
        tags: [`source:${order.number}`],
      },
    });
    addedKeys.push(result.key);
  }

  const removed: { key: string; title: string }[] = [];
  const refreshed = await loadVersion(input.orgId, String(project._id), String(draft._id));
  for (const removal of order.scopeRemovals) {
    if (!removal.requirementKey) continue;
    const target = refreshed.snapshot.requirements.find((r) => r.key === removal.requirementKey);
    if (!target) continue;
    removed.push({ key: target.key, title: target.title });
    target.description = `${target.description ? `${target.description}\n\n` : ''}[${order.number}] Removed from scope: ${removal.note || 'replaced by the accepted change order'}.`;
  }
  if (removed.length) await refreshed.save();

  const request = await ChangeRequest.findById(order.request);
  if (request) {
    const previous = request.outcome;
    request.outcome = {
      decidedAt: previous?.decidedAt ?? order.decision.decidedAt,
      decision: previous?.decision ?? 'accepted',
      decidedBy: previous?.decidedBy ?? order.decision.deciderName,
      additionalValueMinor: previous?.additionalValueMinor ?? order.pricing?.total?.amount ?? 0,
      currency: previous?.currency ?? order.pricing?.currency ?? 'USD',
      scheduleImpactWorkdays: previous?.scheduleImpactWorkdays ?? order.schedule?.additionalWorkdays ?? 0,
      baselineUpdatedTo: draft._id as mongoose.Types.ObjectId,
      unapprovedHours: previous?.unapprovedHours ?? 0,
    };
    await request.save();
  }

  await recordAudit({
    org: input.orgId,
    action: AUDIT_ACTIONS.baselineCreated,
    actor: { kind: 'user', userId: input.actor.userId, name: input.actor.name, email: input.actor.email },
    entity: { type: 'BaselineVersion', id: String(draft._id), label: `v${draft.version} draft from ${order.number}` },
    meta: {
      changeOrder: String(order._id),
      addedKeys,
      removedKeys: removed.map((r) => r.key),
      note: input.note ?? '',
      decisionId: order.decision.decisionId ? String(order.decision.decisionId) : null,
    },
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
  });

  return { draft, addedKeys, removed, order };
}
