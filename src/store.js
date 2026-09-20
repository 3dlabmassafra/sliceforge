import * as THREE from 'three'
import { create } from 'zustand'
import { AXIS_QUATS, computePlaneFromBBox } from './geometry/plane.js'

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
  for (const p of targets) p.geometry.applyMatrix4(m)
  const d = targets.length === all.length ? groundAndCenter(targets) : groundY(targets)
  return new THREE.Matrix4().makeTranslation(d[0], d[1], d[2]).multiply(m)
}

const HISTORY_MAX = 30
function pushEntry(s, entry) {
  return { history: [...s.history, entry].slice(-HISTORY_MAX), future: [] }
}
function matrixEntry(total, ids = null) {
  return { kind: 'matrix', inverse: total.clone().invert().toArray(), ids }
}

export const CONNECTOR_PRESETS = {
  pin: { pinDiameter: 6, pinLength: 8, tolerance: 0.15, spacing: 25 },
  square: { pinDiameter: 6, pinLength: 8, tolerance: 0.2, spacing: 25 },
  hex: { pinDiameter: 6, pinLength: 8, tolerance: 0.2, spacing: 25 },
  dovetail: { pinDiameter: 8, pinLength: 10, tolerance: 0.2, spacing: 25 },
  dowel: { pinDiameter: 8, pinLength: 35, tolerance: 0.2, spacing: 45 }
}

