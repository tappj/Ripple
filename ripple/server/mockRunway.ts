import path from 'node:path';
import fs from 'node:fs/promises';
import { hueShiftImage, hueShiftVideo } from './ffmpeg.ts';
import type {
  AlephEditRequest,
  ImageEditRequest,
  RunwayClient,
  StartedTask,
  TaskSnapshot,
} from './types.ts';

/**
 * Zero-credit simulator. The "edit" is a hue rotation — deliberately obvious so the
 * whole review flow can be exercised without an API key. Task latencies are shortened
 * but nonzero so the async states (queued → running → succeeded) are all visible in the UI.
 */
interface MockTask {
  startedAt: number;
  durationMs: number;
  work: Promise<string>; // resolves to output file path
  done?: string;
  failed?: string;
}

export class MockRunwayClient implements RunwayClient {
  readonly mock = true;
  private tasks = new Map<string, MockTask>();
  private counter = 0;
  private spent = 0;

  constructor(private workDir: string) {}

  private register(durationMs: number, work: Promise<string>): StartedTask {
    const taskId = `mock-${++this.counter}-${Date.now()}`;
    const task: MockTask = { startedAt: Date.now(), durationMs, work };
    work.then(
      (out) => (task.done = out),
      (err) => (task.failed = String(err)),
    );
    this.tasks.set(taskId, task);
    return { taskId };
  }

  async startImageEdit(req: ImageEditRequest): Promise<StartedTask> {
    this.spent += 15;
    const target = req.references[0].filePath;
    const out = path.join(this.workDir, `mock-img-${this.counter + 1}.jpg`);
    return this.register(4000, hueShiftImage(target, out).then(() => out));
  }

  async startAlephEdit(req: AlephEditRequest): Promise<StartedTask> {
    this.spent += Math.max(56, Math.ceil(req.durationSeconds * 28));
    const out = path.join(this.workDir, `mock-vid-${this.counter + 1}.mp4`);
    return this.register(12000, hueShiftVideo(req.videoPath, out).then(() => out));
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    const task = this.tasks.get(taskId);
    if (!task) return { status: 'FAILED', failure: 'Unknown mock task' };
    if (task.failed) return { status: 'FAILED', failure: task.failed };
    const elapsed = Date.now() - task.startedAt;
    if (elapsed < task.durationMs || !task.done) {
      return {
        status: elapsed < 1500 ? 'PENDING' : 'RUNNING',
        progress: Math.min(0.95, elapsed / task.durationMs),
      };
    }
    return { status: 'SUCCEEDED', outputUrls: [`mock-file://${task.done}`] };
  }

  async download(url: string, destPath: string): Promise<void> {
    const src = url.replace('mock-file://', '');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(src, destPath);
  }

  async getCredits(): Promise<{ creditBalance: number }> {
    return { creditBalance: 100_000 - this.spent };
  }
}
