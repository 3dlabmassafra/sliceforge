import React from 'react'

// Inline SVG icons — stroke-based, inherit the button's text color.
const base = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
}

export const IconCut = () => (
  <svg {...base}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <line x1="8.2" y1="8.2" x2="20" y2="20" />
    <line x1="8.2" y1="15.8" x2="20" y2="4" />
  </svg>
)

export const IconBox = () => (
  <svg {...base}>
    <path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" />
    <path d="M3 7l9 4.5L21 7" />
    <line x1="12" y1="11.5" x2="12" y2="21.5" />
  </svg>
)

export const IconCurve = () => (
  <svg {...base}>
    <path d="M2.5 12c3.5-7 6.5-7 9.5 0s6 7 9.5 0" />
    <circle cx="2.5" cy="12" r="1.6" />
    <circle cx="21.5" cy="12" r="1.6" />
  </svg>
)

export const IconMove = () => (
  <svg {...base}>
    <line x1="12" y1="3.5" x2="12" y2="20.5" />
    <line x1="3.5" y1="12" x2="20.5" y2="12" />
    <polyline points="9.2 6 12 3.2 14.8 6" />
    <polyline points="9.2 18 12 20.8 14.8 18" />
    <polyline points="6 9.2 3.2 12 6 14.8" />
    <polyline points="18 9.2 20.8 12 18 14.8" />
  </svg>
)

export const IconReset = () => (
  <svg {...base}>
    <path d="M3 12a9 9 0 1 0 2.9-6.6" />
    <polyline points="3 2.5 3 8.5 9 8.5" />
  </svg>
)

export const IconRotate = () => (
  <svg {...base}>
    <path d="M21 12a9 9 0 1 1-2.9-6.6" />
    <polyline points="21 2.5 21 8.5 15 8.5" />
  </svg>
)

export const IconFaceDown = () => (
  <svg {...base}>
    <line x1="3" y1="20.5" x2="21" y2="20.5" />
    <line x1="12" y1="3.5" x2="12" y2="14.5" />
    <polyline points="7.5 10.5 12 15 16.5 10.5" />
  </svg>
)

export const IconGrid = () => (
  <svg {...base}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
  </svg>
)

export const IconWand = () => (
  <svg {...base}>
    <line x1="4" y1="20" x2="14" y2="10" />
    <path d="M16.5 3.5 17.6 6.4 20.5 7.5 17.6 8.6 16.5 11.5 15.4 8.6 12.5 7.5 15.4 6.4Z" />
    <line x1="5" y1="5" x2="5" y2="8" />
    <line x1="3.5" y1="6.5" x2="6.5" y2="6.5" />
  </svg>
)

export const IconLogo = () => (
  <svg {...base} width={18} height={18}>
    <path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" />
    <line x1="3.5" y1="16.5" x2="20.5" y2="7.5" />
  </svg>
)

export const IconPlane = () => (
  <svg {...base}>
    <polygon points="3,6 21,3 18,18 3,21" />
    <line x1="3" y1="6" x2="18" y2="18" />
  </svg>
)

export const IconPlate = () => (
  <svg {...base}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="12" y1="5" x2="12" y2="19" />
  </svg>
)

export const IconFlip = () => (
  <svg {...base}>
    <path d="m3 7 4-4 4 4" />
    <path d="M7 3v10a4 4 0 0 0 4 4h10" />
    <path d="m21 17-4 4-4-4" />
  </svg>
)

export const IconGrip = () => (
  <svg {...base} width={12} height={12}>
    <circle cx="8" cy="5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="16" cy="5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="8" cy="19" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="16" cy="19" r="1.5" fill="currentColor" stroke="none" />
  </svg>
)

export const IconMinimize = () => (
  <svg {...base} width={12} height={12}>
    <line x1="4" y1="12" x2="20" y2="12" />
  </svg>
)

export const IconMaximize = () => (
  <svg {...base} width={12} height={12}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
)
