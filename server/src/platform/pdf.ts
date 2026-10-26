import PDFDocument from 'pdfkit';
import { formatMoney, toMajor, type Money } from '../domain/money';

/**
 * Change-order PDF rendering. Server-authoritative: the PDF is generated here, hashed,
 * and stored privately; the hash is what a client decision is bound to.
 *
 * Typography is deliberately plain: this is a business document, not a design piece.
 * NOTE: the document ends with a plain-language note that a click is a recorded decision
 * and not a jurisdiction-validated electronic signature. Agencies can attach their own
 * terms via organization settings; we never invent legal clauses.
 */
export interface ChangeOrderPdfInput {
  agencyName: string;
  agencyFooter: string;
  agencyContact: string;
  clientName: string;
  clientContact: string;
  projectCode: string;
  projectName: string;
  requestRef: string;
  requestTitle: string;
  orderNumber: string;
  version: number;
  option: string;
  optionLabel: string;
  baselineVersion: number | null;
  summary: string;
  scopeAdditions: { title: string; description?: string; acceptanceCriteria?: string[]; estimatedHours?: number }[];
  scopeRemovals: { requirementKey: string; title: string; note?: string }[];
  relatedRequirements: { key: string; title: string }[];
  pricing: {
    currency: string;
    subtotal: Money; contingency: Money; discount: Money; tax: Money; total: Money;
    notes?: string;
    effectiveHourlyRate?: Money;
  };
  schedule: { additionalWorkdays: number; currentTargetDate?: Date | null; revisedTargetDate?: Date | null; assumptions: string[] };
  dependencies: string[];
  assumptions: string[];
  validUntil?: Date | null;
  termsText: string;
  generatedAt: Date;
  approvalUrl: string;
}

const COLORS = { ink: '#0f172a', muted: '#64748b', rule: '#e2e8f0', accent: '#4f46e5' };

function optionLabel(option: string): string {
  return (
    {
      add_with_fee: 'Additional work — additional fee',
      add_with_time: 'Additional work — timeline extension',
      substitute: 'Substitution — equal-value swap',
      defer: 'Deferred to a later phase',
      goodwill: 'Included as a goodwill exception',
      reject: 'Not proceeding',
      clarify: 'Clarification required before pricing',
    }[option] ?? option
  );
}

