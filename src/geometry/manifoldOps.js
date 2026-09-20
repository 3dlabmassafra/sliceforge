import * as THREE from 'three'
import Module from 'manifold-3d'
import { MeshoptSimplifier } from 'meshoptimizer'
import { planeBasis, viewBasis } from './plane.js'
import { selectionBoundary } from './shapeSelect.js'
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
  return cleanF32Slivers(niceNormals(g))
}

/**
 * Boolean outputs can contain zero-width fins (e.g. a connector cylinder
 * tangent to a cut wall): two surfaces a fraction of a micron apart, which
 * the float32 rounding collapses onto each other — duplicating edges and
 * breaking slicers. Weld vertices that are identical in float32, drop the
 * triangles that become degenerate, and only keep the result when every
 * remaining edge still pairs up perfectly (otherwise keep the original).
 */
function cleanF32Slivers(g) {
  const pos = g.attributes.position
  const col = g.attributes.color
  const srcIdx = g.index ? g.index.array : null
  const F = (srcIdx ? srcIdx.length : pos.count) / 3
  if (!F) return g
  // 1. weld vertices that share a position on the 0.1µm grid (the same
  //    resolution slicers and the watertight check work at)
  const map = new Map()
  const remap = new Uint32Array(pos.count)
  let next = 0
  for (let v = 0; v < pos.count; v++) {
    const k =
      Math.round(pos.getX(v) * 1e4) + ',' + Math.round(pos.getY(v) * 1e4) + ',' + Math.round(pos.getZ(v) * 1e4)
    let m = map.get(k)
    if (m === undefined) map.set(k, (m = next++))
    remap[v] = m
  }
  if (next === pos.count) return g // nothing collapsed
  // 2. drop triangles degenerate or duplicated after the weld
  const seen = new Set()
  const tri = []
  for (let t = 0; t < F; t++) {
    const a = remap[srcIdx ? srcIdx[t * 3] : t * 3]
    const b = remap[srcIdx ? srcIdx[t * 3 + 1] : t * 3 + 1]
    const c = remap[srcIdx ? srcIdx[t * 3 + 2] : t * 3 + 2]
    if (a === b || b === c || a === c) continue
    const key = [a, b, c].sort((x, y) => x - y).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    tri.push(a, b, c)
  }
  // 3. accept only a perfectly paired (watertight, no duplicates) result
  const dirCount = new Map()
  for (let i = 0; i < tri.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const p = tri[i + e]
      const q = tri[i + ((e + 1) % 3)]
      const dk = p * next + q
      dirCount.set(dk, (dirCount.get(dk) ?? 0) + 1)
    }
  }
  for (const [dk, cnt] of dirCount) {
    if (cnt !== 1) return g
    const p = Math.floor(dk / next)
    const q = dk % next
    if (!dirCount.has(q * next + p)) return g
  }
  // 4. rebuild compact geometry
  const out = new THREE.BufferGeometry()
  const posArr = new Float32Array(next * 3)
  const colArr = col ? new Float32Array(next * 3) : null
  for (let v = 0; v < pos.count; v++) {
    const m = remap[v]
    posArr[m * 3] = pos.getX(v)
    posArr[m * 3 + 1] = pos.getY(v)
    posArr[m * 3 + 2] = pos.getZ(v)
    if (colArr) {
      colArr[m * 3] = col.getX(v)
      colArr[m * 3 + 1] = col.getY(v)
      colArr[m * 3 + 2] = col.getZ(v)
    }
  }
  out.setAttribute('position', new THREE.BufferAttribute(posArr, 3))
  if (colArr) out.setAttribute('color', new THREE.BufferAttribute(colArr, 3))
  out.setIndex(new THREE.BufferAttribute(new Uint32Array(tri), 1))
  return niceNormals(out)
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
  // Enclose corners too: a square's diagonal exceeds its nominal width.
  const footprint = params.connectorType === 'square' ? Math.SQRT2 : params.connectorType === 'dovetail' ? 1.28 : 1
  const testR = (r + tol) * footprint + PIN_WALL
  const testH = h + 2 * tol + 2 * PIN_WALL
  const placements = []
  for (const [x, y] of spots) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    // Manual placements use the same collision guard as automatic ones.
    if (placements.some(([px, py]) => Math.hypot(px - x, py - y) < 2 * testR + 1)) continue
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
 * "Detach along the selection": saw the model exactly along the painted
 * region's boundary. For every boundary edge a cutter slab is built
 * through the surface, perpendicular to it (extended along the smoothed
 * vertex normals so it passes fully through the material, like a jeweler's
 * saw following the drawn line) — the kerf thickens it. One boolean
 * subtract, then the pieces are classified: the ones containing a
 * selection seed come first.
 *
 * This is what makes "take the hair off a bust" or "cut the hand at the
 * wrist" precise: the seam IS the painted boundary, not an approximating
 * box or plane.
 */
