import { createHash } from 'node:crypto';
import { goamlCreateSchema, goamlSubmittedSchema, objectIdSchema } from '@lumio/validation';
import { Router } from 'express';
import type { Types } from 'mongoose';
import mongoose from 'mongoose';
import { z } from 'zod';
import { OID, ROID, RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { runInTransaction } from '../../database/transaction.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import type { RequestContext, TransactionalContext } from '../../shared/context.js';
import { decrypt, encrypt } from '../../shared/crypto.js';
import { money } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { ComplianceCaseModel, KycRecordModel } from '../compliance/index.js';
import { PaymentModel } from '../finance/index.js';
import { UserModel } from '../identity/index.js';
import { PartyModel } from '../master/index.js';
import { CompanyModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { allocateNumber } from '../platform/numbering/index.js';
import { PurchaseInvoiceModel, SalesInvoiceModel } from '../trade/index.js';
import {
  renderGoamlXml,
  reportWarnings,
  splitName,
  type GoamlParty,
  type GoamlReportData,
  type GoamlTransaction,
} from './goaml-xml.js';

export { renderGoamlXml, reportWarnings } from './goaml-xml.js';

const reportSchema = tenantSchema(
  'goamlReports',
  {
    number: RS,
    reportType: { type: String, enum: ['DPMSR', 'STR'], required: true },
    status: { type: String, enum: ['DRAFT', 'APPROVED', 'SUBMITTED'], required: true },
    caseIds: { type: [OID], required: true },
    reason: RS,
    action: String,
    indicators: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
    // Names and identity numbers of the subject, so encrypted like other KYC data.
    xmlSealed: String,
    xmlSha256: String,
    preparedBy: RS,
    approvedBy: String,
    approvedAt: Date,
    fiuReference: String,
    submittedBy: String,
    submittedAt: Date,
    partyId: ROID,
  },
  { timestamps: true },
);
reportSchema.index({ companyId: 1, number: 1 }, { unique: true });
reportSchema.index({ companyId: 1, status: 1, _id: -1 });
export const GoamlReportModel = tenantModel('GoamlReport', reportSchema);

type CreateInput = z.infer<typeof goamlCreateSchema>;
type Ctx = TransactionalContext;

const DOCUMENT_CODES: Record<string, string> = {
  EMIRATES_ID: 'NID',
  PASSPORT: 'PAS',
  TRADE_LICENCE: 'LIC',
};

/** Reads a date as the calendar day it was entered for. */
const day = (value: Date) => value.toISOString().slice(0, 10);

async function loadParty(tx: Ctx, partyId: Types.ObjectId): Promise<GoamlParty> {
  const party = await PartyModel.findOne({ companyId: tx.companyId, _id: partyId })
    .session(tx.session)
    .lean();
  if (!party) throw new NotFoundError('A party on this report was not found.');
  const kyc = await KycRecordModel.findOne({
    companyId: tx.companyId,
    partyId,
    status: 'VERIFIED',
    archivedAt: null,
  })
    .sort({ _id: -1 })
    .session(tx.session)
    .lean();
  return {
    name: party.name,
    type: party.type,
    ...(party.taxRegistrationNumber ? { taxRegistrationNumber: party.taxRegistrationNumber } : {}),
    ...(party.dateOfBirth ? { dateOfBirth: party.dateOfBirth } : {}),
    ...(party.nationality ? { nationality: party.nationality } : {}),
    ...(party.billingAddress ? { address: party.billingAddress } : {}),
    ...(party.phone ? { phone: party.phone } : {}),
    ...(kyc
      ? {
          identification: {
            type: DOCUMENT_CODES[kyc.documentType] ?? 'OTH',
            number: decrypt(kyc.documentNumberSealed),
            ...(kyc.expiresAt ? { expiresAt: day(kyc.expiresAt) } : {}),
          },
        }
      : {}),
  };
}

interface CaseRow {
  _id: Types.ObjectId;
  partyId?: Types.ObjectId;
  sourceType: string;
  sourceId: string;
  sourceNumber?: string;
  amount: Types.Decimal128;
  status: string;
  ruleName: string;
}

async function loadTransaction(tx: Ctx, row: CaseRow): Promise<GoamlTransaction> {
  if (!row.partyId) throw new BusinessRuleError(`Case ${row.ruleName} has no party.`);
  const party = await loadParty(tx, row.partyId);
  const scope = { companyId: tx.companyId, _id: row.sourceId };
  const base = {
    number: row.sourceNumber ?? row.sourceId,
    amount: money(row.amount),
    party,
  };
  if (row.sourceType === 'PAYMENT_POSTED') {
    const payment = await PaymentModel.findOne(scope).session(tx.session).lean();
    if (!payment) throw new NotFoundError('A payment on this report was not found.');
    return {
      ...base,
      date: day(payment.paymentDate),
      description: `${payment.direction === 'RECEIPT' ? 'Receipt' : 'Payment'} ${payment.number}`,
      direction: payment.direction === 'RECEIPT' ? 'FROM_PARTY' : 'TO_PARTY',
      mode: payment.amlClass,
    };
  }
  const isSale = row.sourceType === 'SALE_POSTED';
  const model = isSale ? SalesInvoiceModel : PurchaseInvoiceModel;
  const invoice = await model.findOne(scope).session(tx.session).lean();
  if (!invoice) throw new NotFoundError('An invoice on this report was not found.');
  return {
    ...base,
    date: day(invoice.docDate),
    description: `${isSale ? 'Sale' : 'Purchase'} of precious metals, invoice ${invoice.number}`,
    direction: isSale ? 'FROM_PARTY' : 'TO_PARTY',
    mode: 'INVOICE',
  };
}

async function assemble(
  tx: Ctx,
  report: Pick<CreateInput, 'reportType' | 'reason' | 'indicators'> & {
    number: string;
    action?: string;
  },
  cases: CaseRow[],
): Promise<GoamlReportData> {
  const company = await CompanyModel.findById(tx.companyId).session(tx.session).lean();
  if (!company) throw new NotFoundError();
  const reporter = await UserModel.findById(tx.userId).session(tx.session).lean();
  const transactions: GoamlTransaction[] = [];
  for (const row of cases) transactions.push(await loadTransaction(tx, row));
  return {
    reportType: report.reportType,
    reference: report.number,
    entityId: company.goamlEntityId ?? '',
    submissionDate: day(new Date()),
    currency: company.baseCurrency,
    reporter: { ...splitName(reporter?.name ?? 'Unknown'), email: reporter?.email ?? '' },
    reason: report.reason,
    ...(report.action ? { action: report.action } : {}),
    indicators: report.indicators,
    transactions,
  };
}

const loadCases = (tx: Ctx, ids: (string | Types.ObjectId)[]) =>
  ComplianceCaseModel.find({ companyId: tx.companyId, _id: mongoose.trusted({ $in: ids }) })
    .session(tx.session)
    .lean() as unknown as Promise<CaseRow[]>;

export function createGoamlReport(ctx: RequestContext, input: CreateInput) {
  return runInTransaction(ctx, async (tx) => {
    const ids = [...new Set(input.caseIds)];
    const cases = await loadCases(tx, ids);
    if (cases.length !== ids.length) throw new NotFoundError('A selected case was not found.');
    if (cases.some((row) => row.status === 'CLEARED' || row.status === 'REPORTED')) {
      throw new ConflictError('A selected case has already been closed.');
    }
    const number = await allocateNumber(tx, {
      documentType: 'GOAML',
      scope: 'COMPANY',
      prefix: 'GOAML-',
      padding: 6,
    });
    const warnings = reportWarnings(await assemble(tx, { ...input, number }, cases));
    const [created] = await GoamlReportModel.create(
      [
        {
          ...input,
          caseIds: ids,
          number,
          companyId: tx.companyId,
          partyId: cases[0]?.partyId,
          status: 'DRAFT',
          warnings,
          preparedBy: tx.userId,
        },
      ],
      { session: tx.session },
    );
    await recordAudit(tx, {
      action: 'goaml.prepare',
      entityType: 'goaml_report',
      entityId: String(created?._id),
      after: { number, reportType: input.reportType },
    });
    return created?.toObject();
  });
}

/** Freezes the content under a second person's approval. What is approved is what gets filed. */
export function approveGoamlReport(ctx: RequestContext, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const report = await GoamlReportModel.findOne({ companyId: tx.companyId, _id: id })
      .session(tx.session)
      .lean();
    if (!report) throw new NotFoundError();
    if (report.status !== 'DRAFT') throw new ConflictError('This report is not a draft.');
    if (report.preparedBy === tx.userId) {
      throw new BusinessRuleError('A report must be approved by someone other than its preparer.');
    }
    const data = await assemble(
      tx,
      {
        reportType: report.reportType,
        reason: report.reason,
        indicators: report.indicators,
        number: report.number,
        ...(report.action ? { action: report.action } : {}),
      },
      await loadCases(tx, report.caseIds),
    );
    if (!data.entityId) {
      throw new BusinessRuleError('Set the goAML reporting entity ID in company settings first.');
    }
    const xml = renderGoamlXml(data);
    const updated = await GoamlReportModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: id, status: 'DRAFT' },
      {
        $set: {
          status: 'APPROVED',
          approvedBy: tx.userId,
          approvedAt: new Date(),
          xmlSealed: encrypt(xml),
          xmlSha256: createHash('sha256').update(xml).digest('hex'),
          warnings: reportWarnings(data),
        },
      },
      { returnDocument: 'after', session: tx.session },
    ).lean();
    await recordAudit(tx, {
      action: 'goaml.approve',
      entityType: 'goaml_report',
      entityId: id,
    });
    return updated;
  });
}

