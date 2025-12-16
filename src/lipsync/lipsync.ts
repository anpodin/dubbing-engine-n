import { SyncClient, SyncError } from '@sync.so/sdk';
import type { Generation } from '@sync.so/sdk/api';
import fs from 'fs';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { pathExists } from '../utils/fsUtils';

const syncClient = new SyncClient({ apiKey: process.env.SYNC_LAB_API_KEY });

export class Lipsync {
  static async startLipSync({ audioPath, videoPath }: { audioPath: string; videoPath: string }) {
    try {
      console.debug('Verifying usage links for lip sync...');

      const syncLabResponse = await this.sendLipSyncRequest({
        audioUrl: audioPath,
        videoUrl: videoPath,
      });

      return syncLabResponse;
    } catch (error) {
      console.error(error);
      throw new Error('Error during lip sync request');
    }
  }

  static async sendLipSyncRequest({
    audioUrl,
    videoUrl,
  }: {
    audioUrl: string;
    videoUrl: string;
  }): Promise<Generation> {
    try {
      const response = await syncClient.generations.create({
        input: [
          {
            type: 'video',
            url: videoUrl,
          },
          {
            type: 'audio',
            url: audioUrl,
          },
        ],
        options: {
          sync_mode: 'loop',
          active_speaker_detection: {
            auto_detect: true,
          },
          occlusion_detection_enabled: true,
        },
        model: 'lipsync-2-pro', //? You can also use lipsync-2-pro for better quality (2x more expensive and 2x more duration)
      });

      return response;
    } catch (error) {
      if (error instanceof SyncError) {
        console.error('Error:', error.body);
        throw new Error(`Synclabs error: ${error.message}`);
      }
      throw error;
    }
  }

