# Ripple — scene-level edit propagation for Runway Aleph 2.0

**One-line pitch:** You edit one frame. Ripple propagates that edit across every shot in the scene,
shows you exactly what it's going to spend before it spends it, and gives you a per-shot review
board to catch and retry the shots where the model drifted.

*(Named after the editor's "ripple edit" — a change that flows downstream through the timeline.)*

## Why this is a real gap (verified 2026-07-22)

- Aleph 2.0 (`aleph2` on the dev API) edits **one clip ≤ 30s, ≤ 10 cuts, ≤ 1080p**. Within that
  single file it does propagate across cuts — that's shipped. Its world ends at the file boundary.
- Real scenes are *sequences of separate shots* (separate files, arbitrary total length). There is
  no Runway product surface for: edit hero shot → propagate to N sibling clips → inspect per-shot
  consistency → selectively retry. Edit Studio is clip-by-clip.
- Cost pressure makes this an interface problem: Aleph is ~28 credits/sec of *input* (56 min).
  A wrong scene-wide edit is expensive. The interface must front-load cheap verification (image
  keyframes) and make cost a first-class UI element, not a surprise.

**The nameable hard problem:** compile one approved edit into a *minimal set of Aleph calls* under
the 30s/10-cut window constraint (a packing/planning problem), then make N machine-applied edits
*reviewable* (a trust/verification interface problem).

## Core loop (must be fully working before anything else)

1. **Ingest** — user drops in shot files (or one long clip that Ripple splits at scene cuts via
   ffmpeg). Ripple probes durations, extracts thumbnails, renders the scene as a filmstrip.
2. **Hero edit (cheap, image-first)** — user picks a frame from any shot, writes the edit
   ("change the red rain jacket to a yellow raincoat"). Ripple edits that *frame* with an image
   model (~cents). User approves / retries the still before any video credits move.
3. **Plan (visible, priced)** — Ripple packs shots into propagation groups (each ≤ 30s, ≤ 10 cuts),
   derives one guidance keyframe per group (image model, hero result as reference), and shows the
   plan: groups, per-group keyframes, **estimated credits**. Nothing runs until the user approves.
4. **Execute** — per group: concat shots (ffmpeg) → upload → `aleph2` with timed keyframe guidance
   → poll → re-split output at known cut offsets back into per-shot results.
5. **Review board** — per-shot before/after (synced side-by-side), accept / **retry** (retry = that
   shot alone, freshly derived keyframe, optional prompt adjustment). Export accepted shots +
   stitched scene.

## Architecture

- **Server:** Node 24 + TypeScript + Express. Owns: Runway API client (`/v1/uploads`,
  `/v1/video_to_video` aleph2, `/v1/text_to_image`, `/v1/tasks/{id}`, `/v1/organization`), ffmpeg
  ops (probe/split/concat/frame-extract), the propagation planner, and a polling job engine
  (≥5s interval per API docs). State = one JSON file per project on disk; assets on disk.
- **Web:** Vite + React + TypeScript SPA. Server pushes job/task state via SSE.
- **Mock mode** (`RIPPLE_MOCK=1`): the Runway client is swapped for a simulator that applies a
  visible ffmpeg hue-rotation as the "edit" with realistic task latency. The entire tool is
  demoable end-to-end with zero credits and no API key; real mode is the identical code path.

## Verified API facts this design depends on (from live OpenAPI spec, 2026-07-22)

- `POST /v1/video_to_video` model `aleph2`: `videoUri` (≤30s), optional `promptText` (≤1000 chars),
  `keyframes`: 1–5 `{uri, seconds|at, range?}` timed guidance images, `seed`, `contentModeration`.
  No `references` array on aleph2 — guidance is *timed keyframes only* → per-group keyframes must be
  derived as images first.
- `POST /v1/text_to_image`: every model variant accepts `referenceImages` → "apply the change shown
  in @hero to @frame" derivation works. Default model: `gemini_image3_pro`.
- `POST /v1/uploads` `{filename, type:"ephemeral"}` → `{uploadUrl, fields, runwayUri}` (form POST).
  Image inputs may alternatively be inline data URIs ≤ 5MB.
- `GET /v1/tasks/{id}`: PENDING/THROTTLED/RUNNING/SUCCEEDED/FAILED; poll ≥ 5s.
- `GET /v1/organization`: live `creditBalance` → in-app credits ledger.
- Tier limits: aleph2 max 1 concurrent generation, 50/day → job engine runs groups *serially*.

## Known risks / honest limitations (to document, not hide)

- **Dev API org currently has 0 credits** (verified: generation returns "not enough credits").
  Workspace credits (~100k) are a separate pool only reachable via the Runway app/MCP. Real-mode
  runs need dev-org credits; mock mode and all engineering work proceed regardless.
- Aleph propagation can break on hard identity jumps between shots — that's exactly what the review
  board + solo-shot retry exists for.
- Re-split at concat offsets assumes aleph2 preserves input timing (docs: output duration matches
  input). Minor frame drift at cut boundaries is possible; acceptable for review purposes.
- One edit at a time (no edit stacking), no audio handling, no auto QC scoring — out of scope.

## Out of scope / next

Edit layering/history, automatic consistency scoring (needs a vision LLM), NLE timeline export
(EDL/XML), multi-scene projects, upscaling pass on accepted shots.

## Budget plan (workspace + dev credits)

- Demo source scene: 1 × multi-shot generation (15s, 1080p) — workspace credits, via MCP.
- Hero keyframe iterations: image edits ~5–15 credits each, a handful expected.
- Propagation pass on ~17–20s scene: ~500–600 credits per full pass; plan for ≤ 3 passes total
  including retries → well under 2,500 credits for the whole demo. Hard stop + human check-in
  before anything approaching 10k credits.
