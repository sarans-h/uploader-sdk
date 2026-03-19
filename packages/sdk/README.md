# uploader-sdk

Browser upload SDK for React and web apps with IndexedDB staging, adapter-driven transport, parallel uploads, retries, pause/resume/cancel, and progress callbacks.

This README is written for teams adopting the SDK in production. It explains:

- What the SDK does and does not do
- What your team must manage
- Tradeoffs of the current architecture
- Operational and reliability guidance

## Install

```bash
npm install uploader-sdk
```

## TL;DR

- Use this SDK when you want upload orchestration in the browser.
- Keep auth, authorization, and storage policy in your upload service API.
- Use the built-in presigned S3 adapter or provide your own adapter.

## Current Version Scope

- Built-in provider support in this version is Amazon S3 using presigned URL flows.
- The included adapter (`uploader-sdk/adapters/presigned-s3`) expects service endpoints that issue presigned URLs for simple and multipart uploads.
- The SDK core is provider-agnostic, but non-S3 providers require your own custom adapter implementation.
- This package does not include direct server-side upload execution; uploads are performed by the browser to storage using service-issued signed URLs.

## Responsibility Model

### SDK responsibilities

- Stage files in IndexedDB.
- Enforce extension allow-list rules.
- Run concurrent uploads with retry support.
- Expose progress and lifecycle callbacks.
- Support pause, resume, cancel, and selected uploads.
- Trigger adapter cleanup on cancel or final failure.

### Upload service responsibilities

- Authenticate callers and authorize upload scope.
- Issue signed URLs or upload tokens.
- Validate file metadata and policy constraints.
- Verify object existence and integrity.
- Keep audit logs and operational metrics.
- Manage storage lifecycle (retention, deletion, compliance).

### Integrator responsibilities

- Build UX and business flow around the SDK.
- Configure retry and concurrency for your traffic profile.
- Decide extension allow-list policy.
- Handle callback-driven UI state and user messaging.
- Protect credentials and never expose service secrets in frontend code.

## Security Boundary

- The SDK is auth-agnostic by design.
- Authentication and authorization must be enforced by your upload service API.
- Signing credentials must stay on the server side.
- Do not commit real credentials to source control.

## Architecture Summary

High-level flow:

1. User selects files in browser.
2. SDK stages files in IndexedDB and returns staged metadata.
3. SDK starts uploads via selected adapter.
4. Adapter communicates with your upload service API.
5. Service API signs/transacts with storage provider.
6. SDK reports progress/retry/error/complete events.
7. SDK removes staged data on success or cancel.

## Tradeoffs and Design Decisions

### IndexedDB staging

Pros:

- Works for large files and queued uploads.
- Survives page-level state loss better than in-memory queues.

Tradeoffs:

- Browser quota limits apply.
- Data remains local until cleared.
- Some browser environments (private mode, strict policies) may reduce reliability.

### Adapter abstraction

Pros:

- Storage-provider agnostic SDK core.
- Easier to keep provider-specific logic outside business UI code.

Tradeoffs:

- Integrators must implement and maintain adapter semantics correctly.
- Runtime behavior quality depends on adapter implementation.

### Client retries

Pros:

- Better resilience to transient failures.

Tradeoffs:

- Can amplify backend load if too aggressive.
- Requires sane retry delay and concurrency limits.

### Allow-list only extension policy

Pros:

- Simple mental model and safer default when configured.

Tradeoffs:

- Files without an extension are rejected when allow-list is active.
- MIME spoofing is still possible; server-side validation remains mandatory.

## Quick Start (Core API)