export async function selectionCut(geometry, sel, kerf = 0.15) {
  const bnd = selectionBoundary(geometry, sel)
  if (!bnd.loops.length) throw new Error('selection has no boundary')
  const wasm = await getWasm()
  const { Manifold, Mesh } = wasm

  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const w2 = Math.max(kerf, 0.04) / 2

  // The solid is probed for classification later; the cutter itself is a
  // SHRINKING CAP: starting from the boundary loop, each ring steps inward
  // along the local surface normal (with Laplacian smoothing so rings stay
  // clean) until it collapses to a point — the surface a jeweler's saw
  // would open, following the wrist/cuff/hairline form. Thickened by the
  // kerf into a closed lens-shaped solid.
  const solid = geometryToManifold(wasm, geometry)

  const centroidOf = (pts) => {
    const c = new THREE.Vector3()
    for (const p of pts) c.add(p)
    return c.divideScalar(pts.length)
  }

  const vp = []
  const tv = []
  for (const loop of bnd.loops) {
    // ring 0 = the boundary loop itself (positions + outward normals)
    let cur = []
    for (let i = 0; i < loop.length; i++) {
      const v = bnd.verts.get(loop[i])
      const w = bnd.verts.get(loop[(i + 1) % loop.length])
      if (!v || !w) continue
      if (new THREE.Vector3(...w.p).distanceTo(new THREE.Vector3(...v.p)) < 1e-9) continue
      cur.push({
        p: new THREE.Vector3(...v.p),
        n: new THREE.Vector3(v.nx, v.ny, v.nz).normalize()
      })
    }
    if (cur.length < 3) continue

    // Shrink rings until they collapse: the FIRST step goes straight into
    // the material along -n (the saw enters perpendicular to the surface),
    // then each ring steps toward its own centroid — the cap funnels
    // through the wrist/hairline form. Steps are capped by the local
    // vertex spacing so a ring can never fold over itself.
    // Pre-smooth the raw boundary loop (it zigzags with the mesh triangles);
    // the smoothed ring is the mean plane the saw actually follows.
    for (let pass = 0; pass < 3; pass++) {
      cur = cur.map((v, i) => {
        const prev = cur[(i + cur.length - 1) % cur.length].p
        const next = cur[(i + 1) % cur.length].p
        return { p: v.p.clone().lerp(prev.clone().add(next).multiplyScalar(0.5), 0.5), n: v.n }
      })
    }
    // Skirt: the smoothed ring lies inside the surface zigzag, so the cap is
    // flared OUT of the material — radially past the loop (covers the full
    // cross-section) and lifted along +n (emerges from the surface). This
    // guarantees a watertight severance even on coarse meshes.
    const skirtLift = Math.max(1.2, w2 * 8)
    const skirtGrow = Math.max(1.0, w2 * 4 + 0.8)
    const c0 = centroidOf(cur.map((v) => v.p))
    const rings = [
      cur.map((v) => {
        const out = v.p.clone().sub(c0)
        if (out.lengthSq() < 1e-12) out.set(0, 1, 0)
        return v.p.clone().addScaledVector(out.normalize(), skirtGrow).addScaledVector(v.n, skirtLift)
      }),
    ]
    for (let guard = 0; guard < 200 && cur.length >= 3; guard++) {
      const c = centroidOf(cur.map((v) => v.p))
      const r = cur.reduce((s, v) => s + v.p.distanceTo(c), 0) / cur.length
      rings.push(cur.map((v) => v.p.clone()))
      if (r < Math.max(0.5, w2 * 8)) break
      let minEdge = Infinity
      for (let i = 0; i < cur.length; i++) {
        minEdge = Math.min(minEdge, cur[i].p.distanceTo(cur[(i + 1) % cur.length].p))
      }
      const d = Math.min(r * 0.3, Math.max(0.05, minEdge * 0.5))
      cur = cur.map((v, i) => {
        const dir = guard === 0 ? v.n.clone().negate() : c.clone().sub(v.p).normalize()
        const p = v.p.clone().addScaledVector(dir, d)
        return { p, n: v.n }
      })
      // two gentle Laplacian passes keep the ring smooth
      for (let pass = 0; pass < 2; pass++) {
        cur = cur.map((v, i) => {
          const prev = cur[(i + cur.length - 1) % cur.length].p
          const next = cur[(i + 1) % cur.length].p
          return { p: v.p.clone().lerp(prev.clone().add(next).multiplyScalar(0.5), 0.35), n: v.n }
        })
      }
    }
    if (rings.length < 1) continue

    // The cap is thickened along ITS normal (ring tangent x trajectory),
    // per vertex — never along the trajectory itself.
    const ringCount = rings.length
    const offsetDirs = (j) => {
      const ring = rings[j]
      const n = ring.length
      const out = []
      for (let i = 0; i < n; i++) {
        const tangent = ring[(i + 1) % n].clone().sub(ring[i]).normalize()
        let traj
        if (j + 1 < ringCount) traj = rings[j + 1][i].clone().sub(ring[i])
        else if (j > 0) traj = ring[i].clone().sub(rings[j - 1][i])
        else traj = new THREE.Vector3()
        if (traj.lengthSq() < 1e-12) {
          // no trajectory yet (single ring): use the boundary normals
          traj = new THREE.Vector3()
        }
        let capN
        if (traj.lengthSq() < 1e-12) {
          capN = tangent.clone().cross(new THREE.Vector3(0, 0, 1))
          if (capN.lengthSq() < 1e-9) capN = tangent.clone().cross(new THREE.Vector3(0, 1, 0))
        } else {
          capN = tangent.clone().cross(traj.normalize())
          if (capN.lengthSq() < 1e-9) {
            capN = tangent.clone().cross(new THREE.Vector3(0, 0, 1))
            if (capN.lengthSq() < 1e-9) capN = tangent.clone().cross(new THREE.Vector3(0, 1, 0))
          }
        }
        out.push(capN.normalize().multiplyScalar(w2))
      }
      return out
    }

    const pushSide = (sign) =>
      rings.map((ring, j) => {
        const offs = offsetDirs(j)
        const base = vp.length / 3
        for (let i = 0; i < ring.length; i++) {
          vp.push(
            ring[i].x + sign * offs[i].x,
            ring[i].y + sign * offs[i].y,
            ring[i].z + sign * offs[i].z
          )
        }
        return base
      })
    const fronts = pushSide(1)
    const backs = pushSide(-1)
    const lastRing = rings[ringCount - 1]
    const tipC = centroidOf(lastRing)
    const lastOffs = offsetDirs(ringCount - 1)
    const tipN = new THREE.Vector3()
    for (const o of lastOffs) tipN.add(o)
    tipN.normalize().multiplyScalar(w2)
    const tipF = vp.length / 3
    vp.push(tipC.x + tipN.x, tipC.y + tipN.y, tipC.z + tipN.z)
    const tipB = vp.length / 3
    vp.push(tipC.x - tipN.x, tipC.y - tipN.y, tipC.z - tipN.z)

    const quad = (a1, a2, b1, b2) => tv.push(a1, a2, b2, a1, b2, b1)
    for (let j = 0; j + 1 < ringCount; j++) {
      const n = rings[j].length
      for (let i = 0; i < n; i++) {
        const k = (i + 1) % n
        quad(fronts[j] + i, fronts[j] + k, fronts[j + 1] + i, fronts[j + 1] + k)
        quad(backs[j] + i, backs[j] + k, backs[j + 1] + i, backs[j + 1] + k)
      }
    }
    for (let i = 0; i < lastRing.length; i++) {
      const k = (i + 1) % lastRing.length
      tv.push(fronts[ringCount - 1] + i, fronts[ringCount - 1] + k, tipF)
      tv.push(backs[ringCount - 1] + i, backs[ringCount - 1] + k, tipB)
    }
    const R = rings[0].length
    for (let i = 0; i < R; i++) {
      const k = (i + 1) % R
      quad(fronts[0] + i, fronts[0] + k, backs[0] + i, backs[0] + k)
    }
  }
  if (!tv.length) throw new Error('degenerate selection boundary')

  // Orientation: the loft's faces can wind either way. Propagate one
  // consistent winding across shared edges (BFS), then set the global
  // sense by signed volume — the boolean needs an outward-oriented cutter.
  {
    const triCount = tv.length / 3
    const edgeMap = new Map() // "min_max" -> [tri indices]
    for (let t = 0; t < triCount; t++) {
      for (let e = 0; e < 3; e++) {
        const a = tv[t * 3 + e]
        const b = tv[t * 3 + ((e + 1) % 3)]
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a
        let l = edgeMap.get(key)
        if (!l) edgeMap.set(key, (l = []))
        l.push(t)
      }
    }
    const flipped = new Uint8Array(triCount)
    const queue = []
    // one BFS per connected component (several boundary loops = several
    // cutter bodies in the same mesh)
    for (let s = 0; s < triCount; s++) {
      if (flipped[s]) continue
      flipped[s] = 1
      queue.push(s)
      while (queue.length) {
      const t = queue.shift()
      for (let e = 0; e < 3; e++) {
        const a = tv[t * 3 + e]
        const b = tv[t * 3 + ((e + 1) % 3)]
        const key = a < b ? a * 4294967296 + b : b * 4294967296 + a
        for (const nb of edgeMap.get(key) ?? []) {
          if (nb === t || flipped[nb]) continue
          // does the neighbour traverse this edge in the SAME direction?
          let same = false
          for (let e2 = 0; e2 < 3; e2++) {
            if (tv[nb * 3 + e2] === a && tv[nb * 3 + ((e2 + 1) % 3)] === b) same = true
          }
          if (same) {
            const tmp = tv[nb * 3 + 1]
            tv[nb * 3 + 1] = tv[nb * 3 + 2]
            tv[nb * 3 + 2] = tmp
          }
          flipped[nb] = 1
          queue.push(nb)
        }
      }
      }
    }
  }
  let signed = 0
  for (let i = 0; i < tv.length; i += 3) {
    const a = tv[i] * 3, b = tv[i + 1] * 3, c = tv[i + 2] * 3
    signed +=
      (vp[a] * (vp[b + 1] * vp[c + 2] - vp[b + 2] * vp[c + 1]) +
        vp[a + 1] * (vp[b + 2] * vp[c] - vp[b] * vp[c + 2]) +
        vp[a + 2] * (vp[b] * vp[c + 1] - vp[b + 1] * vp[c]))
  }
  if (signed < 0) for (let i = 0; i < tv.length; i += 3) [tv[i + 1], tv[i + 2]] = [tv[i + 2], tv[i + 1]]
  // No merge(): the index topology is already shared by construction, and
  // welding near-tip vertices would collapse edges into non-manifold ones.
  const cutterMesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(vp), triVerts: new Uint32Array(tv) })
  const cutter = new Manifold(cutterMesh)
  if (cutter.status() !== 'NoError') throw new Error('cutter construction failed')

  const carved = solid.subtract(cutter)
  solid.delete()
  cutter.delete()
  let parts = []
  try {
    parts = carved.decompose().filter((p) => !p.isEmpty() && p.volume() > 0.01)
  } finally {
    carved.delete()
  }
  // Fallback: shrinking cap can leave a membrane on thick wrists / coarse
  // meshes (skirt just inside the zigzag). If the cut did not sever, retry
  // with a planar wafer wall that is guaranteed to span the model: project
  // the largest loop onto its best-fit plane, thicken it by the kerf, and
  // extrude along the plane normal through the whole bounding box.
  if (parts.length < 2) {
    for (const p of parts) try { p.delete() } catch {}
    try {
      const { CrossSection, Mesh: Mesh2, Manifold: Manifold2 } = wasm
      // pick largest loop (most vertices — stable on wrist/hand)
      let best = bnd.loops[0]
      for (const L of bnd.loops) if (L.length > best.length) best = L
      const pts3 = []
      for (const idx of best) {
        const v = bnd.verts.get(idx)
        if (v) pts3.push(new THREE.Vector3(...v.p))
      }
      if (pts3.length >= 3) {
        const C = centroidOf(pts3)
        // Newell normal
        const N = new THREE.Vector3()
        for (let i = 0; i < pts3.length; i++) {
          const a = pts3[i], b = pts3[(i + 1) % pts3.length]
          N.x += (a.y - b.y) * (a.z + b.z)
          N.y += (a.z - b.z) * (a.x + b.x)
          N.z += (a.x - b.x) * (a.y + b.y)
        }
        if (N.lengthSq() < 1e-12) N.set(0, 0, 1)
        N.normalize()
        // orthonormal basis
        const tmp = Math.abs(N.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
        const U = new THREE.Vector3().crossVectors(N, tmp).normalize()
        const V = new THREE.Vector3().crossVectors(N, U).normalize()
        // 2D projection
        const pts2 = pts3.map((p) => {
          const d = p.clone().sub(C)
          return [d.dot(U), d.dot(V)]
        })
        // build ring wall as union of per-edge rectangles thickened by w2
        const rects = []
        for (let i = 0; i < pts2.length; i++) {
          const [ax, ay] = pts2[i]
          const [bx, by] = pts2[(i + 1) % pts2.length]
          const dx = bx - ax, dy = by - ay
          const len = Math.hypot(dx, dy)
          if (len < 1e-9) continue
          const nx = -dy / len, ny = dx / len
          rects.push([
            [ax - nx * w2, ay - ny * w2],
            [bx - nx * w2, by - ny * w2],
            [bx + nx * w2, by + ny * w2],
            [ax + nx * w2, ay + ny * w2]
          ])
        }
        if (rects.length >= 3) {
          const bbSize = geometry.boundingBox.getSize(new THREE.Vector3()).length()
          const depth = Math.max(bbSize * 2, 200)
          const cs = new CrossSection(rects, 'NonZero')
          const wallLocal = cs.extrude(depth).translate([0, 0, -depth / 2])
          cs.delete()
          const wMesh = wallLocal.getMesh()
          wallLocal.delete()
          // transform wallLocal (XY plane at C, Z along N) back to world
          const vpf = wMesh.vertProperties
          const nProp = wMesh.numProp
          for (let i = 0; i < vpf.length; i += nProp) {
            const x = vpf[i], y = vpf[i + 1], z = vpf[i + 2]
            const wx = C.x + U.x * x + V.x * y + N.x * z
            const wy = C.y + U.y * x + V.y * y + N.y * z
            const wz = C.z + U.z * x + V.z * y + N.z * z
            vpf[i] = wx; vpf[i + 1] = wy; vpf[i + 2] = wz
          }
          const wallMesh = new Mesh2({ numProp: nProp, vertProperties: vpf, triVerts: wMesh.triVerts })
          const cutter2 = new Manifold2(wallMesh)
          const solid2 = geometryToManifold(wasm, geometry)
          const carved2 = solid2.subtract(cutter2)
          solid2.delete(); cutter2.delete()
          let parts2 = []
          try { parts2 = carved2.decompose().filter((p) => !p.isEmpty() && p.volume() > 0.01) } finally { carved2.delete() }
          if (parts2.length >= 2) {
            parts = parts2
          } else {
            for (const p of parts2) try { p.delete() } catch {}
          }
        }
      }
    } catch (e) {
      console.warn('[selectionCut] wafer fallback failed', e)
    }
    if (parts.length < 2) throw new Error('Il taglio lungo il bordo non ha separato il pezzo: prova a selezionare un\'area più netta.')
  }
  // Which piece is the selection? A seed point (deepest selected triangle,
  // nudged 0.05mm inward) is inside exactly one piece — odd ray hits.
  const dir = new THREE.Vector3(0.577, 0.577, 0.577)
  const reach = geometry.boundingBox.getSize(new THREE.Vector3()).length() * 3
  const contains = (part, seed) => {
    const pb = part.boundingBox()
    const p = new THREE.Vector3(...seed.p).addScaledVector(new THREE.Vector3(...seed.n).normalize(), -0.05)
    if (
      p.x < pb.min[0] - 1e-6 || p.x > pb.max[0] + 1e-6 ||
      p.y < pb.min[1] - 1e-6 || p.y > pb.max[1] + 1e-6 ||
      p.z < pb.min[2] - 1e-6 || p.z > pb.max[2] + 1e-6
    )
      return false
    const hits = part.rayCast([p.x, p.y, p.z], [p.x + dir.x * reach, p.y + dir.y * reach, p.z + dir.z * reach])
    return hits.length % 2 === 1
  }
  const selParts = parts.filter((p) => bnd.seeds.some((seed) => contains(p, seed)))
  const rest = parts.filter((p) => !selParts.includes(p))
  const byVol = (a, b) => b.volume() - a.volume()
  selParts.sort(byVol)
  rest.sort(byVol)
  const out = [...selParts, ...rest].map((p) => {
    const g = manifoldToGeometry(p)
    p.delete()
    return g
  })
  return out
}

