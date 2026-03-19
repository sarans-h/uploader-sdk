import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addFiles as sdkAddFiles,
  cancelFileUpload,
  clearFiles as sdkClearFiles,
  createUploadClient,
  listFiles as sdkListFiles,
  pauseFileUpload,
  registerStorageAdapter,
  resumeFileUpload,
  setFileExtensionRules,
  uploadFiles as sdkUploadFiles,
  uploadSelectedFiles as sdkUploadSelectedFiles,
} from './index';
import type { StorageAdapter, UploadClient, UploadOptions } from './index';

export type HookFileInfo = {
  id: string;
  name: string;
  size: number;
  type: string;
};

export type UploadState = 'pending' | 'queued' | 'uploading' | 'paused' | 'uploaded' | 'failed' | 'retrying';

export type HookFileStatus = {
  state: UploadState;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  error?: string;
  retryAttempt?: number;
  maxRetries?: number;
};

export type UploaderRules = {
  allowExtensions?: string[];
};

export type UseUploaderConfig = {
  adapterName: string;
  adapter?: StorageAdapter;
  dbName?: string;
  storeName?: string;
  rules?: UploaderRules;
  defaultUploadOptions?: Pick<UploadOptions, 'parallel' | 'retry' | 'retryDelayMs'>;
  autoRefreshOnMount?: boolean;
};

export type UseUploaderResult = {
  client: UploadClient;
  files: HookFileInfo[];
  statusById: Record<string, HookFileStatus>;
  logs: string[];
  isUploading: boolean;
  refresh: () => Promise<HookFileInfo[]>;
  addFiles: (files: File[]) => Promise<{ saved: string[]; rejected: string[] }>;
  clearFiles: () => Promise<void>;
  uploadAll: (options?: UploadOptions) => Promise<void>;
  uploadSelected: (fileIds: string[], options?: UploadOptions) => Promise<void>;
  pause: (fileId: string) => void;
  resume: (fileId: string) => void;
  cancel: (fileId: string) => Promise<void>;
  setRules: (rules: UploaderRules) => void;
};

function mergeUploadOptions(
  defaults: Pick<UploadOptions, 'parallel' | 'retry' | 'retryDelayMs'> | undefined,
  overrides: UploadOptions | undefined
): UploadOptions {
  return {
    parallel: overrides?.parallel ?? defaults?.parallel ?? 3,
    retry: overrides?.retry ?? defaults?.retry ?? 2,
    retryDelayMs: overrides?.retryDelayMs ?? defaults?.retryDelayMs ?? 300,
  };
}

function buildStatus(
  state: UploadState,
  progress: number,
  totalBytes: number,
  error?: string,
  retryMeta?: { attempt: number; maxRetries: number }
): HookFileStatus {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(progress) ? progress : 0));
  const safeTotal = Math.max(0, Number.isFinite(totalBytes) ? totalBytes : 0);
  const uploadedBytes = safeTotal > 0 ? Math.round((bounded / 100) * safeTotal) : 0;
  return {
    state,
    progress: bounded,
    uploadedBytes,
    totalBytes: safeTotal,
    error,
    retryAttempt: retryMeta?.attempt,
    maxRetries: retryMeta?.maxRetries,
  };
}

