import mongoose from 'mongoose';

// Filters containing "$" operators must be wrapped explicitly with mongoose.trusted(), so a
// user-supplied object can never become a query operator.
mongoose.set('sanitizeFilter', true);
mongoose.set('strictQuery', true);
// Indexes are created by migrations under a deploy-time credential, never at application start.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, {
    maxPoolSize: 50,
    retryWrites: true,
    writeConcern: { w: 'majority' },
    serverSelectionTimeoutMS: 10_000,
  });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export async function pingDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB is not connected');
  await db.admin().ping();
}
