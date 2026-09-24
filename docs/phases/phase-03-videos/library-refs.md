---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
    context7_id: "/nestjs/bull"
    note: "Context7 ID /nestjs/bull documents both @nestjs/bull (legacy, Bull v3) and @nestjs/bullmq (modern, BullMQ). Phase 03 architecture chooses @nestjs/bullmq for NestJS 11."
    fetched_at: "2026-09-23T18:55:21-03:00"
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-23T18:55:21-03:00"
  "@aws-sdk/client-s3":
    version: "^3.620.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-23T18:55:21-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.620.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-23T18:55:21-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.620.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-23T18:55:21-03:00"
  "nanoid":
    version: "^5.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-09-23T18:55:21-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T18:35:52-03:00"
---

# phase-03-videos — Library References

Distilled documentation for libraries resolved via Context7 for Phase 03 (Upload & Video Processing).

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7) — High reputation, 303 snippets, benchmark 80.13

**Purpose:** NestJS integration module for BullMQ (modern queue library based on Redis).

**Key Difference vs @nestjs/bull:**
- `@nestjs/bull` supports Bull v3.x/v4.x (decorator-based `@Process()` pattern)
- `@nestjs/bullmq` supports BullMQ 1.x-5.x (class-based `WorkerHost` pattern with FlowProducer and manual registration)
- Phase 03 architecture decision: Use BullMQ (modern), not Bull (legacy)
- **Recommendation:** Use `@nestjs/bullmq` package for NestJS 11 integration

**Setup for NestJS 11:**
```typescript
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot(),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get('REDIS_URL', 'redis://redis:6379'),
        },
      }),
    }),
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
})
export class VideosModule {}
```

**Queue Injection:**
```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideoService {
  constructor(@InjectQueue('video-processing') private videoQueue: Queue) {}
  
  async startUpload(videoId: string, uploadSessionId: string) {
    await this.videoQueue.add(
      'process-video',
      { videoId, uploadSessionId },
      {
        jobId: `video-${videoId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      }
    );
  }
}
```

**Compatibility:** ✅ NestJS 11.0.1 supported by @nestjs/bullmq v11.0.0+

---

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — High reputation, 1719 snippets, benchmark 84.81

**Purpose:** Redis-backed job queue library with deduplication, retry/backoff, and worker management.

**Key APIs:**

### Queue Operations
```typescript
import { Queue, Worker, Job } from 'bullmq';

const videoQueue = new Queue('video-processing', {
  connection: { url: 'redis://redis:6379' },
});

// Add job with canonical enqueue dedup
await videoQueue.add(
  'process-video',
  { videoId: 'v123', duration: 180 },
  {
    jobId: `video-${videoId}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    delay: 0,
  }
);
```

### Canonical Deduplication Contract (GAP-002 Resolution)
- Use `jobId = video-${videoId}` for enqueue deduplication.
- While the canonical job with that ID is active, a new enqueue for the same `videoId` must not create a second independent processing flow.
- This is the default/simple one-at-a-time processing contract adopted for Phase 03.

### Worker/Processor (TD-04, TD-11 Resolution)
```typescript
const worker = new Worker('video-processing', 
  async (job: Job) => {
    console.log(`Processing job ${job.id}: ${job.data.videoId}`);
    try {
      // TD-05: Extract metadata with ffprobe
      const metadata = await extractMetadata(job.data.videoId);
      // Generate thumbnail
      await generateThumbnail(job.data.videoId);
      return { status: 'completed', metadata };
    } catch (error) {
      // Job will retry if attempts > 0
      throw error;
    }
  },
  {
    connection: { url: 'redis://redis:6379' },
    concurrency: 2,  // Max 2 concurrent jobs
  }
);

worker.on('completed', (job, returnValue) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed: ${error.message}`);
  // After all retries exhausted, job is marked 'failed'
});
```

**Retry & Backoff (TD-11, GAP-003 Resolution):**
- `attempts: 5` — retry up to 5 times on failure
- `backoff: { type: 'exponential', delay: 2000 }` — exponential backoff starting at 2s
- Failed jobs remain in `failed` queue for inspection (DLQ-like)
- Completed jobs can be auto-removed with `removeOnComplete: true`

**Idempotency Strategy (GAP-002 Resolution):**
- `jobId = video-${videoId}` prevents duplicate enqueue for the same video.
- Enqueue dedup and worker preflight solve different problems:
  - enqueue dedup prevents duplicate jobs from being created
  - worker preflight prevents duplicate heavy processing when a job is redelivered or manually retried
- Canonical preflight query:

```sql
SELECT id, status FROM videos WHERE id = ? LIMIT 1;
```

- Canonical behavior:
  - `status = 'ready'` → skip, video already processed successfully
  - `status = 'processing'` → skip any new independent execution; BullMQ retries of the same canonical job continue the intended flow
  - `status = 'error'` → retry/reprocess is allowed
  - `status = 'draft'` → upload was not fully completed yet; do not process until completion is confirmed
- If `metadata_json` is already valid, retries skip `ffprobe` and attempt only the thumbnail step.

---

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation, 5132 snippets, benchmark 76.98

**Purpose:** AWS SDK for JavaScript v3 — S3 client for multipart uploads, presigned URLs, object operations.

**Key Features:**

### S3 Client Initialization
```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: 'us-east-1',
  // For MinIO (S3-compatible):
  endpoint: process.env.S3_ENDPOINT,  // e.g., http://minio:9000
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,  // Required for MinIO
});
```

### Multipart Upload Lifecycle (GAP-001 Resolution)

**1. CreateMultipartUpload — Initiate session**
```typescript
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';

