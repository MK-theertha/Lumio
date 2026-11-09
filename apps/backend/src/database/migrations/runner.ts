import mongoose from 'mongoose';
import type { Logger } from '../../shared/logger.js';

export interface Migration {
  /** Permanent, ordered identifier such as "001-kernel-indexes". */
  id: string;
  up(db: mongoose.mongo.Db): Promise<void>;
}

const CHANGELOG = 'migrations';
const LOCK_ID = '__lock__';
const STALE_LOCK_MS = 30 * 60 * 1000;

/** Applies pending migrations in order, once each. A lock stops two deployments racing. */
export async function runMigrations(migrations: Migration[], logger: Logger): Promise<string[]> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB is not connected');
  const changelog = db.collection<{ _id: string; appliedAt: Date }>(CHANGELOG);

  await acquireLock(changelog);
  try {
    const applied: string[] = [];
    for (const migration of migrations) {
      if (await changelog.findOne({ _id: migration.id })) continue;
      logger.info({ migration: migration.id }, 'Applying migration');
      await migration.up(db);
      await changelog.insertOne({ _id: migration.id, appliedAt: new Date() });
      applied.push(migration.id);
    }
    return applied;
  } finally {
    await changelog.deleteOne({ _id: LOCK_ID });
  }
}

async function acquireLock(
  changelog: mongoose.mongo.Collection<{ _id: string; appliedAt: Date }>,
): Promise<void> {
  await changelog.deleteOne({
    _id: LOCK_ID,
    appliedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) },
  });
  try {
    await changelog.insertOne({ _id: LOCK_ID, appliedAt: new Date() });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
      throw new Error('Another migration run is in progress', { cause: error });
    }
    throw error;
  }
}
