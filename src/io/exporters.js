import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import JSZip from 'jszip'

function download(blob, filename) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function baseName(name) {
  return (name || 'model').replace(/\.[^.]+$/, '').replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'model'
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
}

// The viewer is Y-up; printing formats (STL/OBJ/3MF) are Z-up. Rotate a
// COPY back to Z-up at export so slicers open the parts upright.
export function toZUpGeometry(geometry) {
  return geometry.clone().rotateX(Math.PI / 2)
}

function piecesToScene(pieces, zUp = false) {
  const scene = new THREE.Scene()
  const mat = new THREE.MeshStandardMaterial()
  for (const p of pieces) {
    const mesh = new THREE.Mesh(zUp ? toZUpGeometry(p.geometry) : p.geometry, mat)
    mesh.name = p.name
    scene.add(mesh)
  }
  return scene
}

// Browsers block a burst of downloads: one piece downloads directly, several
// pieces are bundled into a single zip.
export function stlPieceBlobs(pieces) {
  const exporter = new STLExporter()
  const used = new Set()
  return pieces.map((p) => {
    const geometry = toZUpGeometry(p.geometry)
    const material = new THREE.MeshStandardMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    const parsed = exporter.parse(mesh, { binary: true })
    geometry.dispose()
    material.dispose()
    const base = baseName(p.name)
    let name = `${base}.stl`, suffix = 2
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}.stl`
    used.add(name.toLowerCase())
    return {
      name,
      data: parsed instanceof DataView ? parsed.buffer : parsed
    }
  })
}

export async function exportSTL(pieces, modelName) {
  const blobs = stlPieceBlobs(pieces)
  if (blobs.length === 1) {
    download(new Blob([blobs[0].data], { type: 'model/stl' }), blobs[0].name)
    return
  }
  const zip = new JSZip()
  for (const b of blobs) zip.file(b.name, b.data)
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  download(blob, `${baseName(modelName)}_pieces.zip`)
}

export function exportOBJ(pieces, modelName) {
  const data = new OBJExporter().parse(piecesToScene(pieces, true))
  download(new Blob([data], { type: 'model/obj' }), `${baseName(modelName)}.obj`)
}

export async function exportGLB(pieces, modelName) {
  const scene = piecesToScene(pieces)
  try {
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true })
    download(new Blob([glb], { type: 'model/gltf-binary' }), `${baseName(modelName)}.glb`)
  } finally {
    scene.children[0]?.material.dispose()
  }
}

// Minimal but valid 3MF: one object per piece, all placed in the build.
export async function build3MFBlob(pieces) {
  const objects = pieces
    .map((p, i) => {
      const zg = toZUpGeometry(p.geometry)
      const g = zg.index ? zg : null
      const pos = zg.attributes.position
      let verts = ''
      for (let v = 0; v < pos.count; v++) {
        verts += `<vertex x="${pos.getX(v)}" y="${pos.getY(v)}" z="${pos.getZ(v)}"/>`
      }
      let tris = ''
      if (g) {
        const idx = g.index
        for (let t = 0; t < idx.count; t += 3) {
          tris += `<triangle v1="${idx.getX(t)}" v2="${idx.getX(t + 1)}" v3="${idx.getX(t + 2)}"/>`
        }
      } else {
        for (let t = 0; t < pos.count; t += 3) {
          tris += `<triangle v1="${t}" v2="${t + 1}" v3="${t + 2}"/>`
        }
      }
      zg.dispose()
      return `<object id="${i + 1}" type="model" name="${xmlEscape(p.name)}"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object>`
    })
    .join('')
  const items = pieces.map((_, i) => `<item objectid="${i + 1}"/>`).join('')
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>${objects}</resources><build>${items}</build></model>`

  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
      `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`
  )
  zip.file('3D/3dmodel.model', model)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

export async function export3MF(pieces, modelName) {
  download(await build3MFBlob(pieces), `${baseName(modelName)}.3mf`)
}

// FBX 7.4 ASCII: static meshes in millimeters, one named object per part.
// No armatures, animations or texture embedding: this is a print-model export.
export function buildFBX(pieces) {
  const objects = [], connections = []
  pieces.forEach((p, i) => {
    const g = toZUpGeometry(p.geometry)
    const pos = g.attributes.position
    const vertices = []
    for (let j = 0; j < pos.count; j++) vertices.push(pos.getX(j), pos.getY(j), pos.getZ(j))
    const indices = g.index ? Array.from(g.index.array) : Array.from({ length: pos.count }, (_, j) => j)
    for (let j = 2; j < indices.length; j += 3) indices[j] = -indices[j] - 1
    const id = 1000 + i * 2
    const name = baseName(p.name).replace(/[\r\n]/g, '_')
    objects.push(`\tGeometry: ${id}, "Geometry::${name}", "Mesh" {\n\t\tVertices: *${vertices.length} {\n\t\t\ta: ${vertices.join(',')}\n\t\t}\n\t\tPolygonVertexIndex: *${indices.length} {\n\t\t\ta: ${indices.join(',')}\n\t\t}\n\t}\n\tModel: ${id + 1}, "Model::${name}", "Mesh" {\n\t\tVersion: 232\n\t\tProperties70: {\n\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0\n\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0\n\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1\n\t\t}\n\t\tShading: T\n\t\tCulling: "CullingOff"\n\t}`)
    connections.push(`\tC: "OO",${id},${id + 1}\n\tC: "OO",${id + 1},0`)
    g.dispose()
  })
  return `; FBX 7.4.0 project file\nFBXHeaderExtension: {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7400\n\tCreator: "SliceForge"\n}\nGlobalSettings: {\n\tVersion: 1000\n\tProperties70: {\n\t\tP: "UpAxis", "int", "Integer", "",2\n\t\tP: "UpAxisSign", "int", "Integer", "",1\n\t\tP: "FrontAxis", "int", "Integer", "",1\n\t\tP: "FrontAxisSign", "int", "Integer", "",-1\n\t\tP: "CoordAxis", "int", "Integer", "",0\n\t\tP: "CoordAxisSign", "int", "Integer", "",1\n\t\tP: "UnitScaleFactor", "double", "Number", "",0.1\n\t}\n}\nObjects: {\n${objects.join('\n')}\n}\nConnections: {\n${connections.join('\n')}\n}\n`
}

export function exportFBX(pieces, modelName) {
  download(new Blob([buildFBX(pieces)], { type: 'application/octet-stream' }), `${baseName(modelName)}.fbx`)
}
