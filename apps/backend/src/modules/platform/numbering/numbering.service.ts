import { retryDuplicateKeyInTransaction } from '../../../database/transaction.js';
import { assertTransactional, type RequestContext } from '../../../shared/context.js';
import { NumberSeriesModel } from './numbering.model.js';

export type NumberingScope = 'COMPANY' | 'COMPANY_FISCAL_YEAR' | 'BRANCH' | 'BRANCH_FISCAL_YEAR';

export interface NumberRequest {
  documentType: string;
  scope: NumberingScope;
  prefix: string;
  padding: number;
  branchCode?: string;
  fiscalYear?: string;
}

export function buildScopeKey(request: NumberRequest): string {
  const { documentType, scope, branchCode, fiscalYear } = request;
  const needsBranch = scope === 'BRANCH' || scope === 'BRANCH_FISCAL_YEAR';
  const needsYear = scope === 'COMPANY_FISCAL_YEAR' || scope === 'BRANCH_FISCAL_YEAR';
  if (needsBranch && !branchCode) throw new Error(`Numbering scope ${scope} requires a branchCode`);
  if (needsYear && !fiscalYear) throw new Error(`Numbering scope ${scope} requires a fiscalYear`);
  return [documentType, needsBranch ? branchCode : null, needsYear ? fiscalYear : null]
    .filter((part) => part !== null)
    .join('/');
}

/**
 * Allocates the next number. It must share the posting transaction: if posting aborts, the
 * increment aborts too, which is what keeps the sequence free of gaps.
 */
export async function allocateNumber(ctx: RequestContext, request: NumberRequest): Promise<string> {
  assertTransactional(ctx, 'allocateNumber');
  const series = await NumberSeriesModel.findOneAndUpdate(
    { companyId: ctx.companyId, scopeKey: buildScopeKey(request) },
    { $inc: { last: 1 } },
    { upsert: true, returnDocument: 'after', session: ctx.session, setDefaultsOnInsert: false },
  ).catch(retryDuplicateKeyInTransaction);

  return `${request.prefix}${String(series.last).padStart(request.padding, '0')}`;
}
