// Generates the E2E fixtures: a 2-object 3MF (split3mf-style multi-part
// file) and a 2-body STL (multi-shell single mesh). Run: node scripts/make-fixtures.mjs
import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import JSZip from 'jszip'
import { writeFileSync } from 'node:fs'

function boxObjXML(id, name, size, cx) {
  const h = size / 2
  const V = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]
  ].map(([x, y, z]) => `<vertex x="${x + cx}" y="${y}" z="${z}"/>`).join('')
  // 12 CCW triangles of a box
  const T = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 6, 2], [3, 7, 6],
    [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]
  ].map(([a, b, c], i) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  return `<object id="${id}" type="model" name="${name}"><mesh><vertices>${V}</vertices><triangles>${T}</triangles></mesh></object>`
}

const model =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
  `<resources>${boxObjXML(1, 'left', 20, -15)}${boxObjXML(2, 'right', 20, 15)}</resources>` +
  `<build><item objectid="1"/><item objectid="2"/></build></model>`

const zip = new JSZip()
zip.file('[Content_Types].xml',
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`)
zip.file('_rels/.rels',
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
  `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`)
zip.file('3D/3dmodel.model', model)
const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync('scripts/fixtures/two-parts.3mf', buf)
console.log('two-parts.3mf', buf.length, 'bytes')

// 2 disjoint boxes in ONE binary STL (multi-body mesh)
const a = new THREE.BoxGeometry(20, 20, 20).translate(-15, 0, 0).toNonIndexed()
const b = new THREE.BoxGeometry(20, 20, 20).translate(15, 0, 0).toNonIndexed()
const merged = new THREE.BufferGeometry()
merged.setAttribute('position', new THREE.BufferAttribute(
  new Float32Array([...a.attributes.position.array, ...b.attributes.position.array]), 3))
const exporter = new STLExporter()
const dv = exporter.parse(new THREE.Mesh(merged), { binary: true })
writeFileSync('scripts/fixtures/two-shells.stl', dv)
console.log('two-shells.stl', dv.byteLength, 'bytes')
