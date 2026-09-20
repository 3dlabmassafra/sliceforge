import * as THREE from 'three'

// Each request owns copies: cancellation can never detach the visible model.
let worker = null
let seq = 0
const pending = new Map()

function resetWorker(error) {
  worker?.terminate()
  worker = null
  for (const p of pending.values()) {
    clearTimeout(p.timer)
    p.reject(error)
  }
  pending.clear()
}

export function cancelCuts() {
  const error = new Error('Operation cancelled; original model unchanged')
  error.name = 'AbortError'
  resetWorker(error)
}

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./cut.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const { id, ok, results, plain, error } = e.data
      const p = pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(id)
      if (!ok) p.reject(new Error(error))
      else if (plain !== undefined) p.resolve({ plain })
      else {
        if (results) results.dowelCount = e.data.dowelCount ?? 0
        p.resolve(results)
      }
    }
    worker.onerror = (e) => resetWorker(new Error(e.message || 'Geometry worker failed'))
    worker.onmessageerror = () => resetWorker(new Error('Invalid geometry worker response'))
  }
  return worker
}

function request(op, geometry, extra = {}) {
  const id = ++seq
  const positions = new Float32Array(geometry.attributes.position.array)
  const colors = geometry.attributes.color ? new Float32Array(geometry.attributes.color.array) : null
  const index = geometry.index ? new Uint32Array(geometry.index.array) : null
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resetWorker(new Error('Geometry operation timed out after 5 minutes')), 300_000)
    pending.set(id, { resolve, reject, timer })
    try {
      getWorker().postMessage(
        { id, op, positions, colors, index, ...extra },
        [positions.buffer, colors?.buffer, index?.buffer].filter(Boolean)
      )
    } catch (error) {
      resetWorker(error)
    }
  })
}

async function runOp(op, geometry, extra) {
  const results = await request(op, geometry, extra)
  const mapped = results.map((r) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3))
    if (r.colors) g.setAttribute('color', new THREE.BufferAttribute(r.colors, 3))
    if (r.normals) g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3))
    if (r.index) g.setIndex(new THREE.BufferAttribute(r.index, 1))
    if (!r.normals) g.computeVertexNormals()
    return g
  })
  mapped.dowelCount = results.dowelCount ?? 0
  return mapped
}

export const splitPartsAsync = (geometry) => runOp('splitParts', geometry, {})
export const selectionCutAsync = (geometry, sel, kerf) =>
  runOp('selectionCut', geometry, { params: { sel, kerf } })
export const planeCutAsync = (geometry, plane, params) =>
  runOp('planeCut', geometry, { plane, params })
export const simplifyAsync = (geometry, ratio) => runOp('simplify', geometry, { params: { ratio } })
export const volumeCutAsync = (geometry, matrix) => runOp('volumeCut', geometry, { params: { matrix } })

export async function smartAnalyzeAsync(geometry, axis, sensitivity) {
  const res = await request('smartAnalyze', geometry, { params: { axis, sensitivity } })
  return res.plain ?? { axis, lo: 0, hi: 0, candidates: [] }
}

export const curvedCutAsync = (geometry, points, viewDir, params) =>
  runOp('curvedCut', geometry, {
    params: {
      ...params,
      points: points.map((p) => [p.x, p.y, p.z]),
      viewDir: [viewDir.x, viewDir.y, viewDir.z]
    }
  })

export async function pinPreviewAsync(geometry, planes, params) {
  const res = await request('pinPreview', geometry, { params: { ...params, planes } })
  return res.plain ?? { pins: [], sections: [] }
}
