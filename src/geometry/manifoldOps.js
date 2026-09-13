import * as THREE from 'three'
import Module from 'manifold-3d'
import { MeshoptSimplifier } from 'meshoptimizer'
import { planeBasis, viewBasis } from './plane.js'
import { reservationsCollide } from './collide.js'
import { niceNormals } from './normals.js'

let wasmPromise = null
async function getWasm() {
  if (!wasmPromise) {
    wasmPromise = Module().then((w) => {
      w.setup()
      return w
    })
  }
  return wasmPromise
}

/**
 * Fix inconsistent triangle winding on a WELDED mesh (flipped patches in the
 * source STL survive Manifold's weld and end up in every cut piece — slicers
 * hate them). Breadth-first orientation propagation across shared edges;
 * the global sense is then chosen so the signed volume is positive (normals
 * outward). Returns corrected triVerts, or null when the mesh is not a
 * repairable closed 2-manifold (degenerate/non-manifold edges, conflicts).
 */
/**
 * Repair a broken source mesh (flipped patches, coincident duplicate
 * triangles, degenerate faces) on the WELDED topology, before it reaches
 * the boolean engine — otherwise every defect survives into every cut
 * piece and slicers choke on it. Steps:
 *   1. apply Manifold's weld mapping (mergeFromVert -> mergeToVert),
 *   2. drop degenerate and coincident-duplicate triangles,
 *   3. BFS-propagate a consistent winding across shared edges,
 *   4. flip globally so the signed volume is positive (normals outward).
 * Returns { vertProperties, triVerts } in compact welded indexing, or null
 * when the mesh is not a repairable closed 2-manifold.
 */
/**
 * Repair a broken source mesh (flipped patches, coincident duplicate
 * triangles, degenerate faces, sliver "fins" on shared edges) on the WELDED
 * topology before it reaches the boolean engine — otherwise every defect
 * survives into every cut piece and slicers choke on it. Steps:
 *   1. apply Manifold's weld mapping (mergeFromVert -> mergeToVert),
 *   2. drop degenerate and coincident-duplicate triangles,
 *   3. iteratively remove sliver faces from edges with 3+ incident faces,
 *   4. BFS-propagate a consistent winding across shared edges,
 *   5. flip globally so the signed volume is positive (normals outward).
 * Returns { vertProperties, triVerts } in compact welded indexing, or null
 * when the mesh is not repairable (the caller then keeps Manifold's best
 * effort, exactly as before this repair existed).
 */
/**
 * Repair a broken source mesh (flipped patches, coincident duplicate
 * triangles, degenerate faces, sliver "fins" on shared edges) on the WELDED
 * topology before it reaches the boolean engine — otherwise every defect
 * survives into every cut piece and slicers choke on it. Steps:
 *   1. apply Manifold's weld mapping (mergeFromVert -> mergeToVert),
 *   2. drop degenerate and coincident-duplicate triangles,
 *   3. iteratively collapse short multi-use edges / sliver apexes,
 *   4. fan-fill the tiny boundary loops the collapses leave behind,
 *   5. BFS-propagate a consistent winding across shared edges,
 *   6. flip globally so the signed volume is positive (normals outward).
 * Returns { vertProperties, triVerts } in compact welded indexing, or null
 * when the mesh is not repairable (the caller then keeps Manifold's best
 * effort, exactly as before this repair existed).
 */
