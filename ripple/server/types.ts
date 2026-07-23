// Shared domain types for Ripple.
// A Project holds an ordered list of Shots (separate video files forming one scene)
// and at most one active EditSession — Ripple deliberately models a single edit
// flowing through the scene at a time (edit stacking is out of scope, see README).

export type TaskStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';

export interface Shot {
  id: string;
  index: number;
  name: string;
  file: string; // relative to project dir
  duration: number;
  width: number;
  height: number;
  fps: number;
  thumb: string;
}

export type EditStage =
  | 'hero-drafting' // iterating on the hero keyframe (image-only, cheap)
  | 'planning' // keyframe approved, plan computed, awaiting user approval
  | 'executing' // groups running against Aleph
  | 'review'; // results in, per-shot accept/retry

export interface KeyframeAttempt {
  id: string;
  prompt: string;
  status: TaskStatus;
  taskId?: string;
  resultFile?: string;
  error?: string;
  createdAt: string;
}

export interface GroupJob {
  status: TaskStatus;
  taskId?: string;
  resultFile?: string;
  error?: string;
  /** 0..1, from the task API while running. */
  progress?: number;
}

export interface PlanGroup {
  id: string;
  shotIds: string[];
  totalDuration: number;
  cuts: number;
  /** Shot whose frame anchors this group's guidance keyframe. */
  anchorShotId: string;
  /** Timestamp of the anchor frame measured inside the concatenated group video. */
  anchorTime: number;
  /** True when this group contains the hero shot — its keyframe IS the approved hero keyframe. */
  containsHero: boolean;
  /** Start offset of each shot inside the concatenated group video, for re-splitting. */
  offsets: number[];
  estimatedCredits: number;
  keyframe: GroupJob; // derived guidance keyframe (image model)
  video: GroupJob; // aleph2 edit of the concatenated group
  concatFile?: string;
}

export type ShotResultStatus =
  | 'pending' // group not finished yet
  | 'ready' // edited clip available, awaiting review
  | 'accepted'
  | 'retrying'
  | 'failed';

export interface RetryAttempt {
  id: string;
  promptAdjustment?: string;
  keyframe: GroupJob;
  video: GroupJob;
  createdAt: string;
}

export interface ShotResult {
  shotId: string;
  groupId: string;
  status: ShotResultStatus;
  editedFile?: string;
  /** Most recent first. The active edited clip is retries[0].video.resultFile when present. */
  retries: RetryAttempt[];
}

export interface PropagationPlan {
  groups: PlanGroup[];
  estimatedCredits: number;
  approvedAt?: string;
}

export interface EditSession {
  id: string;
  instruction: string;
  heroShotId: string;
  heroTime: number; // seconds within the hero shot
  heroFrameFile: string; // the untouched extracted frame
  stage: EditStage;
  attempts: KeyframeAttempt[]; // hero keyframe attempts, most recent first
  approvedAttemptId?: string;
  plan?: PropagationPlan;
  results: ShotResult[];
  error?: string;
}

export interface CreditEntry {
  at: string;
  what: string;
  estimated: number;
  model: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  shots: Shot[];
  edit?: EditSession;
  /** Running log of estimated credit spend, shown in the UI ledger. */
  creditLog: CreditEntry[];
  exportFile?: string;
}

// ---- Runway client abstraction (real + mock implement this) ----

export interface ImageEditRequest {
  prompt: string;
  /** references[0] is the target frame the edit applies to. */
  references: { filePath: string; tag: string }[];
  /** target aspect, used to pick the closest supported output ratio */
  width: number;
  height: number;
}

export interface AlephEditRequest {
  videoPath: string;
  durationSeconds: number;
  prompt: string;
  keyframePath: string;
  keyframeSeconds: number;
}

export interface StartedTask {
  taskId: string;
}

export interface TaskSnapshot {
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  outputUrls?: string[];
  failure?: string;
  progress?: number;
}

export interface RunwayClient {
  readonly mock: boolean;
  startImageEdit(req: ImageEditRequest): Promise<StartedTask>;
  startAlephEdit(req: AlephEditRequest): Promise<StartedTask>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  /** Download a task output to a local file (mock resolves its own scheme). */
  download(url: string, destPath: string): Promise<void>;
  getCredits(): Promise<{ creditBalance: number } | null>;
}
