import type { Permission } from '@lumio/shared-types';
import { objectIdSchema } from '@lumio/validation';
import { Router } from 'express';
import mongoose, { type Types } from 'mongoose';
import { z } from 'zod';
import { RS, tenantModel, tenantSchema } from '../../database/tenant-schema.js';
import { validate } from '../../middleware/validate.js';
import { NotFoundError } from '../../shared/errors.js';
import { sendSuccess } from '../../shared/http.js';
import { plain } from '../../shared/serialize.js';

const notificationSchema = tenantSchema(
  'notifications',
  {
    // Repeating a key is ignored, so each alert is raised only once.
    key: RS,
    audience: RS,
    severity: { type: String, enum: ['INFO', 'WARNING', 'CRITICAL'], required: true },
    title: RS,
    body: RS,
    link: String,
    readBy: { type: [String], default: [] },
  },
  { timestamps: true },
);
notificationSchema.index({ companyId: 1, key: 1 }, { unique: true });
notificationSchema.index({ companyId: 1, audience: 1, _id: -1 });
export const NotificationModel = tenantModel('Notification', notificationSchema);

export interface NewNotification {
  key: string;
  /** Shown to everyone who holds this permission. */
  audience: Permission;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string;
  link?: string;
}

export async function notify(
  companyId: Types.ObjectId,
  notification: NewNotification,
): Promise<boolean> {
  const { key, ...rest } = notification;
  const result = await NotificationModel.updateOne(
    { companyId, key },
    { $setOnInsert: rest },
    { upsert: true },
  );
  return result.upsertedCount > 0;
}

export function createNotificationRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const rows = await NotificationModel.find({
      companyId: req.ctx.companyId,
      audience: mongoose.trusted({ $in: [...req.ctx.permissions] }),
    })
      .sort({ _id: -1 })
      .limit(100)
      .lean();
    const userId = req.ctx.userId;
    sendSuccess(
      req,
      res,
      rows.map(({ readBy, ...row }) => ({
        ...plain<object>(row),
        read: (readBy as string[]).includes(userId),
      })),
    );
  });

  router.post(
    '/:id/read',
    validate({ params: z.object({ id: objectIdSchema }) }),
    async (req, res) => {
      const result = await NotificationModel.updateOne(
        {
          companyId: req.ctx.companyId,
          _id: req.params.id,
          audience: mongoose.trusted({ $in: [...req.ctx.permissions] }),
        },
        { $addToSet: { readBy: req.ctx.userId } },
      );
      if (result.matchedCount === 0) throw new NotFoundError();
      sendSuccess(req, res, { read: true });
    },
  );

  return router;
}
