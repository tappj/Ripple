import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { concat, cutSegment, detectCuts, extractFrame, probe } from './ffmpeg.ts';
import { Store } from './store.ts';
import { Engine } from './jobs.ts';
import { RealRunwayClient } from './runway.ts';
import { MockRunwayClient } from './mockRunway.ts';
import { ALEPH_MIN_SECONDS } from './planner.ts';
import type { Project, Shot } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');

// --- Runway client selection: real key if available, otherwise mock. ---
function loadApiKey(): string | null {
  if (process.env.RUNWAY_API_KEY) return process.env.RUNWAY_API_KEY.trim();
  // Convention for this repo: api-key.txt sits one level above the package.
  const keyFile = path.join(here, '..', '..', 'api-key.txt');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  return null;
}

const apiKey = loadApiKey();
const mock = process.env.RIPPLE_MOCK === '1' || !apiKey;
const client = mock
  ? new MockRunwayClient(path.join(DATA_DIR, 'mock-work'))
  : new RealRunwayClient(apiKey!);
console.log(mock ? '[ripple] MOCK mode — no credits will be spent' : '[ripple] REAL Runway API mode');

const store = new Store(DATA_DIR);
await store.init();
const engine = new Engine(store, client);

const app = express();
app.use(express.json());
const upload = multer({ dest: path.join(DATA_DIR, 'uploads-tmp') });

/** Long-running engine work is fire-and-forget; progress reaches the UI via SSE. */
function background(work: Promise<unknown>): void {
  work.catch((err) => console.error('[ripple] background job failed:', err));
}

app.get('/api/mode', (_req, res) => res.json({ mock }));

app.get('/api/credits', async (_req, res) => {
  res.json(await client.getCredits());
});

app.get('/api/projects', (_req, res) => res.json(store.list()));

app.post('/api/projects', async (req, res) => {
  const project: Project = {
    id: randomUUID(),
    name: req.body?.name || 'Untitled scene',
    createdAt: new Date().toISOString(),
    shots: [],
    creditLog: [],
  };
  await store.create(project);
  res.json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const p = store.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// SSE: full project state on every change. Projects are small; simplicity wins.
app.get('/api/projects/:id/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (p: Project) => {
    if (p.id === req.params.id) res.write(`data: ${JSON.stringify(p)}\n\n`);
  };
  store.events.on('change', send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    store.events.off('change', send);
    clearInterval(heartbeat);
  });
});

