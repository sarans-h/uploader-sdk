import type { StorageAdapter, UploadResult } from './index';

export type PresignedS3AdapterConfig = {
  apiBaseUrl: string;
  multipartThresholdBytes?: number;
  multipartPartSizeBytes?: number;
};

type MultipartSession = {
  assetId: string;
  key: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  fileName: string;
  size: number;
  lastModified: number;
  completedParts: Array<{ PartNumber: number; ETag: string }>;
};

type UploadRuntimeOptions = {
  fileId?: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
};

export class PresignedS3Adapter implements StorageAdapter {
  private apiBaseUrl: string;
  private multipartThresholdBytes: number;
  private multipartPartSizeBytes: number;

  constructor(config: PresignedS3AdapterConfig) {
    this.apiBaseUrl = config.apiBaseUrl;
    this.multipartThresholdBytes =
      typeof config.multipartThresholdBytes === 'number' && config.multipartThresholdBytes > 0
        ? config.multipartThresholdBytes
        : 20 * 1024 * 1024;
    this.multipartPartSizeBytes =
      typeof config.multipartPartSizeBytes === 'number' && config.multipartPartSizeBytes >= 5 * 1024 * 1024
        ? config.multipartPartSizeBytes
        : 8 * 1024 * 1024;
  }

  async uploadFile(file: File, options: UploadRuntimeOptions = {}): Promise<UploadResult> {
    const fileId = options.fileId || `${file.name}::${file.lastModified}::${file.size}`;
    const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const signal = options.signal;

    if (file.size >= this.multipartThresholdBytes) {
      return this.uploadMultipart(file, fileId, report, signal);
    }

    return this.uploadSimple(file, report, signal);
  }

  async cleanupUploadSession(
    fileId: string,
    _meta: { reason: 'canceled' | 'final-failure' } = { reason: 'canceled' }
  ): Promise<void> {
    const session = this.loadSession(fileId);
    if (!session?.key || !session?.uploadId) {
      this.clearSession(fileId);
      return;
    }

    const aborted = await this.abortMultipartWithRetry(session.key, session.uploadId);
    if (aborted) {
      this.clearSession(fileId);
      return;
    }

    // Keep session so cleanup can be retried later if abort endpoint was unreachable.
    throw new Error('Failed to abort multipart session after retries');
  }

