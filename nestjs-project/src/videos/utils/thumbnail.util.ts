import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface GenerateThumbnailParams {
  videoFilePath: string;
  timestamp: number; // Seconds
  outputFilePath: string;
  width?: number;
  height?: number;
}

/**
 * Generate a thumbnail from video at specified timestamp using ffmpeg
 * Defaults to 320x240 resolution
 */
export async function generateThumbnailWithFFmpeg(
  params: GenerateThumbnailParams,
): Promise<void> {
  const width = params.width || 320;
  const height = params.height || 240;

  try {
    // Ensure output directory exists
    const outputDir = path.dirname(params.outputFilePath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // ffmpeg command to extract single frame at timestamp
    // -ss {timestamp} = seek to timestamp
    // -i {input} = input file
    // -vframes 1 = extract 1 frame
    // -s {width}x{height} = scale output
    // {output} = output file
    await execFileAsync('ffmpeg', [
      '-ss',
      String(params.timestamp),
      '-i',
      params.videoFilePath,
      '-vframes',
      '1',
      '-s',
      `${width}x${height}`,
      '-y', // Overwrite output file
      params.outputFilePath,
    ]);
  } catch (error) {
    throw new Error(
      `FFmpeg thumbnail generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read thumbnail file and return buffer
 */
export async function readThumbnailFile(filePath: string): Promise<Buffer> {
  return fs.promises.readFile(filePath);
}

/**
 * Delete temporary thumbnail file
 */
export async function deleteThumbnailFile(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    // Log but don't throw - cleanup is best-effort
    console.error(`Failed to delete temporary thumbnail: ${error}`);
  }
}
