// Headless geometry verification for SliceForge — runs the cut engine in
// Node against synthetic shapes AND the real organic reference model.
// Usage: node scripts/verify-geometry.mjs
import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { readFileSync } from 'node:fs'
import { planeCut, volumeCut, previewPins, simplifyGeometry, curvedCut } from '../src/geometry/manifoldOps.js'

let failures = 0
function check(name, cond, detail = '') {
  const ok = !!cond
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// A geometry is watertight iff every undirected edge is shared by exactly
// two triangles wound consistently (each directed edge appears exactly once).
function watertight(g) {
  const pos = g.attributes.position
  const idx = g.index ? g.index.array : null
  const triCount = (idx ? idx.length : pos.count) / 3
  const key = (a) => `${Math.round(a[0] * 1e4)},${Math.round(a[1] * 1e4)},${Math.round(a[2] * 1e4)}`
  const verts = (t) => {
    const out = []
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx[t * 3 + k] : t * 3 + k
      out.push([pos.getX(v), pos.getY(v), pos.getZ(v)])
    }
    return out
  }
  const directed = new Map()
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = verts(t).map(key)
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a]
    ]) {
      const k = `${p}|${q}`
      if (directed.has(k)) return false
      directed.set(k, 1)
    }
  }
  // every directed edge must have its opposite
  for (const k of directed.keys()) {
    const [p, q] = k.split('|')
    if (!directed.has(`${q}|${p}`)) return false
  }
  return true
}

function volume(g) {
  const pos = g.attributes.position
  const idx = g.index ? g.index.array : null
  const triCount = (idx ? idx.length : pos.count) / 3
  let vol = 0
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3()
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[t * 3] : t * 3
    const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1
    const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2
    ax.fromBufferAttribute(pos, i0)
    ay.fromBufferAttribute(pos, i1)
    az.fromBufferAttribute(pos, i2)
    vol += ax.dot(ay.clone().cross(az)) / 6
  }
  return Math.abs(vol)
}

function bboxSize(g) {
  g.computeBoundingBox()
  return g.boundingBox.getSize(new THREE.Vector3())
}

// --- Synthetic: 100 x 60 x 40 box, non-indexed (raw STL style) ---
function boxGeometry(w, h, d) {
  return new THREE.BoxGeometry(w, h, d).toNonIndexed()
}

console.log('\n=== 1. Plane cut, no pins ===')
{
  const g = boxGeometry(100, 60, 40)
  const v0 = volume(g)
  const plane = { pos: [0, 0, 10], quat: [0, 0, 0, 1] } // identity quat: cut plane = world z=10
  const parts = await planeCut(g, plane, { kerf: 0, pins: false })
  check('cut returns 2 pieces', parts.length === 2)
  check('both pieces watertight', parts.every(watertight))
  const sizes = parts.map(bboxSize)
  // identity quat -> cut along world Z; box is 100(x) 60(y) 40(z) cut at z=10
  check('depths ≈ 10 / 30', Math.abs(sizes[0].z - 10) < 0.01 && Math.abs(sizes[1].z - 30) < 0.01,
    sizes.map((s) => s.z.toFixed(2)).join(' / '))
  check('volumes sum to original', Math.abs(parts.reduce((s, p) => s + volume(p), 0) - v0) / v0 < 1e-3)
}

console.log('\n=== 2. Plane cut with pins (peg+socket) ===')
{
  const g = boxGeometry(100, 60, 40)
  const plane = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
  const params = {
    kerf: 0,
    pins: true,
    pinDiameter: 6,
    pinLength: 8,
    tolerance: 0.15,
    taper: true,
    connectorType: 'pin',
    spacing: 25
  }
  const parts = await planeCut(g, plane, params)
  check('pinned cut returns 2 pieces', parts.length === 2)
  check('both pieces watertight with pins', parts.every(watertight))
  // pegs add material: bottom (negative side) volume grows, top shrinks
  const plain = await planeCut(g, plane, { kerf: 0, pins: false })
  check('peg piece gains volume', volume(parts[1]) > volume(plain[1]) + 1)
  check('socket piece loses volume', volume(parts[0]) < volume(plain[0]) - 1)
}

console.log('\n=== 3. Kerf removes material ===')
{
  const g = boxGeometry(100, 60, 40)
  const plane = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
  const v0 = volume(g)
  const parts = await planeCut(g, plane, { kerf: 0.4, pins: false })
  const total = parts.reduce((s, p) => s + volume(p), 0)
  check('kerfed volumes < original', total < v0 - 1, `lost ${((v0 - total)).toFixed(2)} mm³`)
  check('kerfed pieces watertight', parts.every(watertight))
}

console.log('\n=== 4. Plane fully outside -> single piece ===')
{
  const g = boxGeometry(100, 60, 40)
  const plane = { pos: [0, 0, 500], quat: [0, 0, 0, 1] }
  const parts = await planeCut(g, plane, { kerf: 0, pins: false })
  check('returns 1 untouched piece', parts.length === 1)
}