```ts
import {
  createUploadClient,
  registerStorageAdapter,
  setFileExtensionRules,
  addFiles,
  uploadFiles,
} from 'uploader-sdk';

const client = createUploadClient();

registerStorageAdapter(client, 'custom', {
  async uploadFile(file, options = {}) {
    // Call your upload service signing + upload flow here.
    // Return URL string or detailed UploadResult.
    return 'https://example.com/files/' + encodeURIComponent(file.name);
  },
});

setFileExtensionRules(client, {
  allowExtensions: ['jpg', 'png', 'pdf'],
});

await addFiles(client, selectedFiles);

await uploadFiles(client, 'custom', {
  parallel: 3,
  retry: 5,
  retryDelayMs: 2000,
  onProgress: (progress, fileName) => {
    console.log(fileName, progress);
  },
  onRetry: (error, fileName, meta) => {
    console.log('retry', fileName, meta.attempt, meta.maxRetries, error.message);
  },
  onComplete: (fileName, url) => {
    console.log('uploaded', fileName, url);
  },
  onError: (error, fileName) => {
    console.error('failed', fileName, error.code, error.message);
  },
});
```

## React Hook

Import from subpaths:

```ts
import { useUploader } from 'uploader-sdk/react';
import { createPresignedS3Adapter } from 'uploader-sdk/adapters/presigned-s3';
```

```tsx
import { useUploader } from 'uploader-sdk/react';
import { createPresignedS3Adapter } from 'uploader-sdk/adapters/presigned-s3';

function UploadWidget() {
  const uploader = useUploader({
    adapterName: 's3',
    adapter: createPresignedS3Adapter({
      apiBaseUrl: 'http://localhost:8787',
      multipartThresholdBytes: 20 * 1024 * 1024,
      multipartPartSizeBytes: 8 * 1024 * 1024,
    }),
    defaultUploadOptions: {
      parallel: 3,
      retry: 5,
      retryDelayMs: 2000,
    },
    rules: {
      allowExtensions: ['jpg', 'png', 'pdf'],
    },
  });

  return (
    <>
      <input
        type="file"
        multiple
        onChange={async (e) => {
          const selected = Array.from(e.target.files || []);
          await uploader.addFiles(selected);
          e.target.value = '';
        }}
      />
      <button onClick={() => void uploader.uploadAll()} disabled={uploader.isUploading}>
        Upload All
      </button>
    </>
  );
}
```

Hook return shape:

- client
- files
- statusById
- logs
- isUploading
- refresh()
- addFiles(files)
- clearFiles()
- uploadAll(options?)
- uploadSelected(fileIds, options?)
- pause(fileId)
- resume(fileId)
- cancel(fileId)
- setRules(rules)

## Adapter Contract

Required adapter method:

```ts
interface StorageAdapter {
  uploadFile(file: File, options?: Record<string, unknown>): Promise<string | UploadResult>;
}
```

Optional adapter method:

```ts
cleanupUploadSession?(fileId: string, meta?: { reason: 'canceled' | 'final-failure' }): Promise<void>;
```

Current packaged adapter:

- `uploader-sdk/adapters/presigned-s3` (S3 presigned URL strategy)

Common runtime options passed to adapter:

- fileId
- fileName
- fileSize
- fileType
- signal (AbortSignal)
- attempt
- onProgress(progress: number)

## Extension Rules

- If allowExtensions is provided, only those extensions are accepted.
- If allowExtensions is omitted, all extensions are accepted.

## Public API Surface

- createUploadClient(config?)
- registerStorageAdapter(client, name, adapter)
- setFileExtensionRules(client, rules)
- addFiles(client, files)
- listFiles(client)
- clearFiles(client)
- uploadFiles(client, adapterName, options?)
- uploadSelectedFiles(client, adapterName, fileIds, options?)
- pauseFileUpload(client, fileId)
- resumeFileUpload(client, fileId)
- cancelFileUpload(client, fileId)

## Error Model and Retry Semantics

Error codes:

- ADAPTER_NOT_FOUND
- UPLOAD_ABORTED
- UPLOAD_CANCELED
- UPLOAD_FAILED
- INDEXEDDB_ERROR

Retry behavior:

