import { createHash } from 'node:crypto';
import { canonicalJson } from '@lumio/shared-utils';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import type { tradeReturnSchema } from '@lumio/validation';
import type { z } from 'zod';
import { runInTransaction } from '../../database/transaction.js';
import {
  assertBranchAccess,
  type RequestContext,
  type TransactionalContext,
} from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { plain } from '../../shared/serialize.js';
import {
  assertWithinCreditLimit,
  changePartyBalance,
  createOpenItem,
  OpenItemModel,
  recordPayment,
} from '../finance/index.js';
import {
  receiveInto,
  StockItemModel,
  stockIn,
  stockOut,
  stockOutOldestFirst,
  stockPolicy,
  type LotAllocation,
} from '../inventory/index.js';
import { postJournal, type PostingLine } from '../ledger/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { allocateNumber, type NumberingScope } from '../platform/numbering/index.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import { assertPartyNotOnHold } from '../compliance/index.js';
import { BranchModel } from '../organisation/index.js';
import { recordTaxTransaction } from '../tax/index.js';
import { priceTrade, type Direction, type TradeInput } from './pricing.service.js';
import { CreditNoteModel, PurchaseInvoiceModel, SalesInvoiceModel } from './trade.models.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- sales and purchases share one schema
const modelOf = (direction: Direction): Model<any> =>
  direction === 'SALE' ? SalesInvoiceModel : PurchaseInvoiceModel;

const LABEL = {
  SALE: { series: 'SI', event: 'sale.posted', entity: 'sale', creditPrefix: 'CN' },
  PURCHASE: { series: 'PI', event: 'purchase.posted', entity: 'purchase', creditPrefix: 'DN' },
} as const;

export interface TradeLine {
  lineId: string;
  productId: Types.ObjectId;
  purityId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  location: string;
  stockItemId?: Types.ObjectId;
  lotId?: Types.ObjectId;
  lotNo?: string;
  tag?: string;
  pieces: number;
  grossWeight: Types.Decimal128;
  stoneWeight: Types.Decimal128;
  netWeight: Types.Decimal128;
  fineWeight: Types.Decimal128;
  goldValue: Types.Decimal128;
  makingCharge: Types.Decimal128;
  discount: Types.Decimal128;
  taxableValue: Types.Decimal128;
  taxAmount: Types.Decimal128;
  notionalTax: Types.Decimal128;
  lineTotal: Types.Decimal128;
  costAtIssue?: Types.Decimal128;
  taxCode: string;
  taxTreatment: string;
  taxRatePercent: Types.Decimal128;
  returned: boolean;
  tracking: string;
  allocations?: LotAllocation[];
}

export interface TradeDocument {
  _id: Types.ObjectId;
  number?: string;
  status: string;
  partyId: Types.ObjectId;
  partySnapshot: unknown;
  branchId: Types.ObjectId;
  docDate: Date;
  dueDate?: Date;
  lines: TradeLine[];
  plannedPayments: {
    financialAccountId: string;
    methodId: string;
    amount: string;
    reference?: string;
  }[];
  taxableTotal: Types.Decimal128;
  taxTotal: Types.Decimal128;
  discountTotal: Types.Decimal128;
  grandTotal: Types.Decimal128;
  createdBy: string;
  openItemId?: Types.ObjectId;
}

async function load(ctx: RequestContext, direction: Direction, id: string): Promise<TradeDocument> {
  const doc = (await modelOf(direction)
    .findOne({ companyId: ctx.companyId, _id: id })
    .session(ctx.session ?? null)
    .lean()) as TradeDocument | null;
  if (!doc) throw new NotFoundError();
  assertBranchAccess(ctx, doc.branchId);
  return doc;
}

