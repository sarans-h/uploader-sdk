export type UploadResult = {
  url: string;
  assetId?: string;
  key?: string;
  verified?: boolean;
};

export type UploadErrorCode =
  | 'ADAPTER_NOT_FOUND'
  | 'UPLOAD_ABORTED'
  | 'UPLOAD_CANCELED'
  | 'UPLOAD_FAILED'
  | 'INDEXEDDB_ERROR';

export type UploadError = Error & {
  code: UploadErrorCode;
  retriable?: boolean;
  cause?: unknown;
};

export interface StorageAdapter {
  uploadFile(file: File, options?: Record<string, unknown>): Promise<string | UploadResult>;
  cleanupUploadSession?: (
    fileId: string,
    meta?: { reason: 'canceled' | 'final-failure' }
  ) => Promise<void>;
}

export type ExtensionRules = {
  allowExtensions?: string[];
};

export type UploadOptions = {
  parallel?: number;
  retry?: number;
  retryDelayMs?: number;
  onProgress?: (progress: number, fileName: string, meta?: { fileId: string }) => void;
  onRetry?: (
    error: UploadError,
    fileName: string,
    meta: { attempt: number; maxRetries: number; fileId: string }
  ) => void;
  onError?: (error: UploadError, fileName: string, meta?: { fileId: string }) => void;
  onFinalError?: (error: UploadError, fileName: string, meta?: { fileId: string }) => void;
  onComplete?: (fileName: string, url: string, meta?: { fileId: string }) => void;
  onCompleteDetailed?: (fileName: string, result: UploadResult, meta?: { fileId: string }) => void;
};

type StoredRecord = {
  id: string;
  name: string;
  type: string;
  lastModified: number;
  data: ArrayBuffer;
  size: number;
};

const DEFAULT_DB_NAME = 'upload_sdk_db';
const DEFAULT_STORE_NAME = 'files';

export function createUploadError(
  code: UploadErrorCode,
  message: string,
  options?: { retriable?: boolean; cause?: unknown }
): UploadError {
  const err = new Error(message) as UploadError;
  err.code = code;
  err.retriable = options?.retriable;
  err.cause = options?.cause;
  return err;
}

export class UploadSDK {
  private adapters: Map<string, StorageAdapter> = new Map();
  private dbName: string;
  private storeName: string;
  private allowExtensions: Set<string> | null = null;
  private pausedFileIds: Set<string> = new Set();
  private canceledFileIds: Set<string> = new Set();
  private activeControllers: Map<string, AbortController> = new Map();

  constructor(config?: { dbName?: string; storeName?: string }) {
    this.dbName = config?.dbName ?? DEFAULT_DB_NAME;
    this.storeName = config?.storeName ?? DEFAULT_STORE_NAME;
  }

  registerAdapter(name: string, adapter: StorageAdapter): void {
    this.adapters.set(name, adapter);
  }

  setExtensionRules(rules: ExtensionRules): void {
    this.allowExtensions = rules.allowExtensions
      ? new Set(rules.allowExtensions.map((ext) => this.normalizeExtension(ext)))
      : null;
  }

  pauseUpload(fileId: string): void {
    this.pausedFileIds.add(fileId);
    const controller = this.activeControllers.get(fileId);
    if (controller) {
      controller.abort();
    }
  }

  resumeUpload(fileId: string): void {
    this.pausedFileIds.delete(fileId);
  }

  async cancelUpload(fileId: string): Promise<void> {
    this.canceledFileIds.add(fileId);
    this.pausedFileIds.delete(fileId);
    const controller = this.activeControllers.get(fileId);
    if (controller) {
      controller.abort();
    }
    await this.cleanupAllAdapterSessions(fileId, 'canceled');
    await this.removeStoredFileById(fileId);
  }

  async saveFilesToIndexedDB(files: File[]): Promise<{ saved: string[]; rejected: string[] }> {
    const saved: string[] = [];
    const rejected: string[] = [];
    const recordsToWrite: StoredRecord[] = [];

    for (const file of files) {
      if (!this.isFileAllowed(file.name)) {
        rejected.push(file.name);
        continue;
      }

      const data = await file.arrayBuffer();
      const id = this.buildFileId(file);
      const record: StoredRecord = {
        id,
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        data,
        size: file.size,
      };

      recordsToWrite.push(record);
      saved.push(file.name);
    }

    if (!recordsToWrite.length) {
      return { saved, rejected };
    }

    const db = await this.openDB();
    const tx = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);

    for (const record of recordsToWrite) {
      await this.requestToPromise(store.put(record));
    }

