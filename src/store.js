import * as THREE from 'three'
import { create } from 'zustand'

function modelCenter(pieces) {
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox)
  }
  return box.getCenter(new THREE.Vector3())
}

// Slicer invariant: the plate is fixed at y=0 and the model always RESTS on
// it, centred — never floating. Returns the translation it applied so the
// caller can fold it into the undoable transform matrix.
function groundAndCenter(pieces) {
  if (!pieces.length) return [0, 0, 0]
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox)
  }
  const c = box.getCenter(new THREE.Vector3())
  const dx = -c.x
  const dy = -box.min.y
  const dz = -c.z
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4 && Math.abs(dz) < 1e-4) return [0, 0, 0]
  for (const p of pieces) p.geometry.translate(dx, dy, dz)
  return [dx, dy, dz]
}

// Re-seat pieces on the plate (y only) without touching x/z — used when a
// transform covered only SOME of the pieces: the others must not shift.
function groundY(pieces) {
  const box = new THREE.Box3()
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox)
  }
  const dy = -box.min.y
  if (Math.abs(dy) < 1e-4) return [0, 0, 0]
  for (const p of pieces) p.geometry.translate(0, dy, 0)
  return [0, dy, 0]
}

// Apply a transform to the TARGET pieces (about their own centre, then
// re-grounded) and return the TOTAL affine matrix — undo is its exact
// inverse, no geometry snapshots needed. Full x/z recentring only happens
// when the transform covered every piece (single-model behaviour unchanged).
function transformPieces(targets, makeM, all = targets) {
  const c = modelCenter(targets)
  const m = new THREE.Matrix4()
    .makeTranslation(c.x, c.y, c.z)
    .multiply(makeM())
    .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
  // applyMatrix4 refreshes an already-computed boundingBox itself.
  for (const p of targets) p.geometry.applyMatrix4(m)
  const d = targets.length === all.length ? groundAndCenter(targets) : groundY(targets)
  return new THREE.Matrix4().makeTranslation(d[0], d[1], d[2]).multiply(m)
}

// History entries: { kind: 'snapshot', pieces } for topology changes,
// { kind: 'matrix', inverse } for in-place transforms. LIFO order keeps the
// shared-geometry mutations consistent. Any new action clears the redo stack.
const HISTORY_MAX = 30
function pushEntry(s, entry) {
  return { history: [...s.history, entry].slice(-HISTORY_MAX), future: [] }
}
// ids: piece ids the matrix applies to on undo/redo — null means all pieces.
function matrixEntry(total, ids = null) {
  return { kind: 'matrix', inverse: total.clone().invert().toArray(), ids }
}

export const CONNECTOR_PRESETS = {
  pin: { pinDiameter: 6, pinLength: 8, tolerance: 0.15, spacing: 25 },
  square: { pinDiameter: 6, pinLength: 8, tolerance: 0.2, spacing: 25 },
  hex: { pinDiameter: 6, pinLength: 8, tolerance: 0.2, spacing: 25 },
  dowel: { pinDiameter: 8, pinLength: 35, tolerance: 0.2, spacing: 45 }
}