const createCmd = new CreateMultipartUploadCommand({
  Bucket: 'videos-originals',
  Key: `${videoId}/original.mp4`,
  ContentType: 'video/mp4',
  Metadata: { videoId, uploadSessionId },
});
const { UploadId } = await s3Client.send(createCmd);
// UploadId: identifier for this multipart session, needed for all subsequent operations
```

**2. UploadPart — Upload individual chunks**
```typescript
import { UploadPartCommand } from '@aws-sdk/client-s3';

const uploadPartCmd = new UploadPartCommand({
  Bucket: 'videos-originals',
  Key: `${videoId}/original.mp4`,
  PartNumber: 1,  // 1-10000
  UploadId,
  Body: chunk,  // Stream, Buffer, or Blob
});
const { ETag } = await s3Client.send(uploadPartCmd);
// ETag: required for CompleteMultipartUpload
// Store: { PartNumber: 1, ETag }
```

**3. ListParts — Query uploaded parts (for resume/verification)**
```typescript
import { ListPartsCommand } from '@aws-sdk/client-s3';

const listCmd = new ListPartsCommand({
  Bucket: 'videos-originals',
  Key: `${videoId}/original.mp4`,
  UploadId,
  MaxParts: 1000,
});
const { Parts } = await s3Client.send(listCmd);
// Parts: Array<{ PartNumber, LastModified, ETag, Size }>
// Use to: resume from last uploaded part, verify which chunks are missing
```

**4. CompleteMultipartUpload — Finalize upload**
```typescript
import { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';

const completeCmd = new CompleteMultipartUploadCommand({
  Bucket: 'videos-originals',
  Key: `${videoId}/original.mp4`,
  UploadId,
  MultipartUpload: {
    Parts: [
      { PartNumber: 1, ETag: etag1 },
      { PartNumber: 2, ETag: etag2 },
      // ... all parts in PartNumber order
    ],
  },
});
await s3Client.send(completeCmd);
// Upload is now complete and object is available
```

**5. AbortMultipartUpload — Cancel incomplete upload (GAP-001, CON-001 Resolution)**
```typescript
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

const abortCmd = new AbortMultipartUploadCommand({
  Bucket: 'videos-originals',
  Key: `${videoId}/original.mp4`,
  UploadId,
});
await s3Client.send(abortCmd);
// S3 discards all uploaded parts; storage is freed
// Use when: upload times out, user cancels, or cleanup job runs
```

**Lifecycle Cleanup Rule (CON-001 Resolution):**
```typescript
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

const lifecycleCmd = new PutBucketLifecycleConfigurationCommand({
  Bucket: 'videos-originals',
  LifecycleConfiguration: {
    Rules: [
      {
        Id: 'abort-incomplete-multipart',
        Status: 'Enabled',
        AbortIncompleteMultipartUpload: {
          DaysAfterInitiation: 1,
        },
      },
    ],
  },
});
await s3Client.send(lifecycleCmd);
```

This lifecycle rule automatically cleans up multipart sessions abandoned for 1 day.

**Phase 03 note about `@aws-sdk/lib-storage`:**
- The package remains a valid AWS SDK helper, but it is **not** the canonical upload strategy for this phase.
- Phase 03 standardizes on **presigned multipart upload** coordinated by the API and executed directly by the client.

**MinIO Compatibility:** ✅
- Set `forcePathStyle: true` in S3Client config
- Use `endpoint: http://minio:9000` (or prod S3 endpoint)
- All multipart APIs work identically

---

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7)