export function useUploader(config: UseUploaderConfig): UseUploaderResult {
  const [files, setFiles] = useState<HookFileInfo[]>([]);
  const [statusById, setStatusById] = useState<Record<string, HookFileStatus>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [pausedById, setPausedById] = useState<Record<string, boolean>>({});
  const pausedByIdRef = useRef<Record<string, boolean>>({});

  const client = useMemo(
    () =>
      createUploadClient({
        dbName: config.dbName,
        storeName: config.storeName,
      }),
    [config.dbName, config.storeName]
  );

  const log = useCallback((message: string) => {
    setLogs((prev) => [...prev, message]);
  }, []);

  useEffect(() => {
    pausedByIdRef.current = pausedById;
  }, [pausedById]);

  useEffect(() => {
    if (config.adapter) {
      registerStorageAdapter(client, config.adapterName, config.adapter);
    }
  }, [client, config.adapterName, config.adapter]);

  useEffect(() => {
    if (config.rules) {
      setFileExtensionRules(client, {
        allowExtensions: config.rules.allowExtensions,
      });
    }
  }, [client, config.rules]);

  const refresh = useCallback(async () => {
    const stored = (await sdkListFiles(client)) as HookFileInfo[];
    setFiles(stored);

    setStatusById((prev) => {
      const next = { ...prev };
      for (const f of stored) {
        if (!next[f.id]) {
          next[f.id] = buildStatus('pending', 0, f.size);
        } else {
          next[f.id] = {
            ...next[f.id],
            totalBytes: f.size,
          };
        }
      }

      for (const id of Object.keys(next)) {
        if (!stored.find((f) => f.id === id)) {
          delete next[id];
        }
      }
      return next;
    });

    setPausedById((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (!stored.find((f) => f.id === id)) {
          delete next[id];
        }
      }
      return next;
    });

    return stored;
  }, [client]);

  useEffect(() => {
    if (config.autoRefreshOnMount === false) {
      return;
    }
    void refresh();
  }, [refresh, config.autoRefreshOnMount]);

  const addFiles = useCallback(
    async (selected: File[]) => {
      const result = await sdkAddFiles(client, selected);
      await refresh();
      return result;
    },
    [client, refresh]
  );

  const clearFiles = useCallback(async () => {
    await sdkClearFiles(client);
    setStatusById({});
    setPausedById({});
    await refresh();
  }, [client, refresh]);

  const setRules = useCallback(
    (rules: UploaderRules) => {
      setFileExtensionRules(client, {
        allowExtensions: rules.allowExtensions,
      });
    },
    [client]
  );

  const pause = useCallback(
    (fileId: string) => {
      pauseFileUpload(client, fileId);
      setPausedById((prev) => ({ ...prev, [fileId]: true }));
      setStatusById((prev) => {
        const current = prev[fileId] ?? buildStatus('pending', 0, 0);
        return {
          ...prev,
          [fileId]: {
            ...current,
            state: 'paused',
          },
        };
      });
    },
    [client]
  );

  const resume = useCallback(
    (fileId: string) => {
      resumeFileUpload(client, fileId);
      setPausedById((prev) => ({ ...prev, [fileId]: false }));
      setStatusById((prev) => {
        const current = prev[fileId] ?? buildStatus('pending', 0, 0);
        const nextState: UploadState =
          current.progress > 0 && current.progress < 100 ? 'uploading' : current.progress >= 100 ? 'uploaded' : 'queued';
        return {
          ...prev,
          [fileId]: {
            ...current,
            state: nextState,
          },
        };
      });
    },
    [client]
  );

  const cancel = useCallback(
    async (fileId: string) => {
      await cancelFileUpload(client, fileId);
      setPausedById((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
      setStatusById((prev) => {
        const next = { ...prev };
        delete next[fileId];
        return next;
      });
      await refresh();
    },
    [client, refresh]
  );

  const uploadAll = useCallback(
    async (options?: UploadOptions) => {
      const current = (await sdkListFiles(client)) as HookFileInfo[];
      if (!current.length) {
        return;
      }

      setIsUploading(true);
      const fileById = new Map(current.map((f) => [f.id, f]));

      setStatusById((prev) => {
        const next = { ...prev };
        for (const file of current) {
          const isPaused = pausedByIdRef.current[file.id];
          next[file.id] = buildStatus(isPaused ? 'paused' : 'queued', 0, file.size);
        }
        return next;
      });

      const merged = mergeUploadOptions(config.defaultUploadOptions, options);

      try {
        await sdkUploadFiles(client, config.adapterName, {
          ...merged,
          onProgress: (progress, _fileName, meta) => {
            const id = meta?.fileId;
            if (!id) {
              return;
            }
            const total = fileById.get(id)?.size ?? 0;
            const paused = !!pausedByIdRef.current[id];
            setStatusById((prev) => ({
              ...prev,
              [id]: {
                ...(prev[id] ?? buildStatus('pending', 0, total)),
                ...buildStatus(paused ? 'paused' : progress < 100 ? 'uploading' : 'uploaded', progress, total),
              },
            }));
          },
          onRetry: (error, fileName, meta) => {
            const id = meta?.fileId;
            if (!id) {
              return;
            }
            const total = fileById.get(id)?.size ?? 0;
            setStatusById((prev) => ({
              ...prev,
              [id]: {
                ...(prev[id] ?? buildStatus('pending', 0, total)),
                ...buildStatus('retrying', prev[id]?.progress ?? 0, total, error.message, {
                  attempt: meta.attempt,
                  maxRetries: meta.maxRetries,
                }),
              },
            }));
            log(
              `Retrying: ${fileName} (${meta.attempt}/${meta.maxRetries}) - ${error.message}`
            );
          },
          onError: (error, fileName, meta) => {
            const id = meta?.fileId;
            if (id) {
              const total = fileById.get(id)?.size ?? 0;
              setStatusById((prev) => ({
                ...prev,
                [id]: {
                  ...(prev[id] ?? buildStatus('pending', 0, total)),
                  ...buildStatus('failed', prev[id]?.progress ?? 0, total, error.message),
                },
              }));
            }
              log(`Failed after retries: ${fileName} (${error.message})`);
          },
          onComplete: (fileName, url, meta) => {
            const id = meta?.fileId;
            if (id) {
              const total = fileById.get(id)?.size ?? 0;
              setStatusById((prev) => ({
                ...prev,
                [id]: {
                  ...(prev[id] ?? buildStatus('pending', 0, total)),
                  ...buildStatus('uploaded', 100, total),
                },
              }));
            }
            log(`Uploaded: ${fileName} -> ${url}`);
          },
        });
      } finally {
        setIsUploading(false);
        await refresh();
      }
    },
    [client, config.adapterName, config.defaultUploadOptions, refresh, log]
  );

  const uploadSelected = useCallback(
    async (fileIds: string[], options?: UploadOptions) => {
      if (!fileIds.length) {
        return;
      }

      const current = (await sdkListFiles(client)) as HookFileInfo[];
      const fileById = new Map(current.map((f) => [f.id, f]));
      const idSet = new Set(fileIds);

      setIsUploading(true);
      setStatusById((prev) => {
        const next = { ...prev };
        for (const id of idSet) {
          const total = fileById.get(id)?.size ?? 0;
          const paused = !!pausedByIdRef.current[id];
          next[id] = buildStatus(paused ? 'paused' : 'queued', 0, total);
        }
        return next;
      });

      const merged = mergeUploadOptions(config.defaultUploadOptions, options);

      try {
        await sdkUploadSelectedFiles(client, config.adapterName, fileIds, {
          ...merged,
          onProgress: (progress, _fileName, meta) => {
            const id = meta?.fileId;
            if (!id) {
              return;
            }
            const total = fileById.get(id)?.size ?? 0;
            const paused = !!pausedByIdRef.current[id];
            setStatusById((prev) => ({
              ...prev,
              [id]: {
                ...(prev[id] ?? buildStatus('pending', 0, total)),
                ...buildStatus(paused ? 'paused' : progress < 100 ? 'uploading' : 'uploaded', progress, total),
              },
            }));
          },
          onRetry: (error, fileName, meta) => {
            const id = meta?.fileId;
            if (!id) {
              return;
            }
            const total = fileById.get(id)?.size ?? 0;
            setStatusById((prev) => ({
              ...prev,
              [id]: {
                ...(prev[id] ?? buildStatus('pending', 0, total)),
                ...buildStatus('retrying', prev[id]?.progress ?? 0, total, error.message, {
                  attempt: meta.attempt,
                  maxRetries: meta.maxRetries,
                }),
              },
            }));
            log(
              `Retrying: ${fileName} (${meta.attempt}/${meta.maxRetries}) - ${error.message}`
            );
          },
          onError: (error, fileName, meta) => {
            const id = meta?.fileId;
            if (id) {
              const total = fileById.get(id)?.size ?? 0;
              setStatusById((prev) => ({
                ...prev,
                [id]: {
                  ...(prev[id] ?? buildStatus('pending', 0, total)),
                  ...buildStatus('failed', prev[id]?.progress ?? 0, total, error.message),
                },
              }));
            }
              log(`Failed after retries: ${fileName} (${error.message})`);
          },
          onComplete: (fileName, url, meta) => {
            const id = meta?.fileId;
            if (id) {
              const total = fileById.get(id)?.size ?? 0;
              setStatusById((prev) => ({
                ...prev,
                [id]: {
                  ...(prev[id] ?? buildStatus('pending', 0, total)),
                  ...buildStatus('uploaded', 100, total),
                },
              }));
            }
            log(`Uploaded: ${fileName} -> ${url}`);
          },
        });
      } finally {
        setIsUploading(false);
        await refresh();
      }
    },
    [client, config.adapterName, config.defaultUploadOptions, refresh, log]
  );

  return {
    client,
    files,
    statusById,
    logs,
    isUploading,
    refresh,
    addFiles,
    clearFiles,
    uploadAll,
    uploadSelected,
    pause,
    resume,
    cancel,
    setRules,
  };
}
