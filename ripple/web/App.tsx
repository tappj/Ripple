import { useEffect, useState } from 'react';
import type { Project } from '../server/types.ts';
import { api, post, useCredits, useMode, useProject } from './api.ts';
import { ProjectView } from './ProjectView.tsx';

function useHashRoute(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [hash, (h) => (location.hash = h)];
}

export function App() {
  const [route, navigate] = useHashRoute();
  const mode = useMode();
  const projectId = route.startsWith('p/') ? route.slice(2) : null;
  const project = useProject(projectId);
  const credits = useCredits(project?.creditLog.length);

  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="#">
          <span className="tick">◧</span> Ripple
        </a>
        <span className="sub">scene-level edit propagation</span>
        <div className="spacer" />
        {mode?.mock && <span className="badge-mock" title="No API key / RIPPLE_MOCK=1 — edits are simulated with a hue shift, zero credits spent">MOCK MODE</span>}
        {credits != null && (
          <span className="credits-pill">
            balance <b>{credits.toLocaleString()}</b> cr
          </span>
        )}
      </header>
      {projectId && project ? (
        <ProjectView project={project} />
      ) : (
        <Home onOpen={(id) => navigate(`p/${id}`)} />
      )}
    </div>
  );
}

function Home({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = () => api<Project[]>('/api/projects').then(setProjects);
  useEffect(() => {
    refresh();
  }, []);

  const createProject = async () => {
    const name = prompt('Scene name', 'Untitled scene');
    if (name === null) return;
    const p = await post<Project>('/api/projects', { name });
    onOpen(p.id);
  };

  const loadDemo = async () => {
    setBusy(true);
    try {
      const p = await post<Project>('/api/demo');
      onOpen(p.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="home-inner">
        <h1>
          Edit one frame.
          <br />
          <span className="amber">Ripple it</span> through the scene.
        </h1>
        <p className="lede">
          Aleph 2.0 edits one clip at a time — its world ends at a 30-second file. Ripple
          treats the whole scene as the unit: approve an edit on a single frame, see exactly
          what it will cost, propagate it across every shot, then review each one and retry
          the ones that drifted.
        </p>
        <div className="actions">
          <button className="primary" onClick={createProject}>
            New scene
          </button>
          <button onClick={loadDemo} disabled={busy}>
            {busy ? 'Splitting demo scene…' : 'Load demo scene'}
          </button>
        </div>
        {projects.length > 0 && (
          <>
            <div className="section-label">Scenes</div>
            <div className="project-list">
              {projects.map((p) => (
                <div key={p.id} className="project-row" onClick={() => onOpen(p.id)}>
                  <span className="name">{p.name}</span>
                  <span className="meta">
                    {p.shots.length} shots · {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
