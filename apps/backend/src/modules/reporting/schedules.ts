import { PERMISSIONS } from '@lumio/shared-types';
import { objectIdSchema, reportScheduleSchema } from '@lumio/validation';
import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { requirePermission } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import type { RequestContext } from '../../shared/context.js';
import { AppError, BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';
import { CompanyModel } from '../organisation/index.js';
import { recordAudit } from '../platform/audit/index.js';
import { REPORTS } from './catalogue.js';
import { toPdf, toXlsx } from './exports.js';

const scheduleSchema = tenantSchema(
  'reportSchedules',
  {
    reportKey: RS,
    frequency: { type: String, enum: ['DAILY', 'WEEKLY', 'MONTHLY'], required: true },
    format: { type: String, enum: ['XLSX', 'PDF'], required: true },
    recipients: { type: [String], required: true },
    createdBy: RS,
    lastRunOn: String,
  },
  { timestamps: true },
);
scheduleSchema.index({ companyId: 1, reportKey: 1 });
export const ReportScheduleModel = tenantModel('ReportSchedule', scheduleSchema);

type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
type Input = z.infer<typeof reportScheduleSchema>;

const DAY_MS = 86_400_000;

/** Weekly runs on Mondays and monthly on the 1st, each covering the period just ended. */
export function dueRange(frequency: Frequency, now: Date): { from: Date; to: Date } | null {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(today.getTime() - 1);
  if (frequency === 'DAILY') return { from: new Date(today.getTime() - DAY_MS), to };
  if (frequency === 'WEEKLY') {
    return today.getUTCDay() === 1 ? { from: new Date(today.getTime() - 7 * DAY_MS), to } : null;
  }
  if (today.getUTCDate() !== 1) return null;
  return { from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)), to };
}

export interface ReportEmail {
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; content: Buffer; contentType: string }[];
}

interface ScheduleRow {
  _id: Types.ObjectId;
  reportKey: string;
  frequency: Frequency;
  format: 'XLSX' | 'PDF';
  recipients: string[];
  lastRunOn?: string;
}

/** A schedule was checked against its creator's permissions when it was saved. */
export async function runDueSchedules(
  companyId: Types.ObjectId,
  send: (email: ReportEmail) => Promise<unknown>,
  now = new Date(),
): Promise<number> {
  const stamp = now.toISOString().slice(0, 10);
  const schedules = (await ReportScheduleModel.find({ companyId }).lean()) as ScheduleRow[];
  const company = await CompanyModel.findById(companyId).lean();
  const ctx: RequestContext = {
    companyId,
    userId: 'system',
    branchScope: 'ALL',
    permissions: new Set(PERMISSIONS),
    correlationId: `report-schedule-${stamp}`,
  };
  let sent = 0;
  for (const schedule of schedules) {
    const report = REPORTS[schedule.reportKey];
    const range = dueRange(schedule.frequency, now);
    if (!report || !range || schedule.lastRunOn === stamp) continue;
    const rows = await report.run(ctx, range);
    const subtitle = `${company?.legalName ?? ''}, ${range.from.toISOString().slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}`;
    const attachment =
      schedule.format === 'XLSX'
        ? {
            filename: `${schedule.reportKey}.xlsx`,
            content: toXlsx(report.title, rows),
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }
        : {
            filename: `${schedule.reportKey}.pdf`,
            content: await toPdf(report.title, rows, subtitle),
            contentType: 'application/pdf',
          };
    await send({
      to: schedule.recipients,
      subject: `${report.title} (${stamp})`,
      text: `${report.title}: ${subtitle}. The report is attached.`,
      attachments: [attachment],
    });
    await ReportScheduleModel.updateOne(
      { companyId, _id: schedule._id },
      { $set: { lastRunOn: stamp } },
    );
    sent += 1;
  }
  return sent;
}

export function createReportScheduleRouter(): Router {
  const router = Router();
  const allow = requirePermission('report:export');

  router.get('/', allow, async (req, res) => {
    const rows = await ReportScheduleModel.find({ companyId: req.ctx.companyId })
      .sort({ _id: -1 })
      .lean();
    sendSuccess(req, res, plain(rows));
  });

  router.post('/', allow, validate({ body: reportScheduleSchema }), async (req, res) => {
    const input = req.validated.body as Input;
    const report = REPORTS[input.reportKey];
    if (!report) throw new BusinessRuleError('That report does not exist.');
    if (!req.ctx.permissions.has(report.permission)) {
      throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this report.');
    }
    const created = await ReportScheduleModel.create({
      ...input,
      companyId: req.ctx.companyId,
      createdBy: req.ctx.userId,
    });
    await recordAudit(req.ctx, {
      action: 'report_schedule.create',
      entityType: 'report_schedule',
      entityId: String(created._id),
      after: input,
    });
    sendSuccess(req, res, plain(created.toObject()), 201);
  });

  router.delete(
    '/:id',
    allow,
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      const removed = await ReportScheduleModel.deleteOne({
        companyId: req.ctx.companyId,
        _id: req.params.id,
      });
      if (removed.deletedCount === 0) throw new NotFoundError();
      await recordAudit(req.ctx, {
        action: 'report_schedule.delete',
        entityType: 'report_schedule',
        entityId: String(req.params.id),
      });
      res.status(204).end();
    },
  );

  return router;
}
