const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

dotenv.config({ path: '.env' });

const app = express();
app.use(cors());
app.use(express.json());

const required = ['ACCESS_KEY', 'SECRET_ACCESS_KEY', 'BUCKET_NAME'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
  },
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/presign', async (req, res) => {
  try {
    const { fileName, contentType, size } = req.body || {};
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }

    const assetId = crypto.randomUUID();
    const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `uploads/${Date.now()}-${assetId}-${safeName}`;
    const region = process.env.AWS_REGION || 'ap-south-1';

    const command = new PutObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const fileUrl = `https://${process.env.BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;

    return res.json({
      assetId,
      uploadUrl,
      fileUrl,
      key,
      bucket: process.env.BUCKET_NAME,
      region,
      size: typeof size === 'number' ? size : null,
      contentType: contentType || 'application/octet-stream',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to generate pre-signed URL' });
  }
});

app.post('/api/multipart/start', async (req, res) => {
  try {
    const { fileName, contentType, size, partSize } = req.body || {};
    if (!fileName) {
      return res.status(400).json({ error: 'fileName is required' });
    }
    if (typeof size !== 'number' || size <= 0) {
      return res.status(400).json({ error: 'size must be a positive number' });
    }

    const assetId = crypto.randomUUID();
    const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `uploads/${Date.now()}-${assetId}-${safeName}`;
    const defaultPartSize = Number(process.env.MULTIPART_PART_SIZE || 8 * 1024 * 1024);
    const requestedPartSize = Number(partSize || defaultPartSize);
    const safePartSize = Math.max(5 * 1024 * 1024, Math.min(100 * 1024 * 1024, requestedPartSize));
    const totalParts = Math.ceil(size / safePartSize);

    const cmd = new CreateMultipartUploadCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
    });

    const out = await s3.send(cmd);
    if (!out.UploadId) {
      return res.status(500).json({ error: 'Failed to create multipart upload' });
    }

    return res.json({
      assetId,
      key,
      uploadId: out.UploadId,
      partSize: safePartSize,
      totalParts,
      bucket: process.env.BUCKET_NAME,
      region: process.env.AWS_REGION || 'ap-south-1',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to start multipart upload' });
  }
});

app.post('/api/multipart/sign-part', async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.body || {};
    if (!key || !uploadId || typeof partNumber !== 'number') {
      return res.status(400).json({ error: 'key, uploadId and numeric partNumber are required' });
    }

    const cmd = new UploadPartCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
    return res.json({ uploadUrl, key, uploadId, partNumber });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to sign multipart part' });
  }
});

app.get('/api/multipart/parts', async (req, res) => {
  try {
    const { key, uploadId } = req.query;
    if (!key || !uploadId) {
      return res.status(400).json({ error: 'key and uploadId are required' });
    }

    const out = await s3.send(
      new ListPartsCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
      })
    );

    const parts = (out.Parts || []).map((p) => ({
      PartNumber: p.PartNumber,
      ETag: p.ETag,
      Size: p.Size,
    }));

    return res.json({ key, uploadId, parts });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to list multipart parts' });
  }
});

app.post('/api/multipart/complete', async (req, res) => {
  try {
    const { key, uploadId, parts, assetId } = req.body || {};
    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: 'key, uploadId, and parts[] are required' });
    }

    const normalized = parts
      .map((p) => ({ PartNumber: Number(p.PartNumber), ETag: p.ETag }))
      .filter((p) => p.PartNumber > 0 && typeof p.ETag === 'string')
      .sort((a, b) => a.PartNumber - b.PartNumber);

    const out = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: normalized },
      })
    );

    return res.json({
      assetId: assetId || null,
      key,
      etag: out.ETag || null,
      location: out.Location || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to complete multipart upload' });
  }
});

app.post('/api/multipart/abort', async (req, res) => {
  try {
    const { key, uploadId } = req.body || {};
    if (!key || !uploadId) {
      return res.status(400).json({ error: 'key and uploadId are required' });
    }

    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
      })
    );

    return res.json({ ok: true, key, uploadId });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to abort multipart upload' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { assetId, key, size, contentType } = req.body || {};
    if (!key) {
      return res.status(400).json({ error: 'key is required' });
    }

    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
      })
    );

    const sizeOk = size == null ? true : Number(head.ContentLength || 0) === Number(size);
    const typeOk = !contentType || head.ContentType === contentType;
    const verified = Boolean(sizeOk && typeOk);

    return res.json({
      assetId: assetId || null,
      key,
      verified,
      checks: {
        sizeOk,
        typeOk,
      },
      etag: head.ETag || null,
      contentLength: head.ContentLength || null,
      contentType: head.ContentType || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Verification failed' });
  }
});

app.get('/api/download-url', async (req, res) => {
  try {
    const { key, assetId } = req.query;
    if (!key) {
      return res.status(400).json({ error: 'key is required' });
    }

    const region = process.env.AWS_REGION || 'ap-south-1';
    const bucket = process.env.BUCKET_NAME;

    if (process.env.BUCKET_PUBLIC === 'true') {
      const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      return res.json({ assetId: assetId || null, url: publicUrl, mode: 'public-s3' });
    }

    const signedGetUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
      { expiresIn: 300 }
    );

    return res.json({ assetId: assetId || null, url: signedGetUrl, mode: 'signed-s3' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to get download URL' });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