/**
 * Split a mesh into its connected components (the separate bodies "already
 * stored in the file": multi-part exports, detached details, floating
 * bases). The STL counterpart of what 3MF splitters do with stored objects.
 * Returns one geometry per body, biggest first; a single-body mesh comes
 * back unchanged (length 1).
 */
export async function splitParts(geometry) {
  const wasm = await getWasm()
  const solid = geometryToManifold(wasm, geometry)
  let parts = []
  try {
    parts = solid.decompose().filter((p) => !p.isEmpty())
  } finally {
    solid.delete()
  }
  if (parts.length < 2) {
    parts.forEach((p) => p.delete())
    return [geometry]
  }
  parts.sort((a, b) => b.volume() - a.volume())
  const out = parts.map((p) => {
    const g = manifoldToGeometry(p)
    p.delete()
    return g
  })
  return out
}

/**
 * Preview-only: where would the connectors land for these cut planes?
 * Runs the exact same placement logic as the cut, against the given
 * geometry, and returns world-space poses for the orange ghost markers.
 */
/**
 * Smart cut analysis: find the natural parting lines of a model (statues,
 * figurines) by reading its cross-sections along one axis.
 *
 * Two signals mark a good cut:
 *  - NARROW JOINTS: a local minimum of cross-section area (neck, wrists,
 *    ankles) — cutting there hides the seam and each part stays strong;
 *  - LIMB SEPARATIONS: the number of cross-section components changes and
 *    stays stable on both sides (crotch: 2 legs -> 1 torso, armpits:
 *    1 torso -> torso + 2 free arms).
 *
 * Returns candidates in world coordinates along the chosen axis, each with
 * the counts that let the UI label it (neck / legs / arms / joint).
 */
