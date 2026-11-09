import { convertRate, type GoldRate } from '@lumio/calc-engine';
import { goldRateSchema, objectIdSchema, spotRateSchema } from '@lumio/validation';
import { Router, type Request, type Response } from 'express';
import mongoose, { type Types } from 'mongoose';
import { z } from 'zod';
import { OID, RD128, RS, tenantSchema, tenantModel } from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import type { RequestContext } from '../../shared/context.js';
import { d128, dec } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { PurityModel } from '../master/index.js';
import { CompanyModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';

const TROY_OUNCE_GRAMS = '31.1034768';
const TOLA_GRAMS = '11.6638';

const goldRateModelSchema = tenantSchema(
  'goldRates',
  {
    purityId: OID,
    branchId: OID,
    basis: { type: String, enum: ['FINE_GRAM', 'PURITY_GRAM'], required: true },
    valuePerGram: RD128,
    enteredValue: RS,
    enteredUnit: RS,
    currency: RS,
    source: RS,
    effectiveAt: { type: Date, required: true },
    enteredBy: RS,
    approvedBy: String,
  },
  { appendOnly: true },
);
goldRateModelSchema.index({ companyId: 1, currency: 1, purityId: 1, branchId: 1, effectiveAt: -1 });
export const GoldRateModel = tenantModel('GoldRate', goldRateModelSchema);

const rateRequestSchema = tenantSchema(
  'goldRateRequests',
  {
    payload: { type: Object, required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], required: true },
    requestedBy: RS,
    decidedBy: String,
  },
  { timestamps: true },
);
rateRequestSchema.index({ companyId: 1, status: 1, _id: -1 });
export const GoldRateRequestModel = tenantModel('GoldRateRequest', rateRequestSchema);

type RateInput = z.infer<typeof goldRateSchema>;

async function publishRate(ctx: RequestContext, input: RateInput, approvedBy?: string) {
  const company = await CompanyModel.findById(ctx.companyId).lean();
  const tola = company?.settings?.tolaGrams ? { tolaGrams: company.settings.tolaGrams } : {};
  const [rate] = await GoldRateModel.create([
    {
      companyId: ctx.companyId,
      ...(input.purityId ? { purityId: input.purityId } : {}),
      ...(input.branchId ? { branchId: input.branchId } : {}),
      basis: input.basis,
      valuePerGram: d128(convertRate(input.value, input.unit, 'G', { ...tola })),
      enteredValue: input.value,
      enteredUnit: input.unit,
      currency: input.currency.toUpperCase(),
      source: input.source,
      effectiveAt: new Date(),
      enteredBy: ctx.userId,
      ...(approvedBy ? { approvedBy } : {}),
    },
  ]);
  await recordAudit(ctx, {
    action: 'gold_rate.publish',
    entityType: 'gold_rate',
    entityId: String(rate?._id),
    after: input,
  });
  return rate;
}

export interface ResolvedRate {
  rateId: string;
  rate: GoldRate;
  currency: string;
  source: string;
  effectiveAt: Date;
}

/** The newest rate wins among those applicable: purity-specific, then the fine-gold reference. */
export async function resolveRate(
  ctx: RequestContext,
  args: {
    purityId: Types.ObjectId;
    fineness: string;
    branchId: Types.ObjectId | string;
    currency: string;
    at: Date;
  },
): Promise<ResolvedRate> {
  const find = (purityId: Types.ObjectId | null, branchId: Types.ObjectId | string | null) =>
    GoldRateModel.findOne({
      companyId: ctx.companyId,
      currency: args.currency.toUpperCase(),
      purityId,
      branchId,
      effectiveAt: mongoose.trusted({ $lte: args.at }),
    })
      .sort({ effectiveAt: -1 })
      .session(ctx.session ?? null)
      .lean();

  const row =
    (await find(args.purityId, args.branchId)) ??
    (await find(args.purityId, null)) ??
    (await find(null, args.branchId)) ??
    (await find(null, null));
  if (!row) throw new BusinessRuleError(`No gold rate is available in ${args.currency}.`);

  const value = row.valuePerGram.toString();
  return {
    rateId: row._id.toString(),
    rate:
      row.basis === 'FINE_GRAM'
        ? { basis: 'FINE_GRAM', value }
        : { basis: 'PURITY_GRAM', value, fineness: args.fineness },
    currency: row.currency,
    source: row.source,
    effectiveAt: row.effectiveAt,
  };
}