/** goAML is filed through the FIU portal by hand, so this records that it happened. */
export function markGoamlSubmitted(ctx: RequestContext, id: string, fiuReference: string) {
  return runInTransaction(ctx, async (tx) => {
    const report = await GoamlReportModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: id, status: 'APPROVED' },
      {
        $set: {
          status: 'SUBMITTED',
          fiuReference,
          submittedBy: tx.userId,
          submittedAt: new Date(),
        },
      },
      { returnDocument: 'after', session: tx.session },
    ).lean();
    if (!report) throw new ConflictError('Only an approved report can be marked as filed.');
    await ComplianceCaseModel.updateMany(
      { companyId: tx.companyId, _id: mongoose.trusted({ $in: report.caseIds }) },
      {
        $set: {
          status: 'REPORTED',
          decisionNote: `Filed with the FIU as ${report.number}, reference ${fiuReference}.`,
          decidedBy: tx.userId,
          decidedAt: new Date(),
        },
      },
    ).session(tx.session);
    await recordAudit(tx, {
      action: 'goaml.submit',
      entityType: 'goaml_report',
      entityId: id,
      after: { fiuReference },
    });
    return report;
  });
}

const present = (row: unknown) => {
  const { xmlSealed, ...visible } = plain<Record<string, unknown>>(row);
  return { ...visible, hasXml: Boolean(xmlSealed) };
};

