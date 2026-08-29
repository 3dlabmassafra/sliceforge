import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import * as THREE from 'three'
import { useStore, newPieceId } from './store.js'
import { makeT } from './i18n.js'
import { Viewer, PIECE_COLORS } from './three/viewer.js'
import { importModelFile, ACCEPTED } from './io/importers.js'
import { exportSTL, exportOBJ, exportGLB, export3MF } from './io/exporters.js'
import { AXIS_QUATS, AXIS_INFO, planeBasis, computePlateTransform } from './geometry/plane.js'
import { planeCutAsync, simplifyAsync, volumeCutAsync, pinPreviewAsync } from './geometry/cutClient.js'
import {
  IconCut,
  IconBox,
  IconMove,
  IconReset,
  IconRotate,
  IconFaceDown,
  IconGrid,
  IconWand,
  IconLogo,
  IconPlane,
  IconPlate,
  IconFlip,
  IconGrip,
  IconMinimize,
  IconMaximize
} from './icons.jsx'
import { CutPositionRuler } from './components/CutPositionRuler.jsx'
import { growRegion, regionPositions, regionOrientedBox } from './geometry/shapeSelect.js'
import { reservationsCollide, pinFits2D } from './geometry/collide.js'

// One source of truth for the puzzle grid: the preview shows EXACTLY the
// planes the generation will cut.
function puzzlePlanes(box, blockSize) {
  const planes = []
  for (const axis of ['x', 'y', 'z']) {
    const sz = box.max[axis] - box.min[axis]
    const count = Math.ceil(sz / blockSize[axis])
    for (let i = 1; i < count; i++) {
      planes.push({ axis, offset: box.min[axis] + i * (sz / count) })
    }
  }
  return planes
}

const PRINT_AXES = [
  { key: 'x', label: 'X', color: '#ff5c5c' },
  { key: 'y', label: 'Y', color: '#5ce68a' },
  { key: 'z', label: 'Z', color: '#5cb8ff' }
]

function DimField({ label, color, value, onCommit }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const v = parseFloat(text)
    if (!Number.isNaN(v) && v > 0) onCommit(v)
    else setText(String(value))
  }
  return (
    <div className="dim-field">
      <span style={{ color }}>{label}</span>
      <input
        type="number"
        step="0.5"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur()
          if (e.key === 'Escape') {
            setText(String(value))
            e.target.blur()
          }
        }}
        onBlur={commit}
      />
    </div>
  )
}

const TOOL_GROUPS = [
  [['plane', <IconCut key="c" />, 'planeCut']],
  [
    ['move', <IconMove key="m" />, 'modeMove'],
    ['rotate', <IconRotate key="r" />, 'modeRotate'],
    ['face', <IconFaceDown key="f" />, 'placeFace']
  ],
  [
    ['volume', <IconBox key="b" />, 'volumeCut'],
    ['shape', <IconWand key="w" />, 'shapeCut'],
    ['puzzle', <IconGrid key="p" />, 'puzzle']
  ]
]

const TOOLBAR = TOOL_GROUPS.flat()
const TRANSFORM_TOOLS = new Set(['move', 'rotate', 'face'])

