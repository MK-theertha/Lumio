import mongoose from 'mongoose';
import type { Logger } from '../../../shared/logger.js';
import { OutboxEventModel } from './outbox.model.js';

export interface PublishableEvent {
  id: string;
  companyId: string;
  type: string;
  payload: unknown;
  correlationId: string;
}

export type Publisher = (event: PublishableEvent) => Promise<void>;

export interface RelayOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  lockMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

/**
 * Moves committed outbox rows to the queue. Claims are atomic, so several relays can run safely.
 * A crash mid-publish releases when the lock expires; delivery is at-least-once and consumers
 * deduplicate on the event id.
 */
export class OutboxRelay {
  private readonly options: Required<RelayOptions>;
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly publish: Publisher,
    private readonly logger: Logger,
    options: RelayOptions = {},
  ) {
    this.options = {
      batchSize: 100,
      pollIntervalMs: 1000,
      lockMs: 60_000,
      maxAttempts: 8,
      baseBackoffMs: 1000,
      ...options,
    };
  }

  /** Processes one batch and returns how many events were claimed. */
  async tick(): Promise<number> {
    let processed = 0;
    while (processed < this.options.batchSize) {
      const event = await this.claimNext();
      if (!event) break;
      processed += 1;
      await this.deliver(event);
    }
    return processed;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.tick();
        if (processed > 0) continue;
      } catch (error) {
        this.logger.error({ err: error }, 'Outbox relay tick failed');
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs));
    }
  }

  private claimNext() {
    const now = new Date();
    return OutboxEventModel.findOneAndUpdate(
      {
        $or: [
          { status: 'PENDING', nextAttemptAt: mongoose.trusted({ $lte: now }) },
          { status: 'PROCESSING', lockedUntil: mongoose.trusted({ $lte: now }) },
        ],
      },
      {
        $set: { status: 'PROCESSING', lockedUntil: new Date(now.getTime() + this.options.lockMs) },
        $inc: { attempts: 1 },
      },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    ).lean();
  }

  private async deliver(
    event: NonNullable<Awaited<ReturnType<OutboxRelay['claimNext']>>>,
  ): Promise<void> {
    try {
      await this.publish({
        id: event._id.toString(),
        companyId: event.companyId.toString(),
        type: event.type,
        payload: event.payload,
        correlationId: event.correlationId,
      });
      await OutboxEventModel.updateOne(
        { _id: event._id },
        { $set: { status: 'PUBLISHED', processedAt: new Date() }, $unset: { lockedUntil: 1 } },
      );
    } catch (error) {
      await this.recordFailure(event._id, event.attempts, error);
    }
  }

  private async recordFailure(
    id: mongoose.Types.ObjectId,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const exhausted = attempts >= this.options.maxAttempts;
    const delay = this.options.baseBackoffMs * 2 ** (attempts - 1);
    const lastError = error instanceof Error ? error.message : String(error);
    await OutboxEventModel.updateOne(
      { _id: id },
      {
        $set: {
          status: exhausted ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(Date.now() + delay),
          lastError,
        },
        $unset: { lockedUntil: 1 },
      },
    );
    const log = { eventId: id.toString(), attempts, err: error };
    if (exhausted) this.logger.error(log, 'Outbox event permanently failed');
    else this.logger.warn(log, 'Outbox publish failed; will retry');
  }
}