async function priced(ctx: RequestContext, direction: Direction, input: TradeInput) {
  const { party, totals, lines } = await priceTrade(ctx, direction, input);
  const paid = input.payments.reduce((sum, p) => sum.plus(p.amount), new Decimal(0));
  if (paid.greaterThan(totals.grandTotal)) {
    throw new BusinessRuleError('Payments exceed the invoice total.');
  }
  return {
    partyId: party._id,
    partySnapshot: {
      name: party.name,
      code: party.code,
      taxRegistrationNumber: party.taxRegistrationNumber,
      billingAddress: party.billingAddress,
    },
    branchId: new Types.ObjectId(input.branchId),
    currency: input.currency.toUpperCase(),
    docDate: new Date(input.docDate),
    ...(input.dueDate ? { dueDate: new Date(input.dueDate) } : {}),
    ...(input.supplierInvoiceNo ? { supplierInvoiceNo: input.supplierInvoiceNo } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    lines,
    plannedPayments: input.payments,
    taxableTotal: d128(totals.taxableTotal),
    taxTotal: d128(totals.taxTotal),
    discountTotal: d128(totals.discountTotal),
    grandTotal: d128(totals.grandTotal),
  };
}

export async function quoteTrade(ctx: RequestContext, direction: Direction, input: TradeInput) {
  assertBranchAccess(ctx, input.branchId);
  return plain(await priced(ctx, direction, input));
}

export async function createDraft(ctx: RequestContext, direction: Direction, input: TradeInput) {
  assertBranchAccess(ctx, input.branchId);
  const values = await priced(ctx, direction, input);
  const doc = await modelOf(direction).create({
    ...values,
    companyId: ctx.companyId,
    status: 'DRAFT',
    createdBy: ctx.userId,
  });
  await recordAudit(ctx, {
    action: `${LABEL[direction].entity}.create`,
    entityType: LABEL[direction].entity,
    entityId: doc._id.toString(),
  });
  return plain(doc.toObject());
}

export async function updateDraft(
  ctx: RequestContext,
  direction: Direction,
  id: string,
  input: TradeInput,
) {
  await load(ctx, direction, id);
  assertBranchAccess(ctx, input.branchId);
  const values = await priced(ctx, direction, input);
  const updated = await modelOf(direction)
    .findOneAndUpdate(
      { companyId: ctx.companyId, _id: id, status: 'DRAFT' },
      { $set: values },
      { returnDocument: 'after' },
    )
    .lean();
  if (!updated) throw new ConflictError('Only a draft can be edited.');
  return plain(updated);
}

function discountPercent(doc: TradeDocument): Decimal {
  const base = dec(doc.taxableTotal).plus(dec(doc.discountTotal));
  return base.isZero() ? new Decimal(0) : dec(doc.discountTotal).times(100).dividedBy(base);
}

function needsApproval(
  company: Awaited<ReturnType<typeof stockPolicy>>,
  direction: Direction,
  doc: TradeDocument,
): boolean {
  const settings = company.settings;
  const limit =
    direction === 'SALE' ? settings?.saleApprovalAmount : settings?.purchaseApprovalAmount;
  if (limit && dec(doc.grandTotal).gte(limit)) return true;
  const discountLimit = settings?.discountApprovalPercent;
  return Boolean(discountLimit && discountPercent(doc).gt(discountLimit));
}

async function changeStatus(
  ctx: RequestContext,
  direction: Direction,
  id: string,
  from: string,
  set: Record<string, unknown>,
) {
  const doc = await modelOf(direction)
    .findOneAndUpdate(
      { companyId: ctx.companyId, _id: id, status: from },
      { $set: set },
      { returnDocument: 'after', session: ctx.session ?? null },
    )
    .lean();
  if (!doc) throw new ConflictError(`This document is not in the ${from} state.`);
  return plain(doc);
}

export async function submitDraft(ctx: RequestContext, direction: Direction, id: string) {
  const doc = await load(ctx, direction, id);
  const company = await stockPolicy(ctx);
  const status = needsApproval(company, direction, doc) ? 'PENDING_APPROVAL' : 'APPROVED';
  return changeStatus(ctx, direction, id, 'DRAFT', { status });
}

export async function decideDocument(
  ctx: RequestContext,
  direction: Direction,
  id: string,
  approve: boolean,
) {
  const doc = await load(ctx, direction, id);
  if (doc.createdBy === ctx.userId) {
    throw new BusinessRuleError('A document cannot be decided by the person who created it.');
  }
  const result = await changeStatus(ctx, direction, id, 'PENDING_APPROVAL', {
    status: approve ? 'APPROVED' : 'DRAFT',
    approvedBy: ctx.userId,
  });
  await recordAudit(ctx, {
    action: `${LABEL[direction].entity}.${approve ? 'approve' : 'reject'}`,
    entityType: LABEL[direction].entity,
    entityId: id,
  });
  return result;
}

export function voidDraft(ctx: RequestContext, direction: Direction, id: string) {
  return changeStatus(ctx, direction, id, 'DRAFT', { status: 'VOID' });
}

async function nextNumber(
  tx: TransactionalContext,
  company: Awaited<ReturnType<typeof stockPolicy>>,
  documentType: string,
  branchId: Types.ObjectId,
  date: Date,
): Promise<string> {
  const scope = (company.settings?.numberingScope ?? 'BRANCH_FISCAL_YEAR') as NumberingScope;
  const branch = await BranchModel.findOne({ companyId: tx.companyId, _id: branchId })
    .session(tx.session)
    .lean();
  if (!branch) throw new NotFoundError('The branch was not found.');
  const year = String(date.getUTCFullYear());
  const prefix = [
    documentType,
    scope.startsWith('BRANCH') ? branch.code : null,
    scope.endsWith('FISCAL_YEAR') ? year : null,
  ]
    .filter(Boolean)
    .join('-');
  return allocateNumber(tx, {
    documentType,
    scope,
    prefix: `${prefix}-`,
    padding: 6,
    branchCode: branch.code,
    fiscalYear: year,
  });
}

async function moveStock(
  tx: TransactionalContext,
  direction: Direction,
  doc: TradeDocument,
  company: Awaited<ReturnType<typeof stockPolicy>>,
): Promise<{ lines: TradeLine[]; cost: Decimal }> {
  const moneyScale = company.settings?.pricing?.moneyScale ?? 2;
  const sourceType = direction === 'SALE' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';
  const sourceId = doc._id.toString();
  const lines: TradeLine[] = [];
  let cost = new Decimal(0);

  for (const line of doc.lines) {
    const key = {
      branchId: doc.branchId,
      warehouseId: line.warehouseId,
      location: line.location,
      productId: line.productId,
      purityId: line.purityId,
    };
    const quantity = {
      pieces: line.pieces,
      gross: dec(line.grossWeight),
      net: dec(line.netWeight),
      fine: dec(line.fineWeight),
    };
    const source = { type: direction, sourceType, sourceId, lineId: line.lineId };
    const policy = { allowNegative: company.settings?.allowNegativeStock ?? false, moneyScale };

    if (direction === 'SALE' && line.tracking === 'LOT' && !line.lotId) {
      const issued = await stockOutOldestFirst(tx, key, quantity, source, policy);
      cost = cost.plus(issued.cost);
      lines.push({ ...line, costAtIssue: d128(issued.cost), allocations: issued.allocations });
    } else if (direction === 'SALE') {
      const lineCost = await stockOut(tx, { ...key, lotId: line.lotId }, quantity, source, {
        ...policy,
        ...(line.stockItemId ? { stockItemId: line.stockItemId } : {}),
      });
      cost = cost.plus(lineCost);
      lines.push({ ...line, costAtIssue: d128(lineCost) });
    } else {
      const lineCost = dec(line.taxableValue);
      const received = await receiveInto(tx, {
        warehouseId: line.warehouseId,
        location: line.location,
        productId: line.productId,
        pieces: line.pieces,
        grossWeight: dec(line.grossWeight).toFixed(),
        stoneWeight: dec(line.stoneWeight).toFixed(),
        cost: lineCost,
        ...(line.tag ? { tag: line.tag } : {}),
        sourceType,
        sourceId,
        lineId: line.lineId,
        type: 'PURCHASE',
      });
      cost = cost.plus(lineCost);
      lines.push({
        ...line,
        costAtIssue: d128(lineCost),
        ...(received.lotId ? { lotId: received.lotId } : {}),
        ...(received.stockItemId ? { stockItemId: received.stockItemId } : {}),
      });
    }
  }
  return { lines, cost };
}

function journalLines(
  direction: Direction,
  doc: TradeDocument,
  cost: Decimal,
  notionalTax: Decimal,
): PostingLine[] {
  const total = dec(doc.grandTotal);
  const taxable = dec(doc.taxableTotal);
  const tax = dec(doc.taxTotal);
  const partyId = doc.partyId;
  if (direction === 'PURCHASE') {
    return [
      { role: 'INVENTORY', debit: taxable },
      { role: 'INPUT_VAT', debit: tax.plus(notionalTax) },
      { role: 'OUTPUT_VAT', credit: notionalTax },
      { role: 'AP', credit: total, partyId },
    ];
  }
  const discount = dec(doc.discountTotal);
  const making = doc.lines.reduce((sum, l) => sum.plus(dec(l.makingCharge)), new Decimal(0));
  return [
    { role: 'AR', debit: total, partyId },
    { role: 'SALES_DISCOUNT', debit: discount },
    { role: 'SALES_MAKING', credit: making },
    { role: 'SALES_GOLD', credit: taxable.plus(discount).minus(making) },
    { role: 'OUTPUT_VAT', credit: tax },
    { role: 'COGS', debit: cost },
    { role: 'INVENTORY', credit: cost },
  ];
}

function taxGroups(doc: TradeDocument) {
  const groups = new Map<string, { line: TradeLine; taxable: Decimal; tax: Decimal }>();
  for (const line of doc.lines) {
    const key = `${line.taxCode}`;
    const group = groups.get(key) ?? { line, taxable: new Decimal(0), tax: new Decimal(0) };
    group.taxable = group.taxable.plus(dec(line.taxableValue));
    group.tax = group.tax.plus(dec(line.taxAmount)).plus(dec(line.notionalTax));
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The commit point: stock, ledger, tax, receivable and payments all succeed or none do. */
export function postDocument(ctx: RequestContext, direction: Direction, id: string) {
  return runInTransaction(ctx, async (tx) => {
    const doc = await load(tx, direction, id);
    const company = await stockPolicy(tx);
    if (doc.status === 'DRAFT' && needsApproval(company, direction, doc)) {
      throw new BusinessRuleError('This document needs approval before posting.');
    }
    if (doc.status !== 'DRAFT' && doc.status !== 'APPROVED') {
      throw new ConflictError('This document cannot be posted in its current state.');
    }
    await assertPartyNotOnHold(tx, doc.partyId);
    const label = LABEL[direction];
    const number = await nextNumber(tx, company, label.series, doc.branchId, doc.docDate);
    const { lines, cost } = await moveStock(tx, direction, doc, company);
    const notionalTax = lines.reduce((sum, l) => sum.plus(dec(l.notionalTax)), new Decimal(0));

    const journal = await postJournal(tx, {
      postingDate: doc.docDate,
      branchId: doc.branchId,
      memo: `${direction === 'SALE' ? 'Sales' : 'Purchase'} invoice ${number}`,
      sourceType: direction === 'SALE' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE',
      sourceId: id,
      kind: 'POSTING',
      lines: journalLines(direction, { ...doc, lines }, cost, notionalTax),
    });

    for (const group of taxGroups({ ...doc, lines })) {
      await recordTaxTransaction(tx, {
        sourceType: direction,
        sourceId: id,
        branchId: doc.branchId,
        partyId: doc.partyId,
        direction: direction === 'SALE' ? 'OUTPUT' : 'INPUT',
        treatment: group.line.taxTreatment,
        taxCode: group.line.taxCode,
        ratePercent: dec(group.line.taxRatePercent).toFixed(),
        taxable: group.taxable.toFixed(),
        tax: group.tax.toFixed(),
        date: doc.docDate,
      });
    }

    const side = direction === 'SALE' ? ('RECEIVABLE' as const) : ('PAYABLE' as const);
    const total = dec(doc.grandTotal);
    const openItem = await createOpenItem(tx, {
      partyId: doc.partyId,
      side,
      sourceType: direction,
      sourceId: id,
      number,
      branchId: doc.branchId,
      docDate: doc.docDate,
      dueDate: doc.dueDate ?? doc.docDate,
      amount: total,
    });
    await changePartyBalance(tx, doc.partyId, side, total);

    for (const payment of doc.plannedPayments) {
      await recordPayment(tx, {
        direction: direction === 'SALE' ? 'RECEIPT' : 'PAYMENT',
        side,
        partyId: doc.partyId,
        branchId: doc.branchId,
        financialAccountId: payment.financialAccountId,
        methodId: payment.methodId,
        amount: payment.amount,
        paymentDate: doc.docDate,
        reference: payment.reference ?? number,
        allocations: [{ openItemId: openItem._id, amount: payment.amount }],
        sourceType: direction,
        sourceId: id,
      });
    }
    if (direction === 'SALE') await assertWithinCreditLimit(tx, doc.partyId);

    const postedHash = createHash('sha256')
      .update(canonicalJson(plain({ number, lines, partyId: doc.partyId, total: doc.grandTotal })))
      .digest('hex');
    await modelOf(direction)
      .updateOne(
        { companyId: tx.companyId, _id: id },
        {
          $set: {
            number,
            status: 'POSTED',
            lines,
            postedBy: tx.userId,
            postedAt: new Date(),
            postedHash,
            journalEntryId: journal.entryId,
            openItemId: openItem._id,
          },
        },
      )
      .session(tx.session);

    await recordAudit(tx, {
      action: `${label.entity}.post`,
      entityType: label.entity,
      entityId: id,
      after: { number, total: total.toFixed(), journal: journal.number },
    });
    await enqueueEvent(tx, label.event, {
      id,
      number,
      partyId: doc.partyId.toString(),
      total: total.toFixed(),
      productIds: lines.map((l) => l.productId.toString()),
    });
    return { id, number, journalNumber: journal.number };
  });
}

/** Returns whole lines at their original snapshot values, issuing a credit note. */
export function returnLines(
  ctx: RequestContext,
  direction: Direction,
  id: string,
  input: z.infer<typeof tradeReturnSchema>,
) {
  return runInTransaction(ctx, async (tx) => {
    const doc = await load(tx, direction, id);
    if (doc.status !== 'POSTED' && doc.status !== 'PARTIALLY_RETURNED') {
      throw new ConflictError('Only a posted document can be returned.');
    }
    const company = await stockPolicy(tx);
    const moneyScale = company.settings?.pricing?.moneyScale ?? 2;
    const selected = doc.lines.filter((l) => input.lineIds.includes(l.lineId));
    if (selected.length !== new Set(input.lineIds).size) {
      throw new BusinessRuleError('A selected line does not belong to this document.');
    }
    if (selected.some((l) => l.returned)) {
      throw new ConflictError('A selected line has already been returned.');
    }

    const creditNoteId = new Types.ObjectId();
    const sum = (pick: (l: TradeLine) => Types.Decimal128 | undefined) =>
      selected.reduce((total, l) => total.plus(dec(pick(l))), new Decimal(0));
    let cost = new Decimal(0);

    for (const line of selected) {
      const key = {
        branchId: doc.branchId,
        warehouseId: line.warehouseId,
        location: direction === 'SALE' ? 'RETURNS' : line.location,
        productId: line.productId,
        purityId: line.purityId,
        lotId: line.lotId,
      };
      const quantity = {
        pieces: line.pieces,
        gross: dec(line.grossWeight),
        net: dec(line.netWeight),
        fine: dec(line.fineWeight),
      };
      const source = {
        type: 'RETURN',
        sourceType: 'CREDIT_NOTE',
        sourceId: creditNoteId.toString(),
        lineId: line.lineId,
      };
      if (direction === 'SALE') {
        const lineCost = dec(line.costAtIssue);
        const parts = line.allocations?.length ? line.allocations : null;
        if (parts) {
          for (const [index, part] of parts.entries()) {
            await stockIn(
              tx,
              { ...key, lotId: part.lotId },
              {
                pieces: part.pieces,
                gross: dec(part.gross),
                net: dec(part.net),
                fine: dec(part.fine),
              },
              dec(part.cost),
              { ...source, lineId: `${line.lineId}.${index}` },
            );
          }
        } else {
          await stockIn(tx, key, quantity, lineCost, source, line.stockItemId);
        }
        if (line.stockItemId) {
          await StockItemModel.updateOne(
            { companyId: tx.companyId, _id: line.stockItemId },
            { $set: { status: 'IN_STOCK', location: 'RETURNS' }, $unset: { issuedBy: 1 } },
          ).session(tx.session);
        }
        cost = cost.plus(lineCost);
      } else {
        cost = cost.plus(
          await stockOut(tx, key, quantity, source, {
            allowNegative: false,
            moneyScale,
            ...(line.stockItemId ? { stockItemId: line.stockItemId } : {}),
          }),
        );
      }
    }

    const taxable = sum((l) => l.taxableValue);
    const tax = sum((l) => l.taxAmount);
    const notional = sum((l) => l.notionalTax);
    const total = taxable.plus(tax);
    const date = new Date(input.docDate);
    const number = await nextNumber(tx, company, LABEL[direction].creditPrefix, doc.branchId, date);

    const discount = sum((l) => l.discount);
    const making = sum((l) => l.makingCharge);
    const lines: PostingLine[] =
      direction === 'SALE'
        ? [
            { role: 'AR', credit: total, partyId: doc.partyId },
            { role: 'SALES_DISCOUNT', credit: discount },
            { role: 'SALES_MAKING', debit: making },
            { role: 'SALES_GOLD', debit: taxable.plus(discount).minus(making) },
            { role: 'OUTPUT_VAT', debit: tax },
            { role: 'COGS', credit: cost },
            { role: 'INVENTORY', debit: cost },
          ]
        : [
            { role: 'AP', debit: total, partyId: doc.partyId },
            { role: 'INVENTORY', credit: cost },
            { role: 'STOCK_GAIN_LOSS' },
            { role: 'INPUT_VAT', credit: tax.plus(notional) },
            { role: 'OUTPUT_VAT', debit: notional },
          ];
    // Moving average can relieve a different cost from the original price; the gain or loss is booked.
    if (direction === 'PURCHASE') {
      const difference = taxable.minus(cost);
      lines[2] = difference.isNegative()
        ? { role: 'STOCK_GAIN_LOSS', debit: difference.negated() }
        : { role: 'STOCK_GAIN_LOSS', credit: difference };
    }
    const journal = await postJournal(tx, {
      postingDate: date,
      branchId: doc.branchId,
      memo: `Credit note ${number} against ${doc.number}: ${input.reason}`,
      sourceType: 'CREDIT_NOTE',
      sourceId: creditNoteId.toString(),
      kind: 'POSTING',
      lines,
    });

    await CreditNoteModel.create(
      [
        {
          _id: creditNoteId,
          companyId: tx.companyId,
          number,
          kind: direction === 'SALE' ? 'CUSTOMER' : 'SUPPLIER',
          originalId: doc._id,
          originalNumber: doc.number,
          partyId: doc.partyId,
          branchId: doc.branchId,
          docDate: date,
          reason: input.reason,
          lineIds: input.lineIds,
          taxable: d128(taxable),
          tax: d128(tax),
          total: d128(total),
          journalEntryId: journal.entryId,
          createdBy: tx.userId,
        },
      ],
      { session: tx.session },
    );

    for (const group of taxGroups({ ...doc, lines: selected })) {
      await recordTaxTransaction(tx, {
        sourceType: 'CREDIT_NOTE',
        sourceId: creditNoteId.toString(),
        branchId: doc.branchId,
        partyId: doc.partyId,
        direction: direction === 'SALE' ? 'OUTPUT' : 'INPUT',
        treatment: group.line.taxTreatment,
        taxCode: group.line.taxCode,
        ratePercent: dec(group.line.taxRatePercent).toFixed(),
        taxable: group.taxable.negated().toFixed(),
        tax: group.tax.negated().toFixed(),
        date,
      });
    }

    // Reduces what is still owed. Anything already paid stays as a credit, refundable by payment.
    const side = direction === 'SALE' ? ('RECEIVABLE' as const) : ('PAYABLE' as const);
    const item = await OpenItemModel.findOne({ companyId: tx.companyId, _id: doc.openItemId })
      .session(tx.session)
      .lean();
    if (item) {
      const reduction = Decimal.min(dec(item.outstanding), total);
      const remaining = dec(item.outstanding).minus(reduction);
      await OpenItemModel.updateOne(
        { companyId: tx.companyId, _id: item._id },
        { $set: { outstanding: d128(remaining), status: remaining.isZero() ? 'SETTLED' : 'OPEN' } },
      ).session(tx.session);
    }
    await changePartyBalance(tx, doc.partyId, side, total.negated());

    const updatedLines = doc.lines.map((line) =>
      input.lineIds.includes(line.lineId) ? { ...line, returned: true } : line,
    );
    await modelOf(direction)
      .updateOne(
        { companyId: tx.companyId, _id: id },
        {
          $set: {
            lines: updatedLines,
            status: updatedLines.every((l) => l.returned) ? 'RETURNED' : 'PARTIALLY_RETURNED',
          },
        },
      )
      .session(tx.session);
    await recordAudit(tx, {
      action: `${LABEL[direction].entity}.return`,
      entityType: LABEL[direction].entity,
      entityId: id,
      after: { creditNote: number, total: total.toFixed(), reason: input.reason },
    });
    return { id: creditNoteId.toString(), number };
  });
}

export async function getDocument(ctx: RequestContext, direction: Direction, id: string) {
  return plain(await load(ctx, direction, id));
}
