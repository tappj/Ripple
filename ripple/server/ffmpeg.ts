import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const run = promisify(execFile);

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate:format=duration',
    '-of', 'json',
    file,
  ]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? '30/1').split('/').map(Number);
  return {
    duration: Number(info.format?.duration ?? 0),
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    fps: den ? num / den : 30,
  };
}

export async function extractFrame(file: string, atSeconds: number, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await run('ffmpeg', [
    '-y', '-ss', String(atSeconds), '-i', file,
    '-frames:v', '1', '-q:v', '2', dest,
  ]);
}

/**
 * Detect scene cuts in a clip. Returns cut timestamps (seconds), excluding 0 and the end.
 * Threshold 0.3 works well for generated footage with hard cuts.
 */
export async function detectCuts(file: string, threshold = 0.3): Promise<number[]> {
  const { stderr } = await run('ffmpeg', [
    '-i', file,
    '-filter:v', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ]);
  const cuts: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    cuts.push(Number(m[1]));
  }
  return cuts;
}

/** Cut [from, to) out of a clip, re-encoding for frame accuracy. */
export async function cutSegment(file: string, from: number, to: number, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await run('ffmpeg', [
    '-y', '-ss', String(from), '-to', String(to), '-i', file,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an',
    '-pix_fmt', 'yuv420p', dest,
  ]);
}

/**
 * Concatenate clips (re-encode to normalize timestamps — required for accurate
 * re-splitting of the Aleph output at known offsets).
 */
export async function concat(files: string[], dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const listFile = dest + '.txt';
  await fs.writeFile(listFile, files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'));
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an',
    '-pix_fmt', 'yuv420p', dest,
  ]);
  await fs.rm(listFile, { force: true });
}

/** Visible stand-in "edit" used by mock mode: rotate hue so the change is obvious. */
export async function hueShiftVideo(file: string, dest: string, degrees = 55): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await run('ffmpeg', [
    '-y', '-i', file,
    '-filter:v', `hue=h=${degrees}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an',
    '-pix_fmt', 'yuv420p', dest,
  ]);
}

export async function hueShiftImage(file: string, dest: string, degrees = 55): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await run('ffmpeg', ['-y', '-i', file, '-filter:v', `hue=h=${degrees}`, '-q:v', '2', dest]);
}
