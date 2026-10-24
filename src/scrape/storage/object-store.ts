import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Minimal blob storage used for specs and run results. */
export interface ObjectStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
  /** Binary objects such as screenshots. */
  putBinary(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Writes only when the key does not exist; returns false if it did. */
  putIfAbsent(key: string, body: string): Promise<boolean>;
}

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, string>();
  readonly binaries = new Map<
    string,
    { body: Uint8Array; contentType: string }
  >();

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: string) {
    this.objects.set(key, body);
  }
  async putBinary(key: string, body: Uint8Array, contentType: string) {
    this.binaries.set(key, { body, contentType });
  }
  async putIfAbsent(key: string, body: string) {
    if (this.objects.has(key)) return false;
    this.objects.set(key, body);
    return true;
  }
}

export class LocalFileObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('invalid key');
    return full;
  }

  async get(key: string) {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async put(key: string, body: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  async putBinary(key: string, body: Uint8Array) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  async putIfAbsent(key: string, body: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async get(key: string) {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (await out.Body?.transformToString('utf-8')) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }
  async put(key: string, body: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    );
  }
  async putBinary(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
  async putIfAbsent(key: string, body: string) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 412 || status === 409) return false;
      throw error;
    }
  }
}
