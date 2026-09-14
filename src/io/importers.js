import * as THREE from 'three'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { niceNormals } from '../geometry/normals.js'

function collectGeometries(root) {
  const geoms = []
  root.updateMatrixWorld(true)
  root.traverse((node) => {
    if (node.isMesh && node.geometry) {
      const g = node.geometry.clone().applyMatrix4(node.matrixWorld)
      const flat = g.index ? g.toNonIndexed() : g
      // No vertex colors? Bake the mesh material's color so multi-material
      // files (GLB/3MF/OBJ+MTL) keep their color zones per vertex.
      if (!flat.attributes.color) {
        const c = Array.isArray(node.material) ? node.material[0]?.color : node.material?.color
        if (c) {
          const n = flat.attributes.position.count
          const arr = new Float32Array(n * 3)
          for (let i = 0; i < n; i++) {
            arr[i * 3] = c.r
            arr[i * 3 + 1] = c.g
            arr[i * 3 + 2] = c.b
          }
          flat.setAttribute('color', new THREE.BufferAttribute(arr, 3))
        }
      }
      geoms.push(flat)
    }
  })
  return geoms
}

// Per-object geometries (what a 3MF splitter exposes as "the pieces
// already stored in the file"). Same color baking as the merged path.
function collectParts(root) {
  const geoms = collectGeometries(root)
  if (!geoms.length) throw new Error('no mesh found in file')
  for (const geom of geoms) {
    for (const name of Object.keys(geom.attributes)) {
      if (name !== 'position' && name !== 'color') geom.deleteAttribute(name)
    }
    // An all-white color attribute carries no information — drop it.
    if (geom.attributes.color) {
      const a = geom.attributes.color.array
      let informative = false
      for (let i = 0; i < a.length; i++) {
        if (a[i] < 0.999) {
          informative = true
          break
        }
      }
      if (!informative) geom.deleteAttribute('color')
    }
    niceNormals(geom)
  }
  return geoms
}

function toSingleGeometry(rootOrGeometry) {
  let g
  if (rootOrGeometry.isBufferGeometry) {
    g = rootOrGeometry.index ? rootOrGeometry.toNonIndexed() : rootOrGeometry
  } else {
    const geoms = collectGeometries(rootOrGeometry)
    if (!geoms.length) throw new Error('no mesh found in file')
    const anyColor = geoms.some((geom) => geom.attributes.color)
    for (const geom of geoms) {
      for (const name of Object.keys(geom.attributes)) {
        if (name !== 'position' && name !== 'color') geom.deleteAttribute(name)
      }
      if (anyColor && !geom.attributes.color) {
        const n = geom.attributes.position.count
        geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
      }
    }
    g = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false)
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'color') g.deleteAttribute(name)
  }
  // An all-white color attribute carries no information — drop it.
  if (g.attributes.color) {
    const a = g.attributes.color.array
    let informative = false
    for (let i = 0; i < a.length; i++) {
      if (a[i] < 0.999) {
        informative = true
        break
      }
    }
    if (!informative) g.deleteAttribute('color')
  }
  return niceNormals(g)
}

// 3D-printing formats are Z-up; the three.js scene is Y-up. Convert on
// import so models stand upright like in any slicer, and convert back on
// export (see exporters.js) so slicers receive them upright too.
const Z_UP_FORMATS = new Set(['stl', 'obj', '3mf'])

// Returns { geometry, parts }: `geometry` is the whole model as one mesh
// (unchanged behavior for cuts), `parts` are the file's own objects — a
// multi-object 3MF yields one part per object (split3mf-style), every
// other format yields a single part.
export async function importModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  const buffer = await file.arrayBuffer()
  let g
  let parts = null
  switch (ext) {
    case 'stl':
      g = toSingleGeometry(new STLLoader().parse(buffer))
      break
    case 'obj':
      g = toSingleGeometry(new OBJLoader().parse(new TextDecoder().decode(buffer)))
      break
    case '3mf': {
      const root = new ThreeMFLoader().parse(buffer)
      g = toSingleGeometry(root)
      // Objects already stored as separate parts in the file: keep them.
      // Above a sane cap the file is using objects as mesh chunks — merge.
      try {
        const list = collectParts(root)
        if (list.length > 1 && list.length <= 12) parts = list
      } catch {
        /* single-blob 3MF */
      }
      break
    }
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(buffer, '')
      g = toSingleGeometry(gltf.scene)
      break
    }
    default:
      throw new Error(`unsupported format: .${ext}`)
  }
  if (Z_UP_FORMATS.has(ext)) {
    g.rotateX(-Math.PI / 2)
    parts?.forEach((p) => p.rotateX(-Math.PI / 2))
  }
  return { geometry: g, parts: parts && parts.length > 1 ? parts : [g] }
}

export const ACCEPTED = '.stl,.obj,.glb,.gltf,.3mf'