console.log('\n=== 5. Tilted plane cut ===')
{
  const g = boxGeometry(100, 60, 40)
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.2, 0))
  const plane = { pos: [0, 10, 0], quat: q.toArray() }
  const parts = await planeCut(g, plane, { kerf: 0, pins: true, pinDiameter: 6, pinLength: 8, tolerance: 0.15, spacing: 25, connectorType: 'pin' })
  check('tilted cut returns 2 pieces', parts.length === 2)
  check('tilted pieces watertight', parts.every(watertight))
}

console.log('\n=== 6. Volume (box) cut ===')
{
  const g = boxGeometry(100, 60, 40)
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(30, 20, 0),
    new THREE.Quaternion(),
    new THREE.Vector3(20, 60, 40)
  )
  const parts = await volumeCut(g, m.elements)
  check('box cut returns 2 pieces', parts.length === 2)
  check('box pieces watertight', parts.every(watertight))
  const sizes = parts.map(bboxSize)
  const inside = sizes.find((s) => Math.abs(s.x - 20) < 0.01)
  check('inside piece is 20 mm wide', !!inside, sizes.map((s) => s.x.toFixed(1)).join(' / '))
}

console.log('\n=== 7. Dowel cut + dowelCount ===')
{
  const g = boxGeometry(100, 60, 40)
  const plane = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
  const parts = await planeCut(g, plane, {
    kerf: 0,
    pins: true,
    pinDiameter: 8,
    pinLength: 35,
    tolerance: 0.2,
    connectorType: 'dowel',
    spacing: 45
  })
  check('dowel cut returns 2 pieces', parts.length === 2)
  check('dowelCount > 0', (parts.dowelCount ?? 0) > 0, `dowelCount=${parts.dowelCount}`)
  check('dowel pieces watertight', parts.every(watertight))
}

console.log('\n=== 8. Manual pins honoured ===')
{
  const g = boxGeometry(100, 60, 40)
  const plane = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
  // plane-local coords: world y=10 becomes local z=0; world x/z map to local x/y (identity quat)
  const parts = await planeCut(g, plane, {
    kerf: 0,
    pins: true,
    pinDiameter: 6,
    pinLength: 8,
    tolerance: 0.15,
    connectorType: 'pin',
    manualPins: [[-20, 0], [20, 0]]
  })
  check('manual-pin cut returns 2 pieces', parts.length === 2)
  check('manual-pin pieces watertight', parts.every(watertight))
  // exactly 2 pins: the peg piece volume ≈ plain + 2 pegs
  const plain = await planeCut(g, plane, { kerf: 0, pins: false })
  const pegVol = Math.PI * 3 * 3 * 8 // straight-peg upper bound per peg
  const diff = volume(parts[1]) - volume(plain[1])
  // pegs are centred on the plane: only the half sticking out adds material
  check('≈2 half-pegs of material added', diff > 0.5 * pegVol && diff < 2 * pegVol,
    `diff=${diff.toFixed(1)} half-peg≈${(0.5 * pegVol).toFixed(1)}`)
}

console.log('\n=== 9. previewPins (puzzle-style, 2 planes) ===')
{
  const g = boxGeometry(100, 60, 40)
  const planes = [
    { pos: [0, 10, 0], quat: [0, 0, 0, 1] },
    { pos: [0, 0, -10], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } // normal +x
  ]
  const res = await previewPins(g, planes, {
    pinDiameter: 6,
    pinLength: 8,
    tolerance: 0.15,
    spacing: 25
  })
  check('preview returns pins', res.pins.length > 0, `${res.pins.length} pins`)
  check('preview returns sections for both planes', res.sections.length === 2 && res.sections.every((s) => s.length > 0))
  check('pins carry world centers', res.pins.every((p) => Array.isArray(p.center) && p.center.length === 3))
  const planeIdxs = new Set(res.pins.map((p) => p.planeIdx))
  check('pins land on both planes', planeIdxs.size === 2, [...planeIdxs].join(','))
}

console.log('\n=== 10. Simplification keeps the mesh cuttable ===')
{
  const g = new THREE.SphereGeometry(40, 64, 48).toNonIndexed()
  const simple = await simplifyGeometry(g, 0.25)
  const t0 = g.attributes.position.count / 3
  const t1 = simple.attributes.position.count / 3
  check('triangle count reduced', t1 < t0 * 0.4, `${t0} -> ${t1}`)
  check('simplified sphere watertight', watertight(simple))
  const parts = await planeCut(simple, { pos: [0, 0, 0], quat: [0, 0, 0, 1] }, { kerf: 0, pins: false })
  check('simplified sphere still cuts into 2 watertight pieces',
    parts.length === 2 && parts.every(watertight))
}