export function createGoamlRouter(): Router {
  const router = Router();
  const idParams = validate({ params: z.object({ id: objectIdSchema }) });

  router.get('/', requirePermission('goaml:view'), async (req, res) => {
    const rows = await GoamlReportModel.find({ companyId: req.ctx.companyId })
      .sort({ _id: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, rows.map(present));
  });

  router.post(
    '/',
    requirePermission('goaml:prepare'),
    validate({ body: goamlCreateSchema }),
    async (req, res) => {
      const created = await createGoamlReport(req.ctx, req.validated.body as CreateInput);
      sendSuccess(req, res, present(created), 201);
    },
  );

  router.post('/:id/approve', requirePermission('goaml:approve'), idParams, async (req, res) => {
    sendSuccess(req, res, present(await approveGoamlReport(req.ctx, String(req.params.id))));
  });

  router.post(
    '/:id/submitted',
    requirePermission('goaml:prepare'),
    validate({ params: z.object({ id: objectIdSchema }), body: goamlSubmittedSchema }),
    async (req, res) => {
      const { fiuReference } = req.validated.body as z.infer<typeof goamlSubmittedSchema>;
      sendSuccess(
        req,
        res,
        present(await markGoamlSubmitted(req.ctx, String(req.params.id), fiuReference)),
      );
    },
  );

  router.get('/:id/xml', requirePermission('goaml:view'), idParams, async (req, res) => {
    const report = await GoamlReportModel.findOne({
      companyId: req.ctx.companyId,
      _id: req.params.id,
    }).lean();
    if (!report) throw new NotFoundError();
    if (!report.xmlSealed) throw new ConflictError('The report has not been approved yet.');
    await recordAudit(req.ctx, {
      action: 'goaml.download',
      entityType: 'goaml_report',
      entityId: String(req.params.id),
    });
    res
      .status(200)
      .set({
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${report.number}.xml"`,
        'Cache-Control': 'no-store',
      })
      .send(decrypt(report.xmlSealed));
  });

  return router;
}
