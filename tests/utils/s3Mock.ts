/**
 * Mock AWS S3 for testing
 * This replaces actual S3 calls with in-memory storage
 */

interface MockS3Object {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  uploadedAt: Date;
}

interface DeletedObject {
  bucket: string;
  key: string;
  deletedAt: Date;
}

class MockS3 {
  private storage: Map<string, MockS3Object> = new Map();
  private deletedObjects: DeletedObject[] = [];

  /**
   * Generate storage key
   */
  private getKey(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  /**
   * Upload object (mock)
   */
  async putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    const storageKey = this.getKey(bucket, key);
    this.storage.set(storageKey, {
      bucket,
      key,
      body,
      contentType,
      uploadedAt: new Date(),
    });
  }

  /**
   * Get object (mock)
   */
  async getObject(bucket: string, key: string): Promise<Buffer | null> {
    const storageKey = this.getKey(bucket, key);
    const obj = this.storage.get(storageKey);
    return obj ? obj.body : null;
  }

  /**
   * Delete object (mock) - tracks deletion
   */
  async deleteObject(bucket: string, key: string): Promise<void> {
    const storageKey = this.getKey(bucket, key);
    const obj = this.storage.get(storageKey);
    
    if (obj) {
      // Track deletion
      this.deletedObjects.push({
        bucket,
        key,
        deletedAt: new Date(),
      });
    }
    
    this.storage.delete(storageKey);
  }

  /**
   * Check if object exists
   */
  async objectExists(bucket: string, key: string): Promise<boolean> {
    const storageKey = this.getKey(bucket, key);
    return this.storage.has(storageKey);
  }

  /**
   * Check if object was deleted
   */
  wasDeleted(bucket: string, key: string): boolean {
    return this.deletedObjects.some(
      (deleted) => deleted.bucket === bucket && deleted.key === key
    );
  }

  /**
   * Get deletion history for a key
   */
  getDeletionHistory(bucket: string, key: string): DeletedObject | undefined {
    return this.deletedObjects.find(
      (deleted) => deleted.bucket === bucket && deleted.key === key
    );
  }

  /**
   * Get all deleted objects
   */
  getAllDeletedObjects(): DeletedObject[] {
    return [...this.deletedObjects];
  }

  /**
   * Clear all objects and deletion history (for test cleanup)
   */
  clear(): void {
    this.storage.clear();
    this.deletedObjects = [];
  }

  /**
   * Get all objects for a bucket
   */
  listObjects(bucket: string): MockS3Object[] {
    return Array.from(this.storage.values()).filter(obj => obj.bucket === bucket);
  }

  /**
   * Get object count for a bucket
   */
  getObjectCount(bucket: string): number {
    return this.listObjects(bucket).length;
  }
}

export const mockS3 = new MockS3();

/**
 * Mock S3 client methods
 */
export function mockS3Client() {
  const originalModule = require('../../src/utils/s3');
  
  jest.spyOn(originalModule, 'uploadToS3').mockImplementation(
    async (...args: unknown[]) => {
      const [bucketType, key, buffer, mimeType] = args as [string, string, Buffer, string];
      const bucket = bucketType === 'receipts' ? 'test-receipts-bucket' : 'test-exports-bucket';
      await mockS3.putObject(bucket, key, buffer, mimeType);
    }
  );

  jest.spyOn(originalModule, 'getObjectUrl').mockImplementation(
    (...args: unknown[]) => {
      const [bucketType, key] = args as [string, string];
      const bucket = bucketType === 'receipts' ? 'test-receipts-bucket' : 'test-exports-bucket';
      return `https://${bucket}.s3.amazonaws.com/${key}`;
    }
  );
}

/**
 * Reset S3 mocks
 */
export function resetS3Mocks(): void {
  mockS3.clear();
  jest.restoreAllMocks();
}