function repairMesh(mesh) {
  const numProp = mesh.numProp
  const props = mesh.vertProperties
  const n0 = props.length / numProp
  const F0 = mesh.triVerts.length / 3
  if (F0 < 4 || n0 < 4) return null

  // 1. welded indices (still in original vertex numbering)
  const map = new Uint32Array(n0)
  for (let i = 0; i < n0; i++) map[i] = i
  const mf = mesh.mergeFromVert
  const mt = mesh.mergeToVert
  if (mf && mt) for (let i = 0; i < mf.length; i++) map[mf[i]] = mt[i]

  // 2. drop degenerate + duplicate triangles (keyed on the sorted triple)
  const seen = new Set()
  const keep = []
  for (let t = 0; t < F0; t++) {
    const a = map[mesh.triVerts[t * 3]]
    const b = map[mesh.triVerts[t * 3 + 1]]
    const c = map[mesh.triVerts[t * 3 + 2]]
    if (a === b || b === c || a === c) continue
    let s0, s1, s2
    if (a < b) {
      if (b < c) { s0 = a; s1 = b; s2 = c }
      else if (a < c) { s0 = a; s1 = c; s2 = b }
      else { s0 = c; s1 = a; s2 = b }
    } else {
      if (a < c) { s0 = b; s1 = a; s2 = c }
      else if (b < c) { s0 = b; s1 = c; s2 = a }
      else { s0 = c; s1 = b; s2 = a }
    }
    const key = s0 + ',' + s1 + ',' + s2
    if (seen.has(key)) continue
    seen.add(key)
    keep.push(a, b, c)
  }
  if (keep.length / 3 < 4 || keep.length < F0 * 3 * 0.5) return null

  // compact welded vertex numbering
  const compact = new Int32Array(n0).fill(-1)
  const outProps = []
  let next = 0
  const tri0 = new Uint32Array(keep.length)
  for (let i = 0; i < keep.length; i++) {
    const v = keep[i]
    if (compact[v] < 0) {
      compact[v] = next++
      for (let pr = 0; pr < numProp; pr++) outProps.push(props[v * numProp + pr])
    }
    tri0[i] = compact[v]
  }
  let V = next
  const px = (v) => outProps[v * numProp]
  const py = (v) => outProps[v * numProp + 1]
  const pz = (v) => outProps[v * numProp + 2]
  const faceArea = (t, T) => {
    const a = [px(T[t * 3]), py(T[t * 3]), pz(T[t * 3])]
    const b = [px(T[t * 3 + 1]), py(T[t * 3 + 1]), pz(T[t * 3 + 1])]
    const c = [px(T[t * 3 + 2]), py(T[t * 3 + 2]), pz(T[t * 3 + 2])]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2
  }
  const eps = (() => {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let v = 0; v < V; v++) {
      const x = px(v), y = py(v), z = pz(v)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    const d = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
    return Math.max(1e-4, d * 0.01) // 1% of the diagonal
  })()

  const buildUses = (tri, F) => {
    const uses = new Map()
    for (let t = 0; t < F; t++) {
      for (let e = 0; e < 3; e++) {
        const a = tri[t * 3 + e]
        const b = tri[t * 3 + ((e + 1) % 3)]
        const fwd = a < b
        const k = fwd ? a * V + b : b * V + a
        let list = uses.get(k)
        if (!list) uses.set(k, (list = []))
        list.push({ t, fwd, a, b, area: faceArea(t, tri) })
      }
    }
    return uses
  }

  // 3. collapse loop: short multi-use edges collapse whole (the cleanest
  // kill for a sliver fan); on long edges the extra faces' apexes collapse
  // to the nearest endpoint instead. Degenerate / duplicate results drop.
  let tri = tri0
  let F = tri.length / 3
  for (let iter = 0; iter < 12; iter++) {
    const uses = buildUses(tri, F)
    const remap = new Int32Array(V).fill(-1)
    let planned = 0
    for (const [k, list] of uses) {
      if (list.length <= 2) continue
      const lo = Math.floor(k / V)
      const hi = k % V
      const dEdge = (px(lo) - px(hi)) ** 2 + (py(lo) - py(hi)) ** 2 + (pz(lo) - pz(hi)) ** 2
      if (dEdge <= eps * eps && remap[lo] === -1 && lo !== hi) {
        remap[lo] = hi
        planned++
        continue
      }
      list.sort((x, y) => y.area - x.area)
      const fwd = list.find((u) => u.fwd)
      const bwd = list.find((u) => !u.fwd)
      const survivors = fwd && bwd ? [fwd, bwd] : [list[0], list[1]]
      for (const u of list) {
        if (survivors.includes(u)) continue
        const apex =
          tri[u.t * 3] !== u.a && tri[u.t * 3] !== u.b
            ? tri[u.t * 3]
            : tri[u.t * 3 + 1] !== u.a && tri[u.t * 3 + 1] !== u.b
              ? tri[u.t * 3 + 1]
              : tri[u.t * 3 + 2]
        const dLo = (px(apex) - px(lo)) ** 2 + (py(apex) - py(lo)) ** 2 + (pz(apex) - pz(lo)) ** 2
        const dHi = (px(apex) - px(hi)) ** 2 + (py(apex) - py(hi)) ** 2 + (pz(apex) - pz(hi)) ** 2
        const target = dLo <= dHi ? lo : hi
        if (Math.min(dLo, dHi) <= eps * eps && remap[apex] === -1 && apex !== target) {
          remap[apex] = target
          planned++
        }
      }
    }
    if (!planned) {
      let multiLeft = false
      for (const list of uses.values()) if (list.length > 2) multiLeft = true
      if (multiLeft) return null
      break
    }
    for (let v = 0; v < V; v++) {
      let t = remap[v]
      if (t < 0) continue
      let guard = 0
      while (remap[t] >= 0 && guard++ < 32) t = remap[t]
      remap[v] = t
    }
    const seenTri = new Set()
    const rebuilt = []
    for (let t = 0; t < F; t++) {
      let a = tri[t * 3]
      let b = tri[t * 3 + 1]
      let c = tri[t * 3 + 2]
      if (remap[a] >= 0) a = remap[a]
      if (remap[b] >= 0) b = remap[b]
      if (remap[c] >= 0) c = remap[c]
      if (a === b || b === c || a === c) continue
      const s = [a, b, c].sort((x, y) => x - y)
      const key = s[0] + ',' + s[1] + ',' + s[2]
      if (seenTri.has(key)) continue
      seenTri.add(key)
      rebuilt.push(a, b, c)
    }
    if (rebuilt.length / 3 < 4) return null
    tri = new Uint32Array(rebuilt)
    F = tri.length / 3
  }

  // 4. fan-fill the boundary loops the collapses left behind (tiny holes).
  // Each boundary vertex must have exactly one outgoing and one incoming
  // boundary edge, otherwise the loop is pinched — not repairable.
  {
    const uses = buildUses(tri, F)
    const nextOut = new Map()
    let boundaryCount = 0
    for (const [k, list] of uses) {
      if (list.length === 2) continue
      if (list.length > 2) return null
      boundaryCount++
      const lo = Math.floor(k / V)
      const hi = k % V
      // the single face traverses either lo->hi or hi->lo; record its direction
      if (list[0].fwd) {
        if (nextOut.has(lo)) return null
        nextOut.set(lo, hi)
      } else {
        if (nextOut.has(hi)) return null
        nextOut.set(hi, lo)
      }
    }
    if (boundaryCount > 0) {
      const visitedEdge = new Set()
      const fills = []
      // every existing edge (for chord-collision checks during ear clipping)
      const edgeSet = new Set()
      for (const [k] of uses) edgeSet.add(k)
      const ek = (a, b) => (a < b ? a * V + b : b * V + a)
      for (const [start] of nextOut) {
        // skip vertices already consumed by a previously walked loop
        const firstNxt = nextOut.get(start)
        if (visitedEdge.has(ek(start, firstNxt))) continue
        const loop = [start]
        let cur = start
        let guard = 0
        while (guard++ < 64) {
          const nxt = nextOut.get(cur)
          if (nxt === undefined) return null
          const e = ek(cur, nxt)
          if (visitedEdge.has(e)) break
          visitedEdge.add(e)
          cur = nxt
          if (cur === start) break
          loop.push(cur)
        }
        if (cur !== start || loop.length < 3 || loop.length > 24) return null
        // ear-clip the hole, opposite to the surface's boundary direction;
        // an ear is only valid when its chord is not an existing edge
        const vs = [...loop]
        let guard2 = 0
        while (vs.length > 3 && guard2++ < 64) {
          let clipped = false
          for (let i = 0; i < vs.length; i++) {
            const a = vs[(i + vs.length - 1) % vs.length]
            const b = vs[i]
            const c = vs[(i + 1) % vs.length]
            const chord = ek(a, c)
            if (edgeSet.has(chord)) continue
            fills.push(a, c, b)
            edgeSet.add(chord)
            vs.splice(i, 1)
            clipped = true
            break
          }
          if (!clipped) return null
        }
        fills.push(vs[0], vs[2], vs[1])
      }
      const merged = new Uint32Array(F * 3 + fills.length)
      merged.set(tri)
      merged.set(new Uint32Array(fills), F * 3)
      tri = merged
      F = tri.length / 3
    }
  }

  // 5. final check: every edge used by exactly two faces (closed 2-manifold)
  const BIG = F + 1
  const edges = new Map()
  for (let t = 0; t < F; t++) {
    for (let e = 0; e < 3; e++) {
      const a = tri[t * 3 + e]
      const b = tri[t * 3 + ((e + 1) % 3)]
      const k = a < b ? a * V + b : b * V + a
      const v = edges.get(k)
      if (v === undefined) {
        edges.set(k, t * BIG)
      } else {
        if (v % BIG !== 0) return null
        edges.set(k, v + t + 1)
      }
    }
  }

  // 6. BFS orientation propagation
  const neighbor = (t, e) => {
    const a = tri[t * 3 + e]
    const b = tri[t * 3 + ((e + 1) % 3)]
    const v = edges.get(a < b ? a * V + b : b * V + a)
    const t1 = Math.floor(v / BIG)
    const t2 = v % BIG - 1
    return t2 < 0 ? -1 : t1 === t ? t2 : t1
  }
  const flip = new Uint8Array(F)
  const dirOf = (t, a, b) => {
    for (let e = 0; e < 3; e++) {
      const p = tri[t * 3 + e]
      const q = tri[t * 3 + ((e + 1) % 3)]
      if (p === a && q === b) return flip[t] ? 0 : 1
      if (p === b && q === a) return flip[t] ? 1 : 0
    }
    return -1
  }
  const visited = new Uint8Array(F)
  const comp = new Int32Array(F).fill(-1)
  let nComp = 0
  const stack = []
  for (let seed = 0; seed < F; seed++) {
    if (visited[seed]) continue
    visited[seed] = 1
    comp[seed] = nComp
    stack.push(seed)
    while (stack.length) {
      const t = stack.pop()
      for (let e = 0; e < 3; e++) {
        const a = tri[t * 3 + e]
        const b = tri[t * 3 + ((e + 1) % 3)]
        const nb = neighbor(t, e)
        if (nb < 0 || nb === t) continue
        const dT = flip[t] ? 0 : 1
        const dN = dirOf(nb, a, b)
        if (dN < 0) return null
        if (visited[nb]) {
          if (dN === dT) return null
        } else {
          visited[nb] = 1
          comp[nb] = comp[t]
          if (dN === dT) flip[nb] = 1
          stack.push(nb)
        }
      }
    }
    nComp++
  }

  // 7. per-component signed volume: drop sliver debris left over from the
  //    collapses (both directions), keep real bodies and real cavities
  const compVol6 = new Float64Array(nComp)
  for (let t = 0; t < F; t++) {
    let i0 = tri[t * 3]
    let i1 = tri[t * 3 + 1]
    let i2 = tri[t * 3 + 2]
    if (flip[t]) {
      const tmp = i1
      i1 = i2
      i2 = tmp
    }
    compVol6[comp[t]] +=
      px(i0) * (py(i1) * pz(i2) - pz(i1) * py(i2)) -
      py(i0) * (px(i1) * pz(i2) - pz(i1) * px(i2)) +
      pz(i0) * (px(i1) * py(i2) - py(i1) * px(i2))
  }
  let mainVol6 = 0
  for (let c = 0; c < nComp; c++) mainVol6 = Math.max(mainVol6, Math.abs(compVol6[c]))
  const keepComp = new Uint8Array(nComp)
  for (let c = 0; c < nComp; c++) {
    keepComp[c] = Math.abs(compVol6[c]) > mainVol6 * 1e-4 ? 1 : 0
  }
  if (!keepComp.some((k) => k)) return null
  // global sense from the surviving volume (outward normals)
  let vol6 = 0
  for (let c = 0; c < nComp; c++) if (keepComp[c]) vol6 += compVol6[c]
  const flipAll = vol6 < 0
  const outTri = new Uint32Array(F * 3)
  let w = 0
  for (let t = 0; t < F; t++) {
    if (!keepComp[comp[t]]) continue
    const s = t * 3
    if ((flip[t] === 1) !== flipAll) {
      outTri[w] = tri[s]
      outTri[w + 1] = tri[s + 2]
      outTri[w + 2] = tri[s + 1]
    } else {
      outTri[w] = tri[s]
      outTri[w + 1] = tri[s + 1]
      outTri[w + 2] = tri[s + 2]
    }
    w += 3
  }
  const finalTri = outTri.subarray(0, w)
  const finalMap = new Int32Array(V).fill(-1)
  const finalProps = []
  let fnext = 0
  for (let i = 0; i < finalTri.length; i++) {
    const v = finalTri[i]
    if (finalMap[v] < 0) {
      finalMap[v] = fnext++
      for (let pr = 0; pr < numProp; pr++) finalProps.push(outProps[v * numProp + pr])
    }
    finalTri[i] = finalMap[v]
  }
  return { vertProperties: new Float32Array(finalProps), triVerts: new Uint32Array(finalTri) }
}
function geometryToManifold(wasm, geometry) {
  const { Manifold, Mesh } = wasm
  const pos = geometry.attributes.position
  const col = geometry.attributes.color
  let triVerts
  if (geometry.index) {
    triVerts = new Uint32Array(geometry.index.array)
  } else {
    // Non-indexed (typical STL): sequential indices — Manifold's merge() welds
    // the duplicates in WASM, which scales to millions of vertices where a
    // JS hash-map weld would blow up.
    triVerts = new Uint32Array(pos.count)
    for (let i = 0; i < pos.count; i++) triVerts[i] = i
  }
  // Vertex colors ride along as 3 extra properties — Manifold interpolates
  // them across every boolean, so colors survive cuts.
  let vertProperties
  let numProp = 3
  if (col) {
    numProp = 6
    vertProperties = new Float32Array(pos.count * 6)
    for (let i = 0; i < pos.count; i++) {
      vertProperties[i * 6] = pos.array[i * 3]
      vertProperties[i * 6 + 1] = pos.array[i * 3 + 1]
      vertProperties[i * 6 + 2] = pos.array[i * 3 + 2]
      vertProperties[i * 6 + 3] = col.array[i * 3]
      vertProperties[i * 6 + 4] = col.array[i * 3 + 1]
      vertProperties[i * 6 + 5] = col.array[i * 3 + 2]
    }
  } else {
    vertProperties = new Float32Array(pos.array)
  }
  const mesh = new Mesh({ numProp, vertProperties, triVerts })
  mesh.merge()
  let solid = new Manifold(mesh)
  // Flipped patches in the source file survive the weld (genus < 0 flags
  // inconsistent winding) and would leak into every cut piece — repair once.
  if (solid.genus() < 0) {
    const repaired = repairMesh(mesh)
    let fixed = null
    if (repaired) {
      const m2 = new Mesh({ numProp, vertProperties: repaired.vertProperties, triVerts: repaired.triVerts })
      m2.merge()
      try {
        const candidate = new Manifold(m2)
        if (candidate.status() === 'NoError' && candidate.genus() > solid.genus()) {
          fixed = candidate
        } else {
          candidate.delete()
        }
      } catch {
        /* keep the original solid */
      }
    }
    if (fixed) {
      solid.delete()
      solid = fixed
    }
  }
  return solid
}