  private async abortMultipartWithRetry(key: string, uploadId: string): Promise<boolean> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${this.apiBaseUrl}/api/multipart/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, uploadId }),
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Network/transient failure; retry below.
      }

      if (attempt < maxAttempts) {
        const delayMs = 250 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  private async uploadSimple(
    file: File,
    report: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<UploadResult> {
    report(0);

    const presign = await fetch(`${this.apiBaseUrl}/api/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      }),
    });

    if (!presign.ok) {
      const data = await presign.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to get signed URL');
    }

    const { assetId, uploadUrl, key } = await presign.json();

    await this.putWithProgress({
      url: uploadUrl,
      body: file,
      contentType: file.type || 'application/octet-stream',
      signal,
      onProgress: (loaded, total) => {
        if (total > 0) {
          report((loaded / total) * 100);
        }
      },
    });

    const verifyResp = await fetch(`${this.apiBaseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId,
        key,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
      }),
    });

    if (!verifyResp.ok) {
      const data = await verifyResp.json().catch(() => ({}));
      throw new Error(data.error || 'Verification failed');
    }

    const verifyData = await verifyResp.json();
    if (!verifyData.verified) {
      throw new Error('Uploaded object verification failed (HEAD mismatch)');
    }

    const downloadResp = await fetch(
      `${this.apiBaseUrl}/api/download-url?key=${encodeURIComponent(key)}&assetId=${encodeURIComponent(assetId)}`
    );
    if (!downloadResp.ok) {
      const data = await downloadResp.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to get download URL');
    }
    const downloadData = await downloadResp.json();

    report(100);

    return {
      url: downloadData.url,
      assetId,
      key,
      verified: true,
    };
  }

  private getSessionKey(fileId: string): string {
    return `upload-sdk-mpu:${fileId}`;
  }

  private loadSession(fileId: string): MultipartSession | null {
    try {
      const raw = localStorage.getItem(this.getSessionKey(fileId));
      return raw ? (JSON.parse(raw) as MultipartSession) : null;
    } catch {
      return null;
    }
  }

  private saveSession(fileId: string, session: MultipartSession): void {
    localStorage.setItem(this.getSessionKey(fileId), JSON.stringify(session));
  }

  private clearSession(fileId: string): void {
    localStorage.removeItem(this.getSessionKey(fileId));
  }

  private computeUploadedBytes(fileSize: number, partSize: number, completedPartNumbers: Set<number>): number {
    let bytes = 0;
    for (const partNumber of completedPartNumbers) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, fileSize);
      bytes += Math.max(0, end - start);
    }
    return bytes;
  }

  private async uploadMultipart(
    file: File,
    fileId: string,
    report: (progress: number) => void,
    signal?: AbortSignal
  ): Promise<UploadResult> {
    let session = this.loadSession(fileId);

    if (
      session &&
      (session.fileName !== file.name || session.size !== file.size || session.lastModified !== file.lastModified)
    ) {
      this.clearSession(fileId);
      session = null;
    }

    if (!session) {
      const startResp = await fetch(`${this.apiBaseUrl}/api/multipart/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          partSize: this.multipartPartSizeBytes,
        }),
      });

      if (!startResp.ok) {
        const data = await startResp.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start multipart upload');
      }

      const started = await startResp.json();
      session = {
        assetId: started.assetId,
        key: started.key,
        uploadId: started.uploadId,
        partSize: started.partSize,
        totalParts: started.totalParts,
        fileName: file.name,
        size: file.size,
        lastModified: file.lastModified,
        completedParts: [],
      };
      this.saveSession(fileId, session);
    } else {
      const listResp = await fetch(
        `${this.apiBaseUrl}/api/multipart/parts?key=${encodeURIComponent(session.key)}&uploadId=${encodeURIComponent(
          session.uploadId
        )}`
      );
      if (listResp.ok) {
        const listed = await listResp.json();
        const remote = Array.isArray(listed.parts) ? listed.parts : [];
        const partMap = new Map<number, { PartNumber: number; ETag: string }>();
        for (const part of session.completedParts || []) {
          partMap.set(part.PartNumber, part);
        }
        for (const part of remote) {
          if (part.PartNumber && part.ETag) {
            partMap.set(part.PartNumber, { PartNumber: part.PartNumber, ETag: part.ETag });
          }
        }
        session.completedParts = Array.from(partMap.values()).sort((a, b) => a.PartNumber - b.PartNumber);
        this.saveSession(fileId, session);
      }
    }

    const completedNumbers = new Set((session.completedParts || []).map((p) => p.PartNumber));
    let uploadedBytes = this.computeUploadedBytes(file.size, session.partSize, completedNumbers);
    report((uploadedBytes / file.size) * 100);

    for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
      if (completedNumbers.has(partNumber)) {
        continue;
      }

      const signResp = await fetch(`${this.apiBaseUrl}/api/multipart/sign-part`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: session.key,
          uploadId: session.uploadId,
          partNumber,
        }),
      });

      if (!signResp.ok) {
        const data = await signResp.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to sign multipart part');
      }

      const { uploadUrl } = await signResp.json();

      const start = (partNumber - 1) * session.partSize;
      const end = Math.min(start + session.partSize, file.size);
      const chunk = file.slice(start, end);

      const baseUploaded = uploadedBytes;
      let etag = await this.putWithProgress({
        url: uploadUrl,
        body: chunk,
        signal,
        onProgress: (loaded, total) => {
          const partTotal = total > 0 ? total : chunk.size;
          const progressed = Math.min(partTotal, loaded);
          report(((baseUploaded + progressed) / file.size) * 100);
        },
      });

      if (!etag) {
        etag = await this.waitForPartEtag(session.key, session.uploadId, partNumber);
      }

      if (!etag) {
        throw new Error(`Missing ETag for uploaded part ${partNumber}. Add ETag to S3 CORS ExposeHeaders.`);
      }

      session.completedParts.push({ PartNumber: partNumber, ETag: etag });
      session.completedParts.sort((a, b) => a.PartNumber - b.PartNumber);
      this.saveSession(fileId, session);

      uploadedBytes += end - start;
      report((uploadedBytes / file.size) * 100);
    }

    const completeResp = await fetch(`${this.apiBaseUrl}/api/multipart/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: session.assetId,
        key: session.key,
        uploadId: session.uploadId,
        parts: session.completedParts,
      }),
    });

    if (!completeResp.ok) {
      const data = await completeResp.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to complete multipart upload');
    }

    const verifyResp = await fetch(`${this.apiBaseUrl}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: session.assetId,
        key: session.key,
        size: file.size,
        contentType: file.type || 'application/octet-stream',
      }),
    });

    if (!verifyResp.ok) {
      const data = await verifyResp.json().catch(() => ({}));
      throw new Error(data.error || 'Verification failed');
    }
    const verifyData = await verifyResp.json();
    if (!verifyData.verified) {
      throw new Error('Uploaded object verification failed (HEAD mismatch)');
    }

    const downloadResp = await fetch(
      `${this.apiBaseUrl}/api/download-url?key=${encodeURIComponent(session.key)}&assetId=${encodeURIComponent(
        session.assetId
      )}`
    );
    if (!downloadResp.ok) {
      const data = await downloadResp.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to get download URL');
    }
    const downloadData = await downloadResp.json();

    this.clearSession(fileId);
    report(100);

    return {
      url: downloadData.url,
      assetId: session.assetId,
      key: session.key,
      verified: true,
    };
  }

  private async waitForPartEtag(key: string, uploadId: string, partNumber: number): Promise<string | null> {
    const attempts = 6;
    for (let i = 0; i < attempts; i += 1) {
      const etag = await this.fetchPartEtag(key, uploadId, partNumber);
      if (etag) {
        return etag;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return null;
  }

  private async fetchPartEtag(key: string, uploadId: string, partNumber: number): Promise<string | null> {
    const listResp = await fetch(
      `${this.apiBaseUrl}/api/multipart/parts?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`
    );
    if (!listResp.ok) {
      return null;
    }
    const data = await listResp.json().catch(() => ({}));
    const parts = Array.isArray(data.parts) ? data.parts : [];
    const found = parts.find((p: { PartNumber: number; ETag?: string }) => Number(p.PartNumber) === Number(partNumber));
    return found && found.ETag ? found.ETag : null;
  }

  private putWithProgress({
    url,
    body,
    contentType,
    signal,
    onProgress,
  }: {
    url: string;
    body: Blob;
    contentType?: string;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);

      const extractEtag = () => {
        const headers = xhr.getAllResponseHeaders() || '';
        const lines = headers.split(/\r?\n/);
        for (const line of lines) {
          const idx = line.indexOf(':');
          if (idx < 0) continue;
          const key = line.slice(0, idx).trim().toLowerCase();
          if (key === 'etag') {
            return line.slice(idx + 1).trim();
          }
        }
        return null;
      };

      if (contentType) {
        xhr.setRequestHeader('Content-Type', contentType);
      }

      xhr.upload.onprogress = (event) => {
        if (onProgress) {
          onProgress(event.loaded || 0, event.total || body.size || 0);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = extractEtag();
          resolve(etag);
          return;
        }
        reject(new Error(`S3 upload failed (${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => {
        const abortErr = new Error('Upload aborted');
        (abortErr as Error & { name: string }).name = 'AbortError';
        reject(abortErr);
      };

      if (signal) {
        if (signal.aborted) {
          xhr.abort();
        } else {
          const onAbort = () => xhr.abort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      xhr.send(body);
    });
  }
}

export function createPresignedS3Adapter(config: PresignedS3AdapterConfig): PresignedS3Adapter {
  return new PresignedS3Adapter(config);
}
