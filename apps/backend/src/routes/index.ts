import * as v from '@lumio/validation';
import { Router, type Request } from 'express';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { RoleModel } from '../modules/access/index.js';
import {
  ComplianceRuleModel,
  createComplianceCaseRouter,
  createSanctionsRouter,
  KycRecordModel,
  screenParty,
} from '../modules/compliance/index.js';
import { createDocumentRouter } from '../modules/documents/index.js';
import { createEInvoiceRouter } from '../modules/einvoice/index.js';
import {
  createBankReconciliationRouter,
  FinancialAccountModel,
  OpenItemModel,
  PartyBalanceModel,
  PaymentMethodModel,
  PaymentModel,
  recordPayment,
  reversePayment,
  type PaymentInput,
} from '../modules/finance/index.js';
import { createGoamlRouter } from '../modules/goaml/index.js';
import { createAuthRouter, createUsersRouter, UserModel } from '../modules/identity/index.js';
import * as inventory from '../modules/inventory/index.js';
import {
  beginPeriodClose,
  completePeriodClose,
  createYearPeriods,
  FinancialPeriodModel,
  JournalDraftModel,
  JournalEntryModel,
  JournalLineModel,
  LedgerAccountModel,
  postJournal,
  reopenPeriod,
  reverseJournal,
} from '../modules/ledger/index.js';
import {
  PartyModel,
  PartyPricingModel,
  ProductModel,
  PurityModel,
} from '../modules/master/index.js';
import { provisionCompany } from '../modules/onboarding/index.js';
import {
  BranchModel,
  CompanyModel,
  DepartmentModel,
  EmployeeModel,
  WarehouseModel,
} from '../modules/organisation/index.js';
import { AuditLogModel, recordAudit } from '../modules/platform/audit/index.js';
import { crudRouter } from '../modules/platform/crud/index.js';
import { executeIdempotent } from '../modules/platform/idempotency/index.js';
import { createGoldRateRouter } from '../modules/pricing/index.js';
import { createReportingRouter } from '../modules/reporting/index.js';
import { TaxCodeModel, TaxRuleModel } from '../modules/tax/index.js';
import { createTradeRouter, PurchaseOrderModel } from '../modules/trade/index.js';
import { blindIndex, encrypt } from '../shared/crypto.js';
import { d128 } from '../shared/decimal.js';
import { AppError, BusinessRuleError, ConflictError, NotFoundError } from '../shared/errors.js';
import { sendSuccess } from '../shared/http.js';
import { idempotencyKeyOf } from '../shared/idempotent-route.js';
import type { Logger } from '../shared/logger.js';
import { runInTransaction } from '../database/transaction.js';
import { plain } from '../shared/serialize.js';
import { allocateNumber } from '../modules/platform/numbering/index.js';

const idParams = validate({ params: z.object({ id: v.objectIdSchema }) });
const body = <T>(req: Request) => req.validated.body as T;
const id = (req: Request) => String(req.params.id);
/** Limits a query to the caller's branches. Company-wide roles are unaffected. */
const branchScoped = (req: Request): Record<string, unknown> =>
  req.ctx.branchScope === 'ALL' ? {} : { branchId: mongoose.trusted({ $in: req.ctx.branchScope }) };

const list = (model: { find: (f: object) => unknown }, req: Request) =>
  (model.find({ companyId: req.ctx.companyId }) as mongoose.Query<unknown[], unknown>)
    .sort({ _id: -1 })
    .limit(200)
    .lean();

