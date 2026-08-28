import * as THREE from 'three'

/**
 * Computes line segments representing the intersection between a 3D geometry and a cutting plane/plate.
 * Returns a Float32Array of segment vertex coordinates [x1, y1, z1, x2, y2, z2, ...].
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Vector3} planeNormal - Normalized normal vector of the cut plane
 * @param {THREE.Vector3} planePoint - Point on the cut plane
 * @param {Object} [plateBounds] - Optional bounded plate definition: { matrixWorldInverse, width, height }
 * @returns {Float32Array} Array of lines vertices
 */
export function computeSectionSegments(geometry, planeNormal, planePoint, plateBounds = null) {
  if (!geometry || !geometry.attributes || !geometry.attributes.position) {
    return new Float32Array(0)
  }

  const posAttr = geometry.attributes.position
  const indexAttr = geometry.index
  const vertexCount = posAttr.count
  const triCount = indexAttr ? indexAttr.count / 3 : vertexCount / 3

  const N = planeNormal
  const P = planePoint

  const pA = new THREE.Vector3()
  const pB = new THREE.Vector3()
  const pC = new THREE.Vector3()
  const pI1 = new THREE.Vector3()
  const pI2 = new THREE.Vector3()

  // Pre-allocate buffer (estimated size, trimmed at end)
  const segments = []
  const EPSILON = 1e-6

  const halfW = plateBounds ? plateBounds.width / 2 : 0
  const halfH = plateBounds ? plateBounds.height / 2 : 0
  const invMatrix = plateBounds ? plateBounds.matrixWorldInverse : null

  function checkPlate(pt) {
    if (!invMatrix) return true
    const local = pt.clone().applyMatrix4(invMatrix)
    return Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfH
  }

  for (let i = 0; i < triCount; i++) {
    let i0, i1, i2
    if (indexAttr) {
      i0 = indexAttr.getX(i * 3)
      i1 = indexAttr.getX(i * 3 + 1)
      i2 = indexAttr.getX(i * 3 + 2)
    } else {
      i0 = i * 3
      i1 = i * 3 + 1
      i2 = i * 3 + 2
    }

    pA.fromBufferAttribute(posAttr, i0)
    pB.fromBufferAttribute(posAttr, i1)
    pC.fromBufferAttribute(posAttr, i2)

    const dA = (pA.x - P.x) * N.x + (pA.y - P.y) * N.y + (pA.z - P.z) * N.z
    const dB = (pB.x - P.x) * N.x + (pB.y - P.y) * N.y + (pB.z - P.z) * N.z
    const dC = (pC.x - P.x) * N.x + (pC.y - P.y) * N.y + (pC.z - P.z) * N.z

    const sA = Math.abs(dA) < EPSILON ? 0 : dA > 0 ? 1 : -1
    const sB = Math.abs(dB) < EPSILON ? 0 : dB > 0 ? 1 : -1
    const sC = Math.abs(dC) < EPSILON ? 0 : dC > 0 ? 1 : -1

    // All on same side -> no intersection
    if ((sA > 0 && sB > 0 && sC > 0) || (sA < 0 && sB < 0 && sC < 0)) {
      continue
    }

    // All on plane -> skip coplanar triangles
    if (sA === 0 && sB === 0 && sC === 0) {
      continue
    }

    let hasIntersection = false

    // Case 1: One vertex isolated on one side, two on the other
    if (sA !== sB && sA !== sC && sB === sC) {
      const t1 = dA / (dA - dB)
      const t2 = dA / (dA - dC)
      pI1.copy(pA).lerp(pB, t1)
      pI2.copy(pA).lerp(pC, t2)
      hasIntersection = true
    } else if (sB !== sA && sB !== sC && sA === sC) {
      const t1 = dB / (dB - dA)
      const t2 = dB / (dB - dC)
      pI1.copy(pB).lerp(pA, t1)
      pI2.copy(pB).lerp(pC, t2)
      hasIntersection = true
    } else if (sC !== sA && sC !== sB && sA === sB) {
      const t1 = dC / (dC - dA)
      const t2 = dC / (dC - dB)
      pI1.copy(pC).lerp(pA, t1)
      pI2.copy(pC).lerp(pB, t2)
      hasIntersection = true
    }
    // Case 2: One vertex on the plane, two opposite
    else if (sA === 0 && sB !== sC && sB !== 0 && sC !== 0) {
      const t = dB / (dB - dC)
      pI1.copy(pA)
      pI2.copy(pB).lerp(pC, t)
      hasIntersection = true
    } else if (sB === 0 && sA !== sC && sA !== 0 && sC !== 0) {
      const t = dA / (dA - dC)
      pI1.copy(pB)
      pI2.copy(pA).lerp(pC, t)
      hasIntersection = true
    } else if (sC === 0 && sA !== sB && sA !== 0 && sB !== 0) {
      const t = dA / (dA - dB)
      pI1.copy(pC)
      pI2.copy(pA).lerp(pB, t)
      hasIntersection = true
    }
    // Case 3: Two vertices on plane
    else if (sA === 0 && sB === 0 && sC !== 0) {
      pI1.copy(pA)
      pI2.copy(pB)
      hasIntersection = true
    } else if (sB === 0 && sC === 0 && sA !== 0) {
      pI1.copy(pB)
      pI2.copy(pC)
      hasIntersection = true
    } else if (sA === 0 && sC === 0 && sB !== 0) {
      pI1.copy(pA)
      pI2.copy(pC)
      hasIntersection = true
    }

    if (hasIntersection) {
      if (!plateBounds || (checkPlate(pI1) && checkPlate(pI2))) {
        segments.push(pI1.x, pI1.y, pI1.z, pI2.x, pI2.y, pI2.z)
      }
    }
  }

  return new Float32Array(segments)
}
