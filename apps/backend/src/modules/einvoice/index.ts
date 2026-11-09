import { createHash } from 'node:crypto';
import { objectIdSchema } from '@lumio/validation';
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { runtime } from '../../config/runtime.js';
import { RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { ConflictError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { PartyModel } from '../master/index.js';
import { CompanyModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { SalesInvoiceModel } from '../trade/index.js';
import { renderUblInvoice, type UblInvoice } from './ubl.js';

export { renderUblInvoice } from './ubl.js';

const eInvoiceSchema = tenantSchema(
  'eInvoices',
  {
    sourceId: RS,
    number: RS,
    provider: RS,
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'FAILED'],
      required: true,
    },
    // Exactly what was sent, kept even if company details change later.
    xml: RS,
    xmlSha256: RS,
    providerReference: String,
    message: String,
    attempts: { type: Number, default: 0 },
    submittedAt: Date,
  },
  { timestamps: true },
);
eInvoiceSchema.index({ companyId: 1, sourceId: 1 }, { unique: true });
eInvoiceSchema.index({ companyId: 1, status: 1, _id: -1 });
export const EInvoiceModel = tenantModel('EInvoice', eInvoiceSchema);

export interface EInvoiceSubmission {
  number: string;
  xml: string;
  sellerTrn?: string;
}

export interface EInvoiceResult {
  status: 'ACCEPTED' | 'REJECTED';
  reference?: string;
  message?: string;
}

/** Implemented once per accredited service provider, when one has been chosen. */
export interface EInvoiceProvider {
  readonly name: string;
  submit(submission: EInvoiceSubmission): Promise<EInvoiceResult>;
}

/** Local stand-in that reaches no tax system. The application refuses it in staging and production. */
export const simulatedProvider: EInvoiceProvider = {
  name: 'simulated',
  submit: ({ number, sellerTrn }) =>
    Promise.resolve(
      sellerTrn
        ? {
            status: 'ACCEPTED',
            reference: `SIM-${number}`,
            message: 'Simulated: nothing was sent.',
          }
        : { status: 'REJECTED', message: 'The seller has no tax registration number.' },
    ),
};

export function configuredProvider(): EInvoiceProvider | null {
  return runtime().EINVOICE_PROVIDER === 'simulated' ? simulatedProvider : null;
}

async function buildXml(companyId: Types.ObjectId, id: string) {
  const invoice = await SalesInvoiceModel.findOne({ companyId, _id: id }).lean();
  if (!invoice?.number) throw new NotFoundError('No posted invoice was found.');
  const company = await CompanyModel.findById(companyId).lean();
  if (!company) throw new NotFoundError();
  const data = plain<UblInvoice & { partySnapshot: Record<string, string>; partyId: string }>(
    invoice,
  );
  const xml = renderUblInvoice({
    ...data,
    seller: {
      name: company.legalName,
      ...(company.taxRegistrationNumber
        ? { taxRegistrationNumber: company.taxRegistrationNumber }
        : {}),
      ...(company.address ? { address: company.address } : {}),
    },
    buyer: {
      name: data.partySnapshot.name as string,
      ...(data.partySnapshot.taxRegistrationNumber
        ? { taxRegistrationNumber: data.partySnapshot.taxRegistrationNumber }
        : {}),
      ...(data.partySnapshot.billingAddress ? { address: data.partySnapshot.billingAddress } : {}),
    },
  });
  return { xml, invoice, sellerTrn: company.taxRegistrationNumber as string | undefined };
}

/**
 * Sends a posted sales invoice to the provider. Safe to repeat. A provider outage rethrows so the
 * queue retries it; a rejection is a final answer that a person has to look at.
 */
export async function issueEInvoice(
  companyId: Types.ObjectId,
  id: string,
  provider: EInvoiceProvider | null = configuredProvider(),
  options: { retry?: boolean } = {},
): Promise<void> {
  if (!provider) return;
  const existing = await EInvoiceModel.findOne({ companyId, sourceId: id }).lean();
  if (existing?.status === 'ACCEPTED') return;
  if (existing?.status === 'REJECTED' && !options.retry) return;

  const { xml, invoice, sellerTrn } = await buildXml(companyId, id);
  // The mandate covers business and government buyers. Retail sales stay out of it.
  const party = await PartyModel.findOne({ companyId, _id: invoice.partyId }).lean();
  if (party?.type !== 'BUSINESS') return;

  const scope = { companyId, sourceId: id };
  const xmlSha256 = createHash('sha256').update(xml).digest('hex');
  await EInvoiceModel.updateOne(
    scope,
    {
      $set: { xml, xmlSha256, provider: provider.name, status: 'PENDING', number: invoice.number },
      $inc: { attempts: 1 },
    },
    { upsert: true },
  );
  try {
    const result = await provider.submit({
      number: invoice.number,
      xml,
      ...(sellerTrn ? { sellerTrn } : {}),
    });
    await EInvoiceModel.updateOne(scope, {
      $set: {
        status: result.status,
        submittedAt: new Date(),
        ...(result.reference ? { providerReference: result.reference } : {}),
        ...(result.message ? { message: result.message } : {}),
      },
    });
  } catch (error) {
    await EInvoiceModel.updateOne(scope, {
      $set: { status: 'FAILED', message: (error as Error).message },
    });
    throw error;
  }
}

export function createEInvoiceRouter(
  provider: () => EInvoiceProvider | null = configuredProvider,
): Router {
  const router = Router();
  const idParams = validate({ params: z.object({ id: objectIdSchema }) });

  router.get('/', requirePermission('einvoice:read'), async (req, res) => {
    const rows = await EInvoiceModel.find({ companyId: req.ctx.companyId })
      .select({ xml: 0 })
      .sort({ _id: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, { enabled: Boolean(provider()), rows: plain(rows) });
  });

  router.get(
    '/sales/:id/status',
    requirePermission('einvoice:read'),
    idParams,
    async (req, res) => {
      const row = await EInvoiceModel.findOne({
        companyId: req.ctx.companyId,
        sourceId: req.params.id,
      })
        .select({ xml: 0 })
        .lean();
      sendSuccess(req, res, row ? plain(row) : null);
    },
  );

  router.get('/sales/:id/xml', requirePermission('einvoice:read'), idParams, async (req, res) => {
    const id = String(req.params.id);
    const sent = await EInvoiceModel.findOne({ companyId: req.ctx.companyId, sourceId: id }).lean();
    const built = sent ? null : await buildXml(req.ctx.companyId, id);
    const xml = (sent?.xml ?? built?.xml) as string;
    const number = (sent?.number ?? built?.invoice.number) as string;
    res
      .status(200)
      .set({
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${number}.xml"`,
      })
      .send(xml);
  });

  router.post(
    '/sales/:id/submit',
    requirePermission('einvoice:submit'),
    idParams,
    async (req, res) => {
      const active = provider();
      if (!active) throw new ConflictError('No e-invoicing provider is configured.');
      await issueEInvoice(req.ctx.companyId, String(req.params.id), active, { retry: true });
      await recordAudit(req.ctx, {
        action: 'einvoice.submit',
        entityType: 'einvoice',
        entityId: String(req.params.id),
      });
      const row = await EInvoiceModel.findOne({
        companyId: req.ctx.companyId,
        sourceId: req.params.id,
      })
        .select({ xml: 0 })
        .lean();
      sendSuccess(req, res, row ? plain(row) : null);
    },
  );

  return router;
}