export async function smartAnalyze(geometry, axis = 'y', sensitivity = 5) {
  const wasm = await getWasm()
  // Bring the analysis axis onto +Z (slice() cuts on the local XY plane).
  const AXQ = {
    x: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
    y: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
    z: new THREE.Quaternion()
  }
  const gLocal = geometry.clone().applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(AXQ[axis] ?? AXQ.y))
  const solid = geometryToManifold(wasm, gLocal)
  gLocal.dispose()
  const bb = solid.boundingBox()
  const lo = bb.min[2]
  const hi = bb.max[2]
  const H = hi - lo
  const out = { axis, lo, hi, candidates: [] }
  if (!(H >= 8)) {
    solid.delete()
    return out
  }

  // ~1 slice per mm, capped so huge models stay interactive.
  const N = Math.min(220, Math.max(60, Math.round(H)))
  const step = H / N
  const areas = new Float64Array(N)
  const comps = new Int32Array(N)
  for (let i = 0; i < N; i++) {
    const h = lo + (i + 0.5) * step
    const sec = solid.slice(h)
    const polys = sec.toPolygons()
    sec.delete()
    let a = 0
    let c = 0
    for (const p of polys) {
      const pa = polygonArea(p)
      a += pa
      if (pa > 0) c++
    }
    areas[i] = Math.abs(a)
    comps[i] = c
  }
  solid.delete()

  const w = Math.max(3, Math.round(N * 0.05))
  const thr = 0.8 - sensitivity * 0.05
  const raw = []

  // (a) narrow joints — local minima much thinner than their surroundings
  for (let i = w; i < N - w; i++) {
    if (comps[i] === 0) continue // empty slice is not a joint
    let isMin = true
    let nb = 0
    for (let j = i - w; j <= i + w; j++) {
      if (j !== i && areas[j] < areas[i]) {
        isMin = false
        break
      }
      if (areas[j] > nb) nb = areas[j]
    }
    if (isMin && areas[i] < nb * thr)
      raw.push({ h: lo + (i + 0.5) * step, kind: 'narrow', ratio: +(areas[i] / nb).toFixed(3), below: comps[i], above: comps[i] })
  }

  // (b) stable component transitions — the change must hold on both sides
  const k = Math.max(2, Math.round(w / 2))
  for (let i = 0; i < N - 1; i++) {
    const b = comps[i]
    const a = comps[i + 1]
    if (b === a || b === 0 || a === 0) continue
    let stable = true
    for (let j = Math.max(0, i - k + 1); j <= i && stable; j++) if (comps[j] !== b) stable = false
    for (let j = i + 1; j <= Math.min(N - 1, i + k) && stable; j++) if (comps[j] !== a) stable = false
    if (stable) raw.push({ h: lo + (i + 1) * step, kind: 'split', ratio: 1, below: b, above: a })
  }

  raw.sort((p, q) => p.h - q.h)
  // Merge near-duplicates; a narrow joint wins as the cut line (cleaner
  // seam) but keeps the component counts of the split it absorbs.
  const minSep = Math.max(6, H * (0.1 - sensitivity * 0.005))
  const merged = []
  for (const c of raw) {
    const last = merged[merged.length - 1]
    if (last && c.h - last.h < minSep) {
      if (c.kind === 'narrow' && last.kind !== 'narrow') merged[merged.length - 1] = { ...c, below: last.below, above: last.above }
      else if (c.kind === 'narrow' && last.kind === 'narrow' && c.ratio < last.ratio) merged[merged.length - 1] = c
      continue
    }
    merged.push(c)
  }

  const trimmed = merged.filter((c) => c.h - lo > H * 0.04 && hi - c.h > H * 0.04)
  const narrows = trimmed.filter((c) => c.kind === 'narrow')
  const topNarrow = narrows.length ? narrows[narrows.length - 1] : null
  out.candidates = trimmed.map((c) => {
    const relH = (c.h - lo) / H
    const label =
      c === topNarrow
        ? 'neck'
        : c.kind !== 'split'
          ? 'joint'
          : c.below > c.above
            ? relH < 0.55 ? 'legs' : 'split'
            : relH >= 0.45 ? 'arms' : 'split'
    return { ...c, h: Math.round(c.h * 100) / 100, label }
  })
  return out
}

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
function validateCutParams(params) {
  for (const key of ['kerf', 'tolerance', 'spacing']) {
    if (params[key] !== undefined && (!Number.isFinite(params[key]) || params[key] < 0)) {
      throw new Error(`Invalid ${key}: expected finite non-negative millimeters`)
    }
  }
  if (params.pins) {
    for (const key of ['pinDiameter', 'pinLength']) {
      if (!Number.isFinite(params[key]) || params[key] <= 0) throw new Error(`Invalid ${key}`)
    }
    if ((params.kerf ?? 0) >= params.pinLength * 0.6) {
      throw new Error('Cut gap is too large for the connector length')
    }
  }
}