export async function renderChangeOrderPdf(input: ChangeOrderPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 54, info: { Title: `${input.orderNumber} — ${input.projectName}` } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const width = doc.page.width - 108;
      const h1 = (t: string) => { doc.moveDown(0.6).fillColor(COLORS.ink).fontSize(13).font('Helvetica-Bold').text(t); doc.moveDown(0.25); };
      const body = (t: string) => doc.fillColor(COLORS.ink).fontSize(9.6).font('Helvetica').text(t, { width, lineGap: 2 });
      const muted = (t: string) => doc.fillColor(COLORS.muted).fontSize(8.6).font('Helvetica').text(t, { width, lineGap: 2 });
      const rule = () => { doc.moveDown(0.5); doc.moveTo(54, doc.y).lineTo(54 + width, doc.y).strokeColor(COLORS.rule).lineWidth(0.8).stroke(); doc.moveDown(0.5); };

      // Header
      doc.fillColor(COLORS.accent).fontSize(11).font('Helvetica-Bold').text(input.agencyName.toUpperCase(), { continued: false });
      doc.fillColor(COLORS.muted).fontSize(8.6).font('Helvetica').text(input.agencyContact || '');
      doc.moveDown(0.8);
      doc.fillColor(COLORS.ink).fontSize(20).font('Helvetica-Bold').text('Change Order');
      doc.fillColor(COLORS.muted).fontSize(9.4).font('Helvetica').text(
        `${input.orderNumber} · version ${input.version} · issued ${input.generatedAt.toISOString().slice(0, 10)}`,
      );
      rule();

      // Parties & references
      const colY = doc.y;
      doc.fillColor(COLORS.ink).fontSize(9.4).font('Helvetica-Bold').text('Prepared for', 54, colY, { width: width / 2 });
      doc.font('Helvetica').fillColor(COLORS.ink).fontSize(9.4).text(input.clientName, 54, doc.y, { width: width / 2 });
      if (input.clientContact) muted(input.clientContact);

      doc.font('Helvetica-Bold').fillColor(COLORS.ink).fontSize(9.4).text('Project', 54 + width / 2, colY, { width: width / 2 });
      doc.font('Helvetica').text(`${input.projectCode} — ${input.projectName}`, 54 + width / 2, doc.y, { width: width / 2 });
      muted(`Request ${input.requestRef}: ${input.requestTitle}`);
      if (input.baselineVersion) muted(`Measured against approved baseline v${input.baselineVersion}`);
      doc.moveDown(0.6);

      h1('What is being proposed');
      body(input.summary);

      h1('This change is');
      doc.fillColor(COLORS.accent).fontSize(11).font('Helvetica-Bold').text(optionLabel(input.option));
      doc.moveDown(0.4);

      if (input.scopeAdditions.length) {
        h1('Scope added');
        for (const item of input.scopeAdditions) {
          doc.fillColor(COLORS.ink).fontSize(9.8).font('Helvetica-Bold').text(`•  ${item.title}`, { width });
          if (item.description) body(`    ${item.description}`);
          for (const ac of item.acceptanceCriteria ?? []) muted(`    ✓ ${ac}`);
          if (item.estimatedHours) muted(`    Estimated effort: ${item.estimatedHours} h`);
        }
        doc.moveDown(0.3);
      }

      if (input.scopeRemovals.length) {
        h1('Scope removed or replaced');
        for (const item of input.scopeRemovals) {
          doc.fillColor(COLORS.ink).fontSize(9.8).font('Helvetica-Bold').text(`•  ${item.requirementKey ? `${item.requirementKey} — ` : ''}${item.title}`, { width });
          if (item.note) muted(`    ${item.note}`);
        }
        doc.moveDown(0.3);
      }

      if (input.relatedRequirements.length) {
        h1('Related requirements in the agreed scope');
        for (const r of input.relatedRequirements) muted(`•  ${r.key} — ${r.title}`);
        doc.moveDown(0.3);
      }

      // Pricing
      h1('Price');
      const money = (m: Money) => formatMoney(m);
      const lines: [string, string][] = [
        ['Subtotal', money(input.pricing.subtotal)],
        ...(toMajor(input.pricing.contingency) !== 0 ? ([['Contingency', money(input.pricing.contingency)]] as [string, string][]) : []),
        ...(toMajor(input.pricing.discount) !== 0 ? ([['Discount', `− ${money(input.pricing.discount)}`]] as [string, string][]) : []),
        ...(toMajor(input.pricing.tax) !== 0 ? ([['Tax', money(input.pricing.tax)]] as [string, string][]) : []),
      ];
      for (const [label, value] of lines) {
        doc.fillColor(COLORS.muted).fontSize(9.4).font('Helvetica').text(label, 54, doc.y, { width: width - 120, continued: false });
        doc.fillColor(COLORS.ink).text(value, 54 + width - 120, doc.y - doc.currentLineHeight(), { width: 120, align: 'right' });
      }
      doc.moveDown(0.2);
      doc.moveTo(54, doc.y).lineTo(54 + width, doc.y).strokeColor(COLORS.rule).stroke();
      doc.moveDown(0.3);
      doc.fillColor(COLORS.ink).fontSize(12).font('Helvetica-Bold').text('Total', 54, doc.y, { width: width - 120, continued: false });
      doc.text(money(input.pricing.total), 54 + width - 120, doc.y - doc.currentLineHeight() - 1, { width: 120, align: 'right' });
      doc.moveDown(0.4);
      if (input.pricing.effectiveHourlyRate && toMajor(input.pricing.effectiveHourlyRate) > 0) {
        muted(`Effective hourly rate: ${money(input.pricing.effectiveHourlyRate)}`);
      }
      if (input.pricing.notes) body(input.pricing.notes);
      if (input.validUntil) muted(`This price holds until ${input.validUntil.toISOString().slice(0, 10)}.`);

      // Schedule
      h1('Schedule impact');
      if (input.schedule.additionalWorkdays > 0) {
        body(`Additional work: ${input.schedule.additionalWorkdays} working day(s).`);
        if (input.schedule.currentTargetDate) body(`Committed target: ${input.schedule.currentTargetDate.toISOString().slice(0, 10)}`);
        if (input.schedule.revisedTargetDate) body(`Revised target: ${input.schedule.revisedTargetDate.toISOString().slice(0, 10)}`);
      } else {
        body('No change to the delivery date is expected.');
      }
      for (const a of input.schedule.assumptions ?? []) muted(`•  ${a}`);

      if (input.dependencies.length) {
        h1('Dependencies');
        for (const d of input.dependencies) muted(`•  ${d}`);
      }
      if (input.assumptions.length) {
        h1('Assumptions');
        for (const a of input.assumptions) muted(`•  ${a}`);
      }

      h1('How to respond');
      body('Open the secure link below, review this document, and choose Accept, Decline, or Request clarification. Your decision is recorded against this exact version.');
      doc.fillColor(COLORS.accent).fontSize(9).font('Helvetica-Bold').text(input.approvalUrl, { width, link: input.approvalUrl, underline: true });
      doc.moveDown(0.5);
      muted('Opening the link does not accept anything. Only an explicit decision is recorded.');

      if (input.termsText) {
        h1('Terms');
        body(input.termsText);
      }

      rule();
      muted('This document records a decision made by the client in ScopeShield. It is not legal advice, and it is not presented as a qualified electronic signature under any particular jurisdiction. Agencies should have their own contractual terms reviewed by a qualified professional.');
      if (input.agencyFooter) muted(input.agencyFooter);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export function changeOrderOptionLabel(option: string): string {
  return optionLabel(option);
}
