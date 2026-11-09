import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer } from 'testcontainers';

/** Integration tests run against a real replica set and real Redis, never mocks. */
export default async function setup(): Promise<() => Promise<void>> {
  const [mongo, redis] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);

  process.env.TEST_MONGODB_URI = `${mongo.getConnectionString()}/lumio_test?directConnection=true&replicaSet=rs0`;
  process.env.TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  return async () => {
    await Promise.all([mongo.stop(), redis.stop()]);
  };
}