export async function planeCut(geometry, plane, params = {}) {
  validateCutParams(params)
  if (!plane?.pos?.every(Number.isFinite) || !plane?.quat?.every(Number.isFinite)) {
    throw new Error('Invalid cutting plane')
  }
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
  // Return in WORLD coordinates. Also avoid negative half-space box sizes
  // for colored models and planes outside the model during a multi-cut.
  const gap = Math.max(0, params.kerf ?? 0) / 2
  if (lb.min.z >= -gap || lb.max.z <= gap) {
    gLocal.dispose()
    return [geometry.clone()]
  }
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
      return [manifoldToGeometry(solid).applyMatrix4(toWorld)]
    }

    if (params.pins) {
      // Connector shapes: round/square/hex/dovetail pegs (one piece carries
      // the peg, the other the socket) or dowel holes (both pieces get the
      // same hole, a separate wooden/printed dowel bridges them).
      const type = params.connectorType || 'pin'
      const r = Math.max(0.2, params.pinDiameter / 2)
      const h = Math.max(1, params.pinLength)
      const tol = Math.max(0, params.tolerance)
      // Tapered pegs (tip 80% of base radius) slide into their socket without
      // fighting the first layers — much easier to assemble than straight pins.
      const rTip = params.taper && type !== 'dowel' ? r * 0.8 : r
      const rot = ((params.connectorRot ?? 0) * Math.PI) / 180
      // Which piece carries the peg: 'a' = below the plane (default),
      // 'b' = above it. The peg tip always points into the socket piece.
      const pegAxis = new THREE.Vector3(0, 0, params.pinSide === 'b' ? -1 : 1)
      const placements = pinPlacements(wasm, solid, params)
      if (type === 'dowel') dowelCount = placements.length
      for (const [x, y, off] of placements) {
        const mkPin = (rr, rt, hh) =>
          matchProps(
            geometryToManifold(
              wasm,
              pinGeometry3D({ type, r: rr, rTip: rt, h: hh, rot, axis: pegAxis, center: new THREE.Vector3(x, y, off) })
            ),
            hasColor
          )
        if (type === 'dowel') {
          const hole = mkPin(r + tol, r + tol, h + 2 * tol)
          cleanup.push(hole)
          const t2 = top.subtract(hole)
          const b2 = bottom.subtract(hole)
          cleanup.push(t2, b2)
          top = t2
          bottom = b2
          continue
        }
        const peg = mkPin(r, rTip, h)
        const socket = mkPin(r + tol, rTip + tol, h + 2 * tol)
        cleanup.push(peg, socket)
        if (params.pinSide === 'b') {
          const t2 = top.add(peg)
          const b2 = bottom.subtract(socket)
          cleanup.push(t2, b2)
          top = t2
          bottom = b2
        } else {
          const b2 = bottom.add(peg)
          const t2 = top.subtract(socket)
          cleanup.push(b2, t2)
          bottom = b2
          top = t2
        }
      }
    }

    // Booleans around connector cylinders can leave sub-micron slivers
    // that collapse (and duplicate edges) once rounded to float32;
    // simplify(1µm) cleans them without touching real features.
    const topS = top.simplify(0.001)
    const bottomS = bottom.simplify(0.001)
    cleanup.push(topS, bottomS)
    if (topS.numTri()) top = topS
    if (bottomS.numTri()) bottom = bottomS
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
  validateCutParams(params)
  if (!points || points.length < 2) throw new Error('curved cut needs at least 2 points')
  const wasm = await getWasm()
  const { CrossSection } = wasm
  const kerf = Math.max(params.kerf ?? 0.15, 0.02)
  const w2 = kerf / 2
  const hasColor = !!geometry.attributes.color

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
  const drawn2 = pts2.map((p) => [p[0], p[1]]) // pre-extension copy (pin candidates)
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

  const cleanup = []
  let parts = []
  try {
    parts = carved.decompose().filter((p) => !p.isEmpty())

    let dowelCount = 0
    if (params.pins && drawn2.length >= 2 && parts.length >= 2) {
      dowelCount = applyCurvedPins(wasm, solid, parts, { drawn2, bb, kerf, w2, params, cleanup, hasColor })
    }

    const out = []
    for (const part of parts) {
      // Booleans around connector cylinders can leave sub-micron slivers
      // that collapse (and duplicate edges) once rounded to float32;
      // simplify(1µm) cleans them without touching real features.
      const simp = part.simplify(0.001)
      cleanup.push(simp)
      out.push(manifoldToGeometry(simp.numTri() ? simp : part).applyMatrix4(M))
    }
    out.dowelCount = dowelCount
    return out
  } finally {
    solid.delete()
    carved.delete()
    for (const p of parts) {
      try {
        p.delete()
      } catch {
        /* consumed */
      }
    }
    for (const m of cleanup) {
      try {
        m.delete()
      } catch {
        /* consumed */
      }
    }
  }
}

