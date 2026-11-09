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
import { toPdf, toXlsx } from './exports.js';
import {
  balanceSheet,
  cashFlow,
  generalLedger,
  partyStatement,
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

export { createVatRouter } from './vat.js';
export { createReportScheduleRouter, runDueSchedules, type ReportEmail } from './schedules.js';

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

  router.get(
    '/party-statements/:id',
    requirePermission('party:read', 'report:read'),
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      const statement = await partyStatement(req.ctx, String(req.params.id), rangeOf(req));
      if (req.query.format === 'pdf') {
        res
          .type('application/pdf')
          .attachment('statement.pdf')
          .send(
            await toPdf(
              `Statement: ${statement.party}`,
              statement.rows,
              `Opening ${statement.opening}, closing ${statement.closing}`,
            ),
          );
        return;
      }
      sendSuccess(req, res, statement);
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
    const format = req.query.format;
    if (format === 'csv' || format === 'xlsx' || format === 'pdf') {
      if (!req.ctx.permissions.has('report:export')) {
        throw new AppError(403, 'FORBIDDEN', 'You do not have permission to export reports.');
      }
      const file = `${String(req.params.key)}.${format}`;
      if (format === 'csv') res.type('text/csv').attachment(file).send(toCsv(rows));
      else if (format === 'xlsx') {
        res
          .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
          .attachment(file)
          .send(toXlsx(report.title, rows));
      } else
        res
          .type('application/pdf')
          .attachment(file)
          .send(await toPdf(report.title, rows));
      return;
    }
    sendSuccess(req, res, { title: report.title, rows });
  });

  return router;
}