export function createGoldRateRouter(): Router {
  const router = Router();
  const idParams = validate({ params: z.object({ id: objectIdSchema }) });

  router.get('/', requirePermission('gold_rate:read'), async (req, res) => {
    const rows = await GoldRateModel.find({ companyId: req.ctx.companyId })
      .sort({ effectiveAt: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, plain(rows));
  });

  /** Today's prices by purity, per gram and per tola, as a market board shows them. */
  router.get('/board', requirePermission('gold_rate:read'), async (req, res) => {
    const company = await CompanyModel.findById(req.ctx.companyId).lean();
    const purities = await PurityModel.find({ companyId: req.ctx.companyId, archivedAt: null })
      .sort({ fineness: -1 })
      .lean();
    const tolaGrams = company?.settings?.tolaGrams ?? TOLA_GRAMS;
    const reference = await GoldRateModel.findOne({
      companyId: req.ctx.companyId,
      currency: company?.baseCurrency,
      basis: 'FINE_GRAM',
      purityId: null,
      branchId: null,
    })
      .sort({ effectiveAt: -1 })
      .lean();
    sendSuccess(req, res, {
      effectiveAt: reference?.effectiveAt ?? null,
      currency: company?.baseCurrency,
      tolaGrams,
      rows: reference
        ? purities.map((p) => {
            const perGram = dec(reference.valuePerGram).times(dec(p.fineness));
            return {
              id: String(p._id),
              purity: p.label,
              fineness: dec(p.fineness).toFixed(4),
              perGram: perGram.toFixed(2),
              perTola: perGram.times(tolaGrams).toFixed(2),
            };
          })
        : [],
    });
  });

  /** Converts the international USD per ounce price to a local price per fine gram. */
  router.post(
    '/spot',
    requirePermission('gold_rate:create'),
    validate({ body: spotRateSchema }),
    async (req, res) => {
      const input = req.validated.body as z.infer<typeof spotRateSchema>;
      const company = await CompanyModel.findById(req.ctx.companyId).lean();
      const perGram = dec(input.usdPerOz)
        .dividedBy(TROY_OUNCE_GRAMS)
        .times(input.usdAed)
        .plus(input.premiumPerGram)
        .toDecimalPlaces(4);
      const rate: RateInput = {
        basis: 'FINE_GRAM',
        value: perGram.toFixed(4),
        unit: 'G',
        currency: company?.baseCurrency ?? 'AED',
        source: `SPOT ${input.usdPerOz} USD/oz at ${input.usdAed}`,
      };
      if (company?.settings?.rateApprovalRequired) {
        const request = await GoldRateRequestModel.create({
          companyId: req.ctx.companyId,
          payload: rate,
          status: 'PENDING',
          requestedBy: req.ctx.userId,
        });
        sendSuccess(req, res, plain(request.toObject()), 202);
        return;
      }
      sendSuccess(req, res, plain((await publishRate(req.ctx, rate))?.toObject()), 201);
    },
  );

  router.get('/requests', requirePermission('gold_rate:read'), async (req, res) => {
    const rows = await GoldRateRequestModel.find({
      companyId: req.ctx.companyId,
      status: 'PENDING',
    }).lean();
    sendSuccess(req, res, plain(rows));
  });

  router.post(
    '/',
    requirePermission('gold_rate:create'),
    validate({ body: goldRateSchema }),
    async (req, res) => {
      const input = req.validated.body as RateInput;
      const company = await CompanyModel.findById(req.ctx.companyId).lean();
      if (company?.settings?.rateApprovalRequired) {
        const request = await GoldRateRequestModel.create({
          companyId: req.ctx.companyId,
          payload: input,
          status: 'PENDING',
          requestedBy: req.ctx.userId,
        });
        sendSuccess(req, res, plain(request.toObject()), 202);
        return;
      }
      const rate = await publishRate(req.ctx, input);
      sendSuccess(req, res, plain(rate?.toObject()), 201);
    },
  );

  const decide = (status: 'APPROVED' | 'REJECTED') => async (req: Request, res: Response) => {
    const request = await GoldRateRequestModel.findOne({
      companyId: req.ctx.companyId,
      _id: req.params.id,
      status: 'PENDING',
    }).lean();
    if (!request) throw new ConflictError('This request has already been decided.');
    if (request.requestedBy === req.ctx.userId) {
      throw new BusinessRuleError('You cannot decide your own rate request.');
    }
    await GoldRateRequestModel.updateOne(
      { companyId: req.ctx.companyId, _id: request._id },
      { $set: { status, decidedBy: req.ctx.userId } },
    );
    if (status === 'APPROVED') {
      await publishRate(req.ctx, request.payload as RateInput, req.ctx.userId);
    }
    sendSuccess(req, res, { status });
  };

  router.post(
    '/requests/:id/approve',
    requirePermission('gold_rate:approve'),
    idParams,
    decide('APPROVED'),
  );
  router.post(
    '/requests/:id/reject',
    requirePermission('gold_rate:reject'),
    idParams,
    decide('REJECTED'),
  );
  return router;
}
