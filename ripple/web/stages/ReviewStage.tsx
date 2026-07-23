import { useState } from 'react';
import type { Project, ShotResult } from '../../server/types.ts';
import { asset, post } from '../api.ts';
import { Compare } from '../Compare.tsx';

/**
 * Stage 5 — the trust interface. N machine-applied edits are only useful if a human can
 * verify each one fast. Every shot gets a synced before/after wipe, one-click accept,
 * and a solo retry that re-derives its keyframe (optionally with extra direction).
 */
export function ReviewStage({ project }: { project: Project }) {
  const edit = project.edit!;
  const [exportedFile, setExportedFile] = useState<string | null>(project.exportFile ?? null);
  const [error, setError] = useState<string | null>(null);

  const accepted = edit.results.filter((r) => r.status === 'accepted').length;
  const reviewable = edit.results.filter((r) => r.editedFile).length;

  const doExport = async () => {
    setError(null);
    try {
      const { file } = await post<{ file: string }>(`/api/projects/${project.id}/export`);
      setExportedFile(file);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <>
      <h2 className="stage-title">Review every shot</h2>
      <p className="stage-hint">
        Drag the wipe to compare original and edited — playback stays in sync. Accept the shots
        that hold up; retry the ones that drifted (a retry runs that shot alone with a freshly
        derived keyframe, so one bad shot never means re-running the scene).
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {accepted}/{edit.results.length} accepted
        </span>
        <div style={{ flex: 1 }} />
        {exportedFile && (
          <a
            href={asset(project.id, exportedFile)}
            download="ripple-export.mp4"
            className="mono"
            style={{ color: 'var(--green)', fontSize: 12 }}
          >
            ⬇ ripple-export.mp4
          </a>
        )}
        <button className="primary" onClick={doExport} disabled={reviewable === 0}>
          Export scene
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="review-list">
        {edit.results.map((r) => (
          <ReviewCard key={r.shotId} project={project} result={r} />
        ))}
      </div>

      <Ledger project={project} />
    </>
  );
}

function ReviewCard({ project, result }: { project: Project; result: ShotResult }) {
  const shot = project.shots.find((s) => s.id === result.shotId)!;
  const [adjustment, setAdjustment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const working = result.status === 'retrying';
  const soloBlocked = shot.duration < 2;

  const retry = async () => {
    setError(null);
    try {
      await post(`/api/projects/${project.id}/shots/${shot.id}/retry`, {
        promptAdjustment: adjustment.trim() || undefined,
      });
      setAdjustment('');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const statusCls =
    result.status === 'accepted' ? 'accepted'
    : result.status === 'ready' ? 'ready'
    : result.status === 'failed' ? 'failed'
    : 'working';

  return (
    <div className="review-card">
      <div className="head">
        <span className="name">{shot.name}</span>
        <span className="meta mono">{shot.duration.toFixed(1)}s</span>
        <span className={`status-word ${statusCls}`}>{result.status}</span>
        <div className="actions">
          {result.status === 'ready' && (
            <button
              className="primary"
              onClick={() =>
                post(`/api/projects/${project.id}/shots/${shot.id}/accept`).catch((err) =>
                  setError(String(err)),
                )
              }
            >
              Accept
            </button>
          )}
        </div>
      </div>

      {working ? (
        <div className="working-strip">
          <div className="spinner" /> re-deriving keyframe and re-running this shot…
        </div>
      ) : result.editedFile ? (
        <Compare
          before={asset(project.id, shot.file)}
          after={asset(project.id, result.editedFile)}
        />
      ) : (
        <div className="working-strip error-text">
          {result.status === 'failed' ? 'This shot failed — retry below.' : 'waiting…'}
        </div>
      )}

      {result.status !== 'accepted' && !working && (
        <div className="retry-row">
          <input
            type="text"
            placeholder='optional extra direction for the retry, e.g. "keep the hood down"'
            value={adjustment}
            onChange={(e) => setAdjustment(e.target.value)}
          />
          <button
            onClick={retry}
            disabled={soloBlocked}
            title={
              soloBlocked
                ? `Shot is ${shot.duration.toFixed(1)}s — Aleph needs ≥2s of input for a solo run`
                : undefined
            }
          >
            Retry this shot
          </button>
        </div>
      )}
      {error && <div className="error-text" style={{ padding: '0 16px 12px' }}>{error}</div>}
    </div>
  );
}

function Ledger({ project }: { project: Project }) {
  const total = project.creditLog.reduce((s, e) => s + e.estimated, 0);
  if (project.creditLog.length === 0) return null;
  return (
    <div className="ledger">
      <div className="section-label">Credit ledger (estimates)</div>
      <table>
        <tbody>
          {project.creditLog.map((e, i) => (
            <tr key={i}>
              <td>{new Date(e.at).toLocaleTimeString()}</td>
              <td>{e.what}</td>
              <td>{e.model}</td>
              <td className="num">{e.estimated}</td>
            </tr>
          ))}
          <tr className="total-row">
            <td colSpan={3}>estimated total</td>
            <td className="num">{total.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
