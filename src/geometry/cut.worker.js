import * as THREE from 'three'
import { planeCut, simplifyGeometry, volumeCut, previewPins, curvedCut } from './manifoldOps.js'

function toGeometry({ positions, colors, index }) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1))
  return g
}

function toPayload(geometry) {
  return {
    positions: geometry.attributes.position.array,
    colors: geometry.attributes.color?.array ?? null,
    normals: geometry.attributes.normal?.array ?? null,
    index: geometry.index?.array ?? null
  }
}

self.onmessage = async (e) => {
  const { id, op, plane, params } = e.data
  try {
    const g = toGeometry(e.data)
    let results
    if (op === 'planeCut') results = await planeCut(g, plane, params)
    else if (op === 'simplify') results = [await simplifyGeometry(g, params.ratio)]
    else if (op === 'volumeCut') results = await volumeCut(g, params.matrix)
    else if (op === 'curvedCut')
      results = await curvedCut(
        g,
        params.points.map((p) => new THREE.Vector3(...p)),
        params.viewDir,
        { kerf: params.kerf }
      )
    else if (op === 'pinPreview') {
      const pins = await previewPins(g, params.planes, params)
      self.postMessage({ id, ok: true, plain: pins })
      return
    }
    else throw new Error(`unknown op ${op}`)
    const payload = results.map(toPayload)
    const transfer = payload.flatMap((p) =>
      [...new Set([p.positions.buffer, p.colors?.buffer, p.normals?.buffer, p.index?.buffer])].filter(Boolean)
    )
    self.postMessage({ id, ok: true, results: payload, dowelCount: results.dowelCount ?? 0 }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) })
  }
}
