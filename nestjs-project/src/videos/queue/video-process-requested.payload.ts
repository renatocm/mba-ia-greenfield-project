export interface VideoProcessRequestedPayload {
  eventId: string;
  occurredAt: string;
  videoId: string;
  publicId: string;
  ownerUserId: string;
  sourceBucket: string;
  sourceObjectKey: string;
  storageProvider: 's3';
  uploadSessionId: string;
  attempt: number;
}
