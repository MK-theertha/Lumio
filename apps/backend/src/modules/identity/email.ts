import type { TransactionalContext } from '../../shared/context.js';
import { encrypt } from '../../shared/crypto.js';
import { enqueueEvent } from '../platform/outbox/index.js';

export const EMAIL_EVENT = 'email.send';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Emails can hold single-use links, so the outbox stores them encrypted. */
export function enqueueEmail(tx: TransactionalContext, message: EmailMessage): Promise<void> {
  return enqueueEvent(tx, EMAIL_EVENT, { sealed: encrypt(JSON.stringify(message)) });
}
