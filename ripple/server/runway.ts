import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AlephEditRequest,
  ImageEditRequest,
  RunwayClient,
  StartedTask,
  TaskSnapshot,
} from './types.ts';

const BASE = 'https://api.dev.runwayml.com';
const VERSION = '2024-11-06';

// gemini_image3_pro output ratios, verified against the live OpenAPI spec.
// The keyframe must roughly match the video aspect so Aleph's guidance lines up.
const IMAGE_RATIOS = ['1344:768', '768:1344', '1024:1024', '1184:864', '864:1184', '1536:672'];

function closestRatio(width: number, height: number): string {
  const target = width / height;
  let best = IMAGE_RATIOS[0];
  let bestDelta = Infinity;
  for (const r of IMAGE_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const delta = Math.abs(w / h - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = r;
    }
  }
  return best;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function imageDataUri(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'image/jpeg';
  const uri = `data:${mime};base64,${buf.toString('base64')}`;
  if (uri.length > 5 * 1024 * 1024) {
    throw new Error(`Image ${filePath} exceeds the 5MB data-URI limit; re-encode it smaller.`);
  }
  return uri;
}

export class RealRunwayClient implements RunwayClient {
  readonly mock = false;

  constructor(private apiKey: string) {}

  private async call<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'X-Runway-Version': VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {}
      throw new Error(`Runway ${method} ${endpoint} → ${res.status}: ${message}`);
    }
    return JSON.parse(text) as T;
  }

  /** Ephemeral upload: POST /v1/uploads for a form-upload URL, then multipart POST the bytes. */
  private async uploadVideo(filePath: string): Promise<string> {
    const { uploadUrl, fields, runwayUri } = await this.call<{
      uploadUrl: string;
      fields: Record<string, string>;
      runwayUri: string;
    }>('POST', '/v1/uploads', { filename: path.basename(filePath), type: 'ephemeral' });

    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const bytes = await fs.readFile(filePath);
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), path.basename(filePath));

    const res = await fetch(uploadUrl, { method: 'POST', body: form });
    if (!res.ok) {
      throw new Error(`Upload to ${uploadUrl} failed: ${res.status} ${await res.text()}`);
    }
    return runwayUri;
  }

  async startImageEdit(req: ImageEditRequest): Promise<StartedTask> {
    const referenceImages = await Promise.all(
      req.references.map(async (r) => ({ uri: await imageDataUri(r.filePath), tag: r.tag })),
    );
    const { id } = await this.call<{ id: string }>('POST', '/v1/text_to_image', {
      model: 'gemini_image3_pro',
      promptText: req.prompt,
      ratio: closestRatio(req.width, req.height),
      referenceImages,
    });
    return { taskId: id };
  }

  async startAlephEdit(req: AlephEditRequest): Promise<StartedTask> {
    const videoUri = await this.uploadVideo(req.videoPath);
    const { id } = await this.call<{ id: string }>('POST', '/v1/video_to_video', {
      model: 'aleph2',
      videoUri,
      promptText: req.prompt,
      keyframes: [
        {
          uri: await imageDataUri(req.keyframePath),
          seconds: Math.min(req.keyframeSeconds, Math.max(0, req.durationSeconds - 0.1)),
        },
      ],
    });
    return { taskId: id };
  }

  async getTask(taskId: string): Promise<TaskSnapshot> {
    const task = await this.call<{
      status: TaskSnapshot['status'];
      output?: string[];
      failure?: string;
      progress?: number;
    }>('GET', `/v1/tasks/${taskId}`);
    return {
      status: task.status,
      outputUrls: task.output,
      failure: task.failure,
      progress: task.progress,
    };
  }

  async download(url: string, destPath: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
  }

  async getCredits(): Promise<{ creditBalance: number } | null> {
    try {
      const org = await this.call<{ creditBalance: number }>('GET', '/v1/organization');
      return { creditBalance: org.creditBalance };
    } catch {
      return null;
    }
  }
}