- onRetry fires for non-final failures.
- onError and onFinalError fire only after retries are exhausted.
- Pause-triggered abort does not consume retry budget.
- Cancel-triggered abort is treated as user intent and not surfaced as failure.

## Cancellation and Local Data Semantics

On cancel:

- Staged file is removed from IndexedDB.
- Adapter cleanup is invoked (best effort).
- For multipart uploads, local session metadata is removed when abort succeeds.
- If abort cannot be confirmed, session metadata may be retained for retryable cleanup.

## Operational Tuning Guidance

Recommended starting points:

- parallel: 2 to 4 for browser clients.
- retry: 3 to 5 for unstable networks.
- retryDelayMs: 500 to 2000 depending on backend limits.
- multipartPartSizeBytes: 8 MB to 16 MB for large uploads.

Tune with production metrics:

- Upload success rate
- P95/P99 upload latency
- Retry distribution
- 4xx vs 5xx failure split
- Abort cleanup success rate

## What Developers Must Manage

Frontend/app team:

- UX state, messaging, and retry affordances.
- File picker constraints and UX limits.
- Accessibility and localization of upload UI.

Service/backend team:

- AuthN/AuthZ
- Signing and storage policy
- CORS policy for upload endpoints
- Malware/content scanning if required
- Data retention and deletion lifecycle
- Compliance controls and auditability

SRE/platform team:

- Error budgets and alerting
- Capacity/rate limiting
- Incident runbooks
- Secret rotation and key hygiene

## Backend Contract v1 (for built-in presigned S3 adapter)

The managed upload service should expose:

1. POST /api/presign
Request:
- fileName: string
- contentType: string
- size: number
Response:
- assetId: string
- key: string
- uploadUrl: string

2. POST /api/multipart/start
Request:
- fileName: string
- contentType: string
- size: number
- partSize: number
Response:
- assetId: string
- key: string
- uploadId: string
- partSize: number
- totalParts: number

3. POST /api/multipart/sign-part
Request:
- key: string
- uploadId: string
- partNumber: number
Response:
- uploadUrl: string

4. GET /api/multipart/parts
Query:
- key: string
- uploadId: string
Response:
- parts: Array<{ PartNumber: number; ETag: string; Size?: number }>

5. POST /api/multipart/complete
Request:
- assetId: string
- key: string
- uploadId: string
- parts: Array<{ PartNumber: number; ETag: string }>
Response:
- assetId: string | null
- key: string
- etag?: string

6. POST /api/multipart/abort
Request:
- key: string
- uploadId: string
Response:
- ok: true

7. POST /api/verify
Request:
- assetId: string
- key: string
- size: number
- contentType: string
Response:
- verified: boolean

8. GET /api/download-url
Query:
- key: string
- assetId: string
Response:
- url: string

## Failure Modes You Should Expect

- User closes tab mid-upload.
- Network flaps during multipart part transfer.
- Signed URL expiry during slow uploads.
- CORS misconfiguration blocking ETag visibility.
- Service unavailable during abort cleanup.

Plan for these with retries, user messaging, and operational alerts.

## Testing Strategy

Local CI checks:

- npm run test:ci
- npm run release:check

Optional live integration against real service and S3:

```bash
LIVE_S3_INTEGRATION=1 LIVE_API_BASE_URL=http://localhost:8787 npm run test:live
```

Live check validates:

- /health availability
- end-to-end simple upload contract
- multipart abort cleanup path

By default npm run test:live is a no-op unless LIVE_S3_INTEGRATION=1 is set.

## Package Contents

Published package includes:

- dist/*
- README.md
- package.json

Source, app demo, backend example, tests, scripts, and .env are not part of published artifacts.

## Notes

- This package is browser-oriented and uses IndexedDB.
- Signing, auth, and storage policy belong to your managed upload service.
- Keep secrets server-side and rotate credentials if they are ever exposed.