    await this.txComplete(tx);
    db.close();
    return { saved, rejected };
  }

  async listStoredFiles(): Promise<Array<{ id: string; name: string; size: number; type: string }>> {
    const db = await this.openDB();
    const tx = db.transaction(this.storeName, 'readonly');
    const store = tx.objectStore(this.storeName);
    const records = (await this.requestToPromise(store.getAll())) as StoredRecord[];
    await this.txComplete(tx);
    db.close();

    return records.map((r) => ({ id: r.id, name: r.name, size: r.size, type: r.type }));
  }

  async clearStoredFiles(): Promise<void> {
    const db = await this.openDB();
    const tx = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);
    await this.requestToPromise(store.clear());
    await this.txComplete(tx);
    db.close();
  }

  async uploadFiles(adapterName: string, options: UploadOptions = {}): Promise<void> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw createUploadError('ADAPTER_NOT_FOUND', `Adapter not found: ${adapterName}`);
    }

    const db = await this.openDB();
    const tx = db.transaction(this.storeName, 'readonly');
    const store = tx.objectStore(this.storeName);
    const records = (await this.requestToPromise(store.getAll())) as StoredRecord[];
    await this.txComplete(tx);
    db.close();

    const files = await this.prepareUploadItems(records, options);

    await this.uploadWithConcurrency(files, adapter, options);
  }

  async uploadSelectedFiles(
    adapterName: string,
    fileIds: string[],
    options: UploadOptions = {}
  ): Promise<void> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw createUploadError('ADAPTER_NOT_FOUND', `Adapter not found: ${adapterName}`);
    }

    if (!fileIds.length) {
      return;
    }

    const idSet = new Set(fileIds);
    const db = await this.openDB();
    const tx = db.transaction(this.storeName, 'readonly');
    const store = tx.objectStore(this.storeName);
    const records = (await this.requestToPromise(store.getAll())) as StoredRecord[];
    await this.txComplete(tx);
    db.close();

    const selectedRecords = records.filter((record) => idSet.has(record.id));
    const files = await this.prepareUploadItems(selectedRecords, options);

    await this.uploadWithConcurrency(files, adapter, options);
  }

  private async uploadWithConcurrency(
    items: Array<{ id: string; file: File }>,
    adapter: StorageAdapter,
    options: UploadOptions
  ): Promise<void> {
    const parallel = Math.max(1, options.parallel ?? 3);
    const retry = Math.max(0, options.retry ?? 2);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 300);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) {
          return;
        }

        const item = items[current];
        if (this.canceledFileIds.has(item.id)) {
          continue;
        }

        const canProceed = await this.waitIfPaused(item.id);
        if (!canProceed || this.canceledFileIds.has(item.id)) {
          continue;
        }

        await this.uploadSingleWithRetry(item.id, item.file, adapter, retry, retryDelayMs, options);
        await this.removeStoredFileById(item.id);
        this.canceledFileIds.delete(item.id);
      }
    };

    const workers = Array.from({ length: Math.min(parallel, items.length) }, () => worker());
    await Promise.all(workers);
  }

  private async uploadSingleWithRetry(
    fileId: string,
    file: File,
    adapter: StorageAdapter,
    retry: number,
    retryDelayMs: number,
    options: UploadOptions
  ): Promise<void> {
    let attempts = 0;
    while (attempts <= retry) {
      if (this.canceledFileIds.has(fileId)) {
        return;
      }

      const canProceed = await this.waitIfPaused(fileId);
      if (!canProceed) {
        return;
      }

      const controller = new AbortController();
      this.activeControllers.set(fileId, controller);
      try {
        // Mark file as started before network progress events arrive.
        options.onProgress?.(0, file.name, { fileId });

        let reportedByAdapter = false;
        const reportProgress = (progress: number) => {
          reportedByAdapter = true;
          const bounded = Math.max(0, Math.min(100, progress));
          options.onProgress?.(bounded, file.name, { fileId });
        };

        const adapterResult = await adapter.uploadFile(file, {
          fileId,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          signal: controller.signal,
          attempt: attempts,
          onProgress: reportProgress,
        });
        const normalized: UploadResult =
          typeof adapterResult === 'string'
            ? { url: adapterResult }
            : {
                url: adapterResult.url,
                assetId: adapterResult.assetId,
                key: adapterResult.key,
                verified: adapterResult.verified,
              };
        if (!reportedByAdapter) {
          options.onProgress?.(100, file.name, { fileId });
        } else {
          // Ensure final state is always 100 even if adapter reports a lower terminal value.
          options.onProgress?.(100, file.name, { fileId });
        }
        options.onComplete?.(file.name, normalized.url, { fileId });
        options.onCompleteDetailed?.(file.name, normalized, { fileId });
        return;
      } catch (error) {
        const aborted = this.isAbortError(error);
        const pausedAbort = this.pausedFileIds.has(fileId) && this.isAbortError(error);
        if (pausedAbort) {
          // Do not consume retries for deliberate pause interruption.
          continue;
        }

        const canceledAbort = this.canceledFileIds.has(fileId) && aborted;
        if (canceledAbort) {
          // Cancellation is user-intentional; do not retry or report as error.
          return;
        }

        attempts += 1;
        const err = this.normalizeUploadError(error);
        const willRetry = attempts <= retry;
        if (willRetry) {
          options.onRetry?.(err, file.name, {
            attempt: attempts,
            maxRetries: retry,
            fileId,
          });
        } else {
          await this.cleanupAdapterSession(adapter, fileId, 'final-failure');
          options.onFinalError?.(err, file.name, { fileId });
          options.onError?.(err, file.name, { fileId });
          throw err;
        }
        await this.sleep(retryDelayMs);
      } finally {
        this.activeControllers.delete(fileId);
      }
    }
  }

  private async waitIfPaused(fileId: string): Promise<boolean> {
    while (this.pausedFileIds.has(fileId)) {
      if (this.canceledFileIds.has(fileId)) {
        return false;
      }
      await this.sleep(150);
    }
    return true;
  }

  private async prepareUploadItems(
    records: StoredRecord[],
    options: UploadOptions
  ): Promise<Array<{ id: string; file: File }>> {
    const items: Array<{ id: string; file: File }> = [];

    for (const record of records) {
      items.push({
        id: record.id,
        file: new File([record.data], record.name, {
          type: record.type,
          lastModified: record.lastModified,
        }),
      });
    }

    return items;
  }

  private async removeStoredFileById(id: string): Promise<void> {
    const db = await this.openDB();
    const tx = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);
    await this.requestToPromise(store.delete(id));
    await this.txComplete(tx);
    db.close();
  }

  private isFileAllowed(fileName: string): boolean {
    const ext = this.extractExtension(fileName);
    if (!ext) {
      return this.allowExtensions === null;
    }

    if (this.allowExtensions && !this.allowExtensions.has(ext)) {
      return false;
    }

    return true;
  }

  private extractExtension(fileName: string): string | null {
    const idx = fileName.lastIndexOf('.');
    if (idx < 0 || idx === fileName.length - 1) {
      return null;
    }
    return this.normalizeExtension(fileName.slice(idx + 1));
  }

  private normalizeExtension(ext: string): string {
    return ext.replace(/^\./, '').trim().toLowerCase();
  }

  private buildFileId(_file: File): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) {
      return uuid;
    }
    return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    });
  }

  private requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  private txComplete(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const maybe = error as { name?: string };
    return maybe.name === 'AbortError';
  }

  private normalizeUploadError(error: unknown): UploadError {
    if (error && typeof error === 'object' && 'code' in (error as Record<string, unknown>)) {
      return error as UploadError;
    }

    if (this.isAbortError(error)) {
      return createUploadError('UPLOAD_ABORTED', 'Upload aborted', {
        retriable: false,
        cause: error,
      });
    }

    const message =
      error && typeof error === 'object' && 'message' in (error as Record<string, unknown>)
        ? String((error as { message?: unknown }).message || 'Upload failed')
        : 'Upload failed';
    return createUploadError('UPLOAD_FAILED', message, {
      retriable: true,
      cause: error,
    });
  }

  private async cleanupAdapterSession(
    adapter: StorageAdapter,
    fileId: string,
    reason: 'canceled' | 'final-failure'
  ): Promise<void> {
    if (!adapter.cleanupUploadSession) {
      return;
    }
    try {
      await adapter.cleanupUploadSession(fileId, { reason });
    } catch {
      // Cleanup is best-effort and should not mask primary upload errors.
    }
  }

  private async cleanupAllAdapterSessions(
    fileId: string,
    reason: 'canceled' | 'final-failure'
  ): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const adapter of this.adapters.values()) {
      tasks.push(this.cleanupAdapterSession(adapter, fileId, reason));
    }
    await Promise.all(tasks);
  }
}

