import * as THREE from 'three'

/**
 * The cut plane is a posed object: { pos: [x,y,z], quat: [x,y,z,w] } — its
 * local +Z is the cut normal. Draggable in the viewport, serializable to the
 * worker. Kept free of any manifold import.
 */
export function planeBasis(plane) {
  const q = new THREE.Quaternion(...plane.quat)
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize()
  const origin = new THREE.Vector3(...plane.pos)
  return { normal, origin }
}

/**
 * Orthonormal 2D basis for a freehand cut viewed along `n` (the camera axis):
 * u = screen-right, v = screen-up, n = view direction. Used by BOTH the
 * viewport preview and the worker-side cut so they agree on the projection.
 */
export function viewBasis(nVec) {
  const n = nVec.clone().normalize()
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
  const u = new THREE.Vector3().crossVectors(up, n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u).normalize()
  return { u, v, n }
}

// Quaternions turning local +Z into each world axis.
export const AXIS_QUATS = {
  x: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)).toArray(),
  y: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)).toArray(),
  z: [0, 0, 0, 1],
  nx: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0)).toArray(),
  ny: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)).toArray(),
  nz: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)).toArray()
}

export const AXIS_INFO = [
  { id: 'x', label: 'X', color: '#ef4444', glow: 'rgba(239, 68, 68, 0.45)', quat: AXIS_QUATS.x, invQuat: AXIS_QUATS.nx },
  { id: 'y', label: 'Y', color: '#22c55e', glow: 'rgba(34, 197, 94, 0.45)', quat: AXIS_QUATS.y, invQuat: AXIS_QUATS.ny },
  { id: 'z', label: 'Z', color: '#3b82f6', glow: 'rgba(59, 130, 246, 0.45)', quat: AXIS_QUATS.z, invQuat: AXIS_QUATS.nz }
]

export const DEFAULT_PLANE = { pos: [0, 0, 0], quat: AXIS_QUATS.y }

/**
 * Calculates world pos & quat for a plane along a primary axis inside a bounding box.
 */
export function computePlaneFromBBox(bbox, axis = 'y', offsetRatio = 0.5, flip = false) {
  if (!bbox) return { pos: [0, 0, 0], quat: flip ? AXIS_QUATS.ny : AXIS_QUATS.y }
  const center = bbox.getCenter(new THREE.Vector3())
  const min = bbox.min[axis]
  const max = bbox.max[axis]
  const pos = center.clone()
  pos[axis] = min + (max - min) * offsetRatio

  const axisObj = AXIS_INFO.find((a) => a.id === axis) || AXIS_INFO[1]
  const quat = flip ? axisObj.invQuat : axisObj.quat

  return {
    pos: pos.toArray(),
    quat
  }
}

/**
 * Computes bounding plate 4x4 matrix for volume clipping / bounding box cut.
 */
export function computePlateTransform(pos, rotEuler, width, height, depth = 500) {
  const m = new THREE.Matrix4()
  const position = new THREE.Vector3(...pos)
  const rotation = new THREE.Euler(...rotEuler)
  const scale = new THREE.Vector3(width, height, depth)
  m.compose(position, new THREE.Quaternion().setFromEuler(rotation), scale)
  return m
}
