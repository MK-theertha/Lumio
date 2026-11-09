import { ErrorCode } from '@lumio/shared-types';
import mongoose, { Types } from 'mongoose';
import { retryDuplicateKeyInTransaction, runInTransaction } from '../../database/transaction.js';
import {
  assertBranchAccess,
  assertTransactional,
  type RequestContext,
  type TransactionalContext,
} from '../../shared/context.js';
import { d128, dec, Decimal } from '../../shared/decimal.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { assertPartyNotOnHold } from '../compliance/index.js';
import { postJournal, reverseJournal } from '../ledger/index.js';
import { PartyModel } from '../master/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { allocateNumber } from '../platform/numbering/index.js';
import { enqueueEvent } from '../platform/outbox/index.js';
import {
  FinancialAccountModel,
  OpenItemModel,
  PartyBalanceModel,
  PaymentAllocationModel,
  PaymentMethodModel,
  PaymentModel,
} from './finance.models.js';
import { BankMatchModel } from './reconciliation.js';

type Id = Types.ObjectId | string;
export type Side = 'RECEIVABLE' | 'PAYABLE';

export async function changePartyBalance(
  tx: TransactionalContext,
  partyId: Id,
  side: Side,
  change: Decimal,
): Promise<void> {
  await PartyBalanceModel.updateOne(
    { companyId: tx.companyId, partyId },
    {
      $inc: {
        receivable: d128(side === 'RECEIVABLE' ? change : new Decimal(0)),
        payable: d128(side === 'PAYABLE' ? change : new Decimal(0)),
      },
    },
    { upsert: true, session: tx.session },
  ).catch(retryDuplicateKeyInTransaction);
}

/** Because this reads a document each concurrent sale also writes, overlapping sales conflict. */
export async function assertWithinCreditLimit(
  tx: TransactionalContext,
  partyId: Id,
): Promise<void> {
  const party = await PartyModel.findOne({ companyId: tx.companyId, _id: partyId })
    .session(tx.session)
    .lean();
  if (!party?.creditLimit) return;
  const balance = await PartyBalanceModel.findOne({ companyId: tx.companyId, partyId })
    .session(tx.session)
    .lean();
  if (dec(balance?.receivable).greaterThan(dec(party.creditLimit))) {
    throw new BusinessRuleError(
      'This sale would exceed the customer credit limit.',
      ErrorCode.CREDIT_LIMIT_EXCEEDED,
    );
  }
}

export async function createOpenItem(
  tx: TransactionalContext,
  item: {
    partyId: Id;
    side: Side;
    sourceType: string;
    sourceId: string;
    number: string;
    branchId: Id;
    docDate: Date;
    dueDate: Date;
    amount: Decimal;
  },
) {
  const { amount, ...rest } = item;
  const [created] = await OpenItemModel.create(
    [
      {
        ...rest,
        companyId: tx.companyId,
        original: d128(amount),
        outstanding: d128(amount),
        status: amount.isZero() ? 'SETTLED' : 'OPEN',
      },
    ],
    { session: tx.session },
  );
  return created as unknown as { _id: Types.ObjectId };
}

async function applyToOpenItem(
  tx: TransactionalContext,
  paymentId: Types.ObjectId,
  openItemId: Id,
  amount: Decimal,
): Promise<void> {
  const item = await OpenItemModel.findOneAndUpdate(
    {
      companyId: tx.companyId,
      _id: openItemId,
      outstanding: mongoose.trusted({ $gte: d128(amount) }),
    },
    { $inc: { outstanding: d128(amount.negated()) } },
    { returnDocument: 'after', session: tx.session },
  ).lean();
  if (!item) throw new BusinessRuleError('An allocation exceeds the amount outstanding.');
  await OpenItemModel.updateOne(
    { companyId: tx.companyId, _id: item._id },
    { $set: { status: dec(item.outstanding).isZero() ? 'SETTLED' : 'OPEN' } },
  ).session(tx.session);
  await PaymentAllocationModel.create(
    [{ companyId: tx.companyId, paymentId, openItemId, amount: d128(amount), at: new Date() }],
    { session: tx.session },
  );
}

export interface PaymentInput {
  direction: 'RECEIPT' | 'PAYMENT';
  side?: Side | undefined;
  partyId: Id;
  branchId: Id;
  financialAccountId: Id;
  methodId: Id;
  amount: string;
  paymentDate: string | Date;
  reference?: string | undefined;
  allocations?: { openItemId: Id; amount: string }[] | undefined;
  sourceType?: string;
  sourceId?: string;
}