export type UploadClient = UploadSDK;

export function createUploadClient(config?: { dbName?: string; storeName?: string }): UploadClient {
  return new UploadSDK(config);
}

export function registerStorageAdapter(
  client: UploadClient,
  name: string,
  adapter: StorageAdapter
): void {
  client.registerAdapter(name, adapter);
}

export function setFileExtensionRules(client: UploadClient, rules: ExtensionRules): void {
  client.setExtensionRules(rules);
}

export async function addFiles(
  client: UploadClient,
  files: File[]
): Promise<{ saved: string[]; rejected: string[] }> {
  return client.saveFilesToIndexedDB(files);
}

export async function listFiles(
  client: UploadClient
): Promise<Array<{ id: string; name: string; size: number; type: string }>> {
  return client.listStoredFiles();
}

export async function clearFiles(client: UploadClient): Promise<void> {
  await client.clearStoredFiles();
}

export async function uploadFiles(
  client: UploadClient,
  adapterName: string,
  options: UploadOptions = {}
): Promise<void> {
  await client.uploadFiles(adapterName, options);
}

export async function uploadSelectedFiles(
  client: UploadClient,
  adapterName: string,
  fileIds: string[],
  options: UploadOptions = {}
): Promise<void> {
  await client.uploadSelectedFiles(adapterName, fileIds, options);
}

export function pauseFileUpload(client: UploadClient, fileId: string): void {
  client.pauseUpload(fileId);
}

export function resumeFileUpload(client: UploadClient, fileId: string): void {
  client.resumeUpload(fileId);
}

export async function cancelFileUpload(client: UploadClient, fileId: string): Promise<void> {
  await client.cancelUpload(fileId);
}
