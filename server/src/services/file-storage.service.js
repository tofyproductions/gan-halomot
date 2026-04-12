const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const env = require('../config/env');

let s3Client = null;

function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

async function upload(buffer, key, mimeType) {
  await getClient().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return key;
}

async function download(key) {
  const response = await getClient().send(new GetObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
  }));
  return response.Body;
}

async function getPresignedUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
  return getSignedUrl(getClient(), command, { expiresIn });
}

async function remove(key) {
  await getClient().send(new DeleteObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
  }));
}

module.exports = { upload, download, getPresignedUrl, remove };