function masterRoutes(router: Router): void {
  const mount = (path: string, options: Parameters<typeof crudRouter>[0]) =>
    router.use(path, crudRouter(options));
  mount('/branches', {
    model: BranchModel,
    permission: 'branch',
    entityType: 'branch',
    create: v.branchSchema,
    update: v.branchSchema.partial(),
    searchFields: ['code', 'name'],
    sortable: ['code', 'name'],
  });
  mount('/warehouses', {
    model: WarehouseModel,
    permission: 'warehouse',
    entityType: 'warehouse',
    create: v.warehouseSchema,
    update: v.warehouseSchema.partial(),
    searchFields: ['code', 'name'],
    sortable: ['code', 'name'],
    filters: ['branchId'],
    branchField: 'branchId',
  });
  mount('/departments', {
    model: DepartmentModel,
    permission: 'department',
    entityType: 'department',
    create: v.departmentSchema,
    update: v.departmentSchema.partial(),
    searchFields: ['code', 'name'],
  });
  mount('/employees', {
    model: EmployeeModel,
    permission: 'employee',
    entityType: 'employee',
    create: v.employeeSchema,
    update: v.employeeSchema.partial(),
    searchFields: ['employeeNo', 'name'],
    sortable: ['employeeNo', 'name'],
  });
  mount('/parties', {
    model: PartyModel,
    permission: 'party',
    entityType: 'party',
    create: v.partySchema,
    update: v.partySchema.partial(),
    searchFields: ['code', 'name', 'phone'],
    sortable: ['code', 'name'],
    filters: ['roles', 'kycStatus', 'riskLevel', 'sanctionsStatus'],
    afterSave: (partyId, req) => screenParty(req.ctx.companyId, partyId),
  });
  mount('/party-pricing', {
    model: PartyPricingModel,
    permission: 'party',
    entityType: 'party_pricing',
    create: v.partyPricingSchema,
    update: v.partyPricingSchema.partial(),
    filters: ['partyId'],
  });
  mount('/purities', {
    model: PurityModel,
    permission: 'purity',
    entityType: 'purity',
    create: v.puritySchema,
    update: v.puritySchema.partial(),
    searchFields: ['code', 'label'],
    sortable: ['code'],
  });
  mount('/products', {
    model: ProductModel,
    permission: 'product',
    entityType: 'product',
    create: v.productSchema,
    update: v.productSchema.partial(),
    searchFields: ['sku', 'name', 'barcode'],
    sortable: ['sku', 'name'],
    filters: ['kind', 'purityId', 'tracking'],
  });
  mount('/payment-methods', {
    model: PaymentMethodModel,
    permission: 'payment_method',
    entityType: 'payment_method',
    create: v.paymentMethodSchema,
    update: v.paymentMethodSchema.partial(),
  });
  mount('/financial-accounts', {
    model: FinancialAccountModel,
    permission: 'financial_account',
    entityType: 'financial_account',
    create: v.financialAccountSchema,
    update: v.financialAccountSchema.partial(),
  });
  mount('/ledger-accounts', {
    model: LedgerAccountModel,
    permission: 'ledger_account',
    entityType: 'ledger_account',
    create: v.ledgerAccountSchema,
    update: v.ledgerAccountSchema.partial(),
    searchFields: ['code', 'name'],
    sortable: ['code', 'name'],
    filters: ['type'],
  });
  mount('/tax-codes', {
    model: TaxCodeModel,
    permission: 'tax',
    entityType: 'tax_code',
    create: v.taxCodeSchema,
    update: v.taxCodeSchema.partial(),
  });
  mount('/tax-rules', {
    model: TaxRuleModel,
    permission: 'tax',
    entityType: 'tax_rule',
    create: v.taxRuleSchema,
    update: v.taxRuleSchema.partial(),
    sortable: ['priority'],
  });
  mount('/compliance-rules', {
    model: ComplianceRuleModel,
    permission: 'compliance_rule',
    entityType: 'compliance_rule',
    create: v.complianceRuleSchema,
    update: v.complianceRuleSchema.partial(),
  });
  mount('/kyc-records', {
    model: KycRecordModel,
    permission: 'kyc',
    entityType: 'kyc',
    create: v.kycRecordSchema,
    update: v.kycRecordSchema.partial(),
    filters: ['partyId', 'status'],
    prepare: ({ documentNumber, ...rest }) =>
      documentNumber
        ? {
            ...rest,
            documentNumberSealed: encrypt(String(documentNumber)),
            documentNumberIndex: blindIndex(String(documentNumber)),
            documentNumberLast4: String(documentNumber).slice(-4),
          }
        : rest,
    present: ({ documentNumberSealed: _s, documentNumberIndex: _i, ...row }) => row,
  });
}

