import * as THREE from 'three'

// Shape selection: from a clicked triangle, flood-fill across edges while
// neighbouring faces stay smooth; sharp creases (dihedral angle above the
// sensitivity) stop the growth. Works on indexed and raw (STL) geometry.
// Runs on the main thread — fine up to ~1M triangles; simplify first beyond.
// PRECISION: follows anterior / lateral / posterior curvature around the entire
// part (wrist, neck, limb) by using true Dijkstra geodesic distance + robust
// welded adjacency (0.01mm quantisation) and angle-sorted boundary tracing.

function adjacency(geometry) {
  if (geometry.userData._adj) return geometry.userData._adj
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const triCount = (idx ? idx.length : geometry.attributes.position.count) / 3
  // Weld corners by quantized position so raw STL soup gets real adjacency.
  // 1e5 => 0.01 mm resolution for precise curve following front/side/back.
  const keyMap = new Map()
  const cornerVid = new Int32Array(triCount * 3)
  let nextId = 0
  const q = 1e5
  for (let c = 0; c < triCount * 3; c++) {
    const v = idx ? idx[c] : c
    const key = `${Math.round(pos[v * 3] * q)}_${Math.round(pos[v * 3 + 1] * q)}_${Math.round(
      pos[v * 3 + 2] * q
    )}`
    let id = keyMap.get(key)
    if (id === undefined) {
      id = nextId++
      keyMap.set(key, id)
    }
    cornerVid[c] = id
  }
  // Pair up shared edges — string key avoids 2^22 overflow for large meshes
  // and guarantees exact pairing for precise boundary extraction.
  const neighbors = new Int32Array(triCount * 3).fill(-1)
  const open = new Map()
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const slot = t * 3 + e
      const a = cornerVid[slot]
      const b = cornerVid[t * 3 + ((e + 1) % 3)]
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      const other = open.get(key)
      if (other === undefined) {
        open.set(key, slot)
      } else {
        neighbors[slot] = Math.floor(other / 3)
        neighbors[other] = t
        open.delete(key)
      }
    }
  }
  const adj = { cornerVid, neighbors, triCount }
  geometry.userData._adj = adj
  return adj
}

function triNormals(geometry) {
  if (geometry.userData._triNormals) return geometry.userData._triNormals
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const triCount = (idx ? idx.length : geometry.attributes.position.count) / 3
  const out = new Float32Array(triCount * 3)
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let t = 0; t < triCount; t++) {
    const i0 = (idx ? idx[t * 3] : t * 3) * 3
    const i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3
    const i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3
    a.fromArray(pos, i0)
    b.fromArray(pos, i1)
    c.fromArray(pos, i2)
    ab.subVectors(b, a)
    ac.subVectors(c, a)
    ab.cross(ac).normalize()
    out[t * 3] = ab.x
    out[t * 3 + 1] = ab.y
    out[t * 3 + 2] = ab.z
  }
  geometry.userData._triNormals = out
  return out
}

function triCentroids(geometry) {
  if (geometry.userData._triCentroids) return geometry.userData._triCentroids
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const triCount = (idx ? idx.length : geometry.attributes.position.count) / 3
  const out = new Float32Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    let x = 0,
      y = 0,
      z = 0
    for (let k = 0; k < 3; k++) {
      const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3
      x += pos[v]
      y += pos[v + 1]
      z += pos[v + 2]
    }
    out[t * 3] = x / 3
    out[t * 3 + 1] = y / 3
    out[t * 3 + 2] = z / 3
  }
  geometry.userData._triCentroids = out
  return out
}

// Minimal binary heap for Dijkstra (sorted by distance)
class MinHeap {
  constructor() {
    this.h = []
  }
  push(item) {
    const h = this.h
    h.push(item)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (h[p].dist <= h[i].dist) break
      ;[h[p], h[i]] = [h[i], h[p]]
      i = p
    }
  }
  pop() {
    const h = this.h
    if (!h.length) return null
    const top = h[0]
    const last = h.pop()
    if (h.length) {
      h[0] = last
      let i = 0
      while (true) {
        const l = i * 2 + 1
        const r = l + 1
        let s = i
        if (l < h.length && h[l].dist < h[s].dist) s = l
        if (r < h.length && h[r].dist < h[s].dist) s = r
        if (s === i) break
        ;[h[i], h[s]] = [h[s], h[i]]
        i = s
      }
    }
    return top
  }
  get length() {
    return this.h.length
  }
}

/**
 * Grow from the clicked triangle by geodesic distance over the surface
 * (radius in model units), additionally stopped by sharp creases.
 * PRECISE: Dijkstra heap ensures the radius follows anterior/lateral/
 * posterior curvature with true shortest-path distance, not BFS order.
 * The crease threshold stops uniformly in all directions at the valley
 * surrounding a protrusion (neck, wrist, limb base).
 */