function manifoldToGeometry(manifold) {
  const mesh = manifold.getMesh()
  const g = new THREE.BufferGeometry()
  if (mesh.numProp > 3) {
    const n = mesh.vertProperties.length / mesh.numProp
    const posArr = new Float32Array(n * 3)
    const colArr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      posArr[i * 3] = mesh.vertProperties[i * mesh.numProp]
      posArr[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1]
      posArr[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2]
      colArr[i * 3] = mesh.vertProperties[i * mesh.numProp + 3]
      colArr[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 4]
      colArr[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 5]
    }
    g.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colArr, 3))
  } else {
    g.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3))
  }
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1))
  return niceNormals(g)
}

// Paint cut-face triangles flat grey (non-indexed geometry only: each face
// owns its vertices, so walls keep their colour). planeTest receives the 3
// vertices of a triangle and says whether it lies on a cut plane.
const GREY = [0.62, 0.63, 0.66]
function paintFaces(g, planeTest) {
  const col = g.attributes.color
  if (!col || g.index) return
  const pos = g.attributes.position
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  for (let t = 0; t < pos.count; t += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, t + k)
    if (planeTest(v)) {
      for (let k = 0; k < 3; k++) col.setXYZ(t + k, GREY[0], GREY[1], GREY[2])
    }
  }
  col.needsUpdate = true
}

