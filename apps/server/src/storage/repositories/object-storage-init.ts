import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export async function ensureObjectStorageBucket(
  environment: Record<string, string | undefined> = process.env,
): Promise<void> {
  const bucket = environment.ASSET_BUCKET;
  const endpoint = environment.S3_ENDPOINT;
  if (!bucket || !endpoint) {
    throw new Error("ASSET_BUCKET and S3_ENDPOINT are required");
  }

  const client = new S3Client({
    region: environment.AWS_REGION ?? "us-east-1",
    endpoint,
    forcePathStyle: true,
    ...(environment.AWS_ACCESS_KEY_ID && environment.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID,
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
        ?.httpStatusCode;
      if (status !== 404) {
        throw error;
      }
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  } finally {
    client.destroy();
  }
}

if (import.meta.main) {
  await ensureObjectStorageBucket();
}
