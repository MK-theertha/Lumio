import { runtime } from '@lumio/backend/config/runtime.js';
import {
  screenTransaction,
  type ScreenableEvent,
} from '@lumio/backend/modules/compliance/index.js';
import { EMAIL_EVENT, type EmailMessage } from '@lumio/backend/modules/identity/index.js';
import { decrypt } from '@lumio/backend/shared/crypto.js';
import { createTransport } from 'nodemailer';
import type { EventHandler } from './queues.js';

type Payload = {
  id: string;
  number: string;
  partyId: string;
  total?: string;
  amount?: string;
  amlClass?: string;
};

function screen(trigger: ScreenableEvent['trigger']): EventHandler {
  return async (event) => {
    const payload = event.payload as Payload;
    await screenTransaction({
      companyId: event.companyId,
      trigger,
      sourceId: payload.id,
      sourceNumber: payload.number,
      partyId: payload.partyId,
      amount: payload.amount ?? payload.total ?? '0',
      ...(payload.amlClass ? { amlClass: payload.amlClass } : {}),
    });
  };
}

export function createHandlers(): Record<string, EventHandler> {
  const transport = createTransport(runtime().SMTP_URL);
  return {
    [EMAIL_EVENT]: async (event) => {
      const { sealed } = event.payload as { sealed: string };
      const message = JSON.parse(decrypt(sealed)) as EmailMessage;
      await transport.sendMail({ from: runtime().EMAIL_FROM, ...message });
    },
    'sale.posted': screen('SALE_POSTED'),
    'purchase.posted': screen('PURCHASE_POSTED'),
    'payment.posted': screen('PAYMENT_POSTED'),
  };
}
