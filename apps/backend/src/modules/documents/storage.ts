import { connect } from 'node:net';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Env } from '../../config/env.js';

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

type StoreConfig = Pick<
  Env,
  | 'NODE_ENV'
  | 'S3_ENDPOINT'
  | 'S3_REGION'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
>;

/** Private S3-compatible storage. Objects are only ever reached through the API. */
export function createObjectStore(config: StoreConfig): ObjectStore {
  const client = new S3Client({
    region: config.S3_REGION,
    // Self-hosted stores address buckets by path and may not support newer checksum headers.
    ...(config.S3_ENDPOINT
      ? {
          endpoint: config.S3_ENDPOINT,
          forcePathStyle: true,
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  const Bucket = config.S3_BUCKET;
  const canCreateBucket = config.NODE_ENV !== 'production' && config.NODE_ENV !== 'staging';

  const put = (key: string, body: Buffer, contentType: string) =>
    client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));

  return {
    async put(key, body, contentType) {
      try {
        await put(key, body, contentType);
      } catch (error) {
        // Local stores start empty. Production buckets are provisioned with their policies.
        if (!canCreateBucket || (error as Error).name !== 'NoSuchBucket') throw error;
        await client.send(new CreateBucketCommand({ Bucket }));
        await put(key, body, contentType);
      }
    },
    async get(key) {
      const object = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!object.Body) throw new Error('Stored object has no body');
      return Buffer.from(await object.Body.transformToByteArray());
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

export interface MalwareScanner {
  scan(data: Buffer): Promise<ScanResult>;
}

const CHUNK = 64 * 1024;
const SCAN_TIMEOUT_MS = 60_000;

/** Speaks clamd's INSTREAM protocol. Anything other than a clear verdict rejects, so it is retried. */
export function clamavScanner(host: string, port: number): MalwareScanner {
  return {
    scan: (data) =>
      new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const replies: Buffer[] = [];
        socket.setTimeout(SCAN_TIMEOUT_MS, () => {
          socket.destroy(new Error('Malware scanner timed out'));
        });
        socket.on('error', reject);
        socket.on('data', (part) => replies.push(part));
        socket.on('end', () => {
          const reply = Buffer.concat(replies).toString('utf8').replace(/\0/g, '').trim();
          if (reply.endsWith('OK')) {
            resolve({ clean: true });
            return;
          }
          const found = /^.*?:\s*(.+)\s+FOUND$/.exec(reply);
          if (found?.[1]) resolve({ clean: false, signature: found[1] });
          else reject(new Error('Malware scanner gave no verdict'));
        });
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          for (let offset = 0; offset < data.length; offset += CHUNK) {
            const chunk = data.subarray(offset, offset + CHUNK);
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            socket.write(size);
            socket.write(chunk);
          }
          socket.write(Buffer.alloc(4));
        });
      }),
  };
}