async function ingestFile(projectId: string, absPath: string, name: string, index: number): Promise<Shot> {
  const info = await probe(absPath);
  const id = randomUUID();
  const rel = path.join('shots', `${id}.mp4`);
  const thumbRel = path.join('thumbs', `${id}.jpg`);
  const dest = store.filePath(projectId, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (path.extname(name).toLowerCase() === '.mp4') {
    await fs.copyFile(absPath, dest);
  } else {
    // Normalize container so downstream concat/split is uniform.
    await cutSegment(absPath, 0, info.duration, dest);
  }
  await extractFrame(dest, info.duration / 2, store.filePath(projectId, thumbRel));
  return {
    id,
    index,
    name,
    file: rel,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    thumb: thumbRel,
  };
}

// Upload shots. `split=1` with a single file = treat it as a full scene and cut it at
// detected scene changes (the graceful path for "I have one exported clip, not shots").
app.post('/api/projects/:id/shots', upload.array('files'), async (req, res) => {
  const projectId = String(req.params.id);
  const project = store.get(projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  try {
    const shots: Shot[] = [];
    let index = project.shots.length;
    if (req.body.split === '1' && files.length === 1) {
      const src = files[0].path;
      const info = await probe(src);
      const cuts = await detectCuts(src);
      const bounds = [0, ...cuts, info.duration];
      for (let i = 0; i < bounds.length - 1; i++) {
        const segTmp = path.join(DATA_DIR, 'uploads-tmp', `${randomUUID()}.mp4`);
        await cutSegment(src, bounds[i], bounds[i + 1], segTmp);
        shots.push(await ingestFile(projectId, segTmp, `Shot ${index + 1}`, index++));
        await fs.rm(segTmp, { force: true });
      }
    } else {
      for (const f of files) {
        shots.push(await ingestFile(projectId, f.path, f.originalname, index++));
      }
    }
    for (const f of files) await fs.rm(f.path, { force: true });
    await store.update(projectId, (p) => void p.shots.push(...shots));
    res.json(store.get(projectId));
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// One-click demo: ingest the bundled generated scene and split it at its cuts.
app.post('/api/demo', async (_req, res) => {
  const demoFile = path.join(here, '..', 'demo', 'scene.mp4');
  if (!existsSync(demoFile)) {
    return res.status(404).json({ error: 'demo/scene.mp4 not found — see README for how it was generated' });
  }
  try {
    const project: Project = {
      id: randomUUID(),
      name: 'Red jacket — demo scene',
      createdAt: new Date().toISOString(),
      shots: [],
      creditLog: [],
    };
    await store.create(project);
    const info = await probe(demoFile);
    const cuts = await detectCuts(demoFile);
    const bounds = [0, ...cuts, info.duration];
    const shots: Shot[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const segTmp = path.join(DATA_DIR, 'uploads-tmp', `${randomUUID()}.mp4`);
      await cutSegment(demoFile, bounds[i], bounds[i + 1], segTmp);
      shots.push(await ingestFile(project.id, segTmp, `Shot ${i + 1}`, i));
      await fs.rm(segTmp, { force: true });
    }
    await store.update(project.id, (p) => void p.shots.push(...shots));
    res.json(store.get(project.id));
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Start an edit session: pick hero frame + instruction, immediately draft keyframe #1.
app.post('/api/projects/:id/edit', async (req, res) => {
  const { instruction, heroShotId, heroTime } = req.body ?? {};
  const project = store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const shot = project.shots.find((s) => s.id === heroShotId);
  if (!shot || typeof heroTime !== 'number' || !instruction) {
    return res.status(400).json({ error: 'instruction, heroShotId and heroTime are required' });
  }
  const heroFrameRel = path.join('frames', `hero-${randomUUID()}.jpg`);
  await extractFrame(
    store.filePath(project.id, shot.file),
    Math.min(heroTime, shot.duration - 0.05),
    store.filePath(project.id, heroFrameRel),
  );
  await store.update(project.id, (p) => {
    p.edit = {
      id: randomUUID(),
      instruction,
      heroShotId,
      heroTime,
      heroFrameFile: heroFrameRel,
      stage: 'hero-drafting',
      attempts: [],
      results: [],
    };
  });
  background(engine.generateHeroKeyframe(project.id, instruction));
  res.json(store.get(project.id));
});

// Another hero keyframe attempt (optionally with a refined prompt).
app.post('/api/projects/:id/keyframe', (req, res) => {
  const project = store.get(req.params.id);
  if (!project?.edit) return res.status(404).json({ error: 'No active edit' });
  background(engine.generateHeroKeyframe(project.id, req.body?.prompt || project.edit.instruction));
  res.json({ ok: true });
});

app.post('/api/projects/:id/approve-keyframe', async (req, res) => {
  const { attemptId } = req.body ?? {};
  const project = store.get(req.params.id);
  const attempt = project?.edit?.attempts.find((a) => a.id === attemptId);
  if (!attempt?.resultFile) return res.status(400).json({ error: 'Attempt has no result to approve' });
  await store.update(req.params.id, (p) => {
    p.edit!.approvedAttemptId = attemptId;
  });
  await engine.computePlan(req.params.id);
  res.json(store.get(req.params.id));
});

app.post('/api/projects/:id/execute', (req, res) => {
  const project = store.get(req.params.id);
  if (!project?.edit?.plan) return res.status(400).json({ error: 'No plan to execute' });
  background(engine.execute(project.id));
  res.json({ ok: true });
});

app.post('/api/projects/:id/shots/:shotId/accept', async (req, res) => {
  await store.update(req.params.id, (p) => {
    const r = p.edit!.results.find((x) => x.shotId === req.params.shotId);
    if (!r || !r.editedFile) throw new Error('Nothing to accept');
    r.status = 'accepted';
  });
  res.json({ ok: true });
});

app.post('/api/projects/:id/shots/:shotId/retry', (req, res) => {
  const project = store.get(req.params.id);
  const shot = project?.shots.find((s) => s.id === req.params.shotId);
  if (!project?.edit || !shot) return res.status(404).json({ error: 'Not found' });
  if (shot.duration < ALEPH_MIN_SECONDS) {
    return res.status(400).json({
      error: `Shot is ${shot.duration.toFixed(1)}s — Aleph needs at least ${ALEPH_MIN_SECONDS}s for a solo retry`,
    });
  }
  background(engine.retryShot(project.id, shot.id, req.body?.promptAdjustment));
  res.json({ ok: true });
});

// Discard the edit session and start over (originals are never touched).
app.delete('/api/projects/:id/edit', async (req, res) => {
  await store.update(req.params.id, (p) => {
    delete p.edit;
  });
  res.json({ ok: true });
});

// Export: accepted/ready edited shots, originals where nothing was accepted.
app.post('/api/projects/:id/export', async (req, res) => {
  const project = store.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  try {
    const parts = project.shots
      .sort((a, b) => a.index - b.index)
      .map((s) => {
        const r = project.edit?.results.find((x) => x.shotId === s.id);
        const useEdited = r?.editedFile && (r.status === 'accepted' || r.status === 'ready');
        return store.filePath(project.id, useEdited ? r!.editedFile! : s.file);
      });
    const rel = 'export.mp4';
    await concat(parts, store.filePath(project.id, rel));
    await store.update(project.id, (p) => {
      p.exportFile = rel;
    });
    res.json({ file: rel });
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

// Media files (thumbs, frames, keyframes, shots, edited results).
app.use('/assets', express.static(DATA_DIR));

// Production: serve the built SPA.
const dist = path.join(here, '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|assets).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT ?? 5175);
app.listen(port, () => console.log(`[ripple] listening on http://localhost:${port}`));
