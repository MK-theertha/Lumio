import { MongoDBContainer } from '@testcontainers/mongodb';
import { GenericContainer, Wait } from 'testcontainers';

/** Integration tests run against a real replica set and real Redis, never mocks. */
export default async function setup(): Promise<() => Promise<void>> {
  const [mongo, redis, objectStore] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new GenericContainer('chrislusf/seaweedfs:latest')
      .withCommand(['server', '-dir=/data', '-s3', '-s3.port=8333'])
      .withEnvironment({ AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' })
      .withExposedPorts(8333)
      // An unsigned request is refused, which shows the store is up and enforcing credentials.
      .withWaitStrategy(Wait.forHttp('/', 8333).forStatusCode(403).withStartupTimeout(120_000))
      .start(),
  ]);

  process.env.TEST_MONGODB_URI = `${mongo.getConnectionString()}/lumio_test?directConnection=true&replicaSet=rs0`;
  process.env.TEST_REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.TEST_S3_ENDPOINT = `http://${objectStore.getHost()}:${objectStore.getMappedPort(8333)}`;

  return async () => {
    await Promise.all([mongo.stop(), redis.stop(), objectStore.stop()]);
  };
}
