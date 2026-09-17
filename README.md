# SliceForge

Cut 3D models into printable pieces joined by alignment pins — fully in the browser.

Import a model, position a cutting plane, and SliceForge splits it into watertight solids
with matching peg/socket pairs across the seam, ready to drop into any slicer
(Cura, BambuStudio, PrusaSlicer, Lychee…).

## Features (v0.1)

- **Import** STL / OBJ / GLB / GLTF / 3MF (drag & drop or file picker) — start
  from a clean empty workspace and import your own model
- **Model setup** — model always lands centred and resting on the plate
  (auto-grounded after every rotation/resize), right-click menu to re-centre
  or refit the view, per-axis rotation (±15° / ±90°), in-view rotation wheel,
  place-on-face (click a face, the model lies flat on it), resize by target
  dimensions (proportions locked or per-axis), one-click return to the size
  at import (orientation-aware — never distorts a rotated model), one-click
  m→mm fix for metre-unit exports
- **Per-piece transforms** — click a piece to select it with precise
  per-triangle picking that follows anterior / lateral / posterior curvature
  (a lone piece is selected automatically): move it across the plate with
  in-view arrows, rotate, resize or place it on a face — the other pieces
  never budge, and undo reverses just that piece. The toolbar separates
  transform tools from cutting tools
- **Plane cut** — axis + offset + two tilt angles, optional kerf (blade clearance)
- **Puzzle blocks** — slice a (life-size) model into printable blocks of a
  chosen size (e.g. 230 x 230 x 230 mm), with a live preview of every cut
  plane on the model before you commit, and connectors on every interface:
  round, square or hex pegs, or dowel holes preset for standard 8 x 35 mm
  wooden dowels (adjustable hole clearance) — and a printable dowel part at
  the exact nominal diameter is added next to the model, count in its name; connectors NEVER pierce the
  outer shell — reservations keep a 1.2 mm wall, slide to a 30/70 split when
  one side is shallow, or are skipped; preview them as orange ghosts before
  committing the cut — then drag, add or remove them by hand on their
  planes (collision-guarded: connectors can never run into each other)
- **Shape cut** — click a protruding detail (a hand, an ear): precise
  geodesic region growing follows the anterior, lateral and posterior
  curvature up to the surrounding creases, then detaches exactly along its
  boundary as its own watertight piece
- **Box cut** — position/rotate/scale a box in the viewport and detach
  whatever falls inside it (a hand, a head) as its own piece
- **Alignment pins** — cylindrical peg/socket pairs auto-placed across the cut
  cross-section (as many as the minimum spacing you set allows), printable
  tolerance; pin diameter/length configurable; tapered option (tip 80%)
  for easy assembly — or place them BY HAND: the parts turn transparent and
  each click on the plane drops a connector exactly there
- **Color aware** — vertex colors and material colors survive import,
  cutting and simplification; cut faces render a clean neutral grey
- **Mesh simplification** — decimate heavy scans to a chosen percentage
  (meshoptimizer), model stays cuttable
- **Watertight output** — all booleans run through [Manifold](https://github.com/elalish/manifold)
  (WASM), which guarantees manifold, hole-free results
- **Pieces manager** — visibility toggles, exploded view with a millimetre spacing slider, full undo/redo
  (Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z) across cuts, transforms and simplification
- **Export** STL (one file per piece), 3MF (all pieces in one file), OBJ, GLB
- **FR / EN** interface
- 100 % client-side — no upload, no account, models never leave the machine

## Roadmap

- [ ] Color cut — select a color zone by clicking it, cut per zone
- [ ] Dovetail connectors, manual pin placement
- [ ] Mesh repair for non-manifold inputs
- [ ] Orthographic view, measurement tools

## Development

```bash
npm install
npm run dev     # local dev server
npm run build   # production build in dist/
```

Stack: Vite + React + zustand + Three.js + manifold-3d (WASM). No backend.

## License

MIT. This is an independent, from-scratch implementation; it contains no code or
assets from any other product.
