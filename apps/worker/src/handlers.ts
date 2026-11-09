import { runtime } from '@lumio/backend/config/runtime.js';
import {
  rescreenAllParties,
  SANCTIONS_IMPORTED_EVENT,
  screenTransaction,
  type ScreenableEvent,
} from '@lumio/backend/modules/compliance/index.js';
import {
  configuredScanner,
  createObjectStore,
  DOCUMENT_UPLOADED_EVENT,
  scanDocument,
} from '@lumio/backend/modules/documents/index.js';
import { issueEInvoice } from '@lumio/backend/modules/einvoice/index.js';
import { NIGHTLY_EVENT, runNightlyMaintenance } from '@lumio/backend/modules/maintenance/index.js';
import { EMAIL_EVENT, type EmailMessage } from '@lumio/backend/modules/identity/index.js';
import {
  CREDIT_NOTE_ISSUED_EVENT,
  documentPdf,
  INVOICE_EMAIL_EVENT,
  type Direction,
} from '@lumio/backend/modules/trade/index.js';
import type { PublishableEvent } from '@lumio/backend/modules/platform/outbox/index.js';
import type { RequestContext } from '@lumio/backend/shared/context.js';
import { decrypt } from '@lumio/backend/shared/crypto.js';
import { Types } from 'mongoose';
import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
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

interface InvoiceEmail {
  direction: Direction;
  id: string;
  sealedTo: string;
}

const systemContext = (event: PublishableEvent): RequestContext => ({
  companyId: new Types.ObjectId(event.companyId),
  userId: 'system',
  branchScope: 'ALL',
  permissions: new Set(),
  correlationId: event.correlationId,
});

export function createHandlers(
  logger: Logger,
  transport: Pick<Transporter, 'sendMail'> = createTransport(runtime().SMTP_URL),
): Record<string, EventHandler> {
  const screenSale = screen('SALE_POSTED');
  const scanner = configuredScanner();
  const store = createObjectStore(runtime());
  return {
    [EMAIL_EVENT]: async (event) => {
      const { sealed } = event.payload as { sealed: string };
      const message = JSON.parse(decrypt(sealed)) as EmailMessage;
      await transport.sendMail({ from: runtime().EMAIL_FROM, ...message });
    },
    'sale.posted': async (event) => {
      await screenSale(event);
      const { id } = event.payload as Payload;
      await issueEInvoice(new Types.ObjectId(event.companyId), id);
    },
    [CREDIT_NOTE_ISSUED_EVENT]: (event) =>
      issueEInvoice(new Types.ObjectId(event.companyId), (event.payload as Payload).id),
    [INVOICE_EMAIL_EVENT]: async (event) => {
      const { direction, id, sealedTo } = event.payload as InvoiceEmail;
      const { number, pdf } = await documentPdf(systemContext(event), direction, id);
      await transport.sendMail({
        from: runtime().EMAIL_FROM,
        to: decrypt(sealedTo),
        subject: `Invoice ${number}`,
        text: `Please find invoice ${number} attached.`,
        attachments: [{ filename: `${number}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
    },
    [NIGHTLY_EVENT]: () =>
      runNightlyMaintenance(logger, store, (email) =>
        transport.sendMail({ from: runtime().EMAIL_FROM, ...email }),
      ),
    [DOCUMENT_UPLOADED_EVENT]: async (event) => {
      if (scanner) {
        await scanDocument(event.companyId, (event.payload as Payload).id, store, scanner);
      }
    },
    [SANCTIONS_IMPORTED_EVENT]: async (event) => {
      await rescreenAllParties(new Types.ObjectId(event.companyId));
    },
    'purchase.posted': screen('PURCHASE_POSTED'),
    'payment.posted': screen('PAYMENT_POSTED'),
  };
}
