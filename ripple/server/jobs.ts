import path from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { concat, cutSegment, extractFrame } from './ffmpeg.ts';
import { alephCost, buildPlan, IMAGE_EDIT_CREDITS_ESTIMATE } from './planner.ts';
import type { Store } from './store.ts';
import type {
  GroupJob,
  PlanGroup,
  Project,
  RunwayClient,
  Shot,
  TaskSnapshot,
} from './types.ts';

/**
 * Job engine. Everything Runway-side is async task submission + polling; this
 * module owns that lifecycle and writes every transition into the project store
 * (which broadcasts to the UI over SSE). Groups execute strictly serially —
 * the API tier allows exactly one concurrent Aleph generation.
 *
 * runGroup is written to be IDEMPOTENT: every step checks persisted state and
 * skips work that already completed. That's what makes resume() safe — after a
 * server restart mid-execution, in-flight paid tasks are re-attached by taskId
 * instead of being re-submitted (and re-charged).
 */
export class Engine {
  private running = new Set<string>(); // project ids with an execution in flight

  constructor(
    private store: Store,
    private client: RunwayClient,
  ) {}

  private pollInterval(): number {
    return this.client.mock ? 1200 : 6000; // API docs: no updates more often than 5s
  }

  private async awaitTask(
    taskId: string,
    onTick?: (snap: TaskSnapshot) => Promise<void>,
  ): Promise<TaskSnapshot> {
    for (;;) {
      const snap = await this.client.getTask(taskId);
      if (onTick) await onTick(snap);
      if (snap.status === 'SUCCEEDED' || snap.status === 'FAILED') return snap;
      await new Promise((r) => setTimeout(r, this.pollInterval()));
    }
  }

  private logCredits(project: Project, what: string, model: string, estimated: number): void {
    project.creditLog.push({ at: new Date().toISOString(), what, model, estimated });
  }

  // ---- Startup recovery ----

  /**
   * Re-attach executions orphaned by a server restart. Called once at boot.
   * Policy per group, from persisted state:
   * - video running/queued WITH taskId → resume polling that task (no new spend);
   * - video 'queued' WITHOUT taskId → the crash window straddled submission; we
   *   can't know if Runway accepted it, so fail the group loudly rather than risk
   *   double-charging (~hundreds of credits) by re-submitting blind;
   * - anything not started yet → runs normally via the idempotent runGroup.
   * Shot retries interrupted mid-flight follow the same taskId-or-fail rule.
   */
  async resume(): Promise<void> {
    for (const project of this.store.list()) {
      const edit = project.edit;
      if (!edit) continue;
      if (edit.stage === 'executing') {
        console.log(`[ripple] resuming interrupted execution for project ${project.id}`);
        await this.store.update(project.id, (p) => {
          for (const g of p.edit!.plan!.groups) {
            if (g.video.status === 'queued' && !g.video.taskId) {
              g.video = {
                status: 'failed',
                error:
                  'Server restarted while this group was being submitted; it may or may not have reached Runway. Check your credit balance / recent tasks before retrying the affected shots.',
              };
            }
            if (g.keyframe.status === 'queued' || g.keyframe.status === 'running') {
              // Image derivation is cheap; safe to redo from scratch.
              if (!g.keyframe.taskId) g.keyframe = { status: 'idle' };
            }
          }
        });
        this.execute(project.id, { resumed: true }).catch((err) =>
          console.error('[ripple] resume failed:', err),
        );
      }
      // Interrupted solo retries.
      for (const r of edit.results ?? []) {
        if (r.status !== 'retrying') continue;
        const retry = r.retries[0];
        if (retry?.video.taskId && (retry.video.status === 'running' || retry.video.status === 'queued')) {
          console.log(`[ripple] resuming interrupted retry for shot ${r.shotId}`);
          this.resumeRetry(project.id, r.shotId).catch((err) =>
            console.error('[ripple] retry resume failed:', err),
          );
        } else {
          await this.store.update(project.id, (p) => {
            const result = p.edit!.results.find((x) => x.shotId === r.shotId)!;
            result.status = result.editedFile ? 'ready' : 'failed';
            if (result.retries[0] && result.retries[0].video.status !== 'succeeded') {
              result.retries[0].video = {
                status: 'failed',
                error: 'Interrupted by a server restart before the task id was recorded.',
              };
            }
          });
        }
      }
    }
  }