/**
 * Final connector placements on the z=0 cross-section of `solid` (local
 * frame): candidate spots (auto grid or manual clicks) are validated in 3D —
 * the reservation plus a 1.2 mm wall margin must sit fully INSIDE the solid,
 * so no connector ever pierces the outer shell. If the centred (50/50)
 * position leaks, the reservation is slid along the axis to 30/70 then 70/30;
 * if nothing fits, the spot is dropped. Returns [x, y, zOffset] triples.
 * Shared by the actual cut and the orange preview, so they always agree.
 */
const PIN_WALL = 1.2
function pinPlacements(wasm, solid, params) {
  const { Manifold } = wasm
  const r = Math.max(0.2, params.pinDiameter / 2)
  const h = Math.max(1, params.pinLength)
  const tol = Math.max(0, params.tolerance)
  const section = solid.slice(0)
  const polys = section.toPolygons()
  section.delete()
  let spots
  if (Array.isArray(params.manualPins)) {
    const outers = polys.filter((p) => polygonArea(p) > 0)
    const holes = polys.filter((p) => polygonArea(p) < 0)
    spots = params.manualPins.filter(
      (pt) => outers.some((o) => pointInPolygon(pt, o)) && !holes.some((hp) => pointInPolygon(pt, hp))
    )
  } else {
    spots = pinSpots(polys, r, tol, params.spacing)
  }
  const testR = r + tol + PIN_WALL
  const testH = h + 2 * tol + 2 * PIN_WALL
  const placements = []
  for (const [x, y] of spots) {
    for (const off of [0, 0.2 * h, -0.2 * h]) {
      const tester = Manifold.cylinder(testH, testR, testR, 16, true).translate([x, y, off])
      const leak = tester.subtract(solid)
      const fits = leak.isEmpty() || leak.volume() < 0.05
      tester.delete()
      leak.delete()
      if (fits) {
        placements.push([x, y, off])
        break
      }
    }
  }
  return placements
}

