import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface FFProbeMetadata {
  duration: number;
  resolution: {
    width: number;
    height: number;
  };
  bitrate: number;
  codec: string;
  fps: number;
}

// Type-safe schema validation for ffprobe output
interface FFProbeFormat {
  duration?: unknown;
  bit_rate?: unknown;
}

interface FFProbeStream {
  codec_type?: unknown;
  width?: unknown;
  height?: unknown;
  codec_name?: unknown;
  r_frame_rate?: unknown;
}

interface FFProbeOutput {
  format?: unknown;
  streams?: unknown;
}

/**
 * Extract video metadata using ffprobe (JSON output)
 *
 * Uses ffprobe to extract:
 * - duration (seconds)
 * - resolution (width x height)
 * - bitrate (bits per second)
 * - codec name
 * - frames per second
 */
export async function extractMetadataWithFFProbe(
  videoFilePath: string,
): Promise<FFProbeMetadata> {
  try {
    // ffprobe command with JSON output
    // Note: -of json replaced deprecated -print_json in ffprobe 5.x
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-of',
      'json',
      '-show_format',
      '-show_streams',
      videoFilePath,
    ]);

    const probeData = JSON.parse(stdout) as FFProbeOutput;

    // Extract format-level metadata with type safety
    const format = (probeData.format || {}) as FFProbeFormat;

    const duration =
      parseFloat(String((format.duration ?? '0') as unknown)) || 0;

    const bitrate =
      parseInt(String((format.bit_rate ?? '0') as unknown), 10) || 0;

    // Extract stream metadata (video stream)
    const streams = Array.isArray(probeData.streams) ? probeData.streams : [];
    const videoStream = streams.find(
      (stream: unknown) =>
        stream &&
        typeof stream === 'object' &&
        (stream as { codec_type?: unknown }).codec_type === 'video',
    ) as FFProbeStream | undefined;

    if (!videoStream) {
      throw new Error('No video stream found in file');
    }

    const width =
      parseInt(String((videoStream.width ?? '0') as unknown), 10) || 0;

    const height =
      parseInt(String((videoStream.height ?? '0') as unknown), 10) || 0;

    const codec = String((videoStream.codec_name ?? 'unknown') as unknown);

    const rFrameRate = String((videoStream.r_frame_rate ?? '0/1') as unknown);

    // Parse r_frame_rate (e.g., "30000/1001" or "30/1")
    const [numerator, denominator] = rFrameRate.split('/').map(Number);
    const fps = denominator ? numerator / denominator : 0;

    return {
      duration,
      resolution: { width, height },
      bitrate,
      codec,
      fps: Math.round(fps * 100) / 100, // Round to 2 decimal places
    };
  } catch (error) {
    throw new Error(
      `FFProbe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Calculate optimal thumbnail timestamp
 * Default: 25% of video duration, clamped to reasonable range
 */
export function calculateThumbnailTimestamp(durationSeconds: number): number {
  const minTimestamp = 1; // At least 1 second
  const maxTimestamp = Math.max(durationSeconds * 0.9, 10); // Max 90% or 10s

  const optimalTimestamp = Math.round(durationSeconds * 0.25 * 100) / 100;

  return Math.min(Math.max(optimalTimestamp, minTimestamp), maxTimestamp);
}
