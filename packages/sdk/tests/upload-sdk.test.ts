import {
  addFiles,
  cancelFileUpload,
  clearFiles,
  createUploadClient,
  createUploadError,
  listFiles,
  registerStorageAdapter,
  setFileExtensionRules,
  uploadFiles,
  uploadSelectedFiles,
} from '../index';

describe('UploadSDK core flows', () => {
  const makeClient = () =>
    createUploadClient({
      dbName: `sdk-test-db-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      storeName: 'files',
    });

  const makeFile = (name: string, body: string, type = 'text/plain') =>
    new File([body], name, {
      type,
      lastModified: Date.now(),
    });

  it('adds files and lists staged records', async () => {
    const client = makeClient();

    const result = await addFiles(client, [
      makeFile('a.txt', 'hello'),
      makeFile('b.txt', 'world'),
    ]);

    expect(result.saved).toEqual(['a.txt', 'b.txt']);
    expect(result.rejected).toEqual([]);

    const stored = await listFiles(client);
    expect(stored).toHaveLength(2);
    expect(stored.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('stages duplicate files with unique ids', async () => {
    const client = makeClient();

    const same1 = new File(['same'], 'dup.txt', {
      type: 'text/plain',
      lastModified: 1700000000000,
    });
    const same2 = new File(['same'], 'dup.txt', {
      type: 'text/plain',
      lastModified: 1700000000000,
    });

    const result = await addFiles(client, [same1, same2]);
    expect(result.saved).toEqual(['dup.txt', 'dup.txt']);
    expect(result.rejected).toEqual([]);

    const stored = await listFiles(client);
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((f) => f.id)).size).toBe(2);
  });

  it('enforces allow-list extension rules', async () => {
    const client = makeClient();

    setFileExtensionRules(client, {
      allowExtensions: ['jpg', 'png', 'pdf'],
    });

    const result = await addFiles(client, [
      makeFile('ok.jpg', 'ok', 'image/jpeg'),
      makeFile('blocked.exe', 'nope', 'application/octet-stream'),
      makeFile('not-allowed.txt', 'nope', 'text/plain'),
    ]);

    expect(result.saved).toEqual(['ok.jpg']);
    expect(result.rejected).toEqual(['blocked.exe', 'not-allowed.txt']);

    const stored = await listFiles(client);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('ok.jpg');
  });

  it('retries failed upload and removes file after success', async () => {
    const client = makeClient();
    const attemptsByName: Record<string, number> = {};

    registerStorageAdapter(client, 'mock', {
      async uploadFile(file, options = {}) {
        const name = file.name;
        attemptsByName[name] = (attemptsByName[name] || 0) + 1;
        const attempt = Number((options as { attempt?: number }).attempt || 0);
        if (attempt < 2) {
          throw new Error(`attempt-${attempt}-failed`);
        }
        return `https://example.com/${encodeURIComponent(name)}`;
      },
    });

    await addFiles(client, [makeFile('retry.txt', 'payload')]);

    const progressEvents: number[] = [];
    const finalErrors: string[] = [];
    const retries: Array<{ attempt: number; maxRetries: number }> = [];
    const completed: string[] = [];

    await uploadFiles(client, 'mock', {
      retry: 3,
      retryDelayMs: 1,
      onProgress: (progress) => progressEvents.push(progress),
      onRetry: (_error, _fileName, meta) => retries.push(meta),
      onError: (error) => finalErrors.push(error.message),
      onComplete: (fileName) => completed.push(fileName),
    });

    expect(attemptsByName['retry.txt']).toBe(3);
    expect(retries).toEqual([
      expect.objectContaining({ attempt: 1, maxRetries: 3 }),
      expect.objectContaining({ attempt: 2, maxRetries: 3 }),
    ]);
    expect(finalErrors).toEqual([]);
    expect(completed).toEqual(['retry.txt']);
    expect(progressEvents.some((p) => p >= 100)).toBe(true);

    const remaining = await listFiles(client);
    expect(remaining).toHaveLength(0);
  });

  it('uploads selected ids only', async () => {
    const client = makeClient();
    const uploaded: string[] = [];

    registerStorageAdapter(client, 'mock', {
      async uploadFile(file) {
        uploaded.push(file.name);
        return `https://example.com/${encodeURIComponent(file.name)}`;
      },
    });

    await addFiles(client, [
      makeFile('one.txt', '1'),
      makeFile('two.txt', '2'),
    ]);

    const staged = await listFiles(client);
    const target = staged.find((f) => f.name === 'two.txt');
    expect(target).toBeDefined();

    await uploadSelectedFiles(client, 'mock', [target!.id], {
      retry: 0,
    });

    expect(uploaded).toEqual(['two.txt']);

    const remaining = await listFiles(client);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('one.txt');

    await clearFiles(client);
  });

  it('emits final error once after retries are exhausted', async () => {
    const client = makeClient();
    registerStorageAdapter(client, 'mock', {
      async uploadFile() {
        throw createUploadError('UPLOAD_FAILED', 'always-fails');
      },
    });

    await addFiles(client, [makeFile('fail.txt', 'payload')]);

    const retries: number[] = [];
    const finalErrors: string[] = [];

    await expect(
      uploadFiles(client, 'mock', {
        retry: 2,
        retryDelayMs: 1,
        onRetry: (_error, _fileName, meta) => retries.push(meta.attempt),
        onError: (error) => finalErrors.push(error.message),
      })
    ).rejects.toThrow('always-fails');

    expect(retries).toEqual([1, 2]);
    expect(finalErrors).toEqual(['always-fails']);
  });

  it('runs adapter cleanup session on cancel', async () => {
    const client = makeClient();
    const cleaned: string[] = [];
    registerStorageAdapter(client, 'mock', {
      async uploadFile(file) {
        return `https://example.com/${encodeURIComponent(file.name)}`;
      },
      async cleanupUploadSession(fileId) {
        cleaned.push(fileId);
      },
    });

    await addFiles(client, [makeFile('cleanup.txt', 'payload')]);
    const staged = await listFiles(client);
    await cancelFileUpload(client, staged[0].id);

    expect(cleaned).toEqual([staged[0].id]);
    const remaining = await listFiles(client);
    expect(remaining).toHaveLength(0);
  });
});