/**
 * Preview-only: where would the connectors land for these cut planes?
 * Runs the exact same placement logic as the cut, against the given
 * geometry, and returns world-space poses for the orange ghost markers.
 */
export async function previewPins(geometry, planes, params) {
  const wasm = await getWasm()
  const out = []
  const sections = []
  const occupied = []
  const r = Math.max(0.2, params.pinDiameter / 2) + Math.max(0, params.tolerance)
  const halfH = (Math.max(1, params.pinLength) + 2 * Math.max(0, params.tolerance)) / 2
  for (let planeIdx = 0; planeIdx < planes.length; planeIdx++) {
    const plane = planes[planeIdx]
    const { origin } = planeBasis(plane)
    const q = new THREE.Quaternion(...plane.quat).invert()
    const toLocal = new THREE.Matrix4()
      .makeRotationFromQuaternion(q)
      .multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
    const toWorld = toLocal.clone().invert()
    const gLocal = geometry.clone().applyMatrix4(toLocal)
    const solid = geometryToManifold(wasm, gLocal)
    gLocal.dispose()
    const sec = solid.slice(0)
    sections[planeIdx] = sec.toPolygons().map((poly) => poly.map(([a, b]) => [a, b]))
    sec.delete()
    for (const [u, v, off] of pinPlacements(wasm, solid, params)) {
      const a = new THREE.Vector3(u, v, off - halfH).applyMatrix4(toWorld)
      const b = new THREE.Vector3(u, v, off + halfH).applyMatrix4(toWorld)
      const res = { a: a.toArray(), b: b.toArray(), r }
      // Connectors must NEVER hit each other — reject any reservation that
      // would cross one already accepted on another plane.
      if (occupied.some((o) => reservationsCollide(o, res))) continue
      occupied.push(res)
      const center = new THREE.Vector3(u, v, off).applyMatrix4(toWorld)
      out.push({ center: center.toArray(), quat: plane.quat, u, v, off, planeIdx })
    }
    solid.delete()
  }
  return { pins: out, sections }
}