export function growRegion(geometry, seedTri, angleDeg, radius = Infinity) {
  const { neighbors, triCount } = adjacency(geometry)
  const normals = triNormals(geometry)
  const cent = triCentroids(geometry)
  const cosT = Math.cos((angleDeg * Math.PI) / 180)
  const sel = new Uint8Array(triCount)
  const dist = new Float32Array(triCount).fill(Infinity)
  const heap = new MinHeap()
  sel[seedTri] = 1
  dist[seedTri] = 0
  heap.push({ t: seedTri, dist: 0 })
  let count = 1
  while (heap.length) {
    const cur = heap.pop()
    const t = cur.t
    // stale entry (a shorter path was already found)
    if (cur.dist !== dist[t]) continue
    if (cur.dist > radius) continue
    const nx = normals[t * 3]
    const ny = normals[t * 3 + 1]
    const nz = normals[t * 3 + 2]
    for (let e = 0; e < 3; e++) {
      const nb = neighbors[t * 3 + e]
      if (nb < 0) continue
      const dot = nx * normals[nb * 3] + ny * normals[nb * 3 + 1] + nz * normals[nb * 3 + 2]
      if (dot < cosT) continue
      const step = Math.hypot(
        cent[nb * 3] - cent[t * 3],
        cent[nb * 3 + 1] - cent[t * 3 + 1],
        cent[nb * 3 + 2] - cent[t * 3 + 2]
      )
      const nd = dist[t] + step
      if (nd > radius || nd >= dist[nb] - 1e-9) continue
      const wasNew = !sel[nb]
      dist[nb] = nd
      if (wasNew) {
        sel[nb] = 1
        count++
      }
      heap.push({ t: nb, dist: nd })
    }
  }
  return { sel, count, triCount }
}

/**
 * Boundary of a painted selection: the closed loops where selected
 * triangles meet unselected ones — the exact line "Stacca lungo il bordo"
 * saws through. Per boundary vertex a smoothed surface normal (the saw
 * direction), and per loop a seed point pushed deep inside the selection
 * (used to tell which cut piece is the selection).
 * PRECISE: boundary loops are traced angle-sorted so the seam follows
 * anterior → lateral → posterior curvature smoothly instead of zig-zag.
 */