export function App() {
  const s = useStore()
  const t = makeT(s.lang)
  const canvasRef = useRef(null)
  const viewerRef = useRef(null)
  const fileRef = useRef(null)
  const selectedIdRef = useRef(null)
  const puzzlePlanesRef = useRef([])
  const puzzleSectionsRef = useRef([])
  const puzzlePinsRef = useRef([])
  const puzzleSourceRef = useRef(null)

  const [activeTool, setActiveTool] = useState(null)
  const [selectedId, setSelectedIdState] = useState(null)
  const setSelectedId = (id) => {
    selectedIdRef.current = id
    setSelectedIdState(id)
  }

  const [modelOpen, setModelOpen] = useState(true)
  const [piecesOpen, setPiecesOpen] = useState(true)
  const [uniformScale, setUniformScale] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [checked, setChecked] = useState({})
  const [volumeMode, setVolumeMode] = useState('translate')
  const [planeMode, setPlaneMode] = useState('translate')
  const [pinPlacing, setPinPlacing] = useState(false)
  const [manualPins, setManualPins] = useState([])
  const [puzzleEditMode, setPuzzleEditMode] = useState(false)
  const [manualPuzzlePins, setManualPuzzlePins] = useState({})
  const [ctxMenu, setCtxMenu] = useState(null)
  const [busyMsg, setBusyMsg] = useState(null)

  // Floating Cut HUD state
  const [cutHudMinimized, setCutHudMinimized] = useState(false)
  const [cutHudPos, setCutHudPos] = useState(null)
  const cutHudDragRef = useRef(null)

  const onHudPointerDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const rect = e.currentTarget.closest('.floating-cut-hud').getBoundingClientRect()
    cutHudDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top
    }
  }, [])

  const onHudPointerMove = useCallback((e) => {
    if (!cutHudDragRef.current || e.buttons !== 1) return
    const dx = e.clientX - cutHudDragRef.current.startX
    const dy = e.clientY - cutHudDragRef.current.startY
    setCutHudPos({
      left: Math.max(10, Math.min(window.innerWidth - 320, cutHudDragRef.current.origLeft + dx)),
      top: Math.max(10, Math.min(window.innerHeight - 80, cutHudDragRef.current.origTop + dy))
    })
  }, [])

  const onHudPointerUp = useCallback(() => {
    cutHudDragRef.current = null
  }, [])

  const defaultBlock = 230
  const [blockSizeState, setBlockSizeState] = useState({
    x: defaultBlock,
    y: defaultBlock,
    z: defaultBlock
  })
  const blockSize = blockSizeState

  const [shapeSens, setShapeSens] = useState(40)
  const [shapeRadius, setShapeRadius] = useState(25)
  const [shapeSeed, setShapeSeed] = useState(null)
  const [shapeMeta, setShapeMeta] = useState(null)
  const shapeSelRef = useRef(null)

  function clearShapeSel() {
    shapeSelRef.current = null
    setShapeMeta(null)
    viewerRef.current?.setShapeHighlight(null)
  }

  function runShapeSelection(pieceId, faceIndex, sens, radius, isBrushing) {
    const piece = useStore.getState().pieces.find((p) => p.id === pieceId)
    if (!piece) return
    const res = growRegion(piece.geometry, faceIndex, sens, radius)
    
    if (!isBrushing) {
      if (res.count >= res.triCount * 0.95) {
        shapeSelRef.current = { pieceId, sel: null }
        setShapeMeta(null)
        viewerRef.current?.setShapeHighlight(null)
        useStore.getState().setError(makeT(useStore.getState().lang)('shapeWhole'))
        return
      }
      shapeSelRef.current = { pieceId, sel: res.sel, count: res.count }
    } else {
      // Brushing mode: accumulate selection!
      if (!shapeSelRef.current || shapeSelRef.current.pieceId !== pieceId || !shapeSelRef.current.sel) {
        shapeSelRef.current = { pieceId, sel: res.sel, count: res.count }
      } else {
        const curSel = shapeSelRef.current.sel;
        let newCount = shapeSelRef.current.count;
        for (let i = 0; i < res.sel.length; i++) {
          if (res.sel[i] && !curSel[i]) {
            curSel[i] = 1;
            newCount++;
          }
        }
        shapeSelRef.current.count = newCount;
      }
    }
    useStore.getState().setError(null)
    setShapeMeta({ pieceId, count: shapeSelRef.current.count })
    viewerRef.current?.setShapeHighlight(regionPositions(piece.geometry, shapeSelRef.current.sel, shapeSelRef.current.count))
  }

  const isDowelPiece = (p) => p.name.startsWith('dowel_') || p.name.startsWith('cavilha_') || p.name.startsWith('spinotto_')
  const addDowelPiece = (count) => {
    if (count <= 0) return
    const d = s.cutParams.pinDiameter
    const halfH = s.cutParams.pinLength / 2
    const dowelGeo = new THREE.CylinderGeometry(d / 2, d / 2, halfH * 2, 32)
    dowelGeo.rotateZ(Math.PI / 2)
    dowelGeo.computeVertexNormals()
    dowelGeo.computeBoundingBox()
    const name = `spinotto_${d}x${s.cutParams.pinLength}mm`
    useStore.getState().replacePiece(-1, [
      {
        id: newPieceId(),
        name: count > 1 ? `${name}_x${count}` : name,
        geometry: dowelGeo,
        visible: true
      }
    ])
  }

  // Model bounding box and active axis dimensions
  const modelBox = useMemo(() => {
    if (!s.pieces.length) return null
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (p.geometry) {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      }
    })
    return box
  }, [s.pieces])

  const currentAxisInfo = useMemo(() => {
    return AXIS_INFO.find((a) => a.id === s.cutPlaneAxis) || AXIS_INFO[1]
  }, [s.cutPlaneAxis])

  const axisMin = modelBox ? modelBox.min[s.cutPlaneAxis] : 0
  const axisMax = modelBox ? modelBox.max[s.cutPlaneAxis] : 100
  const axisSpan = Math.max(1, axisMax - axisMin)

  useEffect(() => {
    const viewer = new Viewer(canvasRef.current)
    viewerRef.current = viewer
    if (import.meta.env.DEV) window.__sfViewer = viewer

    viewer.onSelect = (id) => setSelectedId(id)
    viewer.onPlaneChange = (p) => s.setPlane(p)
    viewer.onPlateChange = ({ pos, rot, width, height }) => {
      s.setPlateCutPosition(pos)
      s.setPlateCutRotation(rot)
      s.setPlateCutSize(width, height)
    }
    viewer.onPlatePick = (point, normal) => {
      s.setPlateCutPosition([point.x, point.y, point.z])
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
      const euler = new THREE.Euler().setFromQuaternion(q)
      s.setPlateCutRotation([euler.x, euler.y, euler.z])
    }
    viewer.onFacePick = (normal, pieceId) => {
      const target = new THREE.Vector3(0, -1, 0)
      const q = new THREE.Quaternion().setFromUnitVectors(normal, target)
      s.rotateModelQuaternion(q, pieceId)
    }
    viewer.onRotateEnd = (q) => s.rotateModelQuaternion(q, selectedIdRef.current)
    viewer.onMoveEnd = (dx, dz) => s.translatePiece(selectedIdRef.current, dx, dz)

    viewer.onPuzzlePinMove = (planeIdx, pinIdx, u, v) => {
      const plane = puzzlePlanesRef.current[planeIdx]
      const sec = puzzleSectionsRef.current[planeIdx]
      if (!plane || !sec) return
      const r = s.cutParams.pinDiameter / 2
      const tol = s.cutParams.tolerance
      const d = s.cutParams.spacing
      const ok =
        sec.polys.some((poly) => pinFits2D([u, v], poly, r + tol)) &&
        !reservationsCollide(sec.occupied, [u, v], r, tol, d)
      if (!ok) return false
      setManualPuzzlePins((prev) => {
        const cur = prev[planeIdx] ? [...prev[planeIdx]] : [...(puzzlePinsRef.current[planeIdx] ?? [])]
        cur[pinIdx] = [u, v]
        return { ...prev, [planeIdx]: cur }
      })
      return true
    }

    viewer.onPuzzlePinAdd = (planeIdx, u, v) => {
      const sec = puzzleSectionsRef.current[planeIdx]
      if (!sec) return
      const r = s.cutParams.pinDiameter / 2
      const tol = s.cutParams.tolerance
      const d = s.cutParams.spacing
      const ok =
        sec.polys.some((poly) => pinFits2D([u, v], poly, r + tol)) &&
        !reservationsCollide(sec.occupied, [u, v], r, tol, d)
      if (!ok) return
      setManualPuzzlePins((prev) => {
        const cur = prev[planeIdx] ? [...prev[planeIdx]] : [...(puzzlePinsRef.current[planeIdx] ?? [])]
        cur.push([u, v])
        return { ...prev, [planeIdx]: cur }
      })
    }

    viewer.onPuzzlePinRemove = (planeIdx, pinIdx) => {
      setManualPuzzlePins((prev) => {
        const cur = prev[planeIdx] ? [...prev[planeIdx]] : [...(puzzlePinsRef.current[planeIdx] ?? [])]
        cur.splice(pinIdx, 1)
        return { ...prev, [planeIdx]: cur }
      })
    }

    viewer.puzzlePinValidator = (planeIdx, u, v) => {
      const sec = puzzleSectionsRef.current[planeIdx]
      if (!sec) return false
      const r = s.cutParams.pinDiameter / 2
      const tol = s.cutParams.tolerance
      const d = s.cutParams.spacing
      return (
        sec.polys.some((poly) => pinFits2D([u, v], poly, r + tol)) &&
        !reservationsCollide(sec.occupied, [u, v], r, tol, d)
      )
    }

    viewer.onPinPick = (u, v) => {
      setManualPins((pins) => {
        const idx = pins.findIndex(([pu, pv]) => Math.hypot(pu - u, pv - v) < s.cutParams.pinDiameter)
        if (idx >= 0) return pins.filter((_, i) => i !== idx)
        return [...pins, [u, v]]
      })
    }

    viewer.onShapePick = (faceIdx, pieceId) => {
      setShapeSeed({ faceIdx, pieceId })
    }

    viewer.onContextMenu = (x, y) => setCtxMenu({ x, y })

    const dropEl = canvasRef.current
    const onDragOver = (e) => e.preventDefault()
    const onDrop = async (e) => {
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (file) loadFile(file)
    }
    dropEl.addEventListener('dragover', onDragOver)
    dropEl.addEventListener('drop', onDrop)

    return () => {
      dropEl.removeEventListener('dragover', onDragOver)
      dropEl.removeEventListener('drop', onDrop)
      viewer.dispose()
    }
  }, [])

  useEffect(() => {
    setChecked((prev) => {
      const next = {}
      for (const p of s.pieces) next[p.id] = prev[p.id] ?? true
      return next
    })
  }, [s.pieces])

  useEffect(() => {
    if (!s.pieces.length && !s.modelName) {
      fetch('/ratome.stl')
        .then((r) => (r.ok ? r.blob() : Promise.reject()))
        .then((b) => loadFile(new File([b], 'ratome.stl')))
        .catch(() => {})
    }
  }, [])

  async function loadFile(file) {
    s.setBusy(true)
    s.setError(null)
    try {
      const geometry = await importModelFile(file)
      s.setModel(file.name, geometry)
      puzzleSourceRef.current = geometry.clone()
      setSelectedId(1)
      setActiveTool(null)
      setTimeout(() => viewerRef.current?.fitCamera(), 50)
    } catch (e) {
      console.error(e)
      s.setError(t('loadError', { name: file.name }))
    } finally {
      s.setBusy(false)
    }
  }

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.setPieces(s.pieces)
    if (selectedId && !s.pieces.some((p) => p.id === selectedId)) {
      const first = s.pieces.find((p) => p.visible)?.id ?? null
      setSelectedId(first)
    }
  }, [s.pieces])

  useEffect(() => {
    viewerRef.current?.setSelected(selectedId)
  }, [selectedId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        s.redo()
      } else if (!mod && e.key >= '1' && e.key <= String(TOOLBAR.length)) {
        const idx = parseInt(e.key, 10) - 1
        const tool = TOOLBAR[idx][0]
        setActiveTool((t) => (t === tool ? null : tool))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    viewerRef.current?.setVolumeMode(volumeMode)
  }, [volumeMode])

  useEffect(() => {
    viewerRef.current?.setPlaneGizmoMode(planeMode)
  }, [planeMode])

  useEffect(() => {
    if (activeTool !== 'plane' && activeTool !== 'volume') return
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const k = e.key.toLowerCase()
      if (k !== 't' && k !== 'r') return
      const mode = k === 't' ? 'translate' : 'rotate'
      if (activeTool === 'plane') setPlaneMode(mode)
      else setVolumeMode(mode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool])

  async function onVolumeCut() {
    s.setBusy(true)
    s.setError(null)
    try {
      const matrix = viewerRef.current.getVolumeMatrix()
      const targets = s.pieces.filter((p) => p.visible)
      for (const piece of targets) {
        const parts = await volumeCutAsync(piece.geometry, matrix)
        if (parts.length < 2) continue
        useStore.getState().replacePiece(
          piece.id,
          parts.map((g, i) => ({
            id: newPieceId(),
            name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
            geometry: g,
            visible: true
          }))
        )
      }
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  useEffect(() => {
    viewerRef.current?.setExplode(s.explode)
  }, [s.explode])

  // Synchronize 3D Plane / Bounded Plate and Live Section Contour in Three.js
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (activeTool !== 'plane' || !s.pieces.length) {
      viewer.hidePlane()
      viewer.hidePlate()
      viewer.hideSectionContour()
      return
    }

    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const size = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length()

    if (s.planeCutMode === 'plate') {
      viewer.hidePlane()
      viewer.showPlate(
        s.plateCutPosition,
        s.plateCutRotation,
        s.plateCutWidth,
        s.plateCutHeight,
        !s.plateMoveMode
      )
      const plateEuler = new THREE.Euler(...s.plateCutRotation)
      const plateNormal = new THREE.Vector3(0, 0, 1).applyEuler(plateEuler).normalize()
      const plateOrigin = new THREE.Vector3(...s.plateCutPosition)
      const plateTransform = computePlateTransform(
        s.plateCutPosition,
        s.plateCutRotation,
        s.plateCutWidth,
        s.plateCutHeight,
        400
      )
      const plateBounds = {
        matrixWorldInverse: plateTransform.clone().invert(),
        width: s.plateCutWidth,
        height: s.plateCutHeight
      }
      viewer.updateSectionContour(plateNormal, plateOrigin, plateBounds)
    } else {
      viewer.hidePlate()
      viewer.showPlane(s.plane, size * 0.8, currentAxisInfo.color)
      const { normal, origin } = planeBasis(s.plane)
      viewer.updateSectionContour(normal, origin, null)
    }
  }, [
    s.plane,
    s.pieces,
    activeTool,
    s.planeCutMode,
    s.cutPlaneAxis,
    s.plateCutPosition,
    s.plateCutRotation,
    s.plateCutWidth,
    s.plateCutHeight,
    s.plateMoveMode,
    currentAxisInfo
  ])

  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.planeMode = activeTool === 'plane' && s.planeCutMode === 'infinite'
      viewerRef.current.plateMode = activeTool === 'plane' && s.planeCutMode === 'plate'
      viewerRef.current.plateMoveMode = s.plateMoveMode
    }
  }, [activeTool, s.planeCutMode, s.plateMoveMode])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const active = pinPlacing && activeTool === 'plane'
    viewer.pinMode = active
    viewer.setPiecesGhost(active)
    return () => viewer.setPiecesGhost(false)
  }, [pinPlacing, activeTool, s.pieces])

  useEffect(() => {
    viewerRef.current?.setPinMarkers(manualPins, s.cutParams.pinDiameter, s.cutParams.pinLength)
  }, [manualPins, s.cutParams.pinDiameter, s.cutParams.pinLength, s.plane, activeTool])

  useEffect(() => {
    if (activeTool !== 'plane') {
      setPinPlacing(false)
      setManualPins([])
    }
    setModelOpen(!activeTool || TRANSFORM_TOOLS.has(activeTool))
    if (activeTool === 'puzzle' && dims) {
      const est = Math.max(dims.x, dims.y, dims.z)
      if (est < defaultBlock) {
        const fit = Math.max(20, Math.round(est / 2 / 10) * 10)
        setBlockSizeState({ x: fit, y: fit, z: fit })
      }
    }
    viewerRef.current?.setGizmo(activeTool === 'rotate' ? selectedId : null)
    viewerRef.current?.setMoveGizmo(activeTool === 'move' ? selectedId : null)
    viewerRef.current?.setFaceMode(activeTool === 'face')
    viewerRef.current?.setShapeMode(activeTool === 'shape')
    viewerRef.current?.showVolume(activeTool === 'volume')
    if (activeTool !== 'puzzle') {
      viewerRef.current?.setPuzzlePreview(null)
      viewerRef.current?.setPuzzlePins(null)
      setPuzzleEditMode(false)
      setManualPuzzlePins({})
    }
    if (activeTool !== 'shape') {
      viewerRef.current?.setShapeOverlay(null)
      setShapeSeed(null)
      setShapeMeta(null)
    }
  }, [activeTool, selectedId])

  
  useEffect(() => {
    if (!shapeSeed) return
    runShapeSelection(shapeSeed.pieceId, shapeSeed.faceIdx, shapeSens, effRadius, shapeSeed.isBrushing)
  }, [shapeSeed, shapeSens, effRadius])

  const revealCut = () => {
    if (!s.pieces.length) return
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const sz = box.getSize(new THREE.Vector3()).length()
    const target = Math.max(6, Math.min(60, Math.round(sz * 0.08)))
    s.setExplode(target)
  }

  async function onCut() {
    s.setBusy(true)
    s.setError(null)
    try {
      const targets = s.pieces.filter((p) => p.visible && !isDowelPiece(p))
      let dowels = 0

      if (s.planeCutMode === 'plate') {
        const plateMatrix = computePlateTransform(
          s.plateCutPosition,
          s.plateCutRotation,
          s.plateCutWidth,
          s.plateCutHeight,
          400
        )
        for (const piece of targets) {
          const parts = await volumeCutAsync(piece.geometry, plateMatrix.elements)
          if (parts.length < 2) continue
          useStore.getState().replacePiece(
            piece.id,
            parts.map((g, i) => ({
              id: newPieceId(),
              name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
              geometry: g,
              visible: true
            }))
          )
        }
      } else {
        for (const piece of targets) {
          const parts = await planeCutAsync(piece.geometry, s.plane, {
            ...s.cutParams,
            manualPins: manualPins.length ? manualPins : undefined
          })
          if (parts.length < 2) continue
          dowels += parts.dowelCount ?? 0
          useStore.getState().replacePiece(
            piece.id,
            parts.map((g, i) => ({
              id: newPieceId(),
              name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
              geometry: g,
              visible: true
            }))
          )
        }
        addDowelPiece(dowels)
      }
      setManualPins([])
      setPinPlacing(false)
      revealCut()
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  const [simplifyPct, setSimplifyPct] = useState(25)
  const triCount = s.pieces.reduce(
    (n, p) => n + (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count) / 3,
    0
  )

  async function onSimplify() {
    s.setBusy(true)
    s.setError(null)
    try {
      const geoms = []
      for (const p of s.pieces) {
        geoms.push((await simplifyAsync(p.geometry, simplifyPct / 100))[0])
      }
      useStore.getState().replaceAllGeometries(geoms)
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  // Dimensions & bounds
  let dims = null
  let isTiny = false
  let maxDim = 100
  if (s.pieces.length) {
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const sz = box.getSize(new THREE.Vector3())
    dims = { x: sz.x, y: sz.y, z: sz.z }
    isTiny = Math.max(sz.x, sz.y, sz.z) < 1.0
    maxDim = Math.max(sz.x, sz.y, sz.z)
  }

  const selPiece = s.pieces.find((p) => p.id === selectedId)
  let selDims = null
  if (selPiece) {
    if (!selPiece.geometry.boundingBox) selPiece.geometry.computeBoundingBox()
    const sz = selPiece.geometry.boundingBox.getSize(new THREE.Vector3())
    selDims = { x: sz.x, y: sz.y, z: sz.z }
  }

  const effRadius = Math.min(shapeRadius, Math.ceil(maxDim))

  async function onDetachShape() {
    if (!shapeMeta || !shapeSeed) return
    const piece = s.pieces.find((p) => p.id === shapeSeed.pieceId)
    if (!piece) return
    const selPos = regionPositions(piece.geometry, shapeSelRef.current.sel)
    const { matrix } = regionOrientedBox(selPos)
    s.setBusy(true)
    s.setError(null)
    try {
      const parts = await volumeCutAsync(piece.geometry, matrix)
      if (parts.length < 2) return
      useStore.getState().replacePiece(
        piece.id,
        parts.map((g, i) => ({
          id: newPieceId(),
          name: `${piece.name.replace(/\.[^.]+$/, '')}_${i === 0 ? 'détail' : 'reste'}`,
          geometry: g,
          visible: true
        }))
      )
      setActiveTool(null)
      revealCut()
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
  }

  return (
    <div className="app">
      <header>
        <div className="logo">
          <IconLogo />
          <span>SliceForge</span>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0]
            if (f) loadFile(f)
            e.target.value = ''
          }}
        />
        <button onClick={() => fileRef.current.click()}>{t('import')}</button>
        {s.pieces.length > 0 && (
          <div className="export-menu">
            <button
              className="primary"
              disabled={!Object.values(checked).some(Boolean)}
              onClick={() => setExportOpen((v) => !v)}
            >
              {t('export')} ({Object.values(checked).filter(Boolean).length}) ▾
            </button>
            {exportOpen && (
              <div className="dropdown" onClick={() => setExportOpen(false)}>
                <button
                  onClick={() =>
                    exportSTL(
                      s.pieces.filter((p) => checked[p.id]),
                      s.modelName
                    )
                  }
                >
                  {t('exportStl')}
                </button>
                <button
                  onClick={() =>
                    export3MF(
                      s.pieces.filter((p) => checked[p.id]),
                      s.modelName
                    )
                  }
                >
                  {t('export3mf')}
                </button>
                <button
                  onClick={() =>
                    exportGLB(
                      s.pieces.filter((p) => checked[p.id]),
                      s.modelName
                    )
                  }
                >
                  {t('exportGlb')}
                </button>
                <button
                  onClick={() =>
                    exportOBJ(
                      s.pieces.filter((p) => checked[p.id]),
                      s.modelName
                    )
                  }
                >
                  {t('exportObj')}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="spacer" />
        <button
          className="icon-btn"
          disabled={!s.history.length}
          onClick={() => s.undo()}
          aria-label={t('undo')}
        >
          ↶
        </button>
        <button
          className="icon-btn"
          disabled={!s.future.length}
          onClick={() => s.redo()}
          aria-label={t('redo')}
        >
          ↷
        </button>
        <div className="lang-switcher">
          {['it', 'en', 'pt', 'fr'].map((l) => (
            <button
              key={l}
              className={s.lang === l ? 'active' : ''}
              onClick={() => s.setLang(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <main>
        <div className="viewport">
          <canvas ref={canvasRef} />

          {/* Vertical Toolbar */}
          {s.pieces.length > 0 && (
            <div className="viewport-toolbar">
              {TOOL_GROUPS.map((group, gi) => (
                <div className="tool-group" key={gi}>
                  {group.map(([tool, icon, labelKey]) => (
                    <button
                      key={tool}
                      className={activeTool === tool ? 'active' : ''}
                      onClick={() => setActiveTool(activeTool === tool ? null : tool)}
                      title={t(labelKey)}
                    >
                      {icon} <span className="tool-label">{t(labelKey)}</span>
                      <span className="kbd">{TOOLBAR.findIndex(([tl]) => tl === tool) + 1}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* FLOATING SMART CUT HUD (Nativos3D Parity) */}
          {activeTool === 'plane' && s.pieces.length > 0 && (
            <div
              className="floating-cut-hud"
              style={
                cutHudPos
                  ? { left: cutHudPos.left, top: cutHudPos.top, bottom: 'auto', transform: 'none' }
                  : {}
              }
            >
              <div
                className="cut-hud-header"
                onPointerDown={onHudPointerDown}
                onPointerMove={onHudPointerMove}
                onPointerUp={onHudPointerUp}
              >
                <div className="cut-hud-title-wrap">
                  <IconGrip />
                  <div
                    className="cut-hud-status-dot"
                    style={{
                      background: currentAxisInfo.color,
                      boxShadow: `0 0 8px ${currentAxisInfo.color}`
                    }}
                  />
                  <span className="cut-hud-title">{t('toolCutTitle')}</span>
                </div>
                <div className="cut-hud-actions-right">
                  <span className="cut-hud-badge">{t('watertight')}</span>
                  <button
                    className="cut-hud-icon-btn"
                    onClick={() => setCutHudMinimized((v) => !v)}
                    title={cutHudMinimized ? 'Espandi' : 'Riduci'}
                  >
                    {cutHudMinimized ? <IconMaximize /> : <IconMinimize />}
                  </button>
                </div>
              </div>

              {!cutHudMinimized && (
                <div className="cut-hud-body">
                  {/* Mode switcher tabs: Piano Infinito vs Placca di Limitazione */}
                  <div className="cut-mode-tabs">
                    <button
                      className={`cut-tab-btn ${s.planeCutMode === 'infinite' ? 'active' : ''}`}
                      onClick={() => s.setPlaneCutMode('infinite')}
                    >
                      <IconPlane /> {t('infinitePlane')}
                    </button>
                    <button
                      className={`cut-tab-btn ${s.planeCutMode === 'plate' ? 'active' : ''}`}
                      onClick={() => {
                        s.setPlaneCutMode('plate')
                        s.initPlateFromModel()
                      }}
                    >
                      <IconPlate /> {t('limitationPlate')}
                    </button>
                  </div>

                  {/* INFINITE PLANE CONTROLS */}
                  {s.planeCutMode === 'infinite' && (
                    <div className="cut-infinite-pane">
                      {/* Axis buttons */}
                      <div className="cut-axis-row">
                        <span className="cut-axis-label">{t('axis')}</span>
                        <div className="cut-axis-buttons">
                          {AXIS_INFO.map((a) => (
                            <button
                              key={a.id}
                              className={`cut-axis-btn ${s.cutPlaneAxis === a.id ? 'active' : ''}`}
                              style={
                                s.cutPlaneAxis === a.id
                                  ? {
                                      background: a.color,
                                      borderColor: a.color,
                                      boxShadow: `0 0 10px ${a.glow}`,
                                      color: '#0e1014'
                                    }
                                  : { borderColor: 'rgba(255,255,255,0.1)' }
                              }
                              onClick={() => s.setCutPlaneAxis(a.id)}
                            >
                              {a.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Graduated Millimeter Ruler Slider */}
                      <CutPositionRuler
                        value={s.cutPlaneOffset}
                        onChange={(v) => s.setCutPlaneOffset(v)}
                        modelSize={axisSpan}
                        minVal={axisMin}
                        maxVal={axisMax}
                        axisColor={currentAxisInfo.color}
                        label={t('cutPosition')}
                      />

                      {/* Action buttons */}
                      <div className="cut-action-row">
                        <button
                          className={`cut-btn-invert ${s.cutPlaneFlip ? 'active' : ''}`}
                          onClick={() => s.toggleCutPlaneFlip()}
                          title="Inverte il lato di taglio"
                        >
                          <IconFlip /> {t('cutFlip')}
                        </button>

                        <button
                          className="cut-btn-execute"
                          disabled={s.busy}
                          onClick={onCut}
                          style={{
                            background: currentAxisInfo.color,
                            boxShadow: `0 0 14px ${currentAxisInfo.glow}`
                          }}
                        >
                          <IconCut /> {s.busy ? t('cutExecuting') : t('cutExecute')}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* BOUNDED LIMITATION PLATE CONTROLS */}
                  {s.planeCutMode === 'plate' && (
                    <div className="cut-plate-pane">
                      <div className="cut-plate-submode-row">
                        <button
                          className={`cut-plate-submode-btn ${s.plateMoveMode ? 'active move' : ''}`}
                          onClick={() => s.setPlateMoveMode(true)}
                          title="Clicca sul modello per posizionare la placca"
                        >
                          <IconMove /> {t('plateMove')}
                        </button>
                        <button
                          className={`cut-plate-submode-btn ${!s.plateMoveMode ? 'active edit' : ''}`}
                          onClick={() => s.setPlateMoveMode(false)}
                          title="Gira e ridimensiona la placca con il gizmo 3D"
                        >
                          <IconRotate /> {t('plateEdit')}
                        </button>
                      </div>

                      <div className="cut-plate-hint-callout">
                        {s.plateMoveMode ? (
                          <>
                            <span style={{ color: '#ff9900' }}>●</span> {t('plateMoveHint')}
                          </>
                        ) : (
                          <>
                            <span style={{ color: '#5cb8ff' }}>●</span> {t('plateEditHint')}
                          </>
                        )}
                      </div>

                      {/* Position X Y Z */}
                      <div className="cut-plate-field-block">
                        <span className="cut-plate-field-title">{t('positionXYZ')}</span>
                        <div className="cut-plate-coords-row">
                          {['X', 'Y', 'Z'].map((axis, i) => (
                            <div key={axis} className="cut-plate-coord-box">
                              <span className="coord-axis">{axis}:</span>
                              <input
                                type="number"
                                step="0.5"
                                value={parseFloat(s.plateCutPosition[i].toFixed(1))}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value)
                                  if (isNaN(v)) return
                                  const next = [...s.plateCutPosition]
                                  next[i] = v
                                  s.setPlateCutPosition(next)
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Dimensions W / H */}
                      {!s.plateMoveMode && (
                        <>
                          <div className="cut-plate-field-block">
                            <span className="cut-plate-field-title">{t('dimensionsW_H')}</span>
                            <div className="cut-plate-coords-row">
                              <div className="cut-plate-coord-box">
                                <span className="coord-axis">{t('width')}:</span>
                                <input
                                  type="number"
                                  min="5"
                                  step="5"
                                  value={parseFloat(s.plateCutWidth.toFixed(1))}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    if (!isNaN(v) && v > 0) s.setPlateCutSize(v, s.plateCutHeight)
                                  }}
                                />
                                <span className="unit">mm</span>
                              </div>
                              <div className="cut-plate-coord-box">
                                <span className="coord-axis">{t('height')}:</span>
                                <input
                                  type="number"
                                  min="5"
                                  step="5"
                                  value={parseFloat(s.plateCutHeight.toFixed(1))}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value)
                                    if (!isNaN(v) && v > 0) s.setPlateCutSize(s.plateCutWidth, v)
                                  }}
                                />
                                <span className="unit">mm</span>
                              </div>
                            </div>
                          </div>

                          {/* Rotations in degrees */}
                          <div className="cut-plate-field-block">
                            <span className="cut-plate-field-title">{t('rotationDeg')}</span>
                            <div className="cut-plate-coords-row">
                              {[
                                { axis: 'X', color: '#ff5c5c', idx: 0 },
                                { axis: 'Y', color: '#5ce68a', idx: 1 },
                                { axis: 'Z', color: '#5cb8ff', idx: 2 }
                              ].map(({ axis, color, idx }) => (
                                <div key={axis} className="cut-plate-coord-box">
                                  <span className="coord-axis" style={{ color }}>{axis}:</span>
                                  <input
                                    type="number"
                                    step="5"
                                    value={parseFloat(((s.plateCutRotation[idx] * 180) / Math.PI).toFixed(0))}
                                    onChange={(e) => {
                                      const deg = parseFloat(e.target.value)
                                      if (isNaN(deg)) return
                                      const next = [...s.plateCutRotation]
                                      next[idx] = (deg * Math.PI) / 180
                                      s.setPlateCutRotation(next)
                                    }}
                                  />
                                  <span className="unit">°</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      {/* Active Barrier status badge */}
                      <div className="cut-plate-barrier-badge">
                        <span className="barrier-dot" />
                        <span>{t('activeBarrier')}</span>
                      </div>

                      {/* Action buttons */}
                      <div className="cut-action-row">
                        <button
                          className="cut-btn-execute"
                          disabled={s.busy}
                          onClick={onCut}
                          style={{
                            background: '#ff9900',
                            boxShadow: '0 0 14px rgba(255, 153, 0, 0.45)',
                            color: '#0e1014'
                          }}
                        >
                          <IconCut /> {s.busy ? t('cutExecuting') : t('cutExecute')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!s.pieces.length && (
            <div className="empty-state">
              <IconLogo />
              <p>{t('dropHint')}</p>
              <button className="primary" onClick={() => fileRef.current.click()}>
                {t('import')}
              </button>
              <span className="formats">STL · OBJ · GLB · GLTF · 3MF</span>
            </div>
          )}

          {s.busy && <div className="busy">{busyMsg || t('cutting')}</div>}

          {ctxMenu && (
            <div
              className="ctx-menu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  s.centerModel()
                  setCtxMenu(null)
                }}
              >
                {t('centerModel')}
              </button>
              <button
                onClick={() => {
                  viewerRef.current?.fitCamera()
                  setCtxMenu(null)
                }}
              >
                {t('fitView')}
              </button>
            </div>
          )}

          {s.error && (
            <div className="error" onClick={() => s.setError(null)}>
              {s.error}
            </div>
          )}
        </div>

        {/* SIDEBAR */}
        {s.pieces.length > 0 && (
          <aside>
            <section>
              <h3 className="collapsible" onClick={() => setModelOpen((v) => !v)}>
                {t('model')}
                <span className={`chevron${modelOpen ? '' : ' closed'}`}>▾</span>
              </h3>
              {dims && (
                <div className="dims">
                  {t('dims', {
                    x: dims.x.toFixed(1),
                    y: dims.z.toFixed(1),
                    z: dims.y.toFixed(1)
                  })}
                </div>
              )}
              {isTiny && (
                <div className="tiny-hint">
                  {t('tinyModel')}
                  <button onClick={() => s.scaleModel(1000)}>{t('scaleToMm')}</button>
                </div>
              )}
              {modelOpen && (
                <>
                  {selPiece ? (
                    <>
                      {s.pieces.length > 1 && (
                        <div className="dims">{t('selectedPiece', { name: selPiece.name })}</div>
                      )}
                      <div className="field">
                        <div className="field-head">
                          {t('dimensions')}
                          {(() => {
                            if (s.pieces.length !== 1 || !s.importDims || !selDims) return null
                            const cur = [selDims.x, selDims.y, selDims.z]
                            const sortedCur = [...cur].sort((a, b) => a - b)
                            const sortedImp = [...s.importDims].sort((a, b) => a - b)
                            const f = cur.map((v) => sortedImp[sortedCur.indexOf(v)] / v)
                            return (
                              <button
                                className="icon-btn"
                                aria-label={t('resetSize', {
                                  x: s.importDims[0].toFixed(1),
                                  y: s.importDims[2].toFixed(1),
                                  z: s.importDims[1].toFixed(1)
                                })}
                                onClick={() => {
                                  if (f.every((x) => Math.abs(x - 1) < 1e-3)) return
                                  s.resizeModel(f[0], f[1], f[2], selectedId)
                                }}
                              >
                                <IconReset />
                              </button>
                            )
                          })()}
                        </div>
                        <div className="dim-row">
                          {PRINT_AXES.map(({ key, label, color }) => (
                            <DimField
                              key={key}
                              label={label}
                              color={color}
                              value={selDims ? +selDims[key].toFixed(1) : 0}
                              onCommit={(v) => {
                                if (!selDims) return
                                const f = v / selDims[key]
                                if (uniformScale) s.resizeModel(f, f, f, selectedId)
                                else
                                  s.resizeModel(
                                    key === 'x' ? f : 1,
                                    key === 'y' ? f : 1,
                                    key === 'z' ? f : 1,
                                    selectedId
                                  )
                              }}
                            />
                          ))}
                        </div>
                      </div>
                      <label className="inline">
                        <input
                          type="checkbox"
                          checked={uniformScale}
                          onChange={(e) => setUniformScale(e.target.checked)}
                        />
                        {t('uniform')}
                      </label>
                      <label>
                        {t('rotation')}
                        {PRINT_AXES.map(({ key: axis, label, color }) => (
                          <div className="rot-row" key={axis}>
                            <span className="rot-axis" style={{ color }}>{label}</span>
                            {[-90, -15, 15, 90].map((deg) => (
                              <button key={deg} onClick={() => s.rotateModel(axis, deg, selectedId)}>
                                {deg > 0 ? `+${deg}°` : `${deg}°`}
                              </button>
                            ))}
                          </div>
                        ))}
                      </label>
                    </>
                  ) : (
                    <div className="dims">{t('selectHint')}</div>
                  )}
                  <div className="dims">{t('triangles', { n: Math.round(triCount).toLocaleString() })}</div>
                  <div className="simplify-row">
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={simplifyPct}
                      onChange={(e) => setSimplifyPct(+e.target.value)}
                      aria-label="%"
                    />
                    <span>%</span>
                    <button disabled={s.busy} onClick={onSimplify}>
                      {t('simplify')}
                    </button>
                  </div>
                </>
              )}
            </section>

            {/* PLANE CUT DETAILS & CONNECTORS SECTION */}
            {activeTool === 'plane' && (
              <>
                <section>
                  <h3>{t('planeCut')}</h3>
                  <div className="dims">{t('planeHint')}</div>
                  <div className="axis-row">
                    {[
                      ['translate', `${t('modeMove')} (T)`],
                      ['rotate', `${t('modeRotate')} (R)`]
                    ].map(([mode, label]) => (
                      <button
                        key={mode}
                        className={planeMode === mode ? 'active' : ''}
                        onClick={() => setPlaneMode(mode)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label>
                    {t('kerf')}
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={s.cutParams.kerf}
                      onChange={(e) => s.setCutParams({ kerf: +e.target.value })}
                    />
                  </label>
                  <button className="primary" disabled={s.busy} onClick={onCut}>
                    {s.busy ? t('cutting') : t('cut')}
                  </button>
                </section>

                <section>
                  <h3>
                    {t('connectors')}
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={s.cutParams.pins}
                        onChange={(e) => s.setCutParams({ pins: e.target.checked })}
                      />
                    </label>
                  </h3>
                  {s.cutParams.pins && (
                    <>
                      <label>
                        {t(['square', 'hex'].includes(s.cutParams.connectorType) ? 'pinWidth' : 'pinDiameter')}
                        <input
                          type="number"
                          min="1"
                          step="0.5"
                          value={s.cutParams.pinDiameter}
                          onChange={(e) => s.setCutParams({ pinDiameter: +e.target.value })}
                        />
                      </label>
                      <label>
                        {t('pinLength')}
                        <input
                          type="number"
                          min="2"
                          step="0.5"
                          value={s.cutParams.pinLength}
                          onChange={(e) => s.setCutParams({ pinLength: +e.target.value })}
                        />
                      </label>
                      <label>
                        {t('tolerance')}
                        <input
                          type="number"
                          min="0"
                          step="0.05"
                          value={s.cutParams.tolerance}
                          onChange={(e) => s.setCutParams({ tolerance: +e.target.value })}
                        />
                      </label>
                      <div className="dims">{t('toleranceHint')}</div>
                      <label>
                        {t('spacing')}
                        <input
                          type="number"
                          min="5"
                          step="5"
                          value={s.cutParams.spacing}
                          onChange={(e) => s.setCutParams({ spacing: +e.target.value })}
                        />
                      </label>
                      <label className="inline">
                        <input
                          type="checkbox"
                          checked={s.cutParams.taper}
                          onChange={(e) => s.setCutParams({ taper: e.target.checked })}
                        />
                        {t('taper')}
                      </label>
                      <button
                        className={pinPlacing ? 'active' : ''}
                        onClick={() => setPinPlacing((v) => !v)}
                      >
                        {t('placePins')}
                      </button>
                      {pinPlacing && <div className="dims">{t('pinsHint')}</div>}
                      {manualPins.length > 0 && (
                        <div className="simplify-row">
                          <span className="dims" style={{ flex: 1 }}>
                            {t('pinsPlaced', { n: manualPins.length })}
                          </span>
                          <button onClick={() => setManualPins([])}>{t('clearPins')}</button>
                        </div>
                      )}
                      <label>
                        {t('connector')}
                        <div className="axis-row">
                          {[
                            ['dowel', t('connDowel')],
                            ['pin', t('connPin')],
                            ['square', t('connSquare')],
                            ['hex', t('connHex')]
                          ].map(([type, label]) => (
                            <button
                              key={type}
                              className={s.cutParams.connectorType === type ? 'active' : ''}
                              onClick={() => s.setConnectorType(type)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </label>
                    </>
                  )}
                </section>
              </>
            )}

            {activeTool === 'move' && (
              <section>
                <h3>{t('modeMove')}</h3>
                <div className="dims">{selectedId ? t('moveHint') : t('selectHint')}</div>
              </section>
            )}

            {activeTool === 'volume' && (
              <section>
                <h3>{t('volumeCut')}</h3>
                <div className="dims">{t('volumeHint')}</div>
                <div className="axis-row">
                  {[
                    ['translate', t('modeMove')],
                    ['rotate', t('modeRotate')],
                    ['scale', t('modeScale')]
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      className={volumeMode === mode ? 'active' : ''}
                      onClick={() => setVolumeMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button className="primary" disabled={s.busy} onClick={onVolumeCut}>
                  {s.busy ? t('cutting') : t('detach')}
                </button>
              </section>
            )}

            {activeTool === 'face' && (
              <section>
                <h3>{t('placeFace')}</h3>
                <div className="dims">{t('faceHint')}</div>
              </section>
            )}

            {activeTool === 'rotate' && (
              <section>
                <h3>{t('modeRotate')}</h3>
                <div className="dims">{selectedId ? t('rotateHint') : t('selectHint')}</div>
              </section>
            )}

            {activeTool === 'shape' && (
              <section>
                <h3>{t('shapeCut')}</h3>
                <div className="dims">
                  {shapeMeta ? t('shapeSelected', { n: shapeMeta.count }) : t('shapeHint')}
                </div>
                <label>
                  {t('radius')} ({effRadius} mm)
                  <input
                    type="range"
                    min="1"
                    max={Math.ceil(maxDim)}
                    value={effRadius}
                    onChange={(e) => setShapeRadius(+e.target.value)}
                  />
                </label>
                <label>
                  {t('sensitivity')} ({shapeSens}°)
                  <input
                    type="range"
                    min="5"
                    max="85"
                    value={shapeSens}
                    onChange={(e) => setShapeSens(+e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={s.busy || !shapeMeta}
                  onClick={onDetachShape}
                >
                  {s.busy ? t('cutting') : t('detachShape')}
                </button>
              </section>
            )}

            {activeTool === 'puzzle' && (
              <section>
                <h3>{t('puzzle')}</h3>
                <label>
                  {t('blockSize')}
                  <div className="dim-row">
                    {PRINT_AXES.map(({ key: axis, label, color }) => (
                      <div className="dim-field" key={axis}>
                        <span style={{ color }}>{label}</span>
                        <input
                          type="number"
                          min="10"
                          step="10"
                          value={blockSize[axis]}
                          onChange={(e) =>
                            setBlockSizeState({ ...blockSize, [axis]: +e.target.value })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </label>
              </section>
            )}

            {/* PIECES LIST */}
            <section>
              <h3 className="collapsible" onClick={() => setPiecesOpen((v) => !v)}>
                {t('pieces')} ({s.pieces.length})
                <span className={`chevron${piecesOpen ? '' : ' closed'}`}>▾</span>
              </h3>
              {piecesOpen && (
                <>
                  <div className="pieces-list">
                    {s.pieces.map((p, idx) => (
                      <div
                        key={p.id}
                        className={`piece-item${p.id === selectedId ? ' active' : ''}`}
                        onClick={() => setSelectedId(p.id)}
                      >
                        <input
                          type="checkbox"
                          checked={checked[p.id] ?? true}
                          onChange={(e) => {
                            e.stopPropagation()
                            setChecked((c) => ({ ...c, [p.id]: e.target.checked }))
                          }}
                        />
                        <span
                          className="piece-color-dot"
                          style={{
                            background: `#${(PIECE_COLORS[idx % PIECE_COLORS.length] || 0x5b8dee).toString(16).padStart(6, '0')}`
                          }}
                        />
                        <span className="piece-name">{p.name}</span>
                        <button
                          className="icon-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            s.togglePiece(p.id)
                          }}
                          aria-label={p.visible ? 'Masquer' : 'Afficher'}
                        >
                          {p.visible ? '👁' : '👁‍🗨'}
                        </button>
                      </div>
                    ))}
                  </div>

                  {s.pieces.length > 1 && (
                    <label>
                      {t('explode')} ({s.explode} mm)
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={s.explode}
                        onChange={(e) => s.setExplode(+e.target.value)}
                      />
                    </label>
                  )}
                </>
              )}
            </section>
          </aside>
        )}
      </main>
    </div>
  )
}

export default App
