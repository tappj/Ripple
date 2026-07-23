# Ripple

**Edit one frame. Ripple it through the scene.**

Ripple is a scene-level edit propagation tool built on Runway's Aleph 2.0. You pick one frame
from one shot, approve an edit on it as a cheap still image, and Ripple propagates that edit
across every shot in the scene — with a priced plan you approve before anything runs, and a
per-shot review board for catching and retrying the shots where the model drifted.

Named after the editor's *ripple edit*: a change that flows downstream through the timeline.

**Live showcase:** https://tappj.github.io/Ripple/ · **Run it locally:** see **Run it** below.
(`plan.md` holds the original build spec; `ripple/` is the app; `docs/` is the showcase site.) Works fully offline in mock mode, no API key required.

---

## The problem (and why it's real)

Aleph 2.0 is an in-context video editor: "make the jacket yellow" and it changes only that,
preserving motion, framing, and timing. Within a single clip it even propagates the edit
across cuts. But **its world ends at one file with hard limits: ≤ 30 seconds, ≤ 10 cuts,
≤ 1080p** (verified against the live API spec, July 2026).

Real scenes don't live in one file. They're sequences of separate shots — different lengths,
different takes, collectively longer than 30 seconds. Today, applying one creative change
("the jacket is now yellow", "it's winter now", "the logo on the wall is different") to a
whole scene means running Aleph shot-by-shot, by hand, re-describing the edit each time, and
eyeballing whether the results match each other. There is no product surface for
*edit-once-propagate-everywhere with per-shot verification*. That's the gap Ripple fills.

The hard problem has two halves, and both are interface problems as much as model problems:

1. **Compilation.** One approved edit must become a *minimal set of Aleph calls* that each fit
   the 30s/10-cut window, and every call must aim at the same visual target so results agree.
2. **Trust.** N machine-applied edits are worthless if verifying them is slower than doing
   them manually. The review surface must make "did it hold?" a two-second judgment per shot,
   and recovery from a bad shot must not cost a scene re-run.

## How it works

```
ingest  →  hero frame  →  plan  →  propagate  →  review
shots      edit ONE        priced,   aleph2 per     per-shot wipe,
or one     frame as an     visible   group, timed   accept / solo
long clip  image (~15cr),  packing   keyframe       retry
           approve it      plan      guidance
```

- **Ingest** — drop per-shot files, or one exported sequence Ripple splits at detected scene
  cuts (ffmpeg). Originals are never modified.
- **Hero frame** — you scrub to the frame that best shows the target and describe the edit.
  Ripple edits that *frame* with an image model. Iterating here costs ~15 credits a try
  instead of ~420 a try on video. Approval of a still is the gate to all video spend.