// pieces: [{ id, name, geometry, visible }] — geometry is a THREE.BufferGeometry
export const useStore = create((set, get) => ({
  lang: navigator.language.startsWith('it')
    ? 'it'
    : navigator.language.startsWith('fr')
    ? 'fr'
    : navigator.language.startsWith('pt')
    ? 'pt'
    : navigator.language.startsWith('es')
    ? 'es'
    : 'en',
  setLang: (lang) => set({ lang }),

  modelName: null,
  pieces: [],
  draftMode: false,
  draftCuts: [],
  draftSource: null,
  history: [],
  future: [],
  busy: false,
  error: null,

  explode: 0,
  setExplode: (explode) => set({ explode }),

  // Cut plane as a posed object: pos + quat (local +Z = cut normal).
  plane: { pos: [0, 0, 0], quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
  setPlane: (patch) => set((s) => ({ plane: { ...s.plane, ...patch } })),

  // === SMART CUT / NATIVOS 3D PARITY STATE ===
  planeCutMode: 'infinite', // 'infinite' | 'plate'
  setPlaneCutMode: (mode) => set({ planeCutMode: mode }),

  cutPlaneAxis: 'y', // 'x' | 'y' | 'z'
  setCutPlaneAxis: (axis) => {
    const { pieces, cutPlaneAxis, cutPlaneFlip, plane } = get()
    if (!pieces.length) {
      set({ cutPlaneAxis: axis })
      return
    }
    const box = new THREE.Box3()
    pieces.forEach((p) => {
      if (p.geometry) {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      }
    })
    // Keep the current relative position when switching axis: derive the
    // ratio from where the plane sits on the OLD axis, not from a stale state.
    const oldAxis = cutPlaneAxis
    const oldMin = box.min[oldAxis]
    const oldSpan = Math.max(1e-6, box.max[oldAxis] - oldMin)
    // plane.pos is an array — index it by axis position, not by name
    const axIdx = { x: 0, y: 1, z: 2 }[oldAxis] ?? 1
    const ratio = Math.min(1, Math.max(0, (plane.pos[axIdx] - oldMin) / oldSpan))
    const { pos, quat } = computePlaneFromBBox(box, axis, ratio, cutPlaneFlip)
    set({
      cutPlaneAxis: axis,
      cutPlaneOffset: ratio,
      plane: { pos, quat }
    })
  },

  cutPlaneOffset: 0.5,
  // Slide the plane along the current axis ONLY — a tilted plane (rotated
  // with the gizmo or snapped to a face) keeps its orientation.
  setCutPlaneOffset: (offset) => {
    const { pieces, cutPlaneAxis, cutPlaneFlip, plane } = get()
    if (!pieces.length) {
      set({ cutPlaneOffset: offset })
      return
    }
    const box = new THREE.Box3()
    pieces.forEach((p) => {
      if (p.geometry) {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      }
    })
    const { pos } = computePlaneFromBBox(box, cutPlaneAxis, offset, cutPlaneFlip)
    set({ cutPlaneOffset: offset, plane: { pos, quat: plane.quat } })
  },

  cutPlaneFlip: false,
  // Flip = rotate 180° about the plane's local X axis: the normal inverts
  // while any user tilt is preserved (canonical axis quats land exactly on
  // the preset inverse quats).
  toggleCutPlaneFlip: () => {
    const { plane } = get()
    const flipQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI
    )
    const nextQuat = new THREE.Quaternion(...plane.quat).multiply(flipQ).toArray()
    set((s) => ({ cutPlaneFlip: !s.cutPlaneFlip, plane: { ...s.plane, quat: nextQuat } }))
  },

  // Bounded limitation plate state
  plateCutPosition: [0, 0, 0],
  setPlateCutPosition: (pos) => set({ plateCutPosition: pos }),

  plateCutRotation: [0, 0, 0], // euler angles [x, y, z] in radians
  setPlateCutRotation: (rot) => set({ plateCutRotation: rot }),

  plateCutWidth: 100,
  plateCutHeight: 100,
  setPlateCutSize: (w, h) => set({ plateCutWidth: w, plateCutHeight: h }),

  plateMoveMode: true, // true = click / drag on scene, false = transform gizmo
  setPlateMoveMode: (mode) => set({ plateMoveMode: mode }),

  initPlateFromModel: () => {
    const { pieces } = get()
    if (!pieces.length) return
    const box = new THREE.Box3()
    pieces.forEach((p) => {
      if (p.geometry) {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      }
    })
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z) || 100
    set({
      plateCutPosition: [center.x, center.y, center.z],
      plateCutRotation: [0, 0, 0],
      plateCutWidth: Math.round(maxDim * 0.7),
      plateCutHeight: Math.round(maxDim * 0.7),
      plateMoveMode: true
    })
  },
  // ============================================

  // === MULTI-CUT PLANES ===
  cutPlanes: [],
  addCutPlane: (plane) =>
    set((s) => ({
      cutPlanes: [...s.cutPlanes, { id: Date.now(), ...plane }]
    })),
  removeCutPlane: (id) =>
    set((s) => ({
      cutPlanes: s.cutPlanes.filter((p) => p.id !== id)
    })),
  updateCutPlane: (id, updates) =>
    set((s) => ({
      cutPlanes: s.cutPlanes.map((p) => (p.id === id ? { ...p, ...updates } : p))
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
    connectorRot: 0,
    pinSide: 'a',
    spacing: 25
  },
  setCutParams: (patch) => set((s) => ({ cutParams: { ...s.cutParams, ...patch } })),

  setConnectorType: (type) =>
    set((s) => ({
      cutParams: {
        ...s.cutParams,
        connectorType: type,
        ...(CONNECTOR_PRESETS[type] ?? {})
      }
    })),

  importDims: null,

  // `geo` is one geometry, or an array — a multi-object 3MF imports as one
  // piece per object stored in the file (what 3MF splitters expose).
  setModel: (name, geo) => {
    const geoms = Array.isArray(geo) ? geo : [geo]
    const base = name.replace(/\.[^.]+$/, '')
    const pieces = geoms.map((g, i) => ({
      id: i === 0 ? 1 : newPieceId(),
      name: geoms.length > 1 ? `${base}_${i + 1}` : name,
      geometry: g,
      visible: true
    }))
    groundAndCenter(pieces)
    const box = new THREE.Box3()
    for (const p of pieces) {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    }
    const sz = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(sz.x, sz.y, sz.z) || 100

    const { pos, quat } = computePlaneFromBBox(box, 'y', 0.5, false)

    return set({
      modelName: name,
      importDims: [sz.x, sz.y, sz.z],
      pieces,
      history: [],
      future: [],
      draftMode: false,
      draftCuts: [],
      draftSource: null,
      cutPlanes: [],
      explode: 0,
      error: null,
      cutPlaneAxis: 'y',
      cutPlaneOffset: 0.5,
      cutPlaneFlip: false,
      plane: { pos, quat },
      plateCutPosition: [center.x, center.y, center.z],
      plateCutRotation: [0, 0, 0],
      plateCutWidth: Math.round(maxDim * 0.7),
      plateCutHeight: Math.round(maxDim * 0.7)
    })
  },

  centerModel: () =>
    set((s) => {
      if (s.busy || s.draftMode) return {}
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
      if (s.busy || s.draftMode || !s.history.length) return {}
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
      if (s.busy || s.draftMode || !s.future.length) return {}
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

  rotateModelQuaternion: (q, id = null) =>
    set((s) => {
      if (s.busy || s.draftMode) return {}
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
      if (s.busy || s.draftMode) return {}
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
      if (s.busy || s.draftMode) return {}
      const targets = id ? s.pieces.filter((p) => p.id === id) : s.pieces
      if (!targets.length) return {}
      if (![fx, fy, fz].every((v) => Number.isFinite(v) && v > 0)) return {}
      const m = transformPieces(targets, () => new THREE.Matrix4().makeScale(fx, fy, fz), s.pieces)
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m, id ? [id] : null)) }
    }),

  translatePiece: (id, dx, dz) =>
    set((s) => {
      if (s.busy || s.draftMode || !Number.isFinite(dx) || !Number.isFinite(dz)) return {}
      const piece = s.pieces.find((p) => p.id === id)
      if (!piece || (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4)) return {}
      piece.geometry.translate(dx, 0, dz)
      const m = new THREE.Matrix4().makeTranslation(dx, 0, dz)
      return { pieces: [...s.pieces], ...pushEntry(s, matrixEntry(m, [id])) }
    }),

  scaleModel: (factor) =>
    set((s) => {
      if (s.busy || s.draftMode || !Number.isFinite(factor) || factor <= 0) return {}
      for (const p of s.pieces) {
        p.geometry.scale(factor, factor, factor)
      }
      const d = groundAndCenter(s.pieces)
      const m = new THREE.Matrix4()
        .makeTranslation(d[0], d[1], d[2])
        .multiply(new THREE.Matrix4().makeScale(factor, factor, factor))
      return {
        pieces: [...s.pieces],
        importDims: s.importDims ? s.importDims.map((v) => v * factor) : null,
        ...pushEntry(s, matrixEntry(m))
      }
    }),

  setPiecesBulk: (pieces) =>
    set((s) => ({ pieces, ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces }) })),

  // === Non-destructive cut plan (draft mode) ===
  // The real pieces are never touched while planning: cuts are collected as
  // entries and only applied, in order, when the user builds.
  setDraftMode: (on) =>
    set((s) => {
      if (s.busy || on === s.draftMode) return {}
      if (!on) return { draftMode: false, draftCuts: [], draftSource: null }
      if (!s.pieces.length) return {}
      return {
        draftMode: true,
        draftCuts: [],
        draftSource: s.pieces.map((p) => ({ ...p, geometry: p.geometry.clone() }))
      }
    }),
  addDraftCut: (entry) =>
    set((s) => ({
      draftCuts: [...s.draftCuts, { enabled: true, ...entry, id: newPieceId() }]
    })),
  updateDraftCut: (id, patch) =>
    set((s) => ({
      draftCuts: s.draftCuts.map((c) => (c.id === id ? { ...c, ...patch } : c))
    })),
  toggleDraftCut: (id) =>
    set((s) => ({
      draftCuts: s.draftCuts.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c))
    })),
  removeDraftCut: (id) => set((s) => s.busy ? {} : ({ draftCuts: s.draftCuts.filter((c) => c.id !== id) })),
  moveDraftCut: (id, direction) => set((s) => {
    if (s.busy) return {}
    const index = s.draftCuts.findIndex((c) => c.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= s.draftCuts.length) return {}
    const draftCuts = [...s.draftCuts]
    ;[draftCuts[index], draftCuts[target]] = [draftCuts[target], draftCuts[index]]
    return { draftCuts }
  }),
  setDraftApplied: (pieces) =>
    set((s) => ({
      pieces,
      draftMode: false,
      draftCuts: [],
      draftSource: null,
      ...pushEntry(s, { kind: 'snapshot', pieces: s.pieces })
    })),

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
  performMultiCut: () =>
    set((s) => {
      if (!s.cutPlanes.length) return {}
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
