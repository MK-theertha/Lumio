import type { Model } from 'mongoose';
import mongoose from 'mongoose';
import '../../modules/access/index.js';
import '../../modules/compliance/index.js';
import '../../modules/finance/index.js';
import '../../modules/identity/identity.models.js';
import '../../modules/inventory/inventory.models.js';
import '../../modules/ledger/ledger.models.js';
import '../../modules/master/index.js';
import '../../modules/organisation/organisation.models.js';
import '../../modules/platform/audit/index.js';
import '../../modules/platform/idempotency/index.js';
import '../../modules/platform/numbering/index.js';
import '../../modules/platform/outbox/index.js';
import '../../modules/pricing/index.js';
import '../../modules/tax/index.js';
import '../../modules/trade/trade.models.js';
import type { Migration } from './runner.js';

async function createCollectionsAndIndexes(): Promise<void> {
  for (const model of Object.values(mongoose.models) as Model<unknown>[]) {
    if (model.modelName.startsWith('Test')) continue;
    await model.createCollection();
    await model.createIndexes();
  }
}

/** Append only. Never edit a migration that has shipped. */
export const migrations: Migration[] = [
  { id: '001-kernel-indexes', up: createCollectionsAndIndexes },
  { id: '002-domain-collections', up: createCollectionsAndIndexes },
];