  static async pollLipSyncResult(
    initialResponse: Generation,
    maxAttempts = 600,
    intervalMs = 10000,
  ): Promise<string> {
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        const generation = await syncClient.generations.get(initialResponse.id);

        if (generation.status === 'COMPLETED') {
          if (generation.outputUrl) {
            return generation.outputUrl;
          } else {
            throw new Error('Output URL is missing from completed response');
          }
        } else if (['FAILED', 'REJECTED'].includes(generation.status)) {
          throw new Error(
            `Lipsync generation failed with status: ${generation.status}, error: ${generation.error || 'Unknown error'}`,
          );
        }

        console.debug(
          `Lipsync job status: ${generation.status}. Polling again in ${intervalMs / 1000} seconds...`,
        );
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      } catch (error) {
        if (error instanceof SyncError) {
          console.error('Error polling lipsync result:', error.body);
          throw new Error(`Error polling lipsync result: ${error.message}`);
        }
        throw error;
      }
    }

    throw new Error(`Lipsync generation timed out after ${maxAttempts} attempts`);
  }

  static async startLipSyncAndWaitForResult({
    audioPath,
    videoPath,
  }: {
    audioPath: string;
    videoPath: string;
  }): Promise<string> {
    try {
      console.debug('Starting lip sync process...');

      const initialResponse = await this.sendLipSyncRequest({
        audioUrl: audioPath,
        videoUrl: videoPath,
      });

      console.debug(`Lip sync job started with ID: ${initialResponse.id}`);

      const outputUrl = await this.pollLipSyncResult(initialResponse);

      console.debug(`Lip sync completed. Output available at: ${outputUrl}`);
      return outputUrl;
    } catch (error) {
      console.error('Error during lip sync process:', error);
      throw new Error(
        `Failed to complete lip sync process: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  static async processLipSyncWithAwsUpload({
    localVideoPath,
    localAudioPath,
  }: {
    localVideoPath: string;
    localAudioPath: string;
  }): Promise<string> {
    const requiredEnvVars = [
      'SYNC_LAB_API_KEY',
      'AWS_S3_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_BUCKET_NAME',
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }

    if (!(await pathExists(localVideoPath))) {
      throw new Error(`Video file not found at path: ${localVideoPath}`);
    }
    if (!(await pathExists(localAudioPath))) {
      throw new Error(`Audio file not found at path: ${localAudioPath}`);
    }

    const s3BucketName = process.env.AWS_BUCKET_NAME || '';
    const s3Region = process.env.AWS_S3_REGION || '';

    const s3client = new S3Client({
      region: s3Region,
    });

    let videoFileName = '';
    let audioFileName = '';

    try {
      console.debug('Uploading files to AWS S3...');

      const timestamp = Date.now();
      videoFileName = `lipsync/video_${timestamp}_${localVideoPath.split('/').pop()}`;
      audioFileName = `lipsync/audio_${timestamp}_${localAudioPath.split('/').pop()}`;

      const videoBuffer = fs.readFileSync(localVideoPath);
      const audioBuffer = fs.readFileSync(localAudioPath);

      const [videoUrl, audioUrl] = await Promise.all([
        uploadFileToS3(s3client, s3BucketName, s3Region, videoBuffer, videoFileName),
        uploadFileToS3(s3client, s3BucketName, s3Region, audioBuffer, audioFileName),
      ]);

      console.debug(`Files uploaded successfully. Video URL: ${videoUrl}, Audio URL: ${audioUrl}`);

      const lipSyncResultUrl = await this.startLipSyncAndWaitForResult({
        videoPath: videoUrl,
        audioPath: audioUrl,
      });

      console.debug(`Lipsync processing complete. Result available at: ${lipSyncResultUrl}`);

      try {
        fs.unlinkSync(localVideoPath);
        fs.unlinkSync(localAudioPath);
        console.debug('Local files deleted successfully');
      } catch (deleteError) {
        console.warn('Failed to delete local files:', deleteError);
      }

      try {
        await Promise.all([
          deleteFileFromS3(s3client, s3BucketName, videoFileName),
          deleteFileFromS3(s3client, s3BucketName, audioFileName),
        ]);
        console.debug('S3 files deleted successfully');
      } catch (deleteError) {
        console.warn('Failed to delete S3 files:', deleteError);
      }

      return lipSyncResultUrl;
    } catch (error) {
      console.error('Error in lipsync processing with AWS upload:', error);

      if (videoFileName && audioFileName) {
        try {
          await Promise.all([
            deleteFileFromS3(s3client, s3BucketName, videoFileName),
            deleteFileFromS3(s3client, s3BucketName, audioFileName),
          ]);
          console.debug('S3 files deleted after error');
        } catch (deleteError) {
          console.warn('Failed to delete S3 files after error:', deleteError);
        }
      }

      throw new Error(
        `Failed to process lipsync with AWS: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function uploadFileToS3(
  s3client: S3Client,
  bucketName: string,
  region: string,
  fileBuffer: Buffer,
  filePath: string,
): Promise<string> {
  try {
    await s3client.send(
      new HeadObjectCommand({
        Bucket: bucketName,
        Key: filePath,
      }),
    );
    return `https://${bucketName}.s3.${region}.amazonaws.com/${filePath}`;
  } catch (error: unknown) {
    // File doesn't exist, continue with upload
  }

  const expirationDate = new Date();
  expirationDate.setFullYear(expirationDate.getFullYear() + 1);

  const uploadParams = {
    Bucket: bucketName,
    Key: filePath.trim(),
    Body: fileBuffer,
    Metadata: {
      'x-amz-meta-expiration-date': expirationDate.toISOString(),
    },
  };

  try {
    const data = await s3client.send(new PutObjectCommand(uploadParams));
    if (!data) {
      throw new Error('Error uploading file to AWS S3');
    }

    return `https://${bucketName}.s3.${region}.amazonaws.com/${filePath.trim()}`;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to upload file: ${errorMessage}`);
  }
}

async function deleteFileFromS3(s3client: S3Client, bucketName: string, filePath: string): Promise<void> {
  try {
    await s3client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: filePath,
      }),
    );
    console.debug(`Successfully deleted file from S3: ${filePath}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`Failed to delete file from S3: ${filePath} - ${errorMessage}`);
    throw new Error(`Failed to delete file from S3: ${errorMessage}`);
  }
}