/**
 * Connectors for the freehand cut: pegs and sockets bridging the pieces
 * along the drawn curve. Each pin's axis is the curve's local in-plane
 * normal; its depth along the view axis is centered in the widest
 * material interval found there (ray cast on the original solid), and the
 * final fit is validated with an exact boolean containment test — the
 * same approach as the plane cut's pinPlacements.
 * Returns the dowel count (0 for peg types).
 */
function applyCurvedPins(wasm, solid, parts, ctx) {
  const { drawn2, bb, kerf, w2, params, cleanup, hasColor } = ctx
  const r = Math.max(0.2, (params.pinDiameter ?? 6) / 2)
  const h = Math.max(1, params.pinLength ?? 8)
  const tol = Math.max(0, params.tolerance ?? 0.15)
  const spacing = Math.max(r * 3, params.spacing ?? 25)
  const rot = ((params.connectorRot ?? 0) * Math.PI) / 180
  const pegOnPositive = params.pinSide === 'b'
  const type = params.connectorType || 'pin'
  const isDowel = type === 'dowel'
  const rTip = params.taper !== false && !isDowel ? r * 0.8 : r

  // Sorted hit distances (mm) along a segment on the original solid —
  // rayCast returns fractions of the segment length, so scale by it.
  const hitsAlong = (a, b) => {
    const len = a.distanceTo(b)
    return solid
      .rayCast([a.x, a.y, a.z], [b.x, b.y, b.z])
      .map((hh) => hh.distance * len)
      .sort((x, y) => x - y)
  }

  // Candidates along the drawn polyline (arc length).
  const cands = []
  for (let i = 0; i + 1 < drawn2.length; i++) {
    const [ax, ay] = drawn2[i]
    const [bx, by] = drawn2[i + 1]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-9) continue
    let s = 0
    while (s <= len) {
      const t = s / len
      cands.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, tx: (bx - ax) / len, ty: (by - ay) / len })
      s += Math.max(2, spacing / 4)
    }
  }

  const zMin = bb.min.z
  const zMax = bb.max.z
  const accepted = []
  for (const c of cands) {
    if (accepted.some((p) => Math.hypot(c.x - p.x, c.y - p.y) < spacing)) continue
    // In-plane normal of the curve at this candidate.
    const m = new THREE.Vector3(c.ty, -c.tx, 0)
    // Depth: material intervals along the view axis at (x, y) — the pin
    // cross-section must fit inside the widest one.
    const ds = hitsAlong(new THREE.Vector3(c.x, c.y, zMin - 1), new THREE.Vector3(c.x, c.y, zMax + 1))
    let best = null
    for (let i = 0; i + 1 < ds.length; i += 2) {
      const zA = zMin - 1 + ds[i]
      const zB = zMin - 1 + ds[i + 1]
      if (zB - zA < 2 * (r + tol + PIN_WALL)) continue
      if (!best || zB - zA > best[1] - best[0]) best = [zA, zB]
    }
    if (!best) continue
    accepted.push({ ...c, m, zc: (best[0] + best[1]) / 2 })
  }

  // Exact fit test: the tester pin must sit fully inside the material
  // (the kerf region is still material in the original solid).
  const fitsInside = (geo) => {
    const tester = geometryToManifold(wasm, geo)
    const leak = tester.subtract(solid)
    const fits = leak.isEmpty() || leak.volume() < 0.05
    tester.delete()
    leak.delete()
    return fits
  }

  // Which piece owns a probe point? Odd number of ray hits = inside.
  const pieceAt = (p) => {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const pb = part.boundingBox()
      if (
        p.x < pb.min[0] - 1e-6 || p.x > pb.max[0] + 1e-6 ||
        p.y < pb.min[1] - 1e-6 || p.y > pb.max[1] + 1e-6 ||
        p.z < pb.min[2] - 1e-6 || p.z > pb.max[2] + 1e-6
      ) continue
      const dir = new THREE.Vector3(0.577, 0.577, 0.577).normalize()
      const end = p.clone().addScaledVector(dir, radiusOf(bb) * 3)
      const hits = part.rayCast([p.x, p.y, p.z], [end.x, end.y, end.z])
      if (hits.length % 2 === 1) return i
    }
    return -1
  }

  let dowelCount = 0
  for (const pin of accepted) {
    const center = new THREE.Vector3(pin.x, pin.y, pin.zc)
    const pegDir = pin.m.clone().multiplyScalar(pegOnPositive ? 1 : -1)
    const mkGeo = (rr, rt, hh) => pinGeometry3D({ type, r: rr, rTip: rt, h: hh, rot, axis: pegDir, center })
    if (!fitsInside(mkGeo(r + tol + PIN_WALL, rTip + tol + PIN_WALL, h + 2 * tol + 2 * PIN_WALL))) continue
    // Probe just outside the kerf on each side of the wall.
    const probeDist = w2 + Math.min(0.5, r * 0.2) + 1e-3
    const iA = pieceAt(center.clone().addScaledVector(pegDir, probeDist))
    const iB = pieceAt(center.clone().addScaledVector(pegDir, -probeDist))
    if (iA < 0 || iB < 0 || iA === iB) continue

    const mkPin = (rr, rt, hh) => matchProps(geometryToManifold(wasm, mkGeo(rr, rt, hh)), hasColor)
    if (isDowel) {
      const hole = mkPin(r + tol, r + tol, h + 2 * tol)
      cleanup.push(hole)
      for (const idx of new Set([iA, iB])) {
        const p2 = parts[idx].subtract(hole)
        cleanup.push(p2)
        parts[idx] = p2
      }
      dowelCount++
      continue
    }
    const peg = mkPin(r, rTip, h)
    const socket = mkPin(r + tol, rTip + tol, h + 2 * tol)
    cleanup.push(peg, socket)
    const withPeg = parts[iA].add(peg)
    const withSocket = parts[iB].subtract(socket)
    cleanup.push(withPeg, withSocket)
    parts[iA] = withPeg
    parts[iB] = withSocket
  }
  return dowelCount
}

