import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { AXIS_QUATS, viewBasis } from '../geometry/plane.js'
import { computeSectionSegments } from '../geometry/sectionContour.js'
import { coplanarRegion, growRegion, regionPositions } from '../geometry/shapeSelect.js'

export const PIECE_COLORS = [0x5b8dee, 0xee8a5b, 0x62c48a, 0xd46bc8, 0xe0c34f, 0x6bd4cf, 0x9a7be4]

export class Viewer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    // Full retina (x2) is wasted on multi-million-triangle scenes — cap it.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0e1014)
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000)
    this.camera.position.set(120, 90, 120)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(1, 2, 1.5)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xa0b4ff, 0.5)
    fill.position.set(-1.5, -0.5, -1)
    this.scene.add(fill)

    this.grid = new THREE.GridHelper(200, 20, 0x3a4152, 0x242a38)
    this.scene.add(this.grid)

    this.piecesGroup = new THREE.Group()
    this.scene.add(this.piecesGroup)
    this.planeHelper = null
    this.modelCenter = new THREE.Vector3()

    // In-view rotation wheel: drag a ring, the SELECTED piece rotates live
    // around its centre; on release the rotation is baked into the geometry.
    this.onRotateEnd = null
    this.pivot = new THREE.Object3D()
    this.scene.add(this.pivot)
    this.gizmo = new TransformControls(this.camera, canvas)
    this.gizmo.setMode('rotate')
    this.gizmo.setSize(1.15)
    this.gizmo.setRotationSnap(THREE.MathUtils.degToRad(5))
    this.gizmoHelper = this.gizmo.getHelper()
    this.gizmoHelper.visible = false
    this.scene.add(this.gizmoHelper)
    this._gizmoTarget = null
    this._gizmoBasePos = new THREE.Vector3()
    this.gizmo.addEventListener('objectChange', () => this._applyPivotPreview())
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value
      // Base captured at drag START — the explode slider may have moved the
      // mesh since the gizmo was attached.
      if (e.value && this._gizmoTarget) this._gizmoBasePos.copy(this._gizmoTarget.position)
      if (!e.value) this._bakeGizmoRotation()
    })

    // Move gizmo: plate-plane arrows anchored on the selected piece's centre
    // (a pivot proxy — the meshes carry their location in the geometry, so
    // their origin sits at the plate centre). The piece follows the drag
    // live; the delta is baked into the geometry on release (translatePiece).
    this.onMoveEnd = null
    this.movePivot = new THREE.Object3D()
    this.scene.add(this.movePivot)
    this._moveTarget = null
    this.moveGizmo = new TransformControls(this.camera, canvas)
    this.moveGizmo.setMode('translate')
    this.moveGizmo.showY = false
    this.moveGizmo.setSize(0.9)
    this.moveGizmoHelper = this.moveGizmo.getHelper()
    this.moveGizmoHelper.visible = false
    this.scene.add(this.moveGizmoHelper)
    this._moveBase = new THREE.Vector3()
    this._movePivotBase = new THREE.Vector3()
    this.moveGizmo.addEventListener('objectChange', () => {
      const mesh = this._moveTarget
      if (!mesh) return
      mesh.position
        .copy(this._moveBase)
        .add(this.movePivot.position)
        .sub(this._movePivotBase)
    })
    this.moveGizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value
      const mesh = this._moveTarget
      if (!mesh) return
      if (e.value) {
        this._moveBase.copy(mesh.position)
        this._movePivotBase.copy(this.movePivot.position)
      } else {
        const d = this.movePivot.position.clone().sub(this._movePivotBase)
        mesh.position.copy(this._moveBase)
        if (d.lengthSq() > 1e-6) this.onMoveEnd?.(mesh.userData.pieceId, d.x, d.z)
      }
    })

    this._raf = 0
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()

    // Click-to-select: a press that barely moved (not an orbit drag, not a
    // gizmo grab) raycasts the pieces' bounding boxes — O(pieces), instant
    // even on multi-million-triangle meshes.
    this.onPieceClick = null
    this.onSelect = null // same payload as onPieceClick (App-facing alias)
    this.onFacePick = null
    this.onShapePick = null
    this.onPlanePick = null
    this.onPlaneChange = null
    this.onPlateChange = null
    this.onPinPick = null
    this.onPuzzlePinAdd = null
    this.onPuzzlePinRemove = null
    this.onPuzzlePinMove = null
    this.puzzleEditMode = false
    this._dragPin = null
    this._dragMoved = false
    this.faceMode = false
    this.shapeMode = false
    this.planeMode = false
    this.pinMode = false
    this.curveMode = false
    this.selectedPieceId = null
    this._raycaster = new THREE.Raycaster()
    this._downPos = null
    this._isBrushing = false
    this.onCurvePoint = null
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2) {
        this._rDownPos = [e.clientX, e.clientY]
        return
      }
      this._downPos = [e.clientX, e.clientY]
      if (this.puzzleEditMode && this._pinPreviewGroup) {
        const rect = canvas.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        this._raycaster.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
          ),
          this.camera
        )
        const hit = this._raycaster.intersectObjects(this._pinPreviewGroup.children, false)[0]
        if (hit) {
          this._dragPin = hit.object
          this._dragMoved = false
          this.controls.enabled = false
        }
      }
    })
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const setRay = () =>
        this._raycaster.setFromCamera(
          new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
          ),
          this.camera
        )
      if (this._isBrushing) {
          setRay()
          const hit = this._raycaster.intersectObjects(this.piecesGroup.children.filter((m) => m.visible), false)[0]
          if (hit?.face) this.onShapePick?.(hit.faceIndex, hit.object.userData.pieceId, true)
          return
        }
        if (this._dragPin) {
        setRay()
        const { pos, quat } = this._dragPin.userData.plane
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...quat))
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          normal,
          new THREE.Vector3(...pos)
        )
        const point = new THREE.Vector3()
        if (this._raycaster.ray.intersectPlane(plane, point)) {
          this._dragTried = true
          const inv = new THREE.Quaternion(...quat).invert()
          const local = point.clone().sub(new THREE.Vector3(...pos)).applyQuaternion(inv)
          const ok =
            this.puzzlePinValidator?.(
              this._dragPin.userData.pinIdx,
              this._dragPin.userData.planeIdx,
              local.x,
              local.y
            ) ?? true
          // Hard stop at the valid-zone boundary: the marker only follows
          // the cursor while the position stays legal.
          if (ok) {
            this._dragPin.position.copy(point)
            this._dragLast = [local.x, local.y]
            this._dragMoved = true
          }
        }
        return
      }
      // Freehand-curve hover: a small marker glides over the surface so the
      // user sees where the next point would land.
      if (this.curveMode) {
        setRay()
        const hit = this._raycaster.intersectObjects(
          this.piecesGroup.children.filter((m) => m.visible),
          false
        )[0]
        if (hit) {
          this._ensureCurveHover()
          this._curveHover.visible = true
          this._curveHover.position.copy(hit.point)
          canvas.style.cursor = 'crosshair'
        } else if (this._curveHover) {
          this._curveHover.visible = false
          canvas.style.cursor = ''
        }
        return
      }
      if (this._curveHover) this._curveHover.visible = false
      // Place-on-face hover: light up the facet under the cursor so the user
      // sees WHICH face will land on the plate before clicking.
      if (this.faceMode) {
        setRay()
        const hit = this._raycaster.intersectObjects(
          this.piecesGroup.children.filter((m) => m.visible),
          false
        )[0]
        if (hit?.face) this._setFaceHover(hit.object, hit.faceIndex)
        else this._setFaceHover(null)
        return
      }
      if (this._faceHoverKey) this._setFaceHover(null)
      // Hover affordances in puzzle-edit mode: light up the connector under
      // the cursor (click = remove, drag = move) or the plane a click would
      // add one to.
      if (!this.puzzleEditMode) {
        this._clearHover()
        return
      }
      setRay()
      const pinHit = this._pinPreviewGroup
        ? this._raycaster.intersectObjects(this._pinPreviewGroup.children, false)[0]
        : null
      if (pinHit) {
        this._setHoverPin(pinHit.object)
        this._setHoverQuad(null)
        canvas.style.cursor = 'pointer'
        return
      }
      const quadHit = this._puzzleGroup
        ? this._raycaster.intersectObjects(this._puzzleGroup.children, false)[0]
        : null
      if (quadHit) {
        this._setHoverPin(null)
        this._setHoverQuad(quadHit.object)
        canvas.style.cursor = 'copy'
        return
      }
      this._clearHover()
    })
    // Right-CLICK (not a right-drag pan) opens the context menu.
    this.onContextMenu = null
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const down = this._rDownPos
      this._rDownPos = null
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return
      this.onContextMenu?.(e.clientX, e.clientY)
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return
      if (this._dragPin) {
        const pin = this._dragPin
        this._dragPin = null
        this.controls.enabled = true
        if (this._dragMoved && this._dragLast) {
          this.onPuzzlePinMove?.(pin.userData.pinIdx, this._dragLast[0], this._dragLast[1])
        } else if (!this._dragTried) {
          // A clean click (no drag attempt at all) removes the connector.
          this.onPuzzlePinRemove?.(pin.userData.pinIdx)
        }
        this._dragTried = false
        this._dragLast = null
        this._downPos = null
        return
      }
      const down = this._downPos
      this._downPos = null
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return
      if (this.gizmo.dragging || this.volGizmo?.dragging) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      this._raycaster.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        ),
        this.camera
      )
      if (this.puzzleEditMode && this._puzzleGroup) {
        const hitQ = this._raycaster.intersectObjects(this._puzzleGroup.children, false)[0]
        if (hitQ) {
          const { planeIdx, pos, quat } = hitQ.object.userData
          const inv = new THREE.Quaternion(...quat).invert()
          const local = hitQ.point.clone().sub(new THREE.Vector3(...pos)).applyQuaternion(inv)
          this.onPuzzlePinAdd?.(planeIdx, local.x, local.y)
        }
        return
      }
      if (this.planeMode && this.planeGizmo?.dragging) return
      if (this.plateMode && this.plateGizmo?.dragging) return
      if (this.plateMode && this.plateMoveMode) {
        const hits = this._raycaster.intersectObjects(
          this.piecesGroup.children.filter((m) => m.visible),
          false
        )
        const hit = hits[0]
        if (hit?.face) {
          this.onPlatePick?.(hit.point.clone(), hit.face.normal.clone())
          return
        }
      }
      // Connector placement: clicks land on the plane quad, in plane-local mm.
      if (this.pinMode && this.planeObj?.visible) {
        const hit = this._raycaster.intersectObject(this.planeObj, false)[0]
        if (hit) {
          const local = this.planeObj.worldToLocal(hit.point.clone())
          const sc = this.planeObj.scale.x
          this.onPinPick?.(local.x * sc, local.y * sc)
        }
        return
      }
      if (this.faceMode || this.shapeMode || this.planeMode || this.curveMode) {
        // Precise triangle raycast (meshes carry no rotation, so face data
        // is already in world space).
        const hits = this._raycaster.intersectObjects(
          this.piecesGroup.children.filter((m) => m.visible),
          false
        )
        const hit = hits[0]
        if (!hit?.face) {
          // Clicking the void while painting ends the brush stroke (the
          // selection stays) and gives the orbit controls back.
          if (this.shapeMode && this._isBrushing) {
            this._isBrushing = false
            this.controls.enabled = true
          }
          return
        }
        if (this.curveMode) {
          // A click on the model adds a point to the freehand cut line; the
          // camera axis at that moment is the wall direction (locked by the
          // App on the first point).
          const dir = this.camera.getWorldDirection(new THREE.Vector3())
          this.onCurvePoint?.(hit.point.clone(), dir)
        } else if (this.shapeMode) {
          // Seed click: start/replace the selection AND enter paint mode —
          // from here the cursor brushes (accumulates) until the user
          // clicks the void or leaves the tool.
          this._isBrushing = true
          this.controls.enabled = false
          this.onShapePick?.(hit.faceIndex, hit.object.userData.pieceId, false)
        } else if (this.planeMode)
          this.onPlanePick?.(hit.point.clone(), hit.face.normal.clone())
        else this.onFacePick?.(hit.face.normal.clone(), hit.object.userData.pieceId)
        return
      }
      // A click that lands on a gizmo handle must not clear the selection.
      if (this.gizmo.axis || this.moveGizmo.axis) return
      let best = null
      const target = new THREE.Vector3()
      for (const mesh of this.piecesGroup.children) {
        if (!mesh.visible) continue
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        const box = mesh.geometry.boundingBox.clone().translate(mesh.position)
        if (this._raycaster.ray.intersectBox(box, target)) {
          const d = target.distanceTo(this.camera.position)
          if (!best || d < best.d) best = { d, id: mesh.userData.pieceId }
        }
      }
      this.onPieceClick?.(best?.id ?? null)
      this.onSelect?.(best?.id ?? null)
    })

    this._onResize = () => {
      const { clientWidth: w, clientHeight: h } = canvas.parentElement
      if (!w || !h) return
      this.renderer.setSize(w, h, false)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', this._onResize)
    this._onResize()
  }

  // Surgical update: meshes are reused across renders (no GPU re-creation,
  // no material churn); the camera refits only when the caller says a new
  // model arrived — never on transforms/cuts (that jump read as a freeze).
  setPieces(pieces, explode = 0, refit = false) {
    const byId = new Map(
      [...this.piecesGroup.children].map((m) => [m.userData.pieceId, m])
    )
    this.piecesGroup.clear()
    const box = new THREE.Box3()
    pieces.forEach((p, i) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
      let mesh = byId.get(p.id)
      if (!mesh) {
        mesh = new THREE.Mesh(
          p.geometry,
          new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 })
        )
        mesh.userData.pieceId = p.id
      } else if (mesh.geometry !== p.geometry) {
        mesh.geometry = p.geometry
      }
      // Colored models render their own vertex colors; plain ones get the
      // per-piece palette.
      const hasColor = !!p.geometry.attributes.color
      if (mesh.material.vertexColors !== hasColor) {
        mesh.material.vertexColors = hasColor
        mesh.material.needsUpdate = true
      }
      if (hasColor) mesh.material.color.setHex(0xffffff)
      else mesh.material.color.setHex(PIECE_COLORS[i % PIECE_COLORS.length])
      mesh.material.emissive.setHex(p.id === this.selectedPieceId ? 0x24407a : 0x000000)
      mesh.visible = p.visible
      this.piecesGroup.add(mesh)
    })
    if (!box.isEmpty()) box.getCenter(this.modelCenter)
    this.setExplode(explode)
    // Re-anchor (or drop) the piece gizmos after the pieces changed; the
    // hovered-face overlay is stale against the new geometry.
    if (this.gizmoHelper.visible) this.setGizmo(this.selectedPieceId)
    if (this.moveGizmoHelper.visible) this.setMoveGizmo(this.selectedPieceId)
    this._setFaceHover(null)

    if (!box.isEmpty() && refit) this.fitCamera(box)
  }

  fitCamera(box = null) {
    if (!box) {
      box = new THREE.Box3()
      for (const m of this.piecesGroup.children) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
        box.union(m.geometry.boundingBox.clone().translate(m.position))
      }
      if (box.isEmpty()) return
    }
    const center = box.getCenter(new THREE.Vector3())
    const d = Math.max(box.getSize(new THREE.Vector3()).length(), 10)
    this.camera.position.copy(center).add(new THREE.Vector3(0.8, 0.6, 0.8).multiplyScalar(d))
    this.controls.target.copy(center)
  }

  // Exploded view in REAL millimetres: the gap added between neighbouring
  // pieces equals gapMm. Uniform expansion scaled by the median
  // nearest-neighbour centroid distance — even spacing on a puzzle grid as
  // well as on a simple two-half cut.
  setExplode(gapMm) {
    const meshes = this.piecesGroup.children
    if (!meshes.length) return
    const centers = meshes.map((m) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
      return m.geometry.boundingBox.getCenter(new THREE.Vector3())
    })
    let B = 1
    if (centers.length > 1) {
      const nn = centers.map((c, i) =>
        Math.min(...centers.map((o, j) => (i === j ? Infinity : c.distanceTo(o))))
      )
      nn.sort((a, b) => a - b)
      B = Math.max(1, nn[Math.floor(nn.length / 2)])
    }
    const k = (gapMm || 0) / B
    meshes.forEach((m, i) => {
      m.position.copy(centers[i]).sub(this.modelCenter).multiplyScalar(k)
    })
  }


  setShapeHighlight(positions) {
    if (this._shapeMesh) {
      this.scene.remove(this._shapeMesh)
      this._shapeMesh.geometry.dispose()
      this._shapeMesh.material.dispose()
      this._shapeMesh = null
    }
    if (!positions) return
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this._shapeMesh = new THREE.Mesh(
      g,
      // Orange, near-opaque: must read clearly on top of the blue pieces.
      new THREE.MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0.85,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
    )
    this.scene.add(this._shapeMesh)
  }

  setSelected(pieceId) {
    this.selectedPieceId = pieceId
    for (const mesh of this.piecesGroup.children) {
      mesh.material.emissive.setHex(mesh.userData.pieceId === pieceId ? 0x24407a : 0x000000)
    }
  }

  setVolumeBox(enabled) {
    if (enabled && this.piecesGroup.children.length) {
      if (!this.volBox) {
        this.volBox = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({
            color: 0xffb347,
            transparent: true,
            opacity: 0.22,
            depthWrite: false
          })
        )
        this.volBox.add(
          new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
            new THREE.LineBasicMaterial({ color: 0xffb347 })
          )
        )
        this.scene.add(this.volBox)
        this.volGizmo = new TransformControls(this.camera, this.renderer.domElement)
        this.volGizmo.setSize(0.9)
        this.volGizmoHelper = this.volGizmo.getHelper()
        this.scene.add(this.volGizmoHelper)
        this.volGizmo.addEventListener('dragging-changed', (e) => {
          this.controls.enabled = !e.value
        })
      }
      const box = new THREE.Box3()
      for (const mesh of this.piecesGroup.children) box.union(mesh.geometry.boundingBox)
      const size = box.getSize(new THREE.Vector3())
      this.volBox.position.copy(this.modelCenter)
      this.volBox.scale.set(
        Math.max(1, size.x * 0.4),
        Math.max(1, size.y * 0.4),
        Math.max(1, size.z * 0.4)
      )
      this.volBox.rotation.set(0, 0, 0)
      this.volBox.visible = true
      this.volGizmo.attach(this.volBox)
      this.volGizmoHelper.visible = true
    } else if (this.volBox) {
      this.volGizmo.detach()
      this.volGizmoHelper.visible = false
      this.volBox.visible = false
    }
  }

  setVolumeMode(mode) {
    this.volGizmo?.setMode(mode)
  }

  getVolumeMatrix() {
    this.volBox.updateMatrix()
    return this.volBox.matrix.toArray()
  }

  _meshById(pieceId) {
    return this.piecesGroup.children.find((m) => m.userData.pieceId === pieceId) ?? null
  }

  // Rotation rings on the given piece (null hides them).
  setGizmo(pieceId) {
    const mesh = pieceId != null ? this._meshById(pieceId) : null
    if (mesh) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      this._gizmoTarget = mesh
      this._gizmoBasePos.copy(mesh.position)
      this.pivot.position
        .copy(mesh.geometry.boundingBox.getCenter(new THREE.Vector3()))
        .add(mesh.position)
      this.pivot.quaternion.identity()
      this.gizmo.attach(this.pivot)
      this.gizmoHelper.visible = true
    } else {
      this._gizmoTarget = null
      this.gizmo.detach()
      this.gizmoHelper.visible = false
    }
  }

  // Plate-plane move arrows on the given piece (null hides them).
  setMoveGizmo(pieceId) {
    const mesh = pieceId != null ? this._meshById(pieceId) : null
    if (mesh) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      this._moveTarget = mesh
      this.movePivot.position
        .copy(mesh.geometry.boundingBox.getCenter(new THREE.Vector3()))
        .add(mesh.position)
      this.moveGizmo.attach(this.movePivot)
      this.moveGizmoHelper.visible = true
    } else {
      this._moveTarget = null
      this.moveGizmo.detach()
      this.moveGizmoHelper.visible = false
    }
  }

  _applyPivotPreview() {
    const mesh = this._gizmoTarget
    if (!mesh) return
    const q = this.pivot.quaternion
    const c = this.pivot.position
    mesh.quaternion.copy(q)
    mesh.position.copy(this._gizmoBasePos).sub(c).applyQuaternion(q).add(c)
  }

  _bakeGizmoRotation() {
    const mesh = this._gizmoTarget
    const q = this.pivot.quaternion.clone()
    if (mesh) {
      mesh.quaternion.identity()
      mesh.position.copy(this._gizmoBasePos)
    }
    this.pivot.quaternion.identity()
    if (q.angleTo(new THREE.Quaternion()) > 1e-4) this.onRotateEnd?.(q)
  }

  // The cut plane is a grabbable object: translucent quad + outline, driven
  // by its own TransformControls (translate/rotate, toggled via T/R).
  showPlane(plane, size) {
    if (!this.planeObj) {
      const geo = new THREE.PlaneGeometry(1, 1)
      this.planeObj = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0x2f6bff,
          transparent: true,
          opacity: 0.14,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x2f6bff })
      )
      this.planeObj.add(edges)
      this.scene.add(this.planeObj)
      this.planeGizmo = new TransformControls(this.camera, this.renderer.domElement)
      this.planeGizmo.setSize(0.85)
      this.planeGizmoHelper = this.planeGizmo.getHelper()
      this.scene.add(this.planeGizmoHelper)
      this.planeGizmo.addEventListener('dragging-changed', (e) => {
        this.controls.enabled = !e.value
        if (!e.value) this._commitPlane()
      })
      this.planeGizmo.addEventListener('objectChange', () => this._commitPlane())
    }
    // Don't fight the user's drag with store round-trips.
    if (!this.planeGizmo.dragging) {
      this.planeObj.position.fromArray(plane.pos)
      this.planeObj.quaternion.fromArray(plane.quat)
    }
    this.planeObj.scale.setScalar(Math.max(10, size))
    this.planeObj.visible = true
    this.planeGizmo.attach(this.planeObj)
    this.planeGizmoHelper.visible = true
  }

  _commitPlane() {
    if (!this.planeObj) return
    this.onPlaneChange?.({
      pos: this.planeObj.position.toArray(),
      quat: this.planeObj.quaternion.toArray()
    })
  }

  setPlaneGizmoMode(mode) {
    this.planeGizmo?.setMode(mode)
  }

  // Highlight overlay for the hovered facet in place-on-face mode. Keyed by
  // (piece, region membership) so sliding the cursor across the same flat
  // face never recomputes the flood fill.
  _setFaceHover(mesh, faceIndex = -1) {
    if (!mesh) {
      if (!this._faceHoverKey) return
      this._faceHoverKey = ''
      this._faceHoverSel = null
      if (this._faceHoverMesh) {
        this.scene.remove(this._faceHoverMesh)
        this._faceHoverMesh.geometry.dispose()
        this._faceHoverMesh = null
      }
      return
    }
    const pieceKey = String(mesh.userData.pieceId)
    if (
      this._faceHoverKey === pieceKey &&
      this._faceHoverSel &&
      this._faceHoverSel.sel[faceIndex]
    )
      return
    // The exact coplanar face, floored by a small geodesic patch around the
    // cursor: flat faces light up whole, curved zones still show a visible
    // halo where the piece would tip onto the plate.
    const flat = coplanarRegion(mesh.geometry, faceIndex)
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const bbSize = mesh.geometry.boundingBox.getSize(new THREE.Vector3())
    const halo = growRegion(
      mesh.geometry,
      faceIndex,
      60,
      0.05 * Math.max(bbSize.x, bbSize.y, bbSize.z)
    )
    const sel = flat.sel
    let count = flat.count
    for (let t = 0; t < sel.length; t++) {
      if (halo.sel[t] && !sel[t]) {
        sel[t] = 1
        count++
      }
    }
    if (this._faceHoverMesh) {
      this.scene.remove(this._faceHoverMesh)
      this._faceHoverMesh.geometry.dispose()
      this._faceHoverMesh = null
    }
    this._faceHoverKey = pieceKey
    this._faceHoverSel = { sel }
    const g = new THREE.BufferGeometry()
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(regionPositions(mesh.geometry, sel, count), 3)
    )
    if (!this._faceHoverMat)
      this._faceHoverMat = new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
    this._faceHoverMesh = new THREE.Mesh(g, this._faceHoverMat)
    this._faceHoverMesh.position.copy(mesh.position)
    this.scene.add(this._faceHoverMesh)
  }

  clearFaceHover() {
    this._setFaceHover(null)
  }

  // Build the adjacency / normals / centroids caches ahead of the first
  // hover — on an 80k-tri mesh the cold build costs ~700 ms, which must land
  // at tool activation, not as a freeze mid-mouse-move.
  warmFaceCaches() {
    for (const m of this.piecesGroup.children) {
      if (!m.visible) continue
      const g = m.geometry
      if (g.userData._adj && g.userData._triNormals && g.userData._triCentroids) continue
      growRegion(g, 0, 0.1, 0.001)
    }
  }

  _setHoverPin(mesh) {
    if (this._hoverPin === mesh) return
    if (this._hoverPin && this._pinBaseMat) this._hoverPin.material = this._pinBaseMat
    this._hoverPin = mesh
    if (mesh && this._pinHoverMat) mesh.material = this._pinHoverMat
  }

  _setHoverQuad(mesh) {
    if (this._hoverQuad === mesh) return
    if (this._hoverQuad && this._quadBaseMat) this._hoverQuad.material = this._quadBaseMat
    this._hoverQuad = mesh
    if (mesh && this._quadHoverMat) mesh.material = this._quadHoverMat
  }

  _clearHover() {
    this._setHoverPin(null)
    this._setHoverQuad(null)
    this.renderer.domElement.style.cursor = ''
  }

  // Orange ghost markers showing where connector reservations will land
  // (world-space poses computed by the same engine as the cut).
  setPinPreview(pins, pinDiameter, pinLength) {
    if (!this._pinPreviewGroup) {
      this._pinPreviewGroup = new THREE.Group()
      this.scene.add(this._pinPreviewGroup)
    }
    this._clearHover()
    this._pinPreviewGroup.clear()
    if (this._pinPreviewGeo) this._pinPreviewGeo.dispose()
    if (this._pinPreviewMat) this._pinPreviewMat.dispose()
    this._pinPreviewGeo = this._pinPreviewMat = null
    if (!pins?.length) return
    const geo = new THREE.CylinderGeometry(pinDiameter / 2, pinDiameter / 2, pinLength, 24)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 })
    this._pinPreviewGeo = geo
    this._pinPreviewMat = mat
    this._pinBaseMat = mat
    this._pinHoverMat = new THREE.MeshBasicMaterial({ color: 0xffe08a })
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
    pins.forEach((pin, i) => {
      const m = new THREE.Mesh(geo, mat)
      m.position.fromArray(pin.center)
      m.quaternion.fromArray(pin.quat).multiply(tilt)
      m.userData.pinIdx = i
      m.userData.planeIdx = pin.planeIdx
      m.userData.plane = pin.plane ?? { pos: pin.center, quat: pin.quat }
      this._pinPreviewGroup.add(m)
    })
  }

  // Puzzle preview: one translucent quad per upcoming grid cut, bounded to
  // the model box, updated live as the block size changes.
  setPuzzlePreview(planes, box) {
    if (!this._puzzleGroup) {
      this._puzzleGroup = new THREE.Group()
      this.scene.add(this._puzzleGroup)
    }
    this._clearHover()
    this._puzzleGroup.clear()
    if (!planes?.length || !box) return
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const quad = new THREE.PlaneGeometry(1, 1)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2f6bff,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    this._quadBaseMat = mat
    this._quadHoverMat = new THREE.MeshBasicMaterial({
      color: 0x5b8dee,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.6 })
    const edges = new THREE.EdgesGeometry(quad)
    planes.forEach(({ axis, offset }, planeIdx) => {
      const m = new THREE.Mesh(quad, mat)
      m.add(new THREE.LineSegments(edges, lineMat))
      const pos = [0, 0, 0]
      pos[{ x: 0, y: 1, z: 2 }[axis]] = offset
      m.userData.planeIdx = planeIdx
      m.userData.pos = pos
      m.userData.quat = AXIS_QUATS[axis]
      if (axis === 'x') {
        m.rotation.y = Math.PI / 2
        m.scale.set(size.z * 1.02, size.y * 1.02, 1)
        m.position.set(offset, c.y, c.z)
      } else if (axis === 'y') {
        m.rotation.x = -Math.PI / 2
        m.scale.set(size.x * 1.02, size.z * 1.02, 1)
        m.position.set(c.x, offset, c.z)
      } else {
        m.scale.set(size.x * 1.02, size.y * 1.02, 1)
        m.position.set(c.x, c.y, offset)
      }
      this._puzzleGroup.add(m)
    })
  }

  // Connector markers live as children of the plane object, so they follow
  // its drags for free. Positions are plane-local mm; the parent's uniform
  // scale is compensated per marker.
  setPinMarkers(uvList, pinDiameter, pinLength) {
    if (!this.planeObj) return
    if (!this._pinGroup) {
      this._pinGroup = new THREE.Group()
      this.planeObj.add(this._pinGroup)
    }
    this._pinGroup.clear()
    const sc = this.planeObj.scale.x
    for (const [u, v] of uvList) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(pinDiameter / 2, pinDiameter / 2, pinLength, 24),
        new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9 })
      )
      m.rotation.x = Math.PI / 2
      m.scale.setScalar(1 / sc)
      m.position.set(u / sc, v / sc, 0)
      this._pinGroup.add(m)
    }
  }

  // Ghost the parts so the plane (and the connectors on it) read through
  // the material while placing.
  // === Freehand curved cut ===
  // Live preview of the drawn line: sphere markers at the clicked surface
  // points, a polyline through them, and the translucent cutting wall that
  // will run through the model (same projection the worker uses).
  _ensureCurveHover() {
    if (this._curveHover) return
    const geo = new THREE.SphereGeometry(1, 12, 10)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5c7a })
    this._curveHover = new THREE.Mesh(geo, mat)
    this._curveHover.visible = false
    this.scene.add(this._curveHover)
  }

  setCurvePreview(points, viewDir, kerf) {
    this.clearCurvePreview()
    if (!points || points.length < 1 || !viewDir) return
    if (!this._curveGroup) {
      this._curveGroup = new THREE.Group()
      this.scene.add(this._curveGroup)
    }
    // Scale markers to the model so they stay visible at any zoom.
    const box = new THREE.Box3()
    for (const m of this.piecesGroup.children) {
      if (m.visible) box.expandByObject(m)
    }
    const size = box.isEmpty() ? 50 : box.getSize(new THREE.Vector3()).length()
    const markerR = size * 0.008

    const markerGeo = new THREE.SphereGeometry(markerR, 12, 10)
    const markerMat = new THREE.MeshBasicMaterial({ color: 0xff5c7a })
    const pts3 = points.map((p) => new THREE.Vector3(p.x, p.y, p.z))
    pts3.forEach((p) => {
      const s = new THREE.Mesh(markerGeo, markerMat)
      s.position.copy(p)
      this._curveGroup.add(s)
    })

    if (pts3.length >= 2) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts3)
      const lineMat = new THREE.LineBasicMaterial({ color: 0xff5c7a, linewidth: 2 })
      this._curveGroup.add(new THREE.Line(lineGeo, lineMat))

      // The wall: 2D projection of the curve on the view plane, ends
      // extended, thickened by the kerf, extruded across the model depth.
      const { u, v, n } = viewBasis(new THREE.Vector3(viewDir.x, viewDir.y, viewDir.z))
      const origin = pts3[0].clone()
      const toLocal = (p) => {
        const d = p.clone().sub(origin)
        return [d.dot(u), d.dot(v), d.dot(n)]
      }
      const pts2 = pts3.map((p) => {
        const l = toLocal(p)
        return [l[0], l[1]]
      })
      const radius = size / 2
      const w2 = Math.max(kerf ?? 0.15, 0.02) / 2
      const ext = radius * 1.5 + 10
      const ext2 = (a, b, sign) => {
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const len = Math.hypot(dx, dy)
        if (len < 1e-9) return null
        return [a[0] + (dx / len) * ext * sign, a[1] + (dy / len) * ext * sign]
      }
      const start = ext2(pts2[0], pts2[1], -1)
      if (start) pts2.unshift(start)
      const end = ext2(pts2[pts2.length - 1], pts2[pts2.length - 2], 1)
      if (end) pts2.push(end)

      // Depth range of the model along the view axis.
      let tMin = Infinity
      let tMax = -Infinity
      const corner = new THREE.Vector3()
      if (!box.isEmpty()) {
        for (let xi = 0; xi < 2; xi++)
          for (let yi = 0; yi < 2; yi++)
            for (let zi = 0; zi < 2; zi++) {
              corner.set(xi ? box.max.x : box.min.x, yi ? box.max.y : box.min.y, zi ? box.max.z : box.min.z)
              const t = corner.clone().sub(origin).dot(n)
              tMin = Math.min(tMin, t)
              tMax = Math.max(tMax, t)
            }
      } else {
        tMin = -radius
        tMax = radius
      }
      const pad = (tMax - tMin) * 0.1 + 1
      tMin -= pad
      tMax += pad

      const wallMat = new THREE.MeshBasicMaterial({
        color: 0x38d6e0,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false
      })
      const wallPos = []
      const P = (x, y, t) =>
        origin.clone().addScaledVector(u, x).addScaledVector(v, y).addScaledVector(n, t)
      for (let i = 0; i + 1 < pts2.length; i++) {
        const [ax, ay] = pts2[i]
        const [bx, by] = pts2[i + 1]
        const dx = bx - ax
        const dy = by - ay
        const len = Math.hypot(dx, dy)
        if (len < 1e-9) continue
        const nx = -dy / len
        const ny = dx / len
        const a1 = P(ax + nx * w2, ay + ny * w2, tMin)
        const b1 = P(bx + nx * w2, by + ny * w2, tMin)
        const c1 = P(bx - nx * w2, by - ny * w2, tMin)
        const d1 = P(ax - nx * w2, ay - ny * w2, tMin)
        const a2 = a1.clone().addScaledVector(n, tMax - tMin)
        const b2 = b1.clone().addScaledVector(n, tMax - tMin)
        const c2 = c1.clone().addScaledVector(n, tMax - tMin)
        const d2 = d1.clone().addScaledVector(n, tMax - tMin)
        for (const tri of [
          [a1, b1, b2], [a1, b2, a2], // top edge
          [c1, d1, d2], [c1, d2, c2], // bottom edge
          [a2, b2, c2], [a2, c2, d2]  // far cap
        ]) {
          for (const p of tri) wallPos.push(p.x, p.y, p.z)
        }
      }
      const wallGeo = new THREE.BufferGeometry()
      wallGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wallPos), 3))
      this._curveGroup.add(new THREE.Mesh(wallGeo, wallMat))
    }
  }

  clearCurvePreview() {
    if (!this._curveGroup) return
    this._curveGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
    this.scene.remove(this._curveGroup)
    this._curveGroup = null
  }

  setPiecesGhost(on) {
    for (const mesh of this.piecesGroup.children) {
      mesh.material.transparent = on
      mesh.material.opacity = on ? 0.35 : 1
      mesh.material.depthWrite = !on
      mesh.material.needsUpdate = true
    }
  }

  hidePlane() {
    if (this.planeObj) {
      this.planeObj.visible = false
      this.planeGizmo.detach()
      this.planeGizmoHelper.visible = false
    }
  }

  // === Bounded limitation plate ===
  // A posed quad (width × height in local XY, normal = local +Z) plus a very
  // faint box showing the actual cut volume (±PLATE_DEPTH/2 along the
  // normal), matching computePlateTransform's depth in App.jsx.
  showPlate(pos, rot, width, height, showGizmo = false) {
    if (!this.plateObj) {
      this.plateObj = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: 0xff9900,
          transparent: true,
          opacity: 0.18,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
        new THREE.LineBasicMaterial({ color: 0xff9900 })
      )
      this.plateObj.add(edges)
      this.plateVol = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({
          color: 0xff9900,
          transparent: true,
          opacity: 0.05,
          depthWrite: false
        })
      )
      this.plateVol.scale.set(1, 1, 400) // world (w, h, 400) via the parent
      this.plateObj.add(this.plateVol)
      this.scene.add(this.plateObj)

      this.plateGizmo = new TransformControls(this.camera, this.renderer.domElement)
      this.plateGizmo.setSize(0.85)
      this.plateGizmoHelper = this.plateGizmo.getHelper()
      this.scene.add(this.plateGizmoHelper)
      this.plateGizmo.addEventListener('dragging-changed', (e) => {
        this.controls.enabled = !e.value
        if (!e.value) this._commitPlate()
      })
      this.plateGizmo.addEventListener('objectChange', () => this._commitPlate())
    }
    // Don't fight an ongoing gizmo drag with store round-trips.
    if (!this.plateGizmo.dragging) {
      this.plateObj.position.fromArray(pos)
      this.plateObj.rotation.set(rot[0], rot[1], rot[2])
      this.plateObj.scale.set(Math.max(1, width), Math.max(1, height), 1)
    }
    this.plateObj.visible = true
    if (showGizmo) {
      this.plateGizmo.attach(this.plateObj)
      this.plateGizmoHelper.visible = true
    } else {
      this.plateGizmo.detach()
      this.plateGizmoHelper.visible = false
    }
  }

  _commitPlate() {
    if (!this.plateObj) return
    const e = this.plateObj.rotation
    this.onPlateChange?.({
      pos: this.plateObj.position.toArray(),
      rot: [e.x, e.y, e.z],
      width: Math.max(5, Math.abs(this.plateObj.scale.x)),
      height: Math.max(5, Math.abs(this.plateObj.scale.y))
    })
  }

  setPlateGizmoMode(mode) {
    this.plateGizmo?.setMode(mode)
  }

  hidePlate() {
    if (!this.plateObj) return
    this.plateObj.visible = false
    this.plateGizmo?.detach()
    if (this.plateGizmoHelper) this.plateGizmoHelper.visible = false
  }

  // === Live section contour ===
  // Orange intersection lines of the current plane/plate with the pieces,
  // recomputed at most once per animation frame (plane drags fire often).
  updateSectionContour(normal, origin, plateBounds = null) {
    if (!this._contourLines) {
      this._contourLines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          color: 0xffd166,
          transparent: true,
          opacity: 0.95,
          depthTest: false
        })
      )
      this._contourLines.frustumCulled = false
      this._contourLines.renderOrder = 10
      this.scene.add(this._contourLines)
    }
    this._contourLines.visible = true
    this._contourArgs = { normal: normal.clone(), origin: origin.clone(), plateBounds }
    if (this._contourRaf) return
    this._contourRaf = requestAnimationFrame(() => {
      this._contourRaf = 0
      const args = this._contourArgs
      if (!args || !this._contourLines || !this._contourLines.visible) return
      const parts = []
      let total = 0
      for (const mesh of this.piecesGroup.children) {
        if (!mesh.visible) continue
        // Pieces carry their world position in the geometry; the explode
        // slider offsets them via mesh.position — shift the plane (and the
        // plate bounds) into the mesh frame, then translate the segments back.
        const bounds = args.plateBounds
          ? {
              matrixWorldInverse: args.plateBounds.matrixWorldInverse
                .clone()
                .multiply(
                  new THREE.Matrix4().makeTranslation(
                    mesh.position.x,
                    mesh.position.y,
                    mesh.position.z
                  )
                ),
              width: args.plateBounds.width,
              height: args.plateBounds.height
            }
          : null
        const segs = computeSectionSegments(
          mesh.geometry,
          args.normal,
          args.origin.clone().sub(mesh.position),
          bounds
        )
        if (segs.length) {
          parts.push({ segs, mesh })
          total += segs.length
        }
      }
      const arr = new Float32Array(total)
      let off = 0
      for (const { segs, mesh } of parts) {
        for (let i = 0; i < segs.length; i += 3) {
          arr[off++] = segs[i] + mesh.position.x
          arr[off++] = segs[i + 1] + mesh.position.y
          arr[off++] = segs[i + 2] + mesh.position.z
        }
      }
      this._contourLines.geometry.dispose()
      this._contourLines.geometry = new THREE.BufferGeometry()
      this._contourLines.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    })
  }

  hideSectionContour() {
    if (this._contourLines) this._contourLines.visible = false
  }

  // === Tool-mode setters (kept explicit so App effects read clearly) ===
  setFaceMode(on) {
    this.faceMode = !!on
    if (on) setTimeout(() => this.warmFaceCaches(), 30)
    else this._setFaceHover(null)
  }

  setShapeMode(on) {
    this.shapeMode = !!on
    if (on) {
      setTimeout(() => this.warmFaceCaches(), 30)
    } else {
      // Leaving the tool always ends a brush stroke and frees the controls.
      this._isBrushing = false
      this.controls.enabled = true
    }
  }

  // Aliases: the orange selection overlay for the shape tool, the volume box
  // and the puzzle connector markers.
  setShapeOverlay(positions) {
    this.setShapeHighlight(positions)
  }

  showVolume(on) {
    this.setVolumeBox(!!on && this.piecesGroup.children.length > 0)
  }

  setPuzzlePins(pins, pinDiameter, pinLength) {
    this.setPinPreview(pins, pinDiameter, pinLength)
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    if (this._contourRaf) cancelAnimationFrame(this._contourRaf)
    window.removeEventListener('resize', this._onResize)
    this.renderer.dispose()
  }
}
