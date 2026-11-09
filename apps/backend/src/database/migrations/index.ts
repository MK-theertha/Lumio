import { SYSTEM_ROLES } from '@lumio/shared-types';
import type { Model } from 'mongoose';
import mongoose from 'mongoose';
import '../../modules/access/index.js';
import '../../modules/compliance/index.js';
import '../../modules/documents/index.js';
import '../../modules/einvoice/index.js';
import '../../modules/finance/index.js';
import '../../modules/goaml/index.js';
import '../../modules/identity/identity.models.js';
import '../../modules/maintenance/index.js';
import '../../modules/notifications/index.js';
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
import { RoleModel } from '../../modules/access/index.js';
import { CompanyModel } from '../../modules/organisation/index.js';
import type { Migration } from './runner.js';

async function createCollectionsAndIndexes(): Promise<void> {
  for (const model of Object.values(mongoose.models) as Model<unknown>[]) {
    if (model.modelName.startsWith('Test')) continue;
    await model.createCollection();
    await model.createIndexes();
  }
}

const ADDED_RESOURCES = ['document', 'sanctions', 'goaml', 'einvoice', 'bank_reconciliation'];

/** Grants only what is new, so roles a company has narrowed stay narrowed. */
async function addComplianceDocumentAndBankPermissions(): Promise<void> {
  const companies = await CompanyModel.find().select({ _id: 1 }).lean();
  for (const company of companies) {
    for (const [name, permissions] of Object.entries(SYSTEM_ROLES)) {
      const isNewRole = name === 'Compliance Officer';
      const granted = isNewRole
        ? [...permissions]
        : permissions.filter((p) => ADDED_RESOURCES.includes(p.split(':')[0] as string));
      await RoleModel.updateOne(
        { companyId: company._id, name },
        { $addToSet: { permissions: { $each: granted } }, $setOnInsert: { isSystem: true } },
        { upsert: isNewRole },
      );
    }
  }
}

/** Matches gained a subject, so the old uniqueness rule would now reject beneficial owners. */
async function replaceSanctionsMatchIndex(): Promise<void> {
  const collection = mongoose.connection.collection('sanctionsMatches');
  const name = 'companyId_1_partyId_1_source_1_externalId_1';
  if ((await collection.indexes()).some((index) => index.name === name)) {
    await collection.dropIndex(name);
  }
  await createCollectionsAndIndexes();
}

/** Append only. Never edit a migration that has shipped. */
export const migrations: Migration[] = [
  { id: '001-kernel-indexes', up: createCollectionsAndIndexes },
  { id: '002-domain-collections', up: createCollectionsAndIndexes },
  { id: '003-documents-sanctions-goaml-einvoice-bank', up: createCollectionsAndIndexes },
  { id: '004-new-role-permissions', up: addComplianceDocumentAndBankPermissions },
  { id: '005-sanctions-subject-and-maintenance', up: replaceSanctionsMatchIndex },
];
