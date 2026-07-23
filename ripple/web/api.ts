import { useEffect, useState } from 'react';
import type { Project } from '../server/types.ts';

export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

/** Live project state: initial GET + SSE updates. */
export function useProject(id: string | null): Project | null {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    api<Project>(`/api/projects/${id}`).then((p) => alive && setProject(p));
    const es = new EventSource(`/api/projects/${id}/events`);
    es.onmessage = (e) => alive && setProject(JSON.parse(e.data));
    return () => {
      alive = false;
      es.close();
    };
  }, [id]);
  return project;
}

export function useMode(): { mock: boolean } | null {
  const [mode, setMode] = useState<{ mock: boolean } | null>(null);
  useEffect(() => {
    api<{ mock: boolean }>('/api/mode').then(setMode);
  }, []);
  return mode;
}

export function useCredits(refreshKey: unknown): number | null {
  const [credits, setCredits] = useState<number | null>(null);
  useEffect(() => {
    api<{ creditBalance: number } | null>('/api/credits').then(
      (c) => setCredits(c?.creditBalance ?? null),
    );
  }, [refreshKey]);
  return credits;
}

export const asset = (projectId: string, rel: string) => `/assets/${projectId}/${rel}`;

export function timecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const f = Math.round((seconds % 1) * 24);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
