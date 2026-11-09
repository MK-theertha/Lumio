// Creates or refreshes the application's database role. Run after migrations with mongosh as an admin:
//   mongosh "$ADMIN_URI" --file infrastructure/mongo/create-app-user.js
// Set APP_DB, APP_USER and APP_PASSWORD in the environment.
// Posted records stay immutable even if application code has a bug: this user can never change them.
const dbName = process.env.APP_DB;
const target = db.getSiblingDB(dbName);
const appendOnly = [
  'journalEntries',
  'journalLines',
  'stockMovements',
  'paymentAllocations',
  'taxTransactions',
  'goldRates',
  'auditLogs',
  'loginHistory',
  'partyActivities',
  'metalTransactions',
  'auditSeals',
  'integrityRuns',
  'vatReturns',
];
const privileges = [
  ...target
    .getCollectionNames()
    .filter((name) => !appendOnly.includes(name))
    .map((collection) => ({
      resource: { db: dbName, collection },
      actions: ['find', 'insert', 'update', 'remove'],
    })),
  ...appendOnly.map((collection) => ({
    resource: { db: dbName, collection },
    actions: ['find', 'insert'],
  })),
];
// MongoDB grants per collection, so this must run again after any migration adds a collection.
// It is safe to repeat: an existing role is refreshed and an existing user is left alone.
if (target.getRole('lumioApp')) target.updateRole('lumioApp', { privileges, roles: [] });
else target.createRole({ role: 'lumioApp', privileges, roles: [] });
if (!target.getUser(process.env.APP_USER)) {
  target.createUser({
    user: process.env.APP_USER,
    pwd: process.env.APP_PASSWORD,
    roles: [{ role: 'lumioApp', db: dbName }],
  });
}
