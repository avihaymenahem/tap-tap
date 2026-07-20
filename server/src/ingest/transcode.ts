import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG: string = ffmpegStatic ?? 'ffmpeg';

function run(args: string[], captureStdout: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr?.on('data', (c: Buffer) => {
      // ffmpeg is chatty; keep only the tail for error reporting.
      stderr = (stderr + c.toString()).slice(-4000);
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}\n${stderr}`));
    });
  });
}

/**
 * Decode any input to mono float PCM at the given rate.
 *
 * Raw `f32le` on stdout means no WAV parsing and no temp file — ffmpeg hands
 * back exactly the sample format the analyzer wants.
 */
export async function decodeToMonoPcm(input: string, sampleRate = 44100): Promise<Float32Array> {
  const buf = await run(
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', input,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ],
    true,
  );

  // Copy into a fresh ArrayBuffer: Buffer.concat may hand back a pooled buffer
  // whose byteOffset is not 4-byte aligned, which Float32Array would reject.
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(aligned);
}

/**
 * Encode to AAC in an m4a container.
 *
 * Opus is smaller, but AAC decodes everywhere including Safari, and the size
 * difference is irrelevant for a locally served library.
 */
export async function encodeAac(input: string, output: string, bitrate = '128k'): Promise<void> {
  await run(
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', input,
      '-vn',
      '-c:a', 'aac',
      '-b:a', bitrate,
      '-movflags', '+faststart',
      output,
    ],
    false,
  );
}

/** Re-encode a downloaded thumbnail to jpg, ignoring failure — cover art is optional. */
export async function convertThumbnail(input: string, output: string): Promise<boolean> {
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, output], false);
    return true;
  } catch {
    return false;
  }
}
