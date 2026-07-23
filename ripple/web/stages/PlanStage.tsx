import { useState } from 'react';
import type { GroupJob, PlanGroup, Project } from '../../server/types.ts';
import { asset, post } from '../api.ts';

/**
 * Stages 3 & 4 — the plan is the contract. Ripple shows exactly which shots get packed
 * into which Aleph call, where each guidance keyframe comes from, and what the whole
 * propagation is estimated to cost, before a single video credit is spent.
 */
export function PlanStage({ project, executing }: { project: Project; executing: boolean }) {
  const edit = project.edit!;
  const plan = edit.plan!;
  const [error, setError] = useState<string | null>(null);

  const execute = () =>
    post(`/api/projects/${project.id}/execute`).catch((err) =>
      setError(String(err instanceof Error ? err.message : err)),
    );

  return (
    <>
      <h2 className="stage-title">{executing ? 'Propagating…' : 'The propagation plan'}</h2>
      <p className="stage-hint">
        {executing
          ? 'Groups run one at a time (the API allows a single concurrent Aleph generation). Each group: derive its guidance keyframe from your approved hero edit, run Aleph 2.0 across the whole group, then split the result back into shots.'
          : `Shots are packed in scene order into groups that fit Aleph's input window (≤30s, ≤10 cuts). Your approved keyframe guides the hero's group directly; every other group gets a keyframe derived from it — so all groups aim at the same look.`}
      </p>

      <div className="plan-groups">
        {plan.groups.map((g, i) => (
          <GroupCard key={g.id} project={project} group={g} index={i} />
        ))}
      </div>

      {!executing && (
        <div className="cost-bar">
          <span className="total mono">~{plan.estimatedCredits.toLocaleString()} cr</span>
          <span className="desc">
            Estimated: {plan.groups.length} Aleph run{plan.groups.length > 1 ? 's' : ''} at 28
            cr/sec of input +{' '}
            {plan.groups.filter((g) => !g.containsHero).length} derived keyframe
            {plan.groups.filter((g) => !g.containsHero).length === 1 ? '' : 's'}. Nothing runs
            until you approve.
          </span>
          <button className="primary" onClick={execute}>
            Propagate the edit
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </>
  );
}

function GroupCard({
  project,
  group,
  index,
}: {
  project: Project;
  group: PlanGroup;
  index: number;
}) {
  return (
    <div className="group-card">
      <div className="group-head">
        <span className="gname">Group {String.fromCharCode(65 + index)}</span>
        <span className="gmeta mono">
          {group.shotIds.length} shots · {group.totalDuration.toFixed(1)}s · {group.cuts} cuts
          {group.containsHero ? ' · hero group' : ''}
        </span>
        <span className="gcost">~{group.estimatedCredits} cr</span>
      </div>
      <div className="group-shots">
        {group.shotIds.map((id) => {
          const shot = project.shots.find((s) => s.id === id)!;
          const isAnchor = id === group.anchorShotId;
          return (
            <span key={id} className={`chip ${isAnchor ? 'anchor' : ''}`} title={shot.name}>
              <img src={asset(project.id, shot.thumb)} alt="" />
              {shot.name}
              {isAnchor && ' ⚓'}
            </span>
          );
        })}
      </div>
      <div className="group-status">
        <JobBadge
          label={group.containsHero ? 'keyframe: approved hero edit' : 'derived keyframe'}
          job={group.keyframe}
          hideIdle={!group.containsHero}
        />
        <JobBadge label="aleph 2.0" job={group.video} hideIdle />
      </div>
      {(group.keyframe.error || group.video.error) && (
        <div className="error-text">{group.keyframe.error ?? group.video.error}</div>
      )}
    </div>
  );
}

function JobBadge({ label, job, hideIdle }: { label: string; job: GroupJob; hideIdle?: boolean }) {
  if (job.status === 'idle' && hideIdle) return <span>{label}: —</span>;
  const cls =
    job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : job.status === 'idle' ? '' : 'run';
  let word: string = job.status === 'idle' ? 'ready' : job.status;
  if (job.status === 'running' && job.progress != null) {
    word = `running · ${Math.floor(job.progress * 100)}%`;
  }
  return (
    <span>
      {label}: <span className={cls}>{word}</span>
    </span>
  );
}