// Tool solids (pins, cutting boxes) meeting a colored model in a boolean:
// give them 3 colour properties (setProperties counts EXTRA props, position
// excluded) so the faces they create read as neutral grey, not black.
function matchProps(tool, hasColor) {
  if (!hasColor) return tool
  const upgraded = tool.setProperties(3, (newProp) => {
    newProp[0] = 0.62
    newProp[1] = 0.63
    newProp[2] = 0.66
  })
  tool.delete()
  return upgraded
}

function polygonArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

function polygonCentroid(poly) {
  let cx = 0
  let cy = 0
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    const cross = x1 * y2 - x2 * y1
    a += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  a /= 2
  if (Math.abs(a) < 1e-9) return null
  return [cx / (6 * a), cy / (6 * a)]
}

function pointInPolygon([px, py], poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Choose pin positions on the z=0 cross-section: a coarse grid per region,
 * candidates must fit the whole pin (ring test with margin), then a greedy
 * spread pick — several pins lock rotation, one central pin cannot.
 */
function pinSpots(polys, r, tol, spacing) {
  const margin = r + tol + 1.5
  // The user-set minimum spacing drives HOW MANY connectors a face gets;
  // it can never go below twice the pin footprint (overlap guard).
  const minDist = Math.max(spacing || 0, 4 * margin)
  const outers = polys.filter((p) => polygonArea(p) > 0)
  const holes = polys.filter((p) => polygonArea(p) < 0)
  const inside = (pt) =>
    outers.some((o) => pointInPolygon(pt, o)) && !holes.some((h) => pointInPolygon(pt, h))
  const fits = (pt) => {
    if (!inside(pt)) return false
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      if (!inside([pt[0] + margin * Math.cos(a), pt[1] + margin * Math.sin(a)])) return false
    }
    return true
  }

  const spots = []
  for (const poly of outers) {
    const area = polygonArea(poly)
    if (area < Math.PI * margin * margin * 2.5) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of poly) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const nx = Math.min(14, Math.max(2, Math.round(((maxX - minX) / minDist) * 2)))
    const ny = Math.min(14, Math.max(2, Math.round(((maxY - minY) / minDist) * 2)))
    const cand = []
    const c = polygonCentroid(poly)
    if (c && fits(c)) cand.push(c)
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const pt = [
          minX + ((i + 0.5) * (maxX - minX)) / nx,
          minY + ((j + 0.5) * (maxY - minY)) / ny
        ]
        if (fits(pt)) cand.push(pt)
      }
    }
    // Greedy pick honouring the user's minimum spacing.
    const picked = []
    for (const pt of cand) {
      if (picked.length >= 12) break
      if (picked.every((q) => Math.hypot(pt[0] - q[0], pt[1] - q[1]) >= minDist)) picked.push(pt)
    }
    spots.push(...picked)
  }
  return spots
}

/**
 * Cut a geometry by a plane, optionally adding alignment pins across the seam.
 * Returns an array of 1..2 BufferGeometries (a plane fully outside the model
 * returns the untouched solid as a single piece).
 */
