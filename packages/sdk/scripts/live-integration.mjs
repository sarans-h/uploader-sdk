import { createPresignedS3Adapter } from '../dist/presigned-s3-adapter.js';

const apiBaseUrl = process.env.LIVE_API_BASE_URL || 'http://localhost:8787';
const enabled = process.env.LIVE_S3_INTEGRATION === '1';

if (!enabled) {
  console.log('Skipping live S3 integration. Set LIVE_S3_INTEGRATION=1 to run.');
  process.exit(0);
}

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(String(key), String(value));
    },
    removeItem: (key) => {
      store.delete(String(key));
    },
    clear: () => {
      store.clear();
    },
  };
}

async function assertOk(response, label) {
  if (response.ok) return;
  const data = await response.text().catch(() => '');
  throw new Error(`${label} failed: ${response.status} ${data}`);
}

async function run() {
  const health = await fetch(`${apiBaseUrl}/health`);
  await assertOk(health, 'health');

  const adapter = createPresignedS3Adapter({
    apiBaseUrl,
    multipartThresholdBytes: 1,
    multipartPartSizeBytes: 5 * 1024 * 1024,
  });

  // Simple object upload + verify + download-url contract via adapter.
  const smallFile = new File([new Blob(['live-integration'])], 'live-small.txt', {
    type: 'text/plain',
    lastModified: Date.now(),
  });
  const result = await adapter.uploadFile(smallFile, {
    fileId: `live-small-${Date.now()}`,
    onProgress: () => {},
  });

  if (!result?.url || !result?.key || !result?.verified) {
    throw new Error('Simple upload did not return expected result contract');
  }

  // Multipart start + cleanup abort path validation.
  const startResp = await fetch(`${apiBaseUrl}/api/multipart/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: 'live-abort.bin',
      contentType: 'application/octet-stream',
      size: 10 * 1024 * 1024,
      partSize: 5 * 1024 * 1024,
    }),
  });
  await assertOk(startResp, 'multipart start');
  const started = await startResp.json();

  const cleanupFileId = `live-cleanup-${Date.now()}`;
  globalThis.localStorage.setItem(
    `upload-sdk-mpu:${cleanupFileId}`,
    JSON.stringify({
      assetId: started.assetId,
      key: started.key,
      uploadId: started.uploadId,
      partSize: started.partSize,
      totalParts: started.totalParts,
      fileName: 'live-abort.bin',
      size: 10 * 1024 * 1024,
      lastModified: Date.now(),
      completedParts: [],
    })
  );

  await adapter.cleanupUploadSession(cleanupFileId, { reason: 'canceled' });

  const listedAfterAbort = await fetch(
    `${apiBaseUrl}/api/multipart/parts?key=${encodeURIComponent(started.key)}&uploadId=${encodeURIComponent(started.uploadId)}`
  );

  if (listedAfterAbort.ok) {
    const partsData = await listedAfterAbort.json().catch(() => ({}));
    if (Array.isArray(partsData.parts) && partsData.parts.length > 0) {
      throw new Error('Multipart cleanup did not abort session as expected');
    }
  }

  console.log('Live S3 integration checks passed.');
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