export function selectionBoundary(geometry, sel) {
  const { cornerVid, neighbors, triCount } = adjacency(geometry)
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const normals = triNormals(geometry)
  const cent = triCentroids(geometry)

  // Pass 1: boundary edges (selected tri corner with a real, unselected
  // neighbour) and the set of boundary vertices.
  const bVerts = new Set()
  const edges = [] // { a, b, tri } — welded vertex ids, owning selected tri
  for (let t = 0; t < triCount; t++) {
    if (!sel[t]) continue
    for (let e = 0; e < 3; e++) {
      const slot = t * 3 + e
      const nb = neighbors[slot]
      if (nb < 0 || sel[nb]) continue
      const a = cornerVid[slot]
      const b = cornerVid[t * 3 + ((e + 1) % 3)]
      edges.push({ a, b, tri: t })
      bVerts.add(a)
      bVerts.add(b)
    }
  }
  if (!edges.length) return { loops: [], verts: new Map(), seeds: [] }

  // Pass 2: smoothed normal + position per boundary vertex, accumulated
  // from every selected triangle that touches it.
  const verts = new Map()
  const touch = (vid, slot, t) => {
    if (!bVerts.has(vid)) return
    let v = verts.get(vid)
    if (!v) {
      const p = idx ? idx[slot] : slot
      verts.set(vid, (v = { p: [pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2]], nx: 0, ny: 0, nz: 0 }))
    }
    v.nx += normals[t * 3]
    v.ny += normals[t * 3 + 1]
    v.nz += normals[t * 3 + 2]
  }
  for (let t = 0; t < triCount; t++) {
    if (!sel[t]) continue
    for (let e = 0; e < 3; e++) {
      const slot = t * 3 + e
      touch(cornerVid[slot], slot, t)
    }
  }
  // Normalize pooled normals for stable saw direction on curved surfaces
  for (const v of verts.values()) {
    const l = Math.hypot(v.nx, v.ny, v.nz)
    if (l > 1e-9) {
      v.nx /= l
      v.ny /= l
      v.nz /= l
    }
  }

  // Chain boundary edges into loops — angle-sorted walk for precise
  // anterior/lateral/posterior following.
  const byVertex = new Map()
  edges.forEach((ed, i) => {
    for (const v of [ed.a, ed.b]) {
      let l = byVertex.get(v)
      if (!l) byVertex.set(v, (l = []))
      l.push(i)
    }
  })

  // Helper to get position of welded vertex id
  const vertPos = (vid) => {
    const v = verts.get(vid)
    if (v) return v.p
    // fallback: find any occurrence of this vid in cornerVid
    // (should not happen for boundary verts but be safe)
    return [0, 0, 0]
  }

  const visited = new Uint8Array(edges.length)
  const loops = []
  for (let start = 0; start < edges.length; start++) {
    if (visited[start]) continue
    const loop = []
    let ei = start
    let at = edges[start].a
    let prev = null // previous vertex for direction
    // Initialize with the start edge's b as next, but our loop stores vertices
    while (true) {
      visited[ei] = 1
      const ed = edges[ei]
      const next = ed.a === at ? ed.b : ed.a
      loop.push(at)
      const curAt = at
      prev = at
      at = next
      if (at === edges[start].a && loop.length > 2) break // closed
      const cands = (byVertex.get(at) ?? []).filter((j) => !visited[j])
      if (!cands.length) break // stuck (pinch point): close as-is
      if (cands.length === 1) {
        ei = cands[0]
      } else {
        // Choose candidate that continues straightest (smallest turn angle)
        // — this keeps the seam hugging the smooth curvature around the part
        // instead of cutting across via a jagged triangulation shortcut.
        const curPos = vertPos(at)
        const prevPos = vertPos(prev)
        const inDir = [curPos[0] - prevPos[0], curPos[1] - prevPos[1], curPos[2] - prevPos[2]]
        const inLen = Math.hypot(inDir[0], inDir[1], inDir[2]) || 1
        inDir[0] /= inLen
        inDir[1] /= inLen
        inDir[2] /= inLen
        let bestIdx = cands[0]
        let bestDot = -2
        for (const cand of cands) {
          const e = edges[cand]
          const other = e.a === at ? e.b : e.a
          const otherPos = vertPos(other)
          const outDir = [otherPos[0] - curPos[0], otherPos[1] - curPos[1], otherPos[2] - curPos[2]]
          const outLen = Math.hypot(outDir[0], outDir[1], outDir[2]) || 1
          outDir[0] /= outLen
          outDir[1] /= outLen
          outDir[2] /= outLen
          const dot = inDir[0] * outDir[0] + inDir[1] * outDir[1] + inDir[2] * outDir[2]
          // Prefer the most colinear continuation (dot closest to 1)
          // but for closed loops we actually want to turn ~0° (straight)
          // Boundary loops on smooth sculpts are gently curved, so smallest
          // deviation wins. For sharp corners, any choice is similar.
          if (dot > bestDot) {
            bestDot = dot
            bestIdx = cand
          }
        }
        ei = bestIdx
      }
    }
    if (loop.length >= 3) loops.push(loop)
  }

  // Per loop: seed = deepest selected triangle (BFS from the loop's own
  // boundary triangles), centroid nudged inward along its face normal.
  const seeds = []
  for (const loop of loops) {
    const depth = new Map()
    const queue = []
    const vids = new Set(loop)
    for (const ed of edges) {
      if (vids.has(ed.a) || vids.has(ed.b)) {
        if (!depth.has(ed.tri)) {
          depth.set(ed.tri, 0)
          queue.push(ed.tri)
        }
      }
    }
    let best = queue[0]
    let bestD = 0
    while (queue.length) {
      const t = queue.shift()
      const d = depth.get(t)
      if (d > bestD) {
        bestD = d
        best = t
      }
      for (let e = 0; e < 3; e++) {
        const nb = neighbors[t * 3 + e]
        if (nb < 0 || !sel[nb] || depth.has(nb)) continue
        depth.set(nb, d + 1)
        queue.push(nb)
      }
    }
    if (best !== undefined) {
      seeds.push({
        p: [cent[best * 3], cent[best * 3 + 1], cent[best * 3 + 2]],
        n: [normals[best * 3], normals[best * 3 + 1], normals[best * 3 + 2]]
      })
    }
  }
  return { loops, verts, seeds }
}

/**
 * Connected region whose triangles stay nearly coplanar with the SEED
 * triangle (each candidate is compared to the seed normal, not to its
 * neighbour — gentle curvature cannot drift the selection wide). Used to
 * light up "the face" under the cursor in place-on-face mode.
 */