export async function planeCut(geometry, plane, params) {
  const wasm = await getWasm()
  const { Manifold } = wasm
  const { origin } = planeBasis(plane)

  // Work in the plane's FULL local frame (its quaternion, not just the
  // normal): cut plane becomes z = 0 and the in-plane x/y axes match the
  // viewport plane object, so manual connector (u,v) coords line up exactly.
  const q = new THREE.Quaternion(...plane.quat).invert()
  const toLocal = new THREE.Matrix4()
    .makeRotationFromQuaternion(q)
    .multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z))
  const toWorld = toLocal.clone().invert()

  const gLocal = geometry.clone().applyMatrix4(toLocal)
  const hasColor = !!geometry.attributes.color
  gLocal.computeBoundingBox()
  const lb = gLocal.boundingBox.clone()
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()

  const kerf = Math.max(0, params.kerf || 0)
  const cleanup = []
  let dowelCount = 0
  try {
    let top, bottom
    if (hasColor) {
      // trimByPlane zero-fills colour properties on the cap (black faces);
      // intersect with grey half-space boxes instead so cuts read neutral.
      const m = 1
      const sx = lb.max.x - lb.min.x + 2 * m
      const sy = lb.max.y - lb.min.y + 2 * m
      const boxTop = matchProps(
        Manifold.cube([sx, sy, lb.max.z + m - kerf / 2], false).translate([
          lb.min.x - m,
          lb.min.y - m,
          kerf / 2
        ]),
        true
      )
      const boxBot = matchProps(
        Manifold.cube([sx, sy, -kerf / 2 - (lb.min.z - m)], false).translate([
          lb.min.x - m,
          lb.min.y - m,
          lb.min.z - m
        ]),
        true
      )
      cleanup.push(boxTop, boxBot)
      top = solid.intersect(boxTop)
      bottom = solid.intersect(boxBot)
    } else {
      top = solid.trimByPlane([0, 0, 1], kerf / 2)
      bottom = solid.trimByPlane([0, 0, -1], kerf / 2)
    }
    cleanup.push(top, bottom)

    if (top.isEmpty() || bottom.isEmpty()) {
      return [manifoldToGeometry(solid)]
    }

    if (params.pins) {
      // Connector shapes: round/square/hex pegs (one piece carries the peg,
      // the other the socket) or dowel holes (both pieces get the same hole,
      // a separate wooden/printed dowel bridges them).
      const type = params.connectorType || 'pin'
      const seg = { pin: 48, square: 4, hex: 6, dowel: 48 }[type] ?? 48
      const r = Math.max(0.2, params.pinDiameter / 2)
      const h = Math.max(1, params.pinLength)
      const tol = Math.max(0, params.tolerance)
      // Tapered pegs (tip 80% of base radius) slide into their socket without
      // fighting the first layers — much easier to assemble than straight pins.
      const rTip = params.taper && type !== 'dowel' ? r * 0.8 : r
      const placements = pinPlacements(wasm, solid, params)
      if (type === 'dowel') dowelCount = placements.length
      for (const [x, y, off] of placements) {
        if (type === 'dowel') {
          const hole = matchProps(
            Manifold.cylinder(h + 2 * tol, r + tol, r + tol, seg, true).translate([x, y, off]),
            hasColor
          )
          cleanup.push(hole)
          const t2 = top.subtract(hole)
          const b2 = bottom.subtract(hole)
          cleanup.push(t2, b2)
          top = t2
          bottom = b2
          continue
        }
        const peg = matchProps(
          Manifold.cylinder(h, r, rTip, seg, true).translate([x, y, off]),
          hasColor
        )
        const socket = matchProps(
          Manifold.cylinder(h + 2 * tol, r + tol, rTip + tol, seg, true).translate([x, y, off]),
          hasColor
        )
        cleanup.push(peg, socket)
        const b2 = bottom.add(peg)
        const t2 = top.subtract(socket)
        cleanup.push(b2, t2)
        bottom = b2
        top = t2
      }
    }

    const gTop = manifoldToGeometry(top)
    const gBottom = manifoldToGeometry(bottom)
    if (hasColor) {
      // In the local frame the cut caps sit exactly at z = ±kerf/2.
      paintFaces(gTop, (v) => v.every((p) => Math.abs(p.z - kerf / 2) < 0.02))
      paintFaces(gBottom, (v) => v.every((p) => Math.abs(p.z + kerf / 2) < 0.02))
    }
    gTop.applyMatrix4(toWorld)
    gBottom.applyMatrix4(toWorld)
    const res = [gTop, gBottom]
    res.dowelCount = dowelCount
    return res
  } finally {
    solid.delete()
    for (const m of cleanup) {
      try {
        m.delete()
      } catch {
        /* already consumed */
      }
    }
  }
}

/**
 * Split a solid with an oriented box (unit cube transformed by matrixArray,
 * column-major Matrix4). Returns [outside, inside] — 1 piece if the box
 * misses (or swallows) the solid. Cut in the box's local frame so Manifold
 * only ever sees an axis-aligned unit cube.
 */
export async function volumeCut(geometry, matrixArray) {
  const wasm = await getWasm()
  const { Manifold } = wasm
  const m = new THREE.Matrix4().fromArray(matrixArray)
  const inv = m.clone().invert()
  const gLocal = geometry.clone().applyMatrix4(inv)
  const hasColor = !!geometry.attributes.color
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()
  const cube = matchProps(Manifold.cube([1, 1, 1], true), hasColor)
  const out = []
  for (const part of [solid.subtract(cube), solid.intersect(cube)]) {
    if (!part.isEmpty()) {
      const g = manifoldToGeometry(part)
      if (hasColor) {
        // Box faces sit on the unit cube's planes in the local frame.
        paintFaces(g, (v) =>
          ['x', 'y', 'z'].some((a) =>
            v.every((p) => Math.abs(Math.abs(p[a]) - 0.5) < 0.005)
          )
        )
      }
      out.push(g.applyMatrix4(m))
    }
    part.delete()
  }
  cube.delete()
  solid.delete()
  return out
}

/**
 * Reduce the triangle count to ~ratio (0..1) of the current one.
 * The mesh is first welded through Manifold (clean shared index), then
 * decimated with meshoptimizer's edge-collapse simplifier, which preserves
 * topology — the result stays cuttable.
 */
