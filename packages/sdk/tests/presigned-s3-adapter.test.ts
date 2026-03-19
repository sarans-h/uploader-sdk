// @vitest-environment node

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createPresignedS3Adapter } from '../presigned-s3-adapter';

const storage = new Map<string, string>();
const localStorageMock = {
  getItem(key: string): string | null {
    return storage.has(key) ? (storage.get(key) as string) : null;
  },
  setItem(key: string, value: string): void {
    storage.set(key, value);
  },
  removeItem(key: string): void {
    storage.delete(key);
  },
  clear(): void {
    storage.clear();
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  configurable: true,
});

type Session = {
  uploadId: string;
  key: string;
  parts: Array<{ PartNumber: number; ETag: string }>;
};

type Counters = {
  presign: number;
  start: number;
  signPart: number;
  listParts: number;
  complete: number;
  abort: number;
  verify: number;
  download: number;
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function startMockApi() {
  const counters: Counters = {
    presign: 0,
    start: 0,
    signPart: 0,
    listParts: 0,
    complete: 0,
    abort: 0,
    verify: 0,
    download: 0,
  };

  const sessions = new Map<string, Session>();
  let sessionCounter = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'POST' && url.pathname === '/api/presign') {
      counters.presign += 1;
      return json(res, 200, {
        assetId: 'asset-simple',
        key: 'uploads/simple-file',
        uploadUrl: 'http://upload.local/simple',
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/multipart/start') {
      counters.start += 1;
      const body = await readJson(req);
      sessionCounter += 1;
      const uploadId = `upload-${sessionCounter}`;
      const key = `uploads/multipart-${sessionCounter}`;
      sessions.set(uploadId, {
        uploadId,
        key,
        parts: [],
      });
      const size = Number(body.size || 0);
      const partSize = Number(body.partSize || 5 * 1024 * 1024);
      const totalParts = Math.max(1, Math.ceil(size / partSize));
      return json(res, 200, {
        assetId: `asset-${uploadId}`,
        key,
        uploadId,
        partSize,
        totalParts,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/multipart/sign-part') {
      counters.signPart += 1;
      const body = await readJson(req);
      const uploadId = String(body.uploadId || '');
      const partNumber = Number(body.partNumber || 1);
      return json(res, 200, {
        uploadUrl: `http://upload.local/part?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/multipart/parts') {
      counters.listParts += 1;
      const uploadId = url.searchParams.get('uploadId') || '';
      const session = sessions.get(uploadId);
      return json(res, 200, {
        parts: session?.parts || [],
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/multipart/complete') {
      counters.complete += 1;
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/multipart/abort') {
      counters.abort += 1;
      const body = await readJson(req);
      const uploadId = String(body.uploadId || '');
      sessions.delete(uploadId);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/verify') {
      counters.verify += 1;
      return json(res, 200, { verified: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/download-url') {
      counters.download += 1;
      return json(res, 200, { url: 'https://download.local/file' });
    }

    return json(res, 404, { error: 'not-found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  return {
    apiBaseUrl,
    counters,
    sessions,
    recordPart(uploadId: string, partNumber: number, etag: string) {
      const session = sessions.get(uploadId);
      if (!session) return;
      const existing = session.parts.find((p) => p.PartNumber === partNumber);
      if (existing) {
        existing.ETag = etag;
      } else {
        session.parts.push({ PartNumber: partNumber, ETag: etag });
      }
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('PresignedS3Adapter integration', () => {
  it('covers simple upload contract endpoints', async () => {
    const mock = await startMockApi();
    try {
      const adapter = createPresignedS3Adapter({
        apiBaseUrl: mock.apiBaseUrl,
        multipartThresholdBytes: 1024,
      });

      (adapter as any).putWithProgress = async () => '"etag-simple"';

      const result = await adapter.uploadFile(new File(['hello'], 'simple.txt', { type: 'text/plain' }), {
        fileId: 'simple::1::5',
        onProgress: () => undefined,
      });

      expect(result.url).toContain('download.local');
      expect(mock.counters.presign).toBe(1);
      expect(mock.counters.verify).toBe(1);
      expect(mock.counters.download).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it('covers multipart start/sign/list/complete plus abort cleanup', async () => {
    const mock = await startMockApi();
    try {
      const adapter = createPresignedS3Adapter({
        apiBaseUrl: mock.apiBaseUrl,
        multipartThresholdBytes: 1,
        multipartPartSizeBytes: 5 * 1024 * 1024,
      });

      (adapter as any).putWithProgress = async ({ url }: { url: string }) => {
        const parsed = new URL(url);
        const uploadId = parsed.searchParams.get('uploadId') || '';
        const partNumber = Number(parsed.searchParams.get('partNumber') || '1');
        mock.recordPart(uploadId, partNumber, `"etag-${partNumber}"`);
        return null;
      };

      const file = new File(['multipart-content'], 'large.bin', { type: 'application/octet-stream' });
      const fileId = `${file.name}::${file.lastModified}::${file.size}`;

      const result = await adapter.uploadFile(file, {
        fileId,
        onProgress: () => undefined,
      });

      expect(result.url).toContain('download.local');
      expect(mock.counters.start).toBe(1);
      expect(mock.counters.signPart).toBeGreaterThanOrEqual(1);
      expect(mock.counters.listParts).toBeGreaterThanOrEqual(1);
      expect(mock.counters.complete).toBe(1);
      expect(mock.counters.verify).toBe(1);
      expect(mock.counters.download).toBe(1);

      const cleanupFileId = 'cleanup-file-id';
      localStorage.setItem(
        `upload-sdk-mpu:${cleanupFileId}`,
        JSON.stringify({
          assetId: 'asset-cleanup',
          key: 'uploads/cleanup',
          uploadId: 'upload-cleanup',
          partSize: 5 * 1024 * 1024,
          totalParts: 1,
          fileName: 'cleanup.bin',
          size: 123,
          lastModified: Date.now(),
          completedParts: [],
        })
      );

      await adapter.cleanupUploadSession(cleanupFileId, { reason: 'final-failure' });
      expect(mock.counters.abort).toBe(1);
    } finally {
      await mock.close();
    }
  });
});
