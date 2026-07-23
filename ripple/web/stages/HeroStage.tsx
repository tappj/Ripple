import { useEffect, useRef, useState } from 'react';
import type { KeyframeAttempt, Project } from '../../server/types.ts';
import { asset, post, timecode } from '../api.ts';

/**
 * Stage 2 — the cheap gate. Everything here is image-model territory (~15 credits a try);
 * nothing video-priced can happen until a keyframe is explicitly approved.
 */
export function HeroStage({
  project,
  selectedShotId,
}: {
  project: Project;
  selectedShotId: string | null;
}) {
  const edit = project.edit;
  return edit ? <Drafting project={project} /> : <Setup project={project} shotId={selectedShotId} />;
}

function Setup({ project, shotId }: { project: Project; shotId: string | null }) {
  const shot = project.shots.find((s) => s.id === shotId) ?? project.shots[0];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setT(0), [shot?.id]);
  if (!shot) return null;

  const scrub = (v: number) => {
    setT(v);
    if (videoRef.current) videoRef.current.currentTime = v;
  };

  const start = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/projects/${project.id}/edit`, {
        instruction: instruction.trim(),
        heroShotId: shot.id,
        heroTime: t,
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="stage-title">Pick the hero frame</h2>
      <p className="stage-hint">
        Choose the shot and the exact frame that shows what you want to change, then describe
        the edit. Ripple edits this <em>frame</em> first — a few cents to get the look right
        before any video credits move.
      </p>
      <div className="hero-grid">
        <div>
          <div className="hero-viewer">
            <video
              ref={videoRef}
              src={asset(project.id, shot.file)}
              muted
              playsInline
              preload="auto"
            />
          </div>
          <div className="scrub-row">
            <span className="tc mono">{timecode(t)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0.1, shot.duration - 0.05)}
              step={0.041}
              value={t}
              onChange={(e) => scrub(Number(e.target.value))}
            />
            <span className="tc mono" style={{ textAlign: 'right' }}>
              {timecode(shot.duration)}
            </span>
          </div>
        </div>
        <div>
          <div className="section-label">The edit</div>
          <textarea
            rows={4}
            placeholder='e.g. "change the red rain jacket to a mustard-yellow raincoat"'
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <p className="stage-hint" style={{ margin: '12px 0' }}>
            Describe one change, concretely. Everything you don't mention is preserved.
          </p>
          <button className="primary" onClick={start} disabled={busy || !instruction.trim()}>
            {busy ? 'Extracting frame…' : 'Draft the edit on this frame'}
          </button>
          {error && <div className="error-text">{error}</div>}
        </div>
      </div>
    </>
  );
}

function Drafting({ project }: { project: Project }) {
  const edit = project.edit!;
  const [retryPrompt, setRetryPrompt] = useState(edit.instruction);
  const [error, setError] = useState<string | null>(null);
  const working = edit.attempts.some((a) => a.status === 'queued' || a.status === 'running');

  const call = (fn: () => Promise<unknown>) => () =>
    fn().catch((err) => setError(String(err instanceof Error ? err.message : err)));

  return (
    <>
      <h2 className="stage-title">Approve the look</h2>
      <p className="stage-hint">
        “{edit.instruction}” — drafted on the hero frame. Approve the version that nails it, or
        refine the wording and try again. Each attempt is an image generation (~15 credits);
        approval is what unlocks the priced propagation plan.
      </p>
      <div className="hero-grid">
        <div>
          <div className="section-label">Original frame</div>
          <div className="hero-viewer">
            <img
              src={asset(project.id, edit.heroFrameFile)}
              style={{ width: '100%', display: 'block' }}
              alt="hero frame"
            />
          </div>
          <div className="retry-row" style={{ padding: '12px 0' }}>
            <input
              type="text"
              value={retryPrompt}
              onChange={(e) => setRetryPrompt(e.target.value)}
              placeholder="refine the instruction…"
            />
            <button
              disabled={working}
              onClick={call(() => post(`/api/projects/${project.id}/keyframe`, { prompt: retryPrompt }))}
            >
              New attempt
            </button>
          </div>
          <button
            className="danger-ghost"
            onClick={call(async () => {
              await fetch(`/api/projects/${project.id}/edit`, { method: 'DELETE' });
            })}
          >
            Discard this edit
          </button>
        </div>
        <div className="attempts">
          <div className="section-label">
            Attempts ({edit.attempts.length})
          </div>
          {edit.attempts.map((a) => (
            <Attempt
              key={a.id}
              projectId={project.id}
              attempt={a}
              approved={edit.approvedAttemptId === a.id}
              onApprove={call(() =>
                post(`/api/projects/${project.id}/approve-keyframe`, { attemptId: a.id }),
              )}
            />
          ))}
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}

function Attempt({
  projectId,
  attempt,
  approved,
  onApprove,
}: {
  projectId: string;
  attempt: KeyframeAttempt;
  approved: boolean;
  onApprove: () => void;
}) {
  return (
    <div className={`attempt ${approved ? 'approved' : ''}`}>
      <div className="img-wrap">
        {attempt.status === 'succeeded' && attempt.resultFile ? (
          <img src={asset(projectId, attempt.resultFile)} alt={attempt.prompt} />
        ) : attempt.status === 'failed' ? (
          <div className="working-strip error-text">{attempt.error ?? 'failed'}</div>
        ) : (
          <div className="working-strip">
            <div className="spinner" />
            {attempt.status === 'queued' ? 'queued' : 'generating'}…
          </div>
        )}
      </div>
      <div className="row">
        <span className="prompt-text">{attempt.prompt}</span>
        {attempt.status === 'succeeded' && (
          <button className="primary" onClick={onApprove}>
            {approved ? 'Approved ✓' : 'Approve & plan'}
          </button>
        )}
      </div>
    </div>
  );
}
