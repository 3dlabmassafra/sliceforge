import React, { useRef, useCallback } from 'react'

/**
 * High-precision interactive millimeter ruler slider for mesh cut positioning.
 * Inspired by Nativos3D Cortes SmartCut ruler.
 */
export function CutPositionRuler({
  value = 0.5,
  onChange,
  modelSize = 100,
  minVal = 0,
  maxVal = 100,
  axisColor = '#2f6bff',
  label = 'Posizione del taglio',
  unit = 'mm'
}) {
  const rulerRef = useRef(null)

  const handlePointer = useCallback(
    (e) => {
      if (!rulerRef.current) return
      const rect = rulerRef.current.getBoundingClientRect()
      const raw = (e.clientX - rect.left) / rect.width
      const clamped = Math.min(0.99, Math.max(0.01, raw))
      onChange(clamped)
    },
    [onChange]
  )

  const onPointerDown = useCallback(
    (e) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      handlePointer(e)
    },
    [handlePointer]
  )

  const onPointerMove = useCallback(
    (e) => {
      if (e.buttons !== 1) return
      handlePointer(e)
    },
    [handlePointer]
  )

  const effectiveSize = modelSize || 100
  const currentMm = (minVal + value * (maxVal - minVal)).toFixed(1)
  const pct = Math.round(value * 100)

  // Direct number input handling
  const handleNumericChange = (e) => {
    const num = parseFloat(e.target.value)
    if (isNaN(num)) return
    const span = maxVal - minVal
    if (span <= 0) return
    const norm = (num - minVal) / span
    onChange(Math.min(0.99, Math.max(0.01, norm)))
  }

  return (
    <div className="cut-ruler-widget select-none">
      <div className="cut-ruler-head">
        <span className="cut-ruler-label">{label}</span>
        <div className="cut-ruler-readout">
          <input
            type="number"
            step="0.5"
            value={parseFloat(currentMm)}
            onChange={handleNumericChange}
            className="cut-ruler-input"
            style={{ color: axisColor, borderColor: `${axisColor}66` }}
          />
          <span className="cut-ruler-unit" style={{ color: axisColor }}>{unit}</span>
        </div>
      </div>

      <div
        ref={rulerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        className="cut-ruler-track"
        title="Trascina per regolare la posizione del piano di taglio"
      >
        {/* 21 Graduation Ticks */}
        {Array.from({ length: 21 }).map((_, i) => {
          const ratio = i / 20
          const isMajor = i % 5 === 0
          return (
            <div
              key={i}
              className={`cut-ruler-tick ${isMajor ? 'major' : 'minor'}`}
              style={{ left: `${ratio * 100}%` }}
            />
          )
        })}

        {/* 5 Milestone MM Labels */}
        {Array.from({ length: 5 }).map((_, i) => {
          const ratio = i / 4
          const mmVal = (minVal + ratio * (maxVal - minVal)).toFixed(0)
          return (
            <span
              key={i}
              className="cut-ruler-tick-label"
              style={{ left: `${ratio * 100}%` }}
            >
              {mmVal}
            </span>
          )
        })}

        {/* Interactive glowing cursor thumb */}
        <div
          className="cut-ruler-cursor"
          style={{ left: `${value * 100}%` }}
        >
          <div
            className="cut-ruler-cursor-line"
            style={{ background: axisColor, boxShadow: `0 0 8px ${axisColor}` }}
          />
          <svg width="10" height="6" viewBox="0 0 10 6" className="cut-ruler-cursor-arrow">
            <polygon points="5,0 10,6 0,6" fill={axisColor} />
          </svg>
        </div>
      </div>

      {/* Progress percentage bar */}
      <div className="cut-ruler-footer">
        <div className="cut-ruler-bar-bg">
          <div
            className="cut-ruler-bar-fill"
            style={{ width: `${value * 100}%`, background: axisColor }}
          />
        </div>
        <span className="cut-ruler-pct">{pct}%</span>
      </div>
    </div>
  )
}