export async function simplifyGeometry(geometry, ratio) {
  const wasm = await getWasm()
  const solid = geometryToManifold(wasm, geometry)
  const weldedMesh = solid.getMesh()
  solid.delete()

  await MeshoptSimplifier.ready
  const index = new Uint32Array(weldedMesh.triVerts)
  // De-interleave: the welded mesh may carry colors (numProp 6); meshopt
  // wants bare stride-3 positions and returns indices into the same vertex
  // order, so extra attributes survive untouched.
  const np = weldedMesh.numProp
  const n = weldedMesh.vertProperties.length / np
  let positions
  let colors = null
  if (np > 3) {
    positions = new Float32Array(n * 3)
    colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      positions[i * 3] = weldedMesh.vertProperties[i * np]
      positions[i * 3 + 1] = weldedMesh.vertProperties[i * np + 1]
      positions[i * 3 + 2] = weldedMesh.vertProperties[i * np + 2]
      colors[i * 3] = weldedMesh.vertProperties[i * np + 3]
      colors[i * 3 + 1] = weldedMesh.vertProperties[i * np + 4]
      colors[i * 3 + 2] = weldedMesh.vertProperties[i * np + 5]
    }
  } else {
    positions = new Float32Array(weldedMesh.vertProperties)
  }
  const target = Math.max(4, Math.floor((index.length * ratio) / 3)) * 3
  const [newIndex] = MeshoptSimplifier.simplify(index, positions, 3, target, 0.05, [])

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  g.setIndex(new THREE.BufferAttribute(newIndex, 1))
  return niceNormals(g)
}

/**
 * Freehand curved cut: the user clicked a polyline ON the model surface; the
 * cutting wall follows the drawn curve and runs through the model along the
 * drawing view direction (Blender "knife project" style). The wall is built
 * as a 2D slab (the curve thickened by the kerf) extruded along the view
 * axis — every clicked surface point lies on the wall, so what you drew is
 * exactly where the visible surface gets cut.
 */
export async function curvedCut(geometry, points, viewDir, params = {}) {
  if (!points || points.length < 2) throw new Error('curved cut needs at least 2 points')
  const wasm = await getWasm()
  const { CrossSection } = wasm
  const kerf = Math.max(params.kerf ?? 0.15, 0.02)
  const w2 = kerf / 2

  // Local frame: x/y = screen plane, z = view axis, origin = first point.
  const { u, v, n } = viewBasis(new THREE.Vector3(...viewDir))
  const origin = new THREE.Vector3(...points[0])
  const M = new THREE.Matrix4().makeBasis(u, v, n).setPosition(origin)
  const inv = M.clone().invert()

  // Model in the local frame: the wall must span its full depth and width.
  const gLocal = geometry.clone().applyMatrix4(inv)
  gLocal.computeBoundingBox()
  const bb = gLocal.boundingBox
  const radius = gLocal.boundingBox.getSize(new THREE.Vector3()).length() / 2
  const margin = radius * 0.1 + 1
  const z0 = bb.min.z - margin
  const zDepth = bb.max.z - bb.min.z + 2 * margin

  // The drawn curve in 2D, ends extended straight so the wall exits the model.
  const pts2 = points.map((p) => {
    const l = new THREE.Vector3(...p).applyMatrix4(inv)
    return [l.x, l.y]
  })
  const ext = radius * 1.5 + 10
  const d0 = norm2(sub2(pts2[1], pts2[0]))
  if (d0 > 1e-9) {
    const t = [pts2[1][0] - pts2[0][0], pts2[1][1] - pts2[0][1]]
    pts2.unshift([pts2[0][0] - (t[0] / d0) * ext, pts2[0][1] - (t[1] / d0) * ext])
  }
  const last = pts2.length - 1
  const dN = norm2(sub2(pts2[last], pts2[last - 1]))
  if (dN > 1e-9) {
    const t = [pts2[last][0] - pts2[last - 1][0], pts2[last][1] - pts2[last - 1][1]]
    pts2.push([pts2[last][0] + (t[0] / dN) * ext, pts2[last][1] + (t[1] / dN) * ext])
  }

  // 2D slab = union of one rectangle per segment (robust at any joint
  // angle). All rects share the same winding, so the NonZero fill rule
  // unions them even where they overlap at the joints.
  const polys = []
  for (let i = 0; i + 1 < pts2.length; i++) {
    const [ax, ay] = pts2[i]
    const [bx, by] = pts2[i + 1]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) continue
    const nx = -dy / len
    const ny = dx / len
    polys.push([
      [ax - nx * w2, ay - ny * w2],
      [bx - nx * w2, by - ny * w2],
      [bx + nx * w2, by + ny * w2],
      [ax + nx * w2, ay + ny * w2]
    ])
  }
  if (!polys.length) throw new Error('degenerate curve')
  const cs = new CrossSection(polys, 'NonZero')

  // Wall through the whole model depth, then subtract and split into parts.
  const wall = cs.extrude(zDepth).translate([0, 0, z0])
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()
  const carved = solid.subtract(wall)
  wall.delete()
  solid.delete()
  const out = []
  for (const part of carved.decompose()) {
    if (!part.isEmpty()) out.push(manifoldToGeometry(part).applyMatrix4(M))
    part.delete()
  }
  carved.delete()
  return out
}

function sub2(a, b) {
  return [a[0] - b[0], a[1] - b[1]]
}
function norm2(a) {
  return Math.hypot(a[0], a[1])
}
