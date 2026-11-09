import { objectIdSchema } from '@lumio/validation';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { assertBranchAccess } from '../../shared/context.js';
import { AppError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { REPORTS, type Row } from './catalogue.js';
import { buildDashboard } from './dashboard.js';
import {
  balanceSheet,
  cashFlow,
  generalLedger,
  profitAndLoss,
  trialBalance,
  type Range,
} from './statements.js';

const rangeSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  branchId: objectIdSchema.optional(),
});

function rangeOf(req: Request): Range {
  const parsed = rangeSchema.parse({
    from: req.query.from,
    to: req.query.to,
    branchId: req.query.branchId,
  });
  if (parsed.branchId) assertBranchAccess(req.ctx, parsed.branchId);
  // Branch-limited users only ever see figures for a branch they hold, never company totals.
  const scope = req.ctx.branchScope;
  const branchId = parsed.branchId ?? (scope === 'ALL' ? undefined : scope[0]?.toString());
  if (scope !== 'ALL' && !branchId) {
    throw new AppError(403, 'FORBIDDEN', 'No branch is assigned to this account.');
  }
  return {
    from: parsed.from ? new Date(`${parsed.from}T00:00:00.000Z`) : undefined,
    to: parsed.to ? new Date(`${parsed.to}T23:59:59.999Z`) : undefined,
    branchId,
  };
}

/** Neutralises spreadsheet formula injection as well as CSV delimiters. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] as Row);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join(
    '\n',
  );
}

export function createReportingRouter(): Router {
  const router = Router();

  router.get('/dashboard', requirePermission('report:read'), async (req, res) => {
    sendSuccess(req, res, await buildDashboard(req.ctx, rangeOf(req)));
  });

  const statement = requirePermission('report:read', 'financials:view_cost');
  router.get('/statements/trial-balance', statement, async (req, res) => {
    sendSuccess(req, res, await trialBalance(req.ctx, rangeOf(req)));
  });
  router.get('/statements/profit-and-loss', statement, async (req, res) => {
    sendSuccess(req, res, await profitAndLoss(req.ctx, rangeOf(req)));
  });
  router.get('/statements/balance-sheet', statement, async (req, res) => {
    sendSuccess(req, res, await balanceSheet(req.ctx, rangeOf(req)));
  });
  router.get('/statements/cash-flow', statement, async (req, res) => {
    sendSuccess(req, res, await cashFlow(req.ctx, rangeOf(req)));
  });
  router.get(
    '/statements/general-ledger/:id',
    statement,
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      sendSuccess(req, res, await generalLedger(req.ctx, String(req.params.id), rangeOf(req)));
    },
  );

  router.get('/reports', requirePermission('report:read'), (req, res) => {
    sendSuccess(
      req,
      res,
      Object.entries(REPORTS)
        .filter(([, r]) => req.ctx.permissions.has(r.permission))
        .map(([key, r]) => ({ key, title: r.title })),
    );
  });

  router.get('/reports/:key', requirePermission('report:read'), async (req, res) => {
    const report = REPORTS[String(req.params.key)];
    if (!report) throw new NotFoundError();
    if (!req.ctx.permissions.has(report.permission)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this report.');
    }
    const rows = await report.run(req.ctx, rangeOf(req));
    if (req.query.format === 'csv') {
      if (!req.ctx.permissions.has('report:export')) {
        throw new AppError(403, 'FORBIDDEN', 'You do not have permission to export reports.');
      }
      res
        .type('text/csv')
        .attachment(`${String(req.params.key)}.csv`)
        .send(toCsv(rows));
      return;
    }
    sendSuccess(req, res, { title: report.title, rows });
  });

  return router;
}
