// Creates the application's database user. Run once per environment with mongosh as an admin:
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
];
target.createRole({
  role: 'lumioApp',
  privileges: [
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
  ],
  roles: [],
});
target.createUser({
  user: process.env.APP_USER,
  pwd: process.env.APP_PASSWORD,
  roles: [{ role: 'lumioApp', db: dbName }],
});