**Purpose:** Generate presigned URLs for S3 operations valid for limited time.

**Presigned Multipart Upload (TD-02, NEW-003 Resolution):**
```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1. API starts multipart session
const { UploadId } = await s3Client.send(
  new CreateMultipartUploadCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
    ContentType: 'video/mp4',
  }),
);

// 2. API signs each part upload URL for the client
const part1Url = await getSignedUrl(
  s3Client,
  new UploadPartCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
    UploadId,
    PartNumber: 1,
  }),
  { expiresIn: 3600 },
);

// 3. API can inspect uploaded parts to support resume/verification
const { Parts } = await s3Client.send(
  new ListPartsCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
    UploadId,
  }),
);

// 4. After client returns PartNumber + ETag pairs, API finalizes multipart
await s3Client.send(
  new CompleteMultipartUploadCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
    UploadId,
    MultipartUpload: {
      Parts: [
        { PartNumber: 1, ETag: Parts?.[0]?.ETag ?? '' },
      ],
    },
  }),
);

// 5. Abort if client cancels or session is invalidated
await s3Client.send(
  new AbortMultipartUploadCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
    UploadId,
  }),
);
```

**Presigned URL for Streaming (TD-08, CON-002, NEW-002 Resolution):**
```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';

const streamUrl = await getSignedUrl(
  s3Client,
  new GetObjectCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
  }),
  { expiresIn: 1800 },
);
// Client requests URL with Range header; S3/MinIO streams directly
```

**Presigned URL for Download (TD-09, CON-002, NEW-002 Resolution):**
```typescript
const downloadUrl = await getSignedUrl(
  s3Client,
  new GetObjectCommand({
    Bucket: 'videos-originals',
    Key: `${videoId}/original.mp4`,
    ResponseContentDisposition: 'attachment; filename="video.mp4"',
  }),
  { expiresIn: 86400 },
);
```

**Expiration Normalization (CON-002 Resolution):**
- **CreateMultipartUpload / UploadPart presigned URLs:** 1 hour (`3600s`)
- **Streaming:** 30 minutes (`1800s`)
- **Download:** 24 hours (`86400s`)

**Bucket Usage Clarification (NEW-002 Resolution):**
- `videos-public` is reserved for thumbnails and other public assets.
- Original and processed videos remain in the private `videos-originals` bucket and are accessed only via signed URLs.

## GAP-003: Partial Failure Recovery

**Scenario 1 — `ffprobe` fails:**
- metadata is **not** persisted
- job transitions to `error`
- `last_error_stack_trace` captures the full stack trace
- BullMQ retries with exponential backoff up to 5 attempts

**Scenario 2 — `ffprobe` succeeds, thumbnail generation fails:**
- metadata is persisted immediately (`duration`, `resolution`, `bitrate`, etc.)
- `thumbnail_url` remains `NULL`
- subsequent retries skip `ffprobe` when `metadata_json` is already valid
- retries attempt only the FFmpeg thumbnail step
- if thumbnail still fails after 5 attempts, the video may be marked `ready` without thumbnail
- UI fallback is a placeholder whenever `thumbnail_url` is null

**Cleanup behavior for permanent worker failures:**
- partial/derived objects are not automatically deleted after permanent failure
- they remain available for diagnosis, manual cleanup, or future archival policy

## nanoid

**Source:** `/ai/nanoid` (Context7) — High reputation, 496 snippets, benchmark 76.2

**Purpose:** Generate tiny, secure, URL-friendly unique identifiers (TD-07 Resolution).

**Key Features:**
- **Default:** 21-character string using 64-character alphabet
- **Entropy:** 126 bits (comparable to UUID v4)
- **Safe for:** URLs, clusters (no coordination needed)
- **URL-friendly:** No encoding needed

