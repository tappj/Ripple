import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Project } from './types.ts';

/**
 * Disk-backed project store with a change bus.
 * One directory per project under DATA_DIR, state in project.json, all media
 * files alongside it. Every mutation goes through update() so persistence and
 * SSE notification can't drift apart.
 */
export class Store {
  readonly events = new EventEmitter();
  private projects = new Map<string, Project>();

  constructor(readonly dataDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    for (const entry of await fs.readdir(this.dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await fs.readFile(path.join(this.dataDir, entry.name, 'project.json'), 'utf8');
        const project = JSON.parse(raw) as Project;
        this.projects.set(project.id, project);
      } catch {
        // Skip unreadable project dirs rather than failing startup.
      }
    }
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  dir(id: string): string {
    return path.join(this.dataDir, id);
  }

  /** Absolute path for a project-relative media file. */
  filePath(projectId: string, rel: string): string {
    return path.join(this.dir(projectId), rel);
  }

  async create(project: Project): Promise<void> {
    await fs.mkdir(this.dir(project.id), { recursive: true });
    this.projects.set(project.id, project);
    await this.persist(project);
  }

  /** Mutate a project through fn, persist, and broadcast the new state. */
  async update(id: string, fn: (p: Project) => void | Promise<void>): Promise<Project> {
    const project = this.projects.get(id);
    if (!project) throw new Error(`No project ${id}`);
    await fn(project);
    await this.persist(project);
    return project;
  }

  private async persist(project: Project): Promise<void> {
    const file = path.join(this.dir(project.id), 'project.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(project, null, 2));
    await fs.rename(file + '.tmp', file);
    this.events.emit('change', project);
  }
}
