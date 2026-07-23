import { randomUUID } from 'node:crypto';
import type { PlanGroup, PropagationPlan, Shot } from './types.ts';

// Aleph 2.0 input constraints + pricing, verified against the live API docs 2026-07-22.
export const ALEPH_MAX_SECONDS = 30;
export const ALEPH_MAX_CUTS = 10;
export const ALEPH_MIN_SECONDS = 2;
export const ALEPH_CREDITS_PER_SECOND = 28;
export const ALEPH_MIN_CREDITS = 56;
export const IMAGE_EDIT_CREDITS_ESTIMATE = 20; // observed actual for gemini_image3_pro (July 2026)

export function alephCost(seconds: number): number {
  return Math.max(ALEPH_MIN_CREDITS, Math.ceil(seconds * ALEPH_CREDITS_PER_SECOND));
}

/**
 * Pack the scene's shots into propagation groups.
 *
 * Why greedy-consecutive: shots are packed in scene order so each Aleph call sees
 * narratively adjacent footage (same location/subject), which is what its native
 * cross-cut propagation is good at. Each group must fit Aleph's input window:
 * ≤ 30s total and ≤ 10 cuts (cuts = shots-1, assuming single-take source shots).
 *
 * Cost note: grouping doesn't reduce Aleph cost (priced per input second) — what it
 * buys is *consistency* (one propagation context instead of N independent edits)
 * and fewer keyframe derivations (one image call per group instead of per shot).
 */
export function buildPlan(shots: Shot[], heroShotId: string): PropagationPlan {
  const groups: PlanGroup[] = [];
  let current: Shot[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const total = current.reduce((s, x) => s + x.duration, 0);
    const containsHero = current.some((s) => s.id === heroShotId);
    // Anchor on the hero shot when present; otherwise the longest shot in the
    // group — it gives the image model the most representative frame to carry
    // the edit onto, and Aleph the longest runway around the guidance frame.
    const anchor = containsHero
      ? current.find((s) => s.id === heroShotId)!
      : current.reduce((a, b) => (b.duration > a.duration ? b : a));
    const offsets: number[] = [];
    let acc = 0;
    for (const s of current) {
      offsets.push(acc);
      acc += s.duration;
    }
    const anchorOffset = offsets[current.indexOf(anchor)];
    groups.push({
      id: randomUUID(),
      shotIds: current.map((s) => s.id),
      totalDuration: total,
      cuts: current.length - 1,
      anchorShotId: anchor.id,
      // Guidance frame sits at the anchor shot's midpoint inside the concat.
      anchorTime: anchorOffset + anchor.duration / 2,
      containsHero,
      offsets,
      estimatedCredits:
        alephCost(total) + (containsHero ? 0 : IMAGE_EDIT_CREDITS_ESTIMATE),
      keyframe: { status: 'idle' },
      video: { status: 'idle' },
    });
    current = [];
  };

  for (const shot of [...shots].sort((a, b) => a.index - b.index)) {
    const total = current.reduce((s, x) => s + x.duration, 0);
    if (
      current.length > 0 &&
      (total + shot.duration > ALEPH_MAX_SECONDS || current.length >= ALEPH_MAX_CUTS + 1)
    ) {
      flush();
    }
    current.push(shot);
  }
  flush();

  return {
    groups,
    estimatedCredits: groups.reduce((s, g) => s + g.estimatedCredits, 0),
  };
}