  // ---- Stage 1: hero keyframe (image-only, cheap) ----

  async generateHeroKeyframe(projectId: string, prompt: string): Promise<void> {
    const attemptId = randomUUID();
    await this.store.update(projectId, (p) => {
      if (!p.edit) throw new Error('No active edit session');
      p.edit.attempts.unshift({
        id: attemptId,
        prompt,
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
      this.logCredits(p, 'Hero keyframe attempt', 'gemini_image3_pro', IMAGE_EDIT_CREDITS_ESTIMATE);
    });

    const project = this.store.get(projectId)!;
    const edit = project.edit!;
    const heroShot = project.shots.find((s) => s.id === edit.heroShotId)!;

    try {
      const { taskId } = await this.client.startImageEdit({
        prompt: `${prompt}. Apply this change to @frame. Preserve everything else — composition, framing, lighting, subject identity, background — exactly as in @frame.`,
        references: [{ filePath: this.store.filePath(projectId, edit.heroFrameFile), tag: 'frame' }],
        width: heroShot.width,
        height: heroShot.height,
      });
      await this.store.update(projectId, (p) => {
        const a = p.edit!.attempts.find((x) => x.id === attemptId)!;
        a.taskId = taskId;
        a.status = 'running';
      });

      const snap = await this.awaitTask(taskId);
      if (snap.status === 'FAILED' || !snap.outputUrls?.[0]) {
        throw new Error(snap.failure ?? 'Image task failed with no output');
      }
      const rel = path.join('keyframes', `${attemptId}.jpg`);
      await this.client.download(snap.outputUrls[0], this.store.filePath(projectId, rel));
      await this.store.update(projectId, (p) => {
        const a = p.edit!.attempts.find((x) => x.id === attemptId)!;
        a.status = 'succeeded';
        a.resultFile = rel;
      });
    } catch (err) {
      await this.store.update(projectId, (p) => {
        const a = p.edit!.attempts.find((x) => x.id === attemptId)!;
        a.status = 'failed';
        a.error = String(err instanceof Error ? err.message : err);
      });
    }
  }

  // ---- Stage 2: plan ----

  async computePlan(projectId: string): Promise<void> {
    await this.store.update(projectId, (p) => {
      const edit = p.edit;
      if (!edit?.approvedAttemptId) throw new Error('Approve a hero keyframe first');
      edit.plan = buildPlan(p.shots, edit.heroShotId);
      edit.stage = 'planning';
      edit.results = p.shots.map((s) => ({
        shotId: s.id,
        groupId: edit.plan!.groups.find((g) => g.shotIds.includes(s.id))!.id,
        status: 'pending',
        retries: [],
      }));
    });
  }

  // ---- Stage 3: execute ----

  async execute(projectId: string, opts: { resumed?: boolean } = {}): Promise<void> {
    if (this.running.has(projectId)) throw new Error('Execution already in progress');
    this.running.add(projectId);
    try {
      await this.store.update(projectId, (p) => {
        if (!p.edit?.plan) throw new Error('No plan to execute');
        if (!opts.resumed) p.edit.plan.approvedAt = new Date().toISOString();
        p.edit.stage = 'executing';
      });
      const project = this.store.get(projectId)!;
      for (const group of project.edit!.plan!.groups) {
        await this.runGroup(projectId, group.id);
      }
      await this.store.update(projectId, (p) => {
        p.edit!.stage = 'review';
      });
    } finally {
      this.running.delete(projectId);
    }
  }

  private shotById(project: Project, id: string): Shot {
    return project.shots.find((s) => s.id === id)!;
  }

  private async setGroup(
    projectId: string,
    groupId: string,
    fn: (g: PlanGroup) => void,
  ): Promise<void> {
    await this.store.update(projectId, (p) => {
      const g = p.edit!.plan!.groups.find((x) => x.id === groupId)!;
      fn(g);
    });
  }

  /** Idempotent: every step checks persisted state and skips completed work. */
  private async runGroup(projectId: string, groupId: string): Promise<void> {
    let project = this.store.get(projectId)!;
    let group = project.edit!.plan!.groups.find((g) => g.id === groupId)!;
    const edit = project.edit!;

    // Nothing to do if the group already failed permanently or fully succeeded.
    if (group.video.status === 'failed') return;

    try {
      // 1. Concatenate the group's shots (also normalizes timestamps for re-split).
      const concatRel = group.concatFile ?? path.join('groups', `${group.id}.mp4`);
      if (!group.concatFile || !existsSync(this.store.filePath(projectId, concatRel))) {
        await concat(
          group.shotIds.map((id) => this.store.filePath(projectId, this.shotById(project, id).file)),
          this.store.filePath(projectId, concatRel),
        );
        await this.setGroup(projectId, groupId, (g) => (g.concatFile = concatRel));
      }

      // 2. Guidance keyframe: the hero group reuses the approved hero keyframe as-is;
      //    other groups derive one by carrying the approved edit onto their anchor frame.
      const approved = edit.attempts.find((a) => a.id === edit.approvedAttemptId)!;
      let keyframeRel: string;
      let keyframeSeconds: number;
      if (group.containsHero) {
        keyframeRel = approved.resultFile!;
        const heroIdx = group.shotIds.indexOf(edit.heroShotId);
        keyframeSeconds = group.offsets[heroIdx] + edit.heroTime;
        await this.setGroup(projectId, groupId, (g) => {
          g.keyframe = { status: 'succeeded', resultFile: keyframeRel };
          g.anchorTime = keyframeSeconds;
        });
      } else if (group.keyframe.status === 'succeeded' && group.keyframe.resultFile) {
        keyframeRel = group.keyframe.resultFile;
        keyframeSeconds = group.anchorTime;
      } else {
        keyframeSeconds = group.anchorTime;
        keyframeRel = await this.deriveKeyframe(
          projectId,
          `group-${group.id}`,
          this.store.filePath(projectId, concatRel),
          group.anchorTime,
          undefined,
          (job) => this.setGroup(projectId, groupId, (g) => (g.keyframe = job)),
        );
      }

      // 3. Aleph edit on the whole group — start fresh, or re-attach by taskId.
      let outRel: string;
      group = this.store.get(projectId)!.edit!.plan!.groups.find((g) => g.id === groupId)!;
      if (group.video.status === 'succeeded' && group.video.resultFile) {
        outRel = group.video.resultFile;
      } else if (group.video.taskId) {
        outRel = await this.finishAleph(projectId, `group-${group.id}`, group.video.taskId, (job) =>
          this.setGroup(projectId, groupId, (g) => (g.video = job)),
        );
      } else {
        outRel = await this.runAleph(
          projectId,
          `group-${group.id}`,
          concatRel,
          group.totalDuration,
          edit.instruction,
          keyframeRel,
          keyframeSeconds,
          (job) => this.setGroup(projectId, groupId, (g) => (g.video = job)),
        );
      }

      // 4. Re-split the edited group back into per-shot clips at known offsets.
      project = this.store.get(projectId)!;
      group = project.edit!.plan!.groups.find((g) => g.id === groupId)!;
      for (let i = 0; i < group.shotIds.length; i++) {
        const shot = this.shotById(project, group.shotIds[i]);
        const existing = project.edit!.results.find((x) => x.shotId === shot.id)!;
        if (existing.editedFile && existing.status !== 'pending') continue;
        const from = group.offsets[i];
        const to = from + shot.duration;
        const shotRel = path.join('edited', `${shot.id}.mp4`);
        await cutSegment(
          this.store.filePath(projectId, outRel),
          from,
          to,
          this.store.filePath(projectId, shotRel),
        );
        await this.store.update(projectId, (p) => {
          const r = p.edit!.results.find((x) => x.shotId === shot.id)!;
          r.editedFile = shotRel;
          r.status = 'ready';
        });
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      await this.store.update(projectId, (p) => {
        const g = p.edit!.plan!.groups.find((x) => x.id === groupId)!;
        if (g.video.status !== 'failed') g.video = { status: 'failed', error: message };
        for (const id of g.shotIds) {
          const r = p.edit!.results.find((x) => x.shotId === id)!;
          if (r.status === 'pending') r.status = 'failed';
        }
      });
    }
  }

  /** Carry the approved hero edit onto a target frame via the image model. */
  private async deriveKeyframe(
    projectId: string,
    label: string,
    sourceVideoAbs: string,
    atSeconds: number,
    promptAdjustment: string | undefined,
    report: (job: GroupJob) => Promise<void>,
  ): Promise<string> {
    const project = this.store.get(projectId)!;
    const edit = project.edit!;
    const approved = edit.attempts.find((a) => a.id === edit.approvedAttemptId)!;
    const heroShot = this.shotById(project, edit.heroShotId);

    const frameRel = path.join('frames', `${label}-anchor.jpg`);
    await extractFrame(sourceVideoAbs, atSeconds, this.store.filePath(projectId, frameRel));

    await report({ status: 'queued' });
    await this.store.update(projectId, (p) =>
      this.logCredits(p, `Derived keyframe (${label})`, 'gemini_image3_pro', IMAGE_EDIT_CREDITS_ESTIMATE),
    );
    const { taskId } = await this.client.startImageEdit({
      prompt:
        `Apply to @frame the exact same edit that was already applied in @edited: ${edit.instruction}. ` +
        `Match the edited result's appearance in @edited precisely — same colors, materials, and design. ` +
        `Preserve everything else about @frame exactly: composition, framing, lighting, identity, background.` +
        (promptAdjustment ? ` ${promptAdjustment}` : ''),
      references: [
        { filePath: this.store.filePath(projectId, frameRel), tag: 'frame' },
        { filePath: this.store.filePath(projectId, approved.resultFile!), tag: 'edited' },
      ],
      width: heroShot.width,
      height: heroShot.height,
    });
    await report({ status: 'running', taskId });

    const snap = await this.awaitTask(taskId);
    if (snap.status === 'FAILED' || !snap.outputUrls?.[0]) {
      const error = snap.failure ?? 'Keyframe derivation failed with no output';
      await report({ status: 'failed', taskId, error });
      throw new Error(error);
    }
    const rel = path.join('keyframes', `${label}.jpg`);
    await this.client.download(snap.outputUrls[0], this.store.filePath(projectId, rel));
    await report({ status: 'succeeded', taskId, resultFile: rel });
    return rel;
  }

  private async runAleph(
    projectId: string,
    label: string,
    videoRel: string,
    durationSeconds: number,
    prompt: string,
    keyframeRel: string,
    keyframeSeconds: number,
    report: (job: GroupJob) => Promise<void>,
  ): Promise<string> {
    await report({ status: 'queued' });
    await this.store.update(projectId, (p) =>
      this.logCredits(p, `Aleph edit (${label}, ${durationSeconds.toFixed(1)}s)`, 'aleph2', alephCost(durationSeconds)),
    );
    const { taskId } = await this.client.startAlephEdit({
      videoPath: this.store.filePath(projectId, videoRel),
      durationSeconds,
      prompt,
      keyframePath: this.store.filePath(projectId, keyframeRel),
      keyframeSeconds,
    });
    return this.finishAleph(projectId, label, taskId, report);
  }

  /** Poll a submitted Aleph task to completion, streaming progress into the store. */
  private async finishAleph(
    projectId: string,
    label: string,
    taskId: string,
    report: (job: GroupJob) => Promise<void>,
  ): Promise<string> {
    let lastPct = -1;
    const snap = await this.awaitTask(taskId, async (s) => {
      const pct = Math.floor((s.progress ?? 0) * 100);
      if (pct !== lastPct && (s.status === 'RUNNING' || s.status === 'PENDING' || s.status === 'THROTTLED')) {
        lastPct = pct;
        await report({ status: 'running', taskId, progress: s.progress ?? 0 });
      }
    });
    if (snap.status === 'FAILED' || !snap.outputUrls?.[0]) {
      const error = snap.failure ?? 'Aleph task failed with no output';
      await report({ status: 'failed', taskId, error });
      throw new Error(error);
    }
    const rel = path.join('edited', `${label}-full.mp4`);
    await this.client.download(snap.outputUrls[0], this.store.filePath(projectId, rel));
    await report({ status: 'succeeded', taskId, resultFile: rel });
    return rel;
  }

  // ---- Stage 4: per-shot retry (solo Aleph run with a freshly derived keyframe) ----

  async retryShot(projectId: string, shotId: string, promptAdjustment?: string): Promise<void> {
    const retryId = randomUUID();
    await this.store.update(projectId, (p) => {
      const r = p.edit!.results.find((x) => x.shotId === shotId)!;
      r.status = 'retrying';
      r.retries.unshift({
        id: retryId,
        promptAdjustment,
        keyframe: { status: 'idle' },
        video: { status: 'idle' },
        createdAt: new Date().toISOString(),
      });
    });

    const project = this.store.get(projectId)!;
    const shot = this.shotById(project, shotId);
    const setRetry = this.retrySetter(projectId, shotId, retryId);

    try {
      const keyframeRel = await this.deriveKeyframe(
        projectId,
        `retry-${retryId}`,
        this.store.filePath(projectId, shot.file),
        shot.duration / 2,
        promptAdjustment,
        (job) => setRetry((r) => (r.keyframe = job)),
      );
      const edit = this.store.get(projectId)!.edit!;
      const outRel = await this.runAleph(
        projectId,
        `retry-${retryId}`,
        shot.file,
        shot.duration,
        edit.instruction + (promptAdjustment ? `. ${promptAdjustment}` : ''),
        keyframeRel,
        shot.duration / 2,
        (job) => setRetry((r) => (r.video = job)),
      );
      await this.finishRetry(projectId, shotId, outRel);
    } catch {
      await this.failRetry(projectId, shotId);
    }
  }

  /** Re-attach a solo retry whose Aleph task was in flight when the server restarted. */
  private async resumeRetry(projectId: string, shotId: string): Promise<void> {
    const project = this.store.get(projectId)!;
    const result = project.edit!.results.find((x) => x.shotId === shotId)!;
    const retry = result.retries[0];
    const setRetry = this.retrySetter(projectId, shotId, retry.id);
    try {
      const outRel = await this.finishAleph(
        projectId,
        `retry-${retry.id}`,
        retry.video.taskId!,
        (job) => setRetry((r) => (r.video = job)),
      );
      await this.finishRetry(projectId, shotId, outRel);
    } catch {
      await this.failRetry(projectId, shotId);
    }
  }

  private retrySetter(projectId: string, shotId: string, retryId: string) {
    return async (fn: (r: { keyframe: GroupJob; video: GroupJob }) => void) => {
      await this.store.update(projectId, (p) => {
        const result = p.edit!.results.find((x) => x.shotId === shotId)!;
        fn(result.retries.find((x) => x.id === retryId)!);
      });
    };
  }

  private async finishRetry(projectId: string, shotId: string, outRel: string): Promise<void> {
    await this.store.update(projectId, (p) => {
      const r = p.edit!.results.find((x) => x.shotId === shotId)!;
      r.editedFile = outRel;
      r.status = 'ready';
    });
  }

  private async failRetry(projectId: string, shotId: string): Promise<void> {
    await this.store.update(projectId, (p) => {
      const r = p.edit!.results.find((x) => x.shotId === shotId)!;
      r.status = 'failed';
    });
  }
}
