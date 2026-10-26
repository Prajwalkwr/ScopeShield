import type { ClientSession } from 'mongoose';
import { AuditChain, AuditEvent } from '../models';
import { canonicalJson, sha256 } from './crypto';
import { logger } from './logger';

/**
 * Append-only audit trail with a per-organization hash chain.
 *
 * There is deliberately no update or delete function in this module. A `verifyChain`
 * helper re-walks the chain so tampering is detectable.
 */
export interface AuditInput {
  org: string;
  action: string;
  actor: { kind: 'user' | 'client' | 'system'; userId?: string | null; name?: string; email?: string };
  entity: { type: string; id?: string | null; label?: string };
  changes?: { field: string; from: string; to: string }[];
  meta?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export async function recordAudit(input: AuditInput, session: ClientSession | null = null): Promise<void> {
  try {
    // Atomically claim the next sequence number in this org's chain.
    const chain = await AuditChain.findOneAndUpdate(
      { org: input.org },
      { $inc: { lastSeq: 1 } },
      { new: true, upsert: true, session: session ?? undefined, setDefaultsOnInsert: true },
    );

    const prevHash = chain?.lastHash ?? 'GENESIS';
    const seq = chain?.lastSeq ?? 1;

    /**
     * The event's own timestamp is created here and written explicitly, because it is part of
     * the hashed payload. If the schema set it afterwards, the stored value would differ by a
     * few milliseconds from the hashed one and every verification would report a forgery.
     */
    const createdAt = new Date();

    const payload = {
      seq,
      action: input.action,
      actorKind: input.actor.kind,
      actorId: input.actor.userId ?? null,
      name: input.actor.name ?? '',
      email: input.actor.email ?? '',
      entityType: input.entity.type,
      entityId: input.entity.id ?? null,
      entityLabel: input.entity.label ?? '',
      changes: input.changes ?? [],
      meta: input.meta ?? {},
      createdAt: createdAt.toISOString(),
    };
    const hash = sha256(`${prevHash}|${canonicalJson(payload)}`);

    const event = new AuditEvent({
      org: input.org,
      seq,
      action: input.action,
      actor: {
        kind: input.actor.kind,
        user: input.actor.userId ?? null,
        name: input.actor.name ?? '',
        email: input.actor.email ?? '',
      },
      entity: { type: input.entity.type, id: input.entity.id ?? null, label: input.entity.label ?? '' },
      changes: input.changes ?? [],
      meta: input.meta ?? {},
      ip: input.ip ?? '',
      userAgent: input.userAgent ?? '',
      prevHash,
      hash,
      createdAt,
    });
    // timestamps: false — the timestamp is part of the hashed content and must not be re-stamped.
    await event.save({ session: session ?? undefined, timestamps: false });

    await AuditChain.updateOne({ org: input.org }, { $set: { lastHash: hash } }, { session: session ?? undefined });
  } catch (err) {
    // Auditing must never break the business operation that triggered it, but a failure
    // to record is itself a serious condition and is logged loudly.
    logger.error('AUDIT WRITE FAILED — investigate', {
      action: input.action,
      entityType: input.entity.type,
      entityId: input.entity.id,
      error: err,
    });
  }
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBrokenSeq: number | null;
  reason: string;
}

/** Re-walk an organization's audit chain and report the first inconsistency. */
export async function verifyAuditChain(org: string): Promise<ChainVerification> {
  const events = await AuditEvent.find({ org }).sort({ seq: 1 }).lean();
  let prevHash = 'GENESIS';
  let checked = 0;
  for (const event of events) {
    const actor = event.actor ?? { kind: 'system', name: '', email: '' };
    const entity = event.entity ?? { type: 'unknown', label: '' };
    const payload = {
      seq: event.seq,
      action: event.action,
      actorKind: actor.kind,
      actorId: actor.user?.toString() ?? null,
      name: actor.name ?? '',
      email: actor.email ?? '',
      entityType: entity.type,
      entityId: entity.id?.toString() ?? null,
      entityLabel: entity.label ?? '',
      changes: event.changes ?? [],
      meta: event.meta ?? {},
      createdAt: new Date(event.createdAt as Date).toISOString(),
    };
    const expected = sha256(`${prevHash}|${canonicalJson(payload)}`);
    if (event.prevHash !== prevHash) {
      return { ok: false, checked, firstBrokenSeq: event.seq, reason: 'prevHash does not match the previous event hash.' };
    }
    if (event.hash !== expected) {
      return { ok: false, checked, firstBrokenSeq: event.seq, reason: 'Event hash does not match its content (edited or forged record).' };
    }
    prevHash = event.hash;
    checked += 1;
  }
  return { ok: true, checked, firstBrokenSeq: null, reason: 'Chain intact.' };
}