// pieces: [{ id, name, geometry, visible }] — geometry is a THREE.BufferGeometry
export const useStore = create((set) => ({
  lang: navigator.language.startsWith('fr') ? 'fr' : 'en',
  setLang: (lang) => set({ lang }),

  modelName: null,
  pieces: [],
  history: [],
  future: [],
  busy: false,
  error: null,

  explode: 0,
  setExplode: (explode) => set({ explode }),

  // Cut plane as a posed object: pos + quat (local +Z = cut normal).
  plane: { pos: [0, 0, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
  setPlane: (patch) => set((s) => ({ plane: { ...s.plane, ...patch } })),

  // === MULTI-CUT PLANES ===
  cutPlanes: [],
  addCutPlane: (plane) => set((s) => ({
    cutPlanes: [...s.cutPlanes, { id: Date.now(), ...plane }]
  })),
  removeCutPlane: (id) => set((s) => ({
    cutPlanes: s.cutPlanes.filter(p => p.id !== id)
  })),
  updateCutPlane: (id, updates) => set((s) => ({
    cutPlanes: s.cutPlanes.map(p => p.id === id ? { ...p, ...updates } : p)
  })),
  clearCutPlanes: () => set({ cutPlanes: [] }),
  // ========================

  cutParams: {
    kerf: 0.15,
    pins: true,
    pinDiameter: 6,
    pinLength: 8,
    tolerance: 0.15,
    taper: true,
    connectorType: 'pin',
    spacing: 25
  },
  setCutParams: (patch) => set((s) => ({ cutParams: { ...s.cutParams, ...patch } })),

  // Each connector shape carries a real-world preset — picking "dowel" means
  // standard 8 x 35 mm wooden dowels with a 0.2 mm hole clearance. Values
  // stay editable after the switch.
  setConnectorType: (type) =>
    set((s) => ({
      cutParams: {
        ...s.cutParams,
        connectorType: type,
        ...(CONNECTOR_PRESETS[type] ?? {})
      }
    })),

  // Size of the model as imported (after the m→mm fix, if applied) — the
  // "original size" the reset button returns to.
  importDims: null,

  setModel: (name, geometry) => {
    const pieces = [{ id: 1, name, geometry, visible: true }]
    groundAndCenter(pieces)
    geometry.computeBoundingBox()
    const sz = geometry.boundingBox.getSize(new THREE.Vector3())
    return set({
      modelName: name,
      importDims: [sz.x, sz.y, sz.z],
      pieces,
      history: [],
      future: [],
      explode: 0,
      error: null
    })
  },

  centerModel: () =>
    set((s) => {
      const d = groundAndCenter(s.pieces)
      if (!d[0] && !d[1] && !d[2]) return {}
      const m = new THREE.Matrix4().makeTranslation(d[0], d[1], d[2])
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m)) }
    }),

  replacePiece: (id, newPieces) =>
    set((s) => {
      const idx = s.pieces.findIndex((p) => p.id === id)
      if (idx === -1) return {}
      const pieces = [...s.pieces]
      pieces.splice(idx, 1, ...newPieces)
      return { pieces, ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces }) }
    }),

  undo: () =>
    set((s) => {
      if (!s.history.length) return {}
      const history = [...s.history]
      const entry = history.pop()
      if (entry.kind === 'matrix') {
        const inv = new THREE.Matrix4().fromArray(entry.inverse)
        const targets = entry.ids ? s.pieces.filter((p) => entry.ids.includes(p.id)) : s.pieces
        for (const p of targets) p.geometry.applyMatrix4(inv)
        return {
          pieces: [...s.pieces],
          history,
          future: [...s.future, matrixEntry(inv, entry.ids)]
        }
      }
      return {
        pieces: entry.pieces,
        history,
        future: [...s.future, { kind: 'snapshot', pieces: s.pieces }]
      }
    }),

  redo: () =>
    set((s) => {
      if (!s.future.length) return {}
      const future = [...s.future]
      const entry = future.pop()
      if (entry.kind === 'matrix') {
        const inv = new THREE.Matrix4().fromArray(entry.inverse)
        const targets = entry.ids ? s.pieces.filter((p) => entry.ids.includes(p.id)) : s.pieces
        for (const p of targets) p.geometry.applyMatrix4(inv)
        return {
          pieces: [...s.pieces],
          future,
          history: [...s.history, matrixEntry(inv, entry.ids)].slice(-HISTORY_MAX)
        }
      }
      return {
        pieces: entry.pieces,
        future,
        history: [...s.history, { kind: 'snapshot', pieces: s.pieces }].slice(-HISTORY_MAX)
      }
    }),

  // Transforms act on ONE piece when an id is given (selection-gated UI),
  // on the whole plate when omitted.
  rotateModelQuaternion: (q, id = null) =>
    set((s) => {
      const targets = id ? s.pieces.filter((p) => p.id === id) : s.pieces
      if (!targets.length) return {}
      const m = transformPieces(
        targets,
        () => new THREE.Matrix4().makeRotationFromQuaternion(q),
        s.pieces
      )
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m, id ? [id] : null)) }
    }),

  rotateModel: (axis, deg, id = null) =>
    set((s) => {
      const targets = id ? s.pieces.filter((p) => p.id === id) : s.pieces
      if (!targets.length) return {}
      const rad = THREE.MathUtils.degToRad(deg)
      const m = transformPieces(
        targets,
        () => new THREE.Matrix4()[`makeRotation${axis.toUpperCase()}`](rad),
        s.pieces
      )
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m, id ? [id] : null)) }
    }),

  resizeModel: (fx, fy, fz, id = null) =>
    set((s) => {
      const targets = id ? s.pieces.filter((p) => p.id === id) : s.pieces
      if (!targets.length) return {}
      const m = transformPieces(targets, () => new THREE.Matrix4().makeScale(fx, fy, fz), s.pieces)
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m, id ? [id] : null)) }
    }),

  // Slide one piece across the plate (move gizmo bake) — y never changes,
  // the piece keeps resting on the plate.
  translatePiece: (id, dx, dz) =>
    set((s) => {
      const piece = s.pieces.find((p) => p.id === id)
      if (!piece || (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4)) return {}
      piece.geometry.translate(dx, 0, dz)
      const m = new THREE.Matrix4().makeTranslation(dx, 0, dz)
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m, [id])) }
    }),

  scaleModel: (factor) =>
    set((s) => {
      for (const p of s.pieces) {
        p.geometry.scale(factor, factor, factor)
      }
      const d = groundAndCenter(s.pieces)
      const m = new THREE.Matrix4()
        .makeTranslation(d[0], d[1], d[2])
        .multiply(new THREE.Matrix4().makeScale(factor, factor, factor))
      return {
        pieces: [...s.pieces],
        // The unit fix redefines what "original size" means.
        importDims: s.importDims ? s.importDims.map((v) => v * factor) : null,
        ...pushEntry(s, matrixEntry(m))
      }
    }),

  setPiecesBulk: (pieces) =>
    set((s) => ({ pieces, ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces }) })),

  replaceAllGeometries: (geoms) =>
    set((s) => {
      if (geoms.length !== s.pieces.length) return {}
      return {
        pieces: s.pieces.map((p, i) => ({ ...p, geometry: geoms[i] })),
        ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces })
      }
    }),

  togglePiece: (id) =>
    set((s) => ({
      pieces: s.pieces.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p))
    })),

  // === MULTI-CUT EXECUTION ===
  performMultiCut: () => set((s) => {
    if (!s.cutPlanes.length) return {}
    // Per ora svuota i piani dopo il taglio — la logica booleana vera
    // andrà collegata al worker esistente in un secondo step
    return {
      cutPlanes: [],
      ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces })
    }
  }),
  // ===========================

  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error })
}))

let nextId = 2
export const newPieceId = () => nextId++