function organisationRoutes(router: Router): void {
  router.get('/roles', requirePermission('role:read'), async (req, res) => {
    sendSuccess(
      req,
      res,
      plain(await RoleModel.find({ companyId: req.ctx.companyId }).sort({ name: 1 }).lean()),
    );
  });
  router.get('/roles/permissions', requirePermission('role:read'), (req, res) => {
    sendSuccess(req, res, v.PERMISSION_KEYS);
  });
  router.post(
    '/roles',
    requirePermission('role:create'),
    validate({ body: v.roleSchema }),
    async (req, res) => {
      const input = body<z.infer<typeof v.roleSchema>>(req);
      const role = await RoleModel.create({ ...input, companyId: req.ctx.companyId });
      await recordAudit(req.ctx, {
        action: 'role.create',
        entityType: 'role',
        entityId: role._id.toString(),
        after: input,
      });
      sendSuccess(req, res, plain(role.toObject()), 201);
    },
  );
  router.patch(
    '/roles/:id',
    requirePermission('role:update'),
    validate({ params: z.object({ id: v.objectIdSchema }), body: v.roleSchema }),
    async (req, res) => {
      const input = body<z.infer<typeof v.roleSchema>>(req);
      await RoleModel.updateOne({ companyId: req.ctx.companyId, _id: id(req) }, { $set: input });
      await recordAudit(req.ctx, {
        action: 'role.update',
        entityType: 'role',
        entityId: id(req),
        after: input,
      });
      sendSuccess(req, res, { done: true });
    },
  );
  router.use('/users', createUsersRouter());

  router.get('/company', async (req, res) => {
    sendSuccess(req, res, plain(await CompanyModel.findById(req.ctx.companyId).lean()));
  });
  router.patch(
    '/company',
    requirePermission('settings:manage'),
    validate({ body: v.companySettingsSchema }),
    async (req, res) => {
      const { settings, ...rest } = body<z.infer<typeof v.companySettingsSchema>>(req);
      const flattened = Object.fromEntries(
        Object.entries(settings ?? {}).map(([k, value]) => [`settings.${k}`, value]),
      );
      await CompanyModel.updateOne({ _id: req.ctx.companyId }, { $set: { ...rest, ...flattened } });
      await recordAudit(req.ctx, {
        action: 'settings.update',
        entityType: 'company',
        entityId: req.ctx.companyId.toString(),
        after: body(req),
      });
      sendSuccess(req, res, { done: true });
    },
  );
  router.get('/audit-logs', requirePermission('audit:read'), async (req, res) => {
    const rows = await AuditLogModel.find({ companyId: req.ctx.companyId })
      .sort({ at: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, plain(rows));
  });
}

function inventoryRoutes(router: Router): void {
  const stock = Router();
  const read = requirePermission('stock:read');
  const create = requirePermission('stock:create');
  const approve = requirePermission('stock:approve');

  const hideCost = (req: Request, rows: Record<string, unknown>[]) =>
    req.ctx.permissions.has('financials:view_cost')
      ? rows
      : rows.map(({ cost: _cost, ...row }) => row);

  stock.get('/balances', read, async (req, res) => {
    const rows = await inventory.StockBalanceModel.find({
      companyId: req.ctx.companyId,
      ...branchScoped(req),
    })
      .limit(1000)
      .lean();
    sendSuccess(req, res, hideCost(req, plain(rows)));
  });
  stock.get('/items', read, async (req, res) => {
    const filter: Record<string, unknown> = { companyId: req.ctx.companyId, ...branchScoped(req) };
    if (typeof req.query.status === 'string') filter.status = req.query.status;
    if (typeof req.query.productId === 'string') filter.productId = req.query.productId;
    const rows = await inventory.StockItemModel.find(filter).limit(500).lean();
    sendSuccess(req, res, hideCost(req, plain(rows)));
  });
  stock.get('/lots', read, async (req, res) => {
    sendSuccess(req, res, plain(await list(inventory.StockLotModel, req)));
  });
  stock.get('/movements', read, async (req, res) => {
    const rows = await inventory.StockMovementModel.find({
      companyId: req.ctx.companyId,
      ...branchScoped(req),
    })
      .sort({ at: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, hideCost(req, plain(rows)));
  });

  stock.post('/receipts', create, validate({ body: v.stockReceiptSchema }), async (req, res) => {
    sendSuccess(req, res, await inventory.receiveStock(req.ctx, body(req)), 201);
  });
  stock.post('/issues', create, validate({ body: v.stockIssueSchema }), async (req, res) => {
    sendSuccess(req, res, await inventory.issueStock(req.ctx, body(req)), 201);
  });

  stock.get('/adjustments', read, async (req, res) => {
    sendSuccess(req, res, plain(await list(inventory.StockAdjustmentModel, req)));
  });
  stock.post(
    '/adjustments',
    create,
    validate({ body: v.stockAdjustmentSchema }),
    async (req, res) => {
      sendSuccess(req, res, plain(await inventory.requestAdjustment(req.ctx, body(req))), 201);
    },
  );
  stock.post('/adjustments/:id/approve', approve, idParams, async (req, res) => {
    sendSuccess(req, res, await inventory.decideAdjustment(req.ctx, id(req), true));
  });
  stock.post(
    '/adjustments/:id/reject',
    requirePermission('stock:reject'),
    idParams,
    async (req, res) => {
      sendSuccess(req, res, await inventory.decideAdjustment(req.ctx, id(req), false));
    },
  );

  stock.get('/transfers', read, async (req, res) => {
    sendSuccess(req, res, plain(await list(inventory.StockTransferModel, req)));
  });
  stock.post('/transfers', create, validate({ body: v.stockTransferSchema }), async (req, res) => {
    sendSuccess(req, res, plain(await inventory.createTransfer(req.ctx, body(req))), 201);
  });
  stock.post('/transfers/:id/dispatch', approve, idParams, async (req, res) => {
    sendSuccess(req, res, await inventory.dispatchTransfer(req.ctx, id(req)));
  });
  stock.post(
    '/transfers/:id/receive',
    requirePermission('stock:update'),
    idParams,
    async (req, res) => {
      sendSuccess(req, res, await inventory.receiveTransfer(req.ctx, id(req)));
    },
  );

  stock.get('/reservations', read, async (req, res) => {
    sendSuccess(req, res, plain(await list(inventory.StockReservationModel, req)));
  });
  stock.post(
    '/reservations',
    create,
    validate({ body: v.stockReservationSchema }),
    async (req, res) => {
      sendSuccess(req, res, plain(await inventory.reserveStock(req.ctx, body(req))), 201);
    },
  );
  stock.post(
    '/reservations/:id/release',
    requirePermission('stock:update'),
    idParams,
    async (req, res) => {
      sendSuccess(req, res, await inventory.releaseReservation(req.ctx, id(req)));
    },
  );

  stock.get('/counts', read, async (req, res) => {
    sendSuccess(req, res, plain(await list(inventory.StockCountModel, req)));
  });
  stock.post('/counts', create, validate({ body: v.stockCountSchema }), async (req, res) => {
    sendSuccess(req, res, plain(await inventory.createCount(req.ctx, body(req))), 201);
  });
  stock.post('/counts/:id/approve', approve, idParams, async (req, res) => {
    sendSuccess(req, res, await inventory.approveCount(req.ctx, id(req)));
  });
  router.use('/stock', stock);
}

function financeRoutes(router: Router): void {
  router.get('/payments', requirePermission('payment:read'), async (req, res) => {
    const rows = await PaymentModel.find({ companyId: req.ctx.companyId, ...branchScoped(req) })
      .sort({ _id: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, plain(rows));
  });
  router.post(
    '/payments',
    requirePermission('payment:post'),
    validate({ body: v.paymentSchema }),
    async (req, res) => {
      const input = body<PaymentInput>(req);
      const outcome = await executeIdempotent(req.ctx, idempotencyKeyOf(req), input, (tx) =>
        recordPayment(tx, input),
      );
      sendSuccess(req, res, outcome.result, 201);
    },
  );
  router.post(
    '/payments/:id/reverse',
    requirePermission('payment:reverse'),
    validate({ params: z.object({ id: v.objectIdSchema }), body: v.reasonSchema }),
    async (req, res) => {
      const outcome = await executeIdempotent(
        req.ctx,
        idempotencyKeyOf(req),
        { op: 'reverse', id: id(req) },
        (tx) => reversePayment(tx, id(req), body<{ reason: string }>(req).reason),
      );
      sendSuccess(req, res, outcome.result);
    },
  );
  router.get('/open-items', requirePermission('payment:read'), async (req, res) => {
    const filter: Record<string, unknown> = {
      companyId: req.ctx.companyId,
      status: 'OPEN',
      ...branchScoped(req),
    };
    if (typeof req.query.partyId === 'string') filter.partyId = req.query.partyId;
    if (typeof req.query.side === 'string') filter.side = req.query.side;
    sendSuccess(
      req,
      res,
      plain(await OpenItemModel.find(filter).sort({ dueDate: 1 }).limit(500).lean()),
    );
  });
  router.get('/party-balances', requirePermission('party:read'), async (req, res) => {
    sendSuccess(
      req,
      res,
      plain(await PartyBalanceModel.find({ companyId: req.ctx.companyId }).limit(1000).lean()),
    );
  });

  router.get('/purchase-orders', requirePermission('purchase:read'), async (req, res) => {
    sendSuccess(req, res, plain(await list(PurchaseOrderModel, req)));
  });
  router.post(
    '/purchase-orders',
    requirePermission('purchase:create'),
    validate({ body: v.purchaseOrderSchema }),
    async (req, res) => {
      const input = body<z.infer<typeof v.purchaseOrderSchema>>(req);
      const created = await runInTransaction(req.ctx, async (tx) => {
        const number = await allocateNumber(tx, {
          documentType: 'PO',
          scope: 'COMPANY',
          prefix: 'PO-',
          padding: 6,
        });
        const [order] = await PurchaseOrderModel.create(
          [{ ...input, number, companyId: tx.companyId, status: 'OPEN', createdBy: tx.userId }],
          { session: tx.session },
        );
        return order?.toObject();
      });
      sendSuccess(req, res, plain(created), 201);
    },
  );
}

function ledgerRoutes(router: Router): void {
  router.get('/journals', requirePermission('journal:read'), async (req, res) => {
    const rows = await JournalEntryModel.find({
      companyId: req.ctx.companyId,
      ...branchScoped(req),
    })
      .sort({ postingDate: -1, _id: -1 })
      .limit(200)
      .lean();
    sendSuccess(req, res, plain(rows));
  });
  router.get(
    '/journals/:id/lines',
    requirePermission('journal:read'),
    idParams,
    async (req, res) => {
      sendSuccess(
        req,
        res,
        plain(
          await JournalLineModel.find({ companyId: req.ctx.companyId, entryId: id(req) }).lean(),
        ),
      );
    },
  );
  router.post(
    '/journals/:id/reverse',
    requirePermission('journal:reverse'),
    validate({ params: z.object({ id: v.objectIdSchema }), body: v.reasonSchema }),
    async (req, res) => {
      const outcome = await runInTransaction(req.ctx, (tx) =>
        reverseJournal(tx, id(req), body<{ reason: string }>(req).reason, new Date()),
      );
      sendSuccess(req, res, { number: outcome.number });
    },
  );

  router.get('/journal-drafts', requirePermission('journal:read'), async (req, res) => {
    sendSuccess(req, res, plain(await list(JournalDraftModel, req)));
  });
  router.post(
    '/journal-drafts',
    requirePermission('journal:create'),
    validate({ body: v.journalDraftSchema }),
    async (req, res) => {
      const input = body<z.infer<typeof v.journalDraftSchema>>(req);
      const draft = await JournalDraftModel.create({
        ...input,
        postingDate: new Date(input.postingDate),
        lines: input.lines.map((l) => ({ ...l, debit: d128(l.debit), credit: d128(l.credit) })),
        companyId: req.ctx.companyId,
        status: 'DRAFT',
        createdBy: req.ctx.userId,
      });
      sendSuccess(req, res, plain(draft.toObject()), 201);
    },
  );
  router.post(
    '/journal-drafts/:id/post',
    requirePermission('journal:approve', 'journal:post'),
    idParams,
    async (req, res) => {
      const result = await runInTransaction(req.ctx, async (tx) => {
        const draft = await JournalDraftModel.findOneAndUpdate(
          { companyId: tx.companyId, _id: id(req), status: 'DRAFT' },
          { $set: { status: 'POSTED' } },
          { session: tx.session },
        ).lean();
        if (!draft) throw new ConflictError('This journal has already been decided.');
        if (draft.createdBy === tx.userId) {
          throw new BusinessRuleError('A journal must be posted by someone other than its author.');
        }
        const posted = await postJournal(tx, {
          postingDate: draft.postingDate,
          branchId: draft.branchId,
          memo: draft.memo,
          sourceType: 'MANUAL_JOURNAL',
          sourceId: draft._id.toString(),
          kind: 'MANUAL',
          lines: draft.lines.map(
            (l: {
              accountId: mongoose.Types.ObjectId;
              debit?: unknown;
              credit?: unknown;
              partyId?: mongoose.Types.ObjectId;
            }) => ({
              accountId: l.accountId,
              debit: String(l.debit ?? '0'),
              credit: String(l.credit ?? '0'),
              ...(l.partyId ? { partyId: l.partyId } : {}),
            }),
          ),
        });
        await JournalDraftModel.updateOne(
          { companyId: tx.companyId, _id: draft._id },
          { $set: { entryId: posted.entryId } },
        ).session(tx.session);
        await recordAudit(tx, {
          action: 'journal.post',
          entityType: 'journal',
          entityId: posted.entryId.toString(),
        });
        return posted;
      });
      sendSuccess(req, res, { number: result.number });
    },
  );

  router.get('/periods', requirePermission('period:read'), async (req, res) => {
    sendSuccess(
      req,
      res,
      plain(
        await FinancialPeriodModel.find({ companyId: req.ctx.companyId })
          .sort({ from: -1 })
          .limit(60)
          .lean(),
      ),
    );
  });
  router.post(
    '/periods/year',
    requirePermission('period:create'),
    validate({ body: v.periodYearSchema }),
    async (req, res) => {
      await createYearPeriods(req.ctx, body<{ year: number }>(req).year);
      sendSuccess(req, res, { done: true }, 201);
    },
  );
  router.post(
    '/periods/:id/begin-close',
    requirePermission('period:close'),
    idParams,
    async (req, res) => {
      sendSuccess(req, res, plain(await beginPeriodClose(req.ctx, id(req))));
    },
  );
  router.post(
    '/periods/:id/complete-close',
    requirePermission('period:close'),
    idParams,
    async (req, res) => {
      sendSuccess(req, res, plain(await completePeriodClose(req.ctx, id(req))));
    },
  );
  router.post(
    '/periods/:id/reopen',
    requirePermission('period:reopen'),
    validate({ params: z.object({ id: v.objectIdSchema }), body: v.reasonSchema }),
    async (req, res) => {
      sendSuccess(
        req,
        res,
        plain(await reopenPeriod(req.ctx, id(req), body<{ reason: string }>(req).reason)),
      );
    },
  );
}

export interface ApiDeps {
  redis: Redis;
  logger: Logger;
  allowedOrigins: string[];
  authRateLimit?: number;
}

/** Versioned API. Everything after the auth router requires a verified user. */
export function createApiRouter(deps: ApiDeps): Router {
  const router = Router();
  router.use('/auth', createAuthRouter(deps));
  router.use(authenticate);

  router.post(
    '/platform/companies',
    validate({ body: v.provisionCompanySchema }),
    async (req, res) => {
      const user = await UserModel.findById(req.auth.userId).lean();
      if (!user?.isPlatformAdmin)
        throw new AppError(403, 'FORBIDDEN', 'Platform administrators only.');
      sendSuccess(
        req,
        res,
        await provisionCompany(
          { userId: req.auth.userId, correlationId: req.correlationId },
          body(req),
        ),
        201,
      );
    },
  );

  router.use((req, _res, next) => {
    if (!req.ctx) throw new NotFoundError('No company is associated with this account.');
    next();
  });

  masterRoutes(router);
  organisationRoutes(router);
  inventoryRoutes(router);
  financeRoutes(router);
  ledgerRoutes(router);
  router.use('/gold-rates', createGoldRateRouter());
  router.use('/sales-invoices', createTradeRouter('SALE'));
  router.use('/purchase-invoices', createTradeRouter('PURCHASE'));
  router.use('/compliance-cases', createComplianceCaseRouter());
  router.use('/sanctions', createSanctionsRouter());
  router.use('/goaml-reports', createGoamlRouter());
  router.use('/documents', createDocumentRouter());
  router.use('/e-invoices', createEInvoiceRouter());
  router.use(createBankReconciliationRouter());
  router.use(createReportingRouter());
  return router;
}