export function coplanarRegion(geometry, seedTri, angleDeg = 12) {
  const { neighbors, triCount } = adjacency(geometry)
  const normals = triNormals(geometry)
  const cosT = Math.cos((angleDeg * Math.PI) / 180)
  const sx = normals[seedTri * 3]
  const sy = normals[seedTri * 3 + 1]
  const sz = normals[seedTri * 3 + 2]
  const sel = new Uint8Array(triCount)
  const queue = [seedTri]
  sel[seedTri] = 1
  let count = 1
  while (queue.length) {
    const t = queue.pop()
    for (let e = 0; e < 3; e++) {
      const nb = neighbors[t * 3 + e]
      if (nb < 0 || sel[nb]) continue
      if (sx * normals[nb * 3] + sy * normals[nb * 3 + 1] + sz * normals[nb * 3 + 2] < cosT)
        continue
      sel[nb] = 1
      count++
      queue.push(nb)
    }
  }
  return { sel, count, triCount }
}

export function regionPositions(geometry, sel, count) {
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const out = new Float32Array(count * 9)
  let o = 0
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    for (let k = 0; k < 3; k++) {
      const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3
      out[o++] = pos[v]
      out[o++] = pos[v + 1]
      out[o++] = pos[v + 2]
    }
  }
  return out
}

/**
 * Oriented cutting box for a selected region: the box's bottom face sits on
 * the plane fitted to the region's boundary loop (the "neck"), and it covers
 * the region with a margin. Feed the returned matrix to volumeCut.
 */
export function regionOrientedBox(geometry, sel) {
  const { cornerVid, neighbors } = adjacency(geometry)
  const pos = geometry.attributes.position.array
  const idx = geometry.index?.array ?? null
  const corner = (t, k) => {
    const v = (idx ? idx[t * 3 + k] : t * 3 + k) * 3
    return new THREE.Vector3(pos[v], pos[v + 1], pos[v + 2])
  }

  // Boundary edges = selected tri edges whose neighbour is outside.
  const boundary = []
  const bCentroid = new THREE.Vector3()
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    for (let e = 0; e < 3; e++) {
      const nb = neighbors[t * 3 + e]
      if (nb >= 0 && sel[nb]) continue
      const a = corner(t, e)
      const b = corner(t, (e + 1) % 3)
      boundary.push([a, b])
      bCentroid.add(a).add(b)
    }
  }
  if (!boundary.length) return null
  bCentroid.divideScalar(boundary.length * 2)

  // Newell-style normal over the (consistently wound) boundary edges.
  const n = new THREE.Vector3()
  const ta = new THREE.Vector3()
  const tb = new THREE.Vector3()
  for (const [a, b] of boundary) {
    ta.subVectors(a, bCentroid)
    tb.subVectors(b, bCentroid)
    n.add(ta.cross(tb))
  }
  if (n.lengthSq() < 1e-12) return null
  n.normalize()

  // Region centroid decides which side of the boundary plane the shape is on.
  const rc = new THREE.Vector3()
  let rcount = 0
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    rc.add(corner(t, 0))
    rcount++
  }
  rc.divideScalar(rcount)
  if (n.dot(new THREE.Vector3().subVectors(rc, bCentroid)) < 0) n.negate()

  // Orthonormal basis (u, v, n) and region extents in it.
  const u = new THREE.Vector3(1, 0, 0)
  if (Math.abs(n.x) > 0.8) u.set(0, 1, 0)
  u.cross(n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u)
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity,
    minW = Infinity,
    maxW = -Infinity
  const d = new THREE.Vector3()
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue
    for (let k = 0; k < 3; k++) {
      d.subVectors(corner(t, k), bCentroid)
      const pu = d.dot(u)
      const pv = d.dot(v)
      const pw = d.dot(n)
      if (pu < minU) minU = pu
      if (pu > maxU) maxU = pu
      if (pv < minV) minV = pv
      if (pv > maxV) maxV = pv
      if (pw < minW) minW = pw
      if (pw > maxW) maxW = pw
    }
  }
  const m = Math.max(1, 0.03 * Math.max(maxU - minU, maxV - minV, maxW - minW))
  minU -= m
  maxU += m
  minV -= m
  maxV += m
  maxW += m
  minW = Math.min(minW, 0) - 0.2 // just under the neck plane: full cut, no crumbs

  const size = new THREE.Vector3(maxU - minU, maxV - minV, maxW - minW)
  const center = bCentroid
    .clone()
    .addScaledVector(u, (minU + maxU) / 2)
    .addScaledVector(v, (minV + maxV) / 2)
    .addScaledVector(n, (minW + maxW) / 2)
  const rot = new THREE.Matrix4().makeBasis(u, v, n)
  const quat = new THREE.Quaternion().setFromRotationMatrix(rot)
  return new THREE.Matrix4().compose(center, quat, size).toArray()
}