**TD-07 Usage — Generate Opaque Public ID:**
```typescript
import { nanoid } from 'nanoid';

// Generate public ID for video (opaque, non-sequential)
const publicId = nanoid(12);  // e.g., "V1StGXR8_Z5j" (12 chars)

// Directly usable in URLs without encoding
const videoUrl = `https://streamtube.com/watch/${publicId}`;

// Store in DB: video.publicId = publicId
// Lookup: SELECT * FROM videos WHERE publicId = ?
```

**Characteristics (TD-07):**
- Opaque: No meaning to humans
- Immutable: Once assigned, never changes
- Unique: Collision probability negligible
- No database queries needed for collision detection

---

## FFmpeg Strategy (TD-05, TD-06) — NO NPM PACKAGE

**Decision:** Use FFmpeg/ffprobe binaries directly in worker container via Node.js `child_process.spawn()` or `util.promisify(exec)`.

**Why NOT fluent-ffmpeg:**
- Package `/fluent-ffmpeg/node-fluent-ffmpeg` is archived/deprecated
- Should not be used as dependency in new code
- Bloats dependencies for simple CLI invocation

**Strategy (TD-05):**
- Extract duration/resolution/codec/fps via `ffprobe` (JSON output)
- Calculate thumbnail timestamp: `duration * 0.25` (clamped to reasonable range)
- Extract frame via `ffmpeg -ss {timestamp} -i {input} -vframes 1 -s 320x240 output.jpg`
- Upload thumbnail to S3

**Implementation Approach:**
```typescript
// In video worker (NestJS)
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function extractMetadata(videoPath: string) {
  const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
  const { stdout } = await execAsync(cmd);
  const duration = parseFloat(stdout.trim());
  
  // Extract other metadata as needed
  return { duration, /* ... */ };
}

async function generateThumbnail(videoPath: string, outputPath: string) {
  const metadata = await extractMetadata(videoPath);
  const timestamp = Math.max(1, Math.min(metadata.duration * 0.25, metadata.duration - 1));
  
  const cmd = `ffmpeg -ss ${timestamp} -i "${videoPath}" -vframes 1 -s 320x240 "${outputPath}"`;
  await execAsync(cmd);
  // Upload outputPath to S3
}
```

**Container Setup (Worker, TD-04):**
```dockerfile
FROM node:22-alpine
RUN apk add --no-cache ffmpeg
# ffmpeg, ffprobe, and audio libs now available in PATH
```

**Runtime Dependencies:**
- No npm package needed
- FFmpeg binaries installed on container image
- Node.js built-in modules only (child_process, util)

---

## Summary: Context7 Library IDs & Versions

| Library | ID | Version | Purpose |
|---------|----|---------|----|
| @nestjs/bullmq | /nestjs/bull | ^11.0.0 | NestJS + BullMQ integration |
| bullmq | /taskforcesh/bullmq | ^5.x | Queue engine with Redis |
| @aws-sdk/client-s3 | /aws/aws-sdk-js-v3 | ^3.620.0 | Multipart uploads, S3 ops |
| @aws-sdk/lib-storage | /aws/aws-sdk-js-v3 | ^3.620.0 | High-level upload helper |
| @aws-sdk/s3-request-presigner | /aws/aws-sdk-js-v3 | ^3.620.0 | Presigned URLs |
| nanoid | /ai/nanoid | ^5.x | Opaque ID generation |

**FFmpeg/ffprobe:** System binaries in container (no NPM package)

---

## Findings Resolved via Context7

✅ **GAP-001:** Multipart lifecycle fully specified (`CreateMultipartUpload` → `UploadPart` → `ListParts` → `CompleteMultipartUpload` / `AbortMultipartUpload`)  
✅ **GAP-002:** Idempotency via `jobId=video-${videoId}` + worker preflight by `video.status`  
✅ **GAP-003:** Partial failure recovery documented for `ffprobe` vs thumbnail generation  
✅ **CON-001:** 24h cleanup policy aligned with S3 lifecycle auto-abort for incomplete multipart sessions  
✅ **CON-002:** Signed URL expiration normalized: upload 1h, streaming 30min, download 24h  
✅ **NEW-002:** Bucket usage corrected: `videos-originals` for videos, `videos-public` only for thumbnails  
✅ **NEW-003:** Upload strategy normalized to presigned multipart only  
✅ **TD-07:** `nanoid` generates 12-char opaque public ID  