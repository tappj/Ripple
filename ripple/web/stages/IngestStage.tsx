import { useRef, useState } from 'react';
import type { Project } from '../../server/types.ts';

export function IngestStage({ project }: { project: Project }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith('video/') || f.name.endsWith('.mp4'));
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of list) form.append('files', f);
      // One file + split on → treat it as a full scene export and cut it at scene changes.
      if (split && list.length === 1) form.append('split', '1');
      const res = await fetch(`/api/projects/${project.id}/shots`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Upload failed');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="stage-title">Bring in the scene</h2>
      <p className="stage-hint">
        Drop the shots that make up one scene — either individual clips in order, or a single
        exported sequence that Ripple will cut apart at detected scene changes. Originals are
        never modified.
      </p>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          uploadFiles(e.dataTransfer.files);
        }}
      >
        {busy ? (
          <div className="working-strip">
            <div className="spinner" /> ingesting — probing, splitting, extracting thumbnails…
          </div>
        ) : (
          <>
            <div className="big">Drop video files here</div>
            <div className="fine">mp4 / mov · one scene at a time</div>
            <button onClick={() => inputRef.current?.click()}>Choose files</button>
            <br />
            <label className="split-toggle">
              <input
                type="checkbox"
                checked={split}
                onChange={(e) => setSplit(e.target.checked)}
              />
              single file is a full scene — auto-split at cuts
            </label>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        />
      </div>
      {error && <div className="error-text">{error}</div>}
    </>
  );
}