console.log('\n=== 11. Real model: Ratome mascot (organic, 80k tris, raw STL) ===')
{
  const buf = readFileSync(new URL('../public/ratome.stl', import.meta.url).pathname)
  const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  geo.rotateX(-Math.PI / 2) // importer's Z-up -> Y-up
  const tris = geo.attributes.position.count / 3
  check('ratome loaded', tris > 50000, `${tris} tris`)
  geo.computeBoundingBox()
  const size = geo.boundingBox.getSize(new THREE.Vector3())
  const mid = geo.boundingBox.getCenter(new THREE.Vector3())
  const t0 = Date.now()
  const parts = await planeCut(geo, { pos: [mid.x, mid.y, mid.z], quat: [0, 0, 0, 1] }, {
    kerf: 0.15,
    pins: true,
    pinDiameter: 6,
    pinLength: 8,
    tolerance: 0.15,
    taper: true,
    connectorType: 'pin',
    spacing: 25
  })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  check('ratome cut into 2 pieces', parts.length === 2, `${dt}s`)
  check('ratome pieces watertight', parts.every(watertight))
  check('ratome sizes ≈ half each', Math.max(...parts.map(bboxSize).map((s) => s.z)) < size.z * 0.75,
    parts.map(bboxSize).map((s) => s.z.toFixed(1)).join(' / ') + ` of ${size.z.toFixed(1)}`)
}


console.log('\n=== 12. Freehand curved cut (knife-project style) ===')
{
  // Wavy line drawn on the FRONT hemisphere of a sphere, viewed from +Z.
  const R = 40
  const g = new THREE.SphereGeometry(R, 64, 48).toNonIndexed()
  const pts = []
  for (let i = 0; i <= 12; i++) {
    const x = -R * 0.7 + (1.4 * R * i) / 12
    const y = Math.sin((i / 12) * Math.PI * 2) * R * 0.25
    const z = Math.sqrt(Math.max(1e-6, R * R - x * x - y * y))
    pts.push(new THREE.Vector3(x, y, z))
  }
  const v0 = volume(g)
  const parts = await curvedCut(g, pts, [0, 0, -1], { kerf: 0.15 })
  check('curved cut splits sphere into 2 pieces', parts.length === 2, `${parts.length} pieces`)
  check('curved pieces watertight', parts.every(watertight))
  const vs = parts.reduce((a, p) => a + volume(p), 0)
  check('curved volumes sum to original (minus kerf)', vs < v0 && vs > v0 * 0.97, `${vs.toFixed(0)} of ${v0.toFixed(0)}`)
  // Self-crossing zigzag (freehand lines often cross themselves): the
  // NonZero fill unions the slab and the cut must stay robust.
  const zig = []
  for (let i = 0; i <= 10; i++) {
    const x = -R * 0.7 + (1.4 * R * i) / 10
    const y = (i % 2 ? 1 : -1) * R * 0.3 * (1 - Math.abs(i / 10 - 0.5))
    const z = Math.sqrt(Math.max(1e-6, R * R - x * x - y * y))
    zig.push(new THREE.Vector3(x, y, z))
  }
  const zparts = await curvedCut(g, zig, [0, 0, -1], { kerf: 0.15 })
  check('self-crossing zigzag still cuts cleanly',
    zparts.length === 2 && zparts.every(watertight), `${zparts.length} pieces`)

  // The real model: wavy line across the Ratome's middle (any 3D points
  // whose view-plane projection is the desired curve work — the wall is
  // built from the 2D projection).
  {
    const buf = readFileSync(new URL('../public/ratome.stl', import.meta.url).pathname)
    const geo = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    geo.rotateX(-Math.PI / 2)
    geo.computeBoundingBox()
    const bb = geo.boundingBox
    const cx = bb.getCenter(new THREE.Vector3())
    const pts = []
    for (let i = 0; i <= 14; i++) {
      const t = i / 14
      const x = bb.min.x + (bb.max.x - bb.min.x) * (0.1 + 0.8 * t)
      const y = cx.y + Math.sin(t * Math.PI * 3) * bb.max.y * 0.06
      pts.push(new THREE.Vector3(x, y, 0))
    }
    const t0 = Date.now()
    const rparts = await curvedCut(geo, pts, [0, 0, 1], { kerf: 0.15 })
    check('ratome curved cut into 2 pieces',
      rparts.length === 2 && rparts.every(watertight),
      `${rparts.length} pieces in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  // Diagonal freehand line across a box front, viewed from +Z.
  const box = new THREE.BoxGeometry(100, 60, 40).toNonIndexed()
  const bx = [
    new THREE.Vector3(-45, -25, 20.001),
    new THREE.Vector3(0, 0, 20.001),
    new THREE.Vector3(45, 25, 20.001)
  ]
  const bparts = await curvedCut(box, bx, [0, 0, -1], { kerf: 0.2 })
  check('curved cut splits box into 2 pieces', bparts.length === 2, `${bparts.length} pieces`)
  check('box pieces watertight', bparts.every(watertight))
}

console.log('\n' + (failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASSED'))
process.exit(failures ? 1 : 0)