/** Posts a receipt or payment with its journal and allocations. Joins any enclosing transaction. */
export async function recordPayment(ctx: RequestContext, input: PaymentInput) {
  assertBranchAccess(ctx, input.branchId);
  return runInTransaction(ctx, async (tx) => {
    assertTransactional(tx, 'recordPayment');
    const amount = dec(input.amount);
    if (amount.lessThanOrEqualTo(0)) throw new BusinessRuleError('The amount must be positive.');
    await assertPartyNotOnHold(tx, input.partyId);
    const side: Side = input.side ?? (input.direction === 'RECEIPT' ? 'RECEIVABLE' : 'PAYABLE');
    // Sequential: a MongoDB transaction cannot run operations in parallel on one session.
    const account = await FinancialAccountModel.findOne({
      companyId: tx.companyId,
      _id: input.financialAccountId,
    })
      .session(tx.session)
      .lean();
    const method = await PaymentMethodModel.findOne({
      companyId: tx.companyId,
      _id: input.methodId,
    })
      .session(tx.session)
      .lean();
    const party = await PartyModel.findOne({ companyId: tx.companyId, _id: input.partyId })
      .session(tx.session)
      .lean();
    if (!account || !method || !party) {
      throw new NotFoundError('The account, method or party was not found.');
    }
    const allocated = (input.allocations ?? []).reduce(
      (sum, a) => sum.plus(a.amount),
      new Decimal(0),
    );
    if (allocated.greaterThan(amount)) {
      throw new BusinessRuleError('Allocations exceed the payment amount.');
    }

    const date = new Date(input.paymentDate);
    const number = await allocateNumber(tx, {
      documentType: input.direction === 'RECEIPT' ? 'RCPT' : 'PAY',
      scope: 'COMPANY',
      prefix: input.direction === 'RECEIPT' ? 'RCPT-' : 'PAY-',
      padding: 7,
    });
    const paymentId = new Types.ObjectId();
    const controlRole = side === 'RECEIVABLE' ? ('AR' as const) : ('AP' as const);
    const cashDebit = input.direction === 'RECEIPT';
    const journal = await postJournal(tx, {
      postingDate: date,
      branchId: input.branchId,
      memo: `${input.direction === 'RECEIPT' ? 'Receipt' : 'Payment'} ${number}`,
      sourceType: 'PAYMENT',
      sourceId: paymentId.toString(),
      kind: 'PAYMENT',
      lines: [
        {
          accountId: account.ledgerAccountId,
          ...(cashDebit ? { debit: amount } : { credit: amount }),
        },
        {
          role: controlRole,
          partyId: input.partyId,
          ...(cashDebit ? { credit: amount } : { debit: amount }),
        },
      ],
    });
    await PaymentModel.create(
      [
        {
          _id: paymentId,
          companyId: tx.companyId,
          number,
          direction: input.direction,
          side,
          partyId: input.partyId,
          branchId: input.branchId,
          financialAccountId: account._id,
          methodId: method._id,
          amlClass: method.amlClass,
          amount: d128(amount),
          paymentDate: date,
          reference: input.reference,
          status: 'POSTED',
          journalEntryId: journal.entryId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          createdBy: tx.userId,
        },
      ],
      { session: tx.session },
    );

    for (const allocation of input.allocations ?? []) {
      const item = await OpenItemModel.findOne({
        companyId: tx.companyId,
        _id: allocation.openItemId,
      })
        .session(tx.session)
        .lean();
      if (!item || !item.partyId.equals(String(input.partyId)) || item.side !== side) {
        throw new BusinessRuleError('An allocation refers to another party or account.');
      }
      await applyToOpenItem(tx, paymentId, allocation.openItemId, dec(allocation.amount));
    }

    const reducesBalance =
      (side === 'RECEIVABLE' && input.direction === 'RECEIPT') ||
      (side === 'PAYABLE' && input.direction === 'PAYMENT');
    await changePartyBalance(tx, input.partyId, side, reducesBalance ? amount.negated() : amount);
    await recordAudit(tx, {
      action: 'payment.post',
      entityType: 'payment',
      entityId: paymentId.toString(),
      after: { number, amount: input.amount, direction: input.direction },
    });
    await enqueueEvent(tx, 'payment.posted', {
      id: paymentId.toString(),
      partyId: String(input.partyId),
      amount: amount.toFixed(),
      amlClass: method.amlClass,
      number,
    });
    return { id: paymentId.toString(), number, journalNumber: journal.number };
  });
}

export function reversePayment(ctx: RequestContext, id: string, reason: string) {
  return runInTransaction(ctx, async (tx) => {
    if (
      await BankMatchModel.findOne({ companyId: tx.companyId, paymentId: id }).session(tx.session)
    ) {
      throw new ConflictError('This payment has cleared the bank. Unmatch it before reversing.');
    }
    const payment = await PaymentModel.findOneAndUpdate(
      { companyId: tx.companyId, _id: id, status: 'POSTED' },
      { $set: { status: 'REVERSED' } },
      { session: tx.session },
    ).lean();
    if (!payment) throw new ConflictError('This payment cannot be reversed.');
    assertBranchAccess(tx, payment.branchId);
    await reverseJournal(tx, payment.journalEntryId, reason, new Date());

    const allocations = await PaymentAllocationModel.find({
      companyId: tx.companyId,
      paymentId: payment._id,
    })
      .session(tx.session)
      .lean();
    for (const allocation of allocations) {
      await OpenItemModel.updateOne(
        { companyId: tx.companyId, _id: allocation.openItemId },
        { $inc: { outstanding: allocation.amount }, $set: { status: 'OPEN' } },
      ).session(tx.session);
      await PaymentAllocationModel.create(
        [
          {
            companyId: tx.companyId,
            paymentId: payment._id,
            openItemId: allocation.openItemId,
            amount: d128(dec(allocation.amount).negated()),
            at: new Date(),
          },
        ],
        { session: tx.session },
      );
    }

    const reduced =
      (payment.side === 'RECEIVABLE' && payment.direction === 'RECEIPT') ||
      (payment.side === 'PAYABLE' && payment.direction === 'PAYMENT');
    const amount = dec(payment.amount);
    await changePartyBalance(
      tx,
      payment.partyId,
      payment.side,
      reduced ? amount : amount.negated(),
    );
    return { status: 'REVERSED' };
  });
}
