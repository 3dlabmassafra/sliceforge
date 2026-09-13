import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import * as THREE from 'three'
import { useStore, newPieceId } from './store.js'
import { makeT } from './i18n.js'
import { Viewer, PIECE_COLORS } from './three/viewer.js'
import { importModelFile, ACCEPTED } from './io/importers.js'
import { exportSTL, exportOBJ, exportGLB, export3MF } from './io/exporters.js'
import { AXIS_QUATS, AXIS_INFO, planeBasis, computePlateTransform } from './geometry/plane.js'
import { planeCutAsync, simplifyAsync, volumeCutAsync, pinPreviewAsync, curvedCutAsync } from './geometry/cutClient.js'
import {
  IconCut,
  IconCurve,
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
    ['puzzle', <IconGrid key="p" />, 'puzzle'],
    ['curved', <IconCurve key="cv" />, 'curvedCut']
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
  const puzzlePlanesRef = useRef([]) // posed planes matching planeIdx
  const puzzleSectionsRef = useRef([]) // per-plane cross-section polygons
  const puzzlePinsRef = useRef(null) // live mirror of puzzlePins (validator)
  const puzzleSourceRef = useRef(null) // { pieces, ids } — regenerate from the original

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
  const [plateGizmoMode, setPlateGizmoMode] = useState('rotate')
  const [pinPlacing, setPinPlacing] = useState(false)
  const [manualPins, setManualPins] = useState([])
  const [pinPreviewOn, setPinPreviewOn] = useState(false)
  const [puzzlePins, setPuzzlePins] = useState(null) // [{planeIdx, u, v, off}]
  const [ctxMenu, setCtxMenu] = useState(null)
  const [busyMsg, setBusyMsg] = useState(null)
  const [curvePoints, setCurvePoints] = useState([]) // [{ point: Vector3, dir: Vector3 }]
  const curveRef = useRef([])
  const curveDirRef = useRef(null)
  const modelDiagRef = useRef(100)

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
        shapeSelRef.current = { pieceId, sel: null, count: res.count }
        setShapeMeta(null)
        viewerRef.current?.setShapeHighlight(null)
        useStore.getState().setError(makeT(useStore.getState().lang)('shapeWhole'))
        return
      }
      shapeSelRef.current = { pieceId, sel: res.sel, count: res.count }
    } else {
      // Brushing: union the freshly grown region into the current selection.
      if (!shapeSelRef.current || shapeSelRef.current.pieceId !== pieceId || !shapeSelRef.current.sel) {
        shapeSelRef.current = { pieceId, sel: res.sel, count: res.count }
      } else {
        const curSel = shapeSelRef.current.sel
        let newCount = shapeSelRef.current.count
        for (let i = 0; i < res.sel.length; i++) {
          if (res.sel[i] && !curSel[i]) {
            curSel[i] = 1
            newCount++
          }
        }
        shapeSelRef.current.count = newCount
      }
    }
    useStore.getState().setError(null)
    setShapeMeta({ pieceId, count: shapeSelRef.current.count })
    viewerRef.current?.setShapeHighlight(
      regionPositions(piece.geometry, shapeSelRef.current.sel, shapeSelRef.current.count)
    )
  }

  const isDowelPiece = (p) =>
    p.name.startsWith('spinotto_') ||
    p.name.startsWith('tourillon_') ||
    p.name.startsWith('dowel_') ||
    p.name.startsWith('cavilha_')

  // Printable dowels: the HOLES carry the tolerance, the dowel itself is the
  // exact nominal diameter. One piece per size, count accumulated in its
  // name, standing on the plate beside the model, excluded from later cuts.
  function addDowelPiece(count) {
    if (!count) return
    const st = useStore.getState()
    const cp = st.cutParams
    const base = `spinotto_${cp.pinDiameter}x${cp.pinLength}`
    const existing = st.pieces.find((x) => x.name.startsWith(base))
    const prev = existing ? parseInt(existing.name.match(/_x(\d+)$/)?.[1] ?? '0', 10) : 0
    const total = prev + count
    const box = new THREE.Box3()
    st.pieces.forEach((q) => {
      if (isDowelPiece(q)) return
      if (!q.geometry.boundingBox) q.geometry.computeBoundingBox()
      box.union(q.geometry.boundingBox)
    })
    const g = new THREE.CylinderGeometry(cp.pinDiameter / 2, cp.pinDiameter / 2, cp.pinLength, 48)
    g.translate((box.isEmpty() ? 0 : box.max.x) + 15 + cp.pinDiameter, cp.pinLength / 2, 0)
    const name = `${base}_x${total}`
    if (existing) {
      useStore.getState().setPiecesBulk(
        st.pieces.map((q) => (q === existing ? { ...q, name, geometry: g } : q))
      )
    } else {
      useStore.getState().setPiecesBulk([
        ...st.pieces,
        { id: newPieceId(), name, geometry: g, visible: true }
      ])
    }
  }

  // === Puzzle tool helpers ===
  function clearPinPreview() {
    setPinPreviewOn(false)
    setPuzzlePins(null)
    viewerRef.current?.setPinPreview(null)
    viewerRef.current?.setPiecesGhost(false)
    if (viewerRef.current) viewerRef.current.puzzleEditMode = false
  }

  // World-space reservation segment for collision checks between connectors.
  function pinReservation(planeIdx, u, v, off = 0) {
    const plane = puzzlePlanesRef.current[planeIdx]
    const p = useStore.getState().cutParams
    const halfH = (p.pinLength + 2 * p.tolerance) / 2
    const q = new THREE.Quaternion(...plane.quat)
    const base = new THREE.Vector3(...plane.pos)
    const toW = (z) => new THREE.Vector3(u, v, z).applyQuaternion(q).add(base).toArray()
    return { a: toW(off - halfH), b: toW(off + halfH), r: p.pinDiameter / 2 + p.tolerance }
  }

  function pinValid2D(planeIdx, u, v) {
    const polys = puzzleSectionsRef.current[planeIdx]
    if (!polys?.length) return false
    const p = useStore.getState().cutParams
    return pinFits2D(polys, u, v, p.pinDiameter / 2 + p.tolerance + 1.5)
  }

  function collidesWithOthers(pins, selfIdx, planeIdx, u, v, off) {
    const res = pinReservation(planeIdx, u, v, off)
    return pins.some((pin, i) => {
      if (i === selfIdx) return false
      return reservationsCollide(res, pinReservation(pin.planeIdx, pin.u, pin.v, pin.off))
    })
  }

  // Compute where the puzzle's connectors will land (same engine as the
  // cut) and show them as orange ghosts through transparent pieces.
  async function onPreviewPins() {
    const st = useStore.getState()
    s.setBusy(true)
    s.setError(null)
    try {
      const box = new THREE.Box3()
      st.pieces.forEach((p) => {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      })
      const planes = puzzlePlanes(box, blockSize).map(({ axis, offset }) => {
        const pos = [0, 0, 0]
        pos[{ x: 0, y: 1, z: 2 }[axis]] = offset
        return { pos, quat: AXIS_QUATS[axis] }
      })
      puzzlePlanesRef.current = planes
      const all = []
      const sections = []
      for (const piece of st.pieces.filter((p) => p.visible)) {
        const res = await pinPreviewAsync(piece.geometry, planes, st.cutParams)
        all.push(...res.pins)
        res.sections.forEach((polys, i) => {
          sections[i] = [...(sections[i] ?? []), ...(polys ?? [])]
        })
      }
      puzzleSectionsRef.current = sections
      setPuzzlePins(all.map(({ planeIdx, u, v, off }) => ({ planeIdx, u, v, off })))
      viewerRef.current.setPiecesGhost(true)
      viewerRef.current.puzzleEditMode = true
      setPinPreviewOn(true)
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
    }
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

  // Model scale reference for click-debounce and marker sizing.
  useEffect(() => {
    modelDiagRef.current = modelBox ? modelBox.getSize(new THREE.Vector3()).length() : 100
  }, [modelBox])

  // Live preview of the freehand cut line + cutting wall.
  useEffect(() => {
    if (activeTool !== 'curved') return
    viewerRef.current?.setCurvePreview(
      curvePoints.map((cp) => cp.point),
      curveDirRef.current,
      s.cutParams.kerf
    )
  }, [curvePoints, activeTool, s.cutParams.kerf])

  // Backspace removes the last drawn point while the curved tool is active.
  useEffect(() => {
    if (activeTool !== 'curved') return
    const onKey = (e) => {
      if (e.key !== 'Backspace') return
      const el = document.activeElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()
      curveRef.current = curveRef.current.slice(0, -1)
      if (!curveRef.current.length) curveDirRef.current = null
      setCurvePoints(curveRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool])

  async function onCurveCut() {
    if (curveRef.current.length < 2 || !curveDirRef.current) return
    s.setBusy(true)
    s.setError(null)
    setBusyMsg(t('cutting'))
    try {
      const dir = curveDirRef.current
      const targets = s.pieces.filter((p) => p.visible && !isDowelPiece(p))
      let split = 0
      for (const piece of targets) {
        const parts = await curvedCutAsync(
          piece.geometry,
          curveRef.current.map((cp) => cp.point),
          dir,
          s.cutParams.kerf
        )
        if (parts.length < 2) continue
        split++
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
      if (!split) s.setError(t('curvedNoSplit'))
      else {
        curveRef.current = []
        curveDirRef.current = null
        setCurvePoints([])
      }
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      setBusyMsg(null)
      s.setBusy(false)
    }
  }

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

    // Infinite-plane mode: clicking the model snaps the cut plane onto the
    // clicked surface (position + orientation from the face normal).
    viewer.onPlanePick = (point, normal) => {
      const quat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        normal.clone().normalize()
      )
      useStore.getState().setPlane({ pos: [point.x, point.y, point.z], quat: quat.toArray() })
    }

    // Editable puzzle connectors: add on plane click, remove on marker
    // click, move by dragging — all collision-guarded.
    viewer.onPuzzlePinAdd = (planeIdx, u, v) => {
      setPuzzlePins((pins) => {
        if (!pins) return pins
        if (!pinValid2D(planeIdx, u, v)) return pins
        if (collidesWithOthers(pins, -1, planeIdx, u, v, 0)) return pins
        return [...pins, { planeIdx, u, v, off: 0 }]
      })
    }
    // Live drag constraint: the marker only follows while inside the
    // material (2D section + wall margin) and away from other connectors.
    viewer.puzzlePinValidator = (pinIdx, planeIdx, u, v) => {
      if (!pinValid2D(planeIdx, u, v)) return false
      const pins = puzzlePinsRef.current
      if (!pins) return true
      const pin = pins[pinIdx]
      return !collidesWithOthers(pins, pinIdx, planeIdx, u, v, pin?.off ?? 0)
    }
    viewer.onPuzzlePinRemove = (idx) => {
      setPuzzlePins((pins) => (pins ? pins.filter((_, i) => i !== idx) : pins))
    }
    viewer.onPuzzlePinMove = (idx, u, v) => {
      setPuzzlePins((pins) => {
        if (!pins) return pins
        const pin = pins[idx]
        if (!pin) return pins
        if (collidesWithOthers(pins, idx, pin.planeIdx, u, v, pin.off ?? 0)) return [...pins]
        return pins.map((q, i) => (i === idx ? { ...q, u, v } : q))
      })
    }

    viewer.onPinPick = (u, v) => {
      setManualPins((pins) => {
        const idx = pins.findIndex(([pu, pv]) => Math.hypot(pu - u, pv - v) < s.cutParams.pinDiameter)
        if (idx >= 0) return pins.filter((_, i) => i !== idx)
        return [...pins, [u, v]]
      })
    }

    viewer.onShapePick = (faceIdx, pieceId, isBrushing) => {
      setShapeSeed({ faceIdx, pieceId, isBrushing: !!isBrushing })
    }

    viewer.onCurvePoint = (point, camDir) => {
      if (useStore.getState().busy) return
      // Ignore near-duplicate clicks (double click, jitter) — within 0.5% of
      // the model diagonal they add nothing to the curve.
      const diag = modelDiagRef.current
      const last = curveRef.current[curveRef.current.length - 1]
      if (last && last.point.distanceTo(point) < diag * 0.005) return
      if (!curveRef.current.length) curveDirRef.current = camDir.clone()
      curveRef.current = [...curveRef.current, { point, dir: camDir.clone() }]
      setCurvePoints(curveRef.current)
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
      // BASE_URL keeps this working under GitHub Pages sub-paths.
      fetch(import.meta.env.BASE_URL + 'ratome.stl')
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
      puzzleSourceRef.current = null // a new model resets puzzle regeneration
      clearPinPreview()
      setSelectedId(1)
      setActiveTool(null)
    } catch (e) {
      console.error(e)
      s.setError(t('loadError', { name: file.name }))
    } finally {
      s.setBusy(false)
    }
  }

  // Camera refits only when a NEW model arrives, never on cuts/transforms.
  const lastModelRef = useRef(null)
  useEffect(() => {
    const refit = s.modelName !== lastModelRef.current
    lastModelRef.current = s.modelName
    viewerRef.current?.setPieces(s.pieces, s.explode, refit)
  }, [s.pieces])

  // A lone piece is always the implicit selection; a selection whose piece
  // vanished (cut, undo) falls back to the first visible piece.
  useEffect(() => {
    if (s.pieces.length === 1) {
      setSelectedId(s.pieces[0].id)
    } else if (selectedId != null && !s.pieces.some((p) => p.id === selectedId)) {
      setSelectedId(s.pieces.find((p) => p.visible)?.id ?? null)
    }
  }, [s.pieces, selectedId])

  useEffect(() => {
    viewerRef.current?.setSelected(selectedId)
  }, [selectedId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useStore.getState().redo()
        else useStore.getState().undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        useStore.getState().redo()
      } else if (e.key === 'Escape') {
        setPinPlacing((placing) => {
          if (placing) return false
          setActiveTool(null)
          setCtxMenu(null)
          return placing
        })
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
    viewerRef.current?.setPlateGizmoMode(plateGizmoMode)
  }, [plateGizmoMode])

  useEffect(() => {
    if (activeTool !== 'plane' && activeTool !== 'volume') return
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const k = e.key.toLowerCase()
      if (k !== 't' && k !== 'r' && k !== 's') return
      const mode = k === 't' ? 'translate' : k === 'r' ? 'rotate' : 'scale'
      if (activeTool === 'volume') setVolumeMode(mode)
      else if (s.planeCutMode === 'plate') setPlateGizmoMode(mode)
      else if (mode !== 'scale') setPlaneMode(mode)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTool, s.planeCutMode])

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
    // Opening the puzzle on a model smaller than the default blocks would
    // yield "1 block" and feel broken — propose sizes that actually split.
    if (activeTool === 'puzzle' && dims) {
      const est =
        Math.ceil(dims.x / Math.max(1, blockSize.x)) *
        Math.ceil(dims.y / Math.max(1, blockSize.y)) *
        Math.ceil(dims.z / Math.max(1, blockSize.z))
      if (est <= 1) {
        setBlockSizeState({
          x: Math.max(10, Math.ceil(dims.x / 2 / 5) * 5),
          y: Math.max(10, Math.ceil(dims.y / 2 / 5) * 5),
          z: Math.max(10, Math.ceil(dims.z / 2 / 5) * 5)
        })
      }
    }
    viewerRef.current?.setFaceMode(activeTool === 'face')
    viewerRef.current?.setShapeMode(activeTool === 'shape')
    viewerRef.current?.showVolume(activeTool === 'volume')
    viewerRef.current.curveMode = activeTool === 'curved'
    if (activeTool !== 'puzzle') clearPinPreview()
    if (activeTool !== 'shape') {
      clearShapeSel()
      setShapeSeed(null)
    }
    if (activeTool !== 'curved') {
      curveRef.current = []
      curveDirRef.current = null
      setCurvePoints([])
      viewerRef.current?.clearCurvePreview()
    }
  }, [activeTool])

  useEffect(() => {
    viewerRef.current?.setGizmo(activeTool === 'rotate' ? selectedId : null)
  }, [activeTool, selectedId, s.pieces])

  useEffect(() => {
    viewerRef.current?.setMoveGizmo(activeTool === 'move' ? selectedId : null)
  }, [activeTool, selectedId, s.pieces])

  // Live preview of the puzzle grid while the tool is open.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (activeTool !== 'puzzle' || !s.pieces.length) {
      viewer.setPuzzlePreview(null)
      return
    }
    const box = new THREE.Box3()
    s.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    viewer.setPuzzlePreview(puzzlePlanes(box, blockSize), box)
    return () => viewer.setPuzzlePreview(null)
  }, [activeTool, blockSize, s.pieces])

  // Render the orange markers from the editable pin list.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (!puzzlePins) {
      viewer.setPinPreview(null)
      return
    }
    const p = s.cutParams
    const pins = puzzlePins.map(({ planeIdx, u, v, off }) => {
      const plane = puzzlePlanesRef.current[planeIdx]
      const q = new THREE.Quaternion(...plane.quat)
      const center = new THREE.Vector3(u, v, off ?? 0)
        .applyQuaternion(q)
        .add(new THREE.Vector3(...plane.pos))
      return { center: center.toArray(), quat: plane.quat, plane, planeIdx }
    })
    viewer.setPinPreview(pins, p.pinDiameter, p.pinLength)
  }, [puzzlePins, s.cutParams.pinDiameter, s.cutParams.pinLength])

  useEffect(() => {
    puzzlePinsRef.current = puzzlePins
  }, [puzzlePins])

  // Make the cut visible: gently explode the pieces (real mm, scaled to the
  // model) — only when not already exploded, so the user's slider is law.
  const revealCut = () => {
    const st = useStore.getState()
    if (st.explode !== 0) return
    const box = new THREE.Box3()
    st.pieces.forEach((p) => {
      if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
      box.union(p.geometry.boundingBox)
    })
    const sz = box.isEmpty() ? 100 : box.getSize(new THREE.Vector3()).length()
    st.setExplode(Math.max(6, Math.min(60, Math.round(sz * 0.08))))
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

  // Puzzle: slice the model into printable blocks along a regular grid,
  // connectors added on every interface by the plane-cut engine.
  async function onPuzzle() {
    s.setBusy(true)
    s.setError(null)
    try {
      const box = new THREE.Box3()
      s.pieces.forEach((p) => {
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
        box.union(p.geometry.boundingBox)
      })
      const planes = puzzlePlanes(box, blockSize).map(({ axis, offset }) => {
        const pos = [0, 0, 0]
        pos[{ x: 0, y: 1, z: 2 }[axis]] = offset
        return { axis, offset, pos, quat: AXIS_QUATS[axis] }
      })
      const edited = puzzlePins
      const targets = s.pieces.filter((p) => p.visible && !isDowelPiece(p))
      let kept = s.pieces.filter((p) => !p.visible || isDowelPiece(p))
      let current = targets
      // Re-clicking Generate must REGENERATE, never re-cut the previous
      // blocks: if the targets are exactly the last generation, restart
      // from the saved source and drop the previous dowel piece.
      const src = puzzleSourceRef.current
      if (src && targets.length && targets.every((p) => src.ids?.has(p.id))) {
        current = src.pieces
        kept = kept.filter((p) => !isDowelPiece(p))
      } else {
        puzzleSourceRef.current = { pieces: targets, ids: null }
      }
      let done = 0
      let dowels = 0
      for (let planeIdx = 0; planeIdx < planes.length; planeIdx++) {
        const plane = planes[planeIdx]
        const next = []
        for (const piece of current) {
          if (!piece.geometry.boundingBox) piece.geometry.computeBoundingBox()
          const bb = piece.geometry.boundingBox
          if (plane.offset <= bb.min[plane.axis] + 0.05 || plane.offset >= bb.max[plane.axis] - 0.05) {
            next.push(piece)
            continue
          }
          const parts = await planeCutAsync(piece.geometry, plane, {
            ...s.cutParams,
            manualPins: edited
              ? edited.filter((pin) => pin.planeIdx === planeIdx).map(({ u, v }) => [u, v])
              : undefined
          })
          dowels += parts.dowelCount ?? 0
          if (parts.length < 2) next.push(piece)
          else
            parts.forEach((g) =>
              next.push({ id: newPieceId(), name: piece.name, geometry: g, visible: true })
            )
        }
        current = next
        done++
        setBusyMsg(`${done} / ${planes.length}`)
      }
      // Name blocks bottom layer first — stable reading order for assembly.
      const base = (s.modelName || 'model').replace(/\.[^.]+$/, '')
      const c = new THREE.Vector3()
      current
        .map((p) => {
          p.geometry.computeBoundingBox()
          p.geometry.boundingBox.getCenter(c)
          return { p, y: c.y, z: c.z, x: c.x }
        })
        .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
        .forEach((e, i) => {
          e.p.name = `${base}_${String(i + 1).padStart(2, '0')}`
        })
      useStore.getState().setPiecesBulk([...kept, ...current])
      puzzleSourceRef.current.ids = new Set(current.map((p) => p.id))
      addDowelPiece(dowels)
      clearPinPreview()
      revealCut()
      viewerRef.current?.fitCamera?.()
      setActiveTool(null)
    } catch (e) {
      console.error(e)
      s.setError(t('cutError'))
    } finally {
      s.setBusy(false)
      setBusyMsg(null)
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

  // shape tool live selection (must run after effRadius is declared)
  useEffect(() => {
    if (!shapeSeed) return
    runShapeSelection(shapeSeed.pieceId, shapeSeed.faceIdx, shapeSens, effRadius, shapeSeed.isBrushing)
  }, [shapeSeed, shapeSens, effRadius])

  async function onDetachShape() {
    const sh = shapeSelRef.current
    if (!sh || !sh.sel) return
    s.setBusy(true)
    s.setError(null)
    try {
      const piece = useStore.getState().pieces.find((p) => p.id === sh.pieceId)
      if (!piece) return
      const matrix = regionOrientedBox(piece.geometry, sh.sel)
      if (!matrix) throw new Error('no boundary')
      const parts = await volumeCutAsync(piece.geometry, matrix)
      if (parts.length < 2) return
      useStore.getState().replacePiece(
        piece.id,
        parts.map((g, i) => ({
          id: newPieceId(),
          name: `${piece.name.replace(/\.[^.]+$/, '')}_${i + 1}`,
          geometry: g,
          visible: true
        }))
      )
      clearShapeSel()
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

      <main className="main">
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
                        value={Math.min(
                          0.99,
                          Math.max(
                            0.01,
                            (s.plane.pos[{ x: 0, y: 1, z: 2 }[s.cutPlaneAxis] ?? 1] - axisMin) /
                              axisSpan
                          )
                        )}
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

                      {/* Gizmo mode: translate / rotate / scale (T/R/S) */}
                      {!s.plateMoveMode && (
                        <div className="axis-row" style={{ marginTop: 8 }}>
                          {[
                            ['translate', t('modeMove')],
                            ['rotate', t('modeRotate')],
                            ['scale', t('modeScale')]
                          ].map(([mode, label]) => (
                            <button
                              key={mode}
                              className={plateGizmoMode === mode ? 'active' : ''}
                              onClick={() => setPlateGizmoMode(mode)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      )}

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

            {activeTool === 'curved' && (
              <section>
                <h3>{t('curvedCut')}</h3>
                <div className="dims">{t('curvedHint')}</div>
                <div className="dims">
                  {t('curvedPoints', { n: curvePoints.length })}
                  {curvePoints.length > 0 && (
                    <>
                      {' · '}
                      <button
                        className="link"
                        disabled={s.busy || !curvePoints.length}
                        onClick={() => {
                          curveRef.current = curveRef.current.slice(0, -1)
                          if (!curveRef.current.length) curveDirRef.current = null
                          setCurvePoints(curveRef.current)
                        }}
                      >
                        {t('curvedUndo')}
                      </button>
                      {' · '}
                      <button
                        className="link"
                        disabled={s.busy || !curvePoints.length}
                        onClick={() => {
                          curveRef.current = []
                          curveDirRef.current = null
                          setCurvePoints([])
                        }}
                      >
                        {t('curvedClear')}
                      </button>
                    </>
                  )}
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
                <button
                  className="primary"
                  disabled={s.busy || curvePoints.length < 2}
                  onClick={onCurveCut}
                >
                  {s.busy ? t('cutting') : t('curvedExecute')}
                </button>
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
                <div className="dims">{t('blockSizeHint')}</div>
                {dims && (
                  <div className="dims">
                    {t('blocksEstimate', {
                      n:
                        Math.ceil(dims.x / Math.max(1, blockSize.x)) *
                        Math.ceil(dims.y / Math.max(1, blockSize.y)) *
                        Math.ceil(dims.z / Math.max(1, blockSize.z))
                    })}
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
                <button
                  className={pinPreviewOn ? 'active' : ''}
                  disabled={s.busy}
                  onClick={() => (pinPreviewOn ? clearPinPreview() : onPreviewPins())}
                >
                  {pinPreviewOn ? t('hidePins') : t('previewPins')}
                </button>
                {pinPreviewOn && (
                  <>
                    <div className="dims">{t('pinsPlaced', { n: puzzlePins?.length ?? 0 })}</div>
                    <div className="dims">{t('hintMove')}</div>
                    <div className="dims">{t('hintRemove')}</div>
                    <div className="dims">{t('hintAdd')}</div>
                  </>
                )}
                <button className="primary" disabled={s.busy} onClick={onPuzzle}>
                  {s.busy ? busyMsg || t('cutting') : t('generate')}
                </button>
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
