import * as THREE from 'three'

// Main-thread facade over the geometry worker: heavy Manifold/meshopt work
// runs off the UI thread, geometries cross the boundary as transferables.
let worker = null
let seq = 0
const pending = new Map()

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./cut.worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const { id, ok, results, plain, error } = e.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (!ok) p.reject(new Error(error))
      else if (plain !== undefined) p.resolve({ plain })
      else {
        if (results) results.dowelCount = e.data.dowelCount ?? 0
        p.resolve(results)
      }
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'))
      pending.clear()
    }
  }
  return worker
}

async function runOp(op, geometry, extra) {
  const id = ++seq
  // Copies: the displayed geometry must keep its buffers.
  const positions = new Float32Array(geometry.attributes.position.array)
  const colors = geometry.attributes.color ? new Float32Array(geometry.attributes.color.array) : null
  const index = geometry.index ? new Uint32Array(geometry.index.array) : null
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  getWorker().postMessage(
    { id, op, positions, colors, index, ...extra },
    [positions.buffer, colors?.buffer, index?.buffer].filter(Boolean)
  )
  const results = await promise
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

export const planeCutAsync = (geometry, plane, params) =>
  runOp('planeCut', geometry, { plane, params })

export const simplifyAsync = (geometry, ratio) => runOp('simplify', geometry, { params: { ratio } })

export const volumeCutAsync = (geometry, matrix) => runOp('volumeCut', geometry, { params: { matrix } })

// Plain-data op: smart cut candidate analysis (no geometry comes back).
export async function smartAnalyzeAsync(geometry, axis, sensitivity) {
  const id = ++seq
  const positions = new Float32Array(geometry.attributes.position.array)
  const index = geometry.index ? new Uint32Array(geometry.index.array) : null
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  getWorker().postMessage(
    { id, op: 'smartAnalyze', positions, index, params: { axis, sensitivity } },
    [positions.buffer, index?.buffer].filter(Boolean)
  )
  const res = await promise
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

// Plain-data op: connector preview poses (no geometry comes back).
export async function pinPreviewAsync(geometry, planes, params) {
  const id = ++seq
  const positions = new Float32Array(geometry.attributes.position.array)
  const index = geometry.index ? new Uint32Array(geometry.index.array) : null
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  getWorker().postMessage(
    { id, op: 'pinPreview', positions, index, params: { ...params, planes } },
    [positions.buffer, index?.buffer].filter(Boolean)
  )
  const res = await promise
  return res.plain ?? { pins: [], sections: [] }
}
