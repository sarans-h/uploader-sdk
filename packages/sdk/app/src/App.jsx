import React, { useMemo, useState } from 'react';
import { useUploader } from 'uploader-sdk/react';
import { createPresignedS3Adapter } from 'uploader-sdk/adapters/presigned-s3';

const API_BASE = 'http://localhost:8787';

function safeId(id) {
  return encodeURIComponent(id).replace(/%/g, '_');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 100 || idx === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

export default function App() {
  const AUTO_RETRY_COUNT = 5;
  const AUTO_RETRY_DELAY_MS = 2000;

  const [multipartThresholdMb, setMultipartThresholdMb] = useState(20);
  const [multipartPartSizeMb, setMultipartPartSizeMb] = useState(8);
  const adapter = useMemo(
    () =>
      createPresignedS3Adapter({
        apiBaseUrl: API_BASE,
        multipartThresholdBytes: Number(multipartThresholdMb || 20) * 1024 * 1024,
        multipartPartSizeBytes: Math.max(5, Number(multipartPartSizeMb || 8)) * 1024 * 1024,
      }),
    [multipartThresholdMb, multipartPartSizeMb]
  );

  const [allowExt, setAllowExt] = useState('jpg,png,pdf');
  const [localLogs, setLocalLogs] = useState([]);
  const [hasPendingSelection, setHasPendingSelection] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);

  const log = (msg) => setLocalLogs((prev) => [...prev, msg]);

  const {
    files,
    statusById,
    logs,
    isUploading,
    refresh,
    addFiles,
    clearFiles,
    uploadAll: runUploadAll,
    uploadSelected,
    pause,
    resume,
    cancel,
    setRules,
  } = useUploader({
    adapterName: 's3',
    adapter,
    defaultUploadOptions: {
      parallel: 3,
      retry: AUTO_RETRY_COUNT,
      retryDelayMs: AUTO_RETRY_DELAY_MS,
    },
    rules: {
      allowExtensions: allowExt.split(',').map((x) => x.trim()).filter(Boolean),
    },
  });

  const applyRules = () => {
    setRules({
      allowExtensions: allowExt.split(',').map((x) => x.trim()).filter(Boolean),
    });
    log('Extension rules applied.');
  };

  const pauseOne = (fileId) => {
    pause(fileId);
    log('Paused: ' + fileId);
  };

  const resumeOne = (fileId) => {
    resume(fileId);
    log('Resumed: ' + fileId);
  };

  const pauseAll = () => {
    for (const f of files) {
      pause(f.id);
    }
    log('Paused all files.');
  };

  const resumeAll = () => {
    for (const f of files) {
      resume(f.id);
    }
    log('Resumed all files.');
  };

  const addSelectedFiles = async (selected, sourceCount = selected.length) => {
    if (!selected.length) {
      setHasPendingSelection(false);
      return;
    }

    setHasPendingSelection(true);
    try {
      const result = await addFiles(selected);
      if (selected.length === 10 && sourceCount > 10) {
        log('Only first 10 files were taken from selection.');
      }
      if (result.saved.length) {
        log('Saved: ' + result.saved.join(', '));
      }
      if (result.rejected.length) {
        log('Rejected: ' + result.rejected.join(', '));
      }
      if (!result.saved.length && result.rejected.length) {
        log('All selected files were rejected by extension rules.');
      }
      await refresh();
    } catch (err) {
      log('Save failed: ' + (err?.message || String(err)));
    } finally {
      setHasPendingSelection(false);
    }
  };

  const onSelect = async (e) => {
    const selected = Array.from(e.target.files || []).slice(0, 10);
    await addSelectedFiles(selected, (e.target.files || []).length);
    // Allow selecting the same file again to retrigger onChange.
    e.target.value = '';
  };

  const onDragOver = (e) => {
    e.preventDefault();
    setIsDragActive(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    setIsDragActive(false);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setIsDragActive(false);
    const dropped = Array.from(e.dataTransfer?.files || []).slice(0, 10);
    await addSelectedFiles(dropped, (e.dataTransfer?.files || []).length);
  };

  const uploadAllAction = async () => {
    if (!files.length) {
      return;
    }

    try {
      await runUploadAll();
    } catch (err) {
      log('Upload run error: ' + (err?.message || String(err)));
    }
  };

  const startOne = async (file) => {
    try {
      await uploadSelected([file.id], {
        parallel: 1,
        retry: AUTO_RETRY_COUNT,
        retryDelayMs: AUTO_RETRY_DELAY_MS,
      });
    } catch (err) {
      log('Start one error: ' + (err?.message || String(err)));
    }
  };

  const retryOne = async (file) => {
    await startOne(file);
  };

  const cancelOne = async (file) => {
    try {
      await cancel(file.id);
      log('Canceled and removed: ' + file.name + ' (' + file.id + ')');
    } catch (err) {
      log('Cancel failed: ' + (err?.message || String(err)));
    }
  };

  const wipe = async () => {
    await clearFiles();
    setLocalLogs([]);
    await refresh();
  };

  const combinedLogs = [...logs, ...localLogs];

  return (
    <div className="container">
      <h2>Upload SDK React + S3 Presigned Demo</h2>
      <div className="row">
        <input value={allowExt} onChange={(e) => setAllowExt(e.target.value)} placeholder="allow: jpg,png,pdf" />
        <button onClick={applyRules}>Apply Rules</button>
      </div>

      <div className="row">
        <label>
          Multipart threshold (MB)
          <input
            type="number"
            min="1"
            value={multipartThresholdMb}
            onChange={(e) => setMultipartThresholdMb(Number(e.target.value || 1))}
            style={{ marginLeft: 8, width: 100 }}
          />
        </label>
        <label>
          Part size (MB, min 5)
          <input
            type="number"
            min="5"
            value={multipartPartSizeMb}
            onChange={(e) => setMultipartPartSizeMb(Number(e.target.value || 5))}
            style={{ marginLeft: 8, width: 100 }}
          />
        </label>
      </div>

      <div className="row">
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          style={{
            border: isDragActive ? '2px solid #2b7fff' : '2px dashed #909090',
            borderRadius: 8,
            padding: '10px 12px',
            minWidth: 260,
            textAlign: 'center',
            background: isDragActive ? '#eef5ff' : 'transparent',
          }}
        >
          {isDragActive ? 'Drop files here' : 'Drag and drop files here'}
        </div>
        <input type="file" multiple onChange={onSelect} />
        <button onClick={refresh}>Refresh List</button>
        <button onClick={uploadAllAction} disabled={(!files.length && !hasPendingSelection) || isUploading}>Upload All</button>
        <button onClick={pauseAll} disabled={!files.length}>Pause All</button>
        <button onClick={resumeAll} disabled={!files.length}>Resume All</button>
        <button onClick={wipe}>Clear IndexedDB</button>
      </div>

      {files.map((f) => {
        const st = statusById[f.id] || { state: 'pending', progress: 0, uploadedBytes: 0, totalBytes: f.size };
        const disableStart = st.state === 'uploading' || st.state === 'queued' || st.state === 'retrying';
        const retryText =
          st.state === 'retrying' && Number.isFinite(st.retryAttempt) && Number.isFinite(st.maxRetries)
            ? `Retry ${st.retryAttempt}/${st.maxRetries}`
            : null;
        return (
          <div className="file-card" key={f.id} id={`row-${safeId(f.id)}`}>
            <span>{f.name} ({f.size} bytes)</span>
            <span className="status">{st.state}{retryText ? ` (${retryText})` : ''}</span>
            <progress max="100" value={st.progress} />
            <span>{formatBytes(st.uploadedBytes || 0)} / {formatBytes(st.totalBytes || f.size || 0)}</span>
            <button onClick={() => startOne(f)} disabled={disableStart}>Start</button>
            {st.state === 'paused' ? (
              <button onClick={() => resumeOne(f.id)}>Resume</button>
            ) : (
              <button onClick={() => pauseOne(f.id)}>Pause</button>
            )}
            {st.state === 'failed' ? (
              <button onClick={() => retryOne(f)}>Retry</button>
            ) : null}
            <button onClick={() => cancelOne(f)} disabled={st.state === 'uploaded'}>Cancel</button>
          </div>
        );
      })}

      <div className="log">{combinedLogs.join('\n')}</div>
    </div>
  );
}
