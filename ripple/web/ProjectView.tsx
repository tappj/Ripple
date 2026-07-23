import { useMemo, useState } from 'react';
import type { Project, Shot } from '../server/types.ts';
import { asset, timecode } from './api.ts';
import { IngestStage } from './stages/IngestStage.tsx';
import { HeroStage } from './stages/HeroStage.tsx';
import { PlanStage } from './stages/PlanStage.tsx';
import { ReviewStage } from './stages/ReviewStage.tsx';

const STAGES = ['Ingest', 'Hero frame', 'Plan', 'Propagate', 'Review'] as const;

function activeStage(p: Project): number {
  if (p.shots.length === 0) return 0;
  if (!p.edit || p.edit.stage === 'hero-drafting') return 1;
  if (p.edit.stage === 'planning') return 2;
  if (p.edit.stage === 'executing') return 3;
  return 4;
}

export function ProjectView({ project }: { project: Project }) {
  const stage = activeStage(project);
  // Hero selection lives here (pre-session) so the filmstrip can drive it.
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const heroShotId = project.edit?.heroShotId ?? selectedShotId ?? project.shots[0]?.id ?? null;

  const shotStatus = useMemo(() => {
    const map = new Map<string, string>();
    if (!project.edit) return map;
    for (const r of project.edit.results) {
      const cls =
        r.status === 'accepted' ? 'accepted'
        : r.status === 'ready' ? 'ready'
        : r.status === 'failed' ? 'failed'
        : r.status === 'retrying' ? 'working'
        : stage === 3 ? 'working'
        : 'pending';
      map.set(r.shotId, cls);
    }
    return map;
  }, [project.edit, stage]);

  return (
    <div className="project">
      <nav className="stage-rail">
        {STAGES.map((name, i) => (
          <div key={name} className={`stage-item ${i === stage ? 'active' : i < stage ? 'done' : ''}`}>
            <span className="idx">{i < stage ? '✓' : i + 1}</span>
            {name}
          </div>
        ))}
        <div className="rail-footer">
          <div className="section-label">{project.name}</div>
        </div>
      </nav>

      <div className="stage-canvas">
        <div className="stage-body">
          {stage === 0 && <IngestStage project={project} />}
          {stage === 1 && (
            <HeroStage project={project} selectedShotId={heroShotId} />
          )}
          {(stage === 2 || stage === 3) && <PlanStage project={project} executing={stage === 3} />}
          {stage === 4 && <ReviewStage project={project} />}
        </div>

        {project.shots.length > 0 && (
          <Filmstrip
            project={project}
            heroShotId={heroShotId}
            shotStatus={shotStatus}
            selectable={stage === 1 && !project.edit}
            onSelect={setSelectedShotId}
          />
        )}
      </div>
    </div>
  );
}

function Filmstrip({
  project,
  heroShotId,
  shotStatus,
  selectable,
  onSelect,
}: {
  project: Project;
  heroShotId: string | null;
  shotStatus: Map<string, string>;
  selectable: boolean;
  onSelect: (id: string) => void;
}) {
  const shots = [...project.shots].sort((a, b) => a.index - b.index);
  let acc = 0;
  const starts = shots.map((s) => {
    const v = acc;
    acc += s.duration;
    return v;
  });
  return (
    <div className="filmstrip">
      <div className="filmstrip-head">
        <span className="section-label" style={{ marginBottom: 0 }}>
          Scene · {shots.length} shots · {timecode(acc)}
        </span>
        {selectable && (
          <span className="section-label" style={{ marginBottom: 0, color: 'var(--amber)' }}>
            click a shot to make it the hero
          </span>
        )}
      </div>
      <div className="filmstrip-track">
        {shots.map((s: Shot, i) => (
          <div
            key={s.id}
            className={`shot-card ${s.id === heroShotId ? 'hero' : ''}`}
            onClick={() => selectable && onSelect(s.id)}
            title={s.name}
          >
            <img src={asset(project.id, s.thumb)} alt={s.name} />
            <span className="tc">{timecode(starts[i])}</span>
            <span className="dur">{s.duration.toFixed(1)}s</span>
            {shotStatus.has(s.id) && <span className={`st ${shotStatus.get(s.id)}`} />}
          </div>
        ))}
      </div>
    </div>
  );
}