function radiusOf(bb) {
  return Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) / 2
}

/**
 * Oriented connector solid as a THREE geometry (local cut frame): a
 * cylinder / square / hex prism / dovetail with its axis along `axis`,
 * self-rotated by `rot`, centered at `center`. The tip (+axis end) is the
 * narrow end for tapered pins and dovetails.
 */
function pinGeometry3D({ type, r, rTip, h, rot, axis, center }) {
  let geo
  if (type === 'square') {
    geo = new THREE.BoxGeometry(2 * r, h, 2 * r)
  } else if (type === 'dovetail') {
    // Trapezoid prism: wide at the root, narrow at the tip — resists
    // pull-out and eases insertion like a tapered peg.
    const wBase = 2 * r
    const wTip = 1.4 * r
    const depth = 1.6 * r
    const corners = []
    const push = (x, y, z) => corners.push(x, y, z)
    // base rect (y = -h/2), tip rect (y = +h/2)
    push(-wBase / 2, -h / 2, -depth / 2); push(wBase / 2, -h / 2, -depth / 2)
    push(wBase / 2, -h / 2, depth / 2); push(-wBase / 2, -h / 2, depth / 2)
    push(-wTip / 2, h / 2, -depth / 2); push(wTip / 2, h / 2, -depth / 2)
    push(wTip / 2, h / 2, depth / 2); push(-wTip / 2, h / 2, depth / 2)
    const V = corners
    const faces = [
      [0, 3, 2, 1], // base (y-)
      [4, 5, 6, 7], // tip (y+)
      [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7] // sides
    ]
    const pos = []
    for (const f of faces) {
      for (const i of [0, 1, 2, 0, 2, 3]) pos.push(V[f[i] * 3], V[f[i] * 3 + 1], V[f[i] * 3 + 2])
    }
    geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  } else {
    const seg = type === 'hex' ? 6 : 48
    geo = new THREE.CylinderGeometry(rTip, r, h, seg)
  }
  const qSelf = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot)
  const qAlign = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize())
  geo.applyQuaternion(qAlign.multiply(qSelf))
  geo.translate(center.x, center.y, center.z)
  return geo
}

function sub2(a, b) {
  return [a[0] - b[0], a[1] - b[1]]
}
function norm2(a) {
  return Math.hypot(a[0], a[1])
}