- **Plan** — shots are packed in scene order into groups that fit Aleph's window. The hero's
  group is guided by your approved keyframe directly; every other group gets a keyframe
  *derived* from it (image model, with the approved edit as reference: "apply the same change
  to this frame"). The full plan — groups, anchors, estimated credits — is shown and nothing
  runs until you approve it.
- **Propagate** — per group: concat → upload → `aleph2` with the guidance keyframe pinned at
  its timestamp → poll → split the output back into shots at the known cut offsets. Groups
  run serially (the API tier allows exactly one concurrent Aleph generation).
- **Review** — every shot gets a playback-synced before/after wipe. Accept, or retry that
  shot alone: a solo Aleph run with a freshly derived keyframe and optional extra direction.
  Export stitches accepted edits (originals fill any gaps).

## The two hardest design decisions

**1. Images are the currency of intent, not text.**
Aleph 2.0 on the dev API takes *timed keyframe images* as guidance — not reference images,
not just text. So Ripple treats the approved hero *image* as the single source of truth for
what the edit means, and translates it for each group by deriving a new keyframe from it.
Text prompts drift ("mustard-yellow" renders differently call to call); an image anchor keeps
every Aleph call aiming at the same target. It also creates the cheap approval gate: you
converge on the look in ~15-credit image iterations before the first 400-credit video call.

**2. Grouping is for consistency, not cost.**
Aleph is priced per input second, so packing shots into groups doesn't save credits. Ripple
packs them anyway — consecutive shots, ≤ 30s, ≤ 10 cuts per group — because Aleph's native
cross-cut propagation *within* one call is the most consistent propagation available: one
model context sees four shots together instead of four independent edits hoping to agree.
Grouping also cuts keyframe derivations from one-per-shot to one-per-group. The per-shot
path still exists — it's exactly what "retry this shot" does.

## Run it

Requires Node ≥ 22 and ffmpeg on PATH.

```bash
cd ripple
npm install
npm run server        # → http://localhost:5175  (serves the built UI)
# or: npm run dev     # server + vite hot reload on :5174
```

- **Mock mode (default without a key):** no API key needed, zero credits. The Runway client is
  swapped for a simulator that applies a visible hue rotation as "the edit" with realistic
  async task states. Every screen, state transition, and the full pipeline (concat, split,
  re-split, export) is real — only the model calls are simulated. Force with `RIPPLE_MOCK=1`.
- **Real mode:** put a dev API key in `api-key.txt` at the repo root or `RUNWAY_API_KEY`, and run
  `npm run preflight` first — it validates the key, prints the org credit balance, and tests
  the upload path without spending anything.
- **Demo scene:** click *Load demo scene* — a bundled 4-shot, 15s generated scene (woman in a
  red rain jacket crossing a Paris street into a café) built to make propagation visibly
  checkable: try `change the red rain jacket to a mustard-yellow raincoat`.

## Where it breaks (known limitations, on purpose)

- **The dev-org credit wall.** The developer API's credit pool is separate from Runway
  app/workspace credits, and a fresh dev org can't even use ephemeral uploads until its first
  credit purchase (observed: `403: At least one credit purchase is required`). Real-mode runs
  require topping up at dev.runwayml.com. This is why mock mode is a first-class citizen and
  not an afterthought.
- **Identity jumps break propagation.** Aleph's cross-cut propagation assumes visual
  continuity. If a group cuts to a different actor or product variant, that shot can come
  back inconsistent. Ripple's answer is the review board + solo retry — detection is human;
  automatic consistency scoring would need a vision model pass (out of scope, next on the list).
- **Re-split drift.** Splitting the edited group at the original concat offsets assumes Aleph
  preserves input timing. Docs say output duration matches input; still, cut boundaries could
  drift by a frame or two. Acceptable for review; a frame-accurate mapping would need
  per-boundary scene re-detection on the output.
- **Shots under 2 seconds can't be retried solo** (Aleph minimum input). They ride along in
  groups fine; the retry button explains itself when disabled.
- **One edit at a time.** An edit session is scene-wide and singular — no stacking, no undo
  tree. Layering edits (run a second ripple on top of accepted results) is the obvious next
  feature and the data model (per-shot results feeding back to shots) was shaped with it in mind.
- **Cost estimates are estimates.** 28 cr/s (56 minimum) for Aleph and ~20/image are observed
  numbers, shown per-plan and logged per-action in the in-app ledger; the API doesn't return
  actual charged amounts per task, so the ledger is honest about being an estimate.

## Out of scope / what I'd build next

1. **Automatic drift detection** — score each propagated shot against the approved keyframe
   (CLIP/vision-model similarity on extracted frames), auto-flagging shots for review instead
   of relying on human scanning. The review board already has the exact seam for this.
2. **Edit layering** — accepted results become the new baseline; ripple another edit on top.
3. **Range-limited edits** — `aleph2` supports per-keyframe time ranges; Ripple could scope an
   edit to a beat within a shot ("only after she stands up").
4. NLE handoff (EDL/OTIO export), audio passthrough, upscaling accepted shots.

## Credits spent building this

| What | Pool | Credits (est.) |
|---|---|---|
| Demo scene generation (15s, 1080p, multi-shot) | Workspace (via MCP) | ~500–750 |
| Hero keyframe (gemini_image3_pro, real run) | Dev org | 20 (actual) |
| Aleph 2.0 propagation, 15.04s group (real run) | Dev org | 420 (actual) |
| Mock-mode development & testing | — | 0 |

The full real pass on the bundled scene cost **440 credits ($4.40)**, within 2% of the
in-app estimate (442). Estimated solo retry cost: ~130–150 per shot.

---

*Stack: Node 24 + TypeScript + Express, React + Vite, ffmpeg. State is one JSON file per
project on disk; job engine polls the async task API (≥5s per docs) and streams every state
transition to the UI over SSE. No database, no queue framework — deliberate: the interesting
complexity budget was spent on the propagation planner and the review interaction.*
