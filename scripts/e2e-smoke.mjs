// Headless E2E smoke test against the dev server (or a static preview).
// Usage: node scripts/e2e-smoke.mjs [baseUrl]
import { chromium } from 'playwright'

const BASE = process.argv[2] || 'http://localhost:5173/'
const results = []
const check = (name, ok, info = '') => {
  results.push({ name, ok, info })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ locale: 'it-IT' })
const page = await ctx.newPage()

const consoleErrors = []
const pageErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => pageErrors.push(String(e)))

const countPieces = () => page.locator('.piece-item').count()
const waitNotBusy = (timeout = 180000) =>
  page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout })

try {
  const t0 = Date.now()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // default Ratome model auto-loads
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()
  check('load default model (Ratome)', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // --- plane cut ---
  await page.locator('.viewport-toolbar button').first().click() // plane tool
  await page.locator('.cut-btn-execute').click()
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 2,
    null,
    { timeout: 120000 }
  )
  await waitNotBusy()
  const n2 = await countPieces()
  check('plane cut returns 2 pieces', n2 === 2)

  // --- reload, freehand curved cut ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()

  await page.locator('.viewport-toolbar button[title="Taglio curvo a mano libera"]').click()
  // Draw a gentle S down the model's middle band (the model occupies the
  // central third of the viewport horizontally).
  const canvas = page.locator('canvas')
  const cbox = await canvas.boundingBox()
  const row = [
    [0.48, 0.42],
    [0.52, 0.48],
    [0.47, 0.55],
    [0.52, 0.62]
  ]
  for (const [fx, fy] of row) {
    await page.mouse.click(cbox.x + cbox.width * fx, cbox.y + cbox.height * fy)
    await page.waitForTimeout(120)
  }
  const ptsTxt = await page.locator('.dims', { hasText: 'Punti:' }).first().textContent()
  const nPts = parseInt(ptsTxt.replace(/\D+/g, ''), 10)
  check('curved line points collected', nPts >= 2, `${nPts} points`)
  const curveBtn = page.locator('button.primary', { hasText: 'Esegui taglio curvo' })
  await curveBtn.click()
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 2,
    null,
    { timeout: 180000 }
  )
  await waitNotBusy(180000)
  const nCv = await countPieces()
  check('curved cut returns 2 pieces', nCv === 2)

  // --- reload, puzzle flow ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()

  await page.locator('.viewport-toolbar button[title="Puzzle a blocchi"]').click()
  // connector preview
  const previewBtn = page.getByRole('button', { name: 'Mostra connettori' })
  if (await previewBtn.count()) {
    await previewBtn.click()
    await waitNotBusy(120000)
    const pinsInfo = await page.locator('.puzzle-panel .dims, .dims').first().textContent().catch(() => '')
    check('puzzle connector preview renders', true, pinsInfo.trim().slice(0, 40))
  }
  // generate the puzzle
  const genBtn = page.locator('.puzzle-panel button.primary, button.primary', {
    hasText: 'Genera puzzle',
  }).first()
  await genBtn.click()
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length > 1,
    null,
    { timeout: 240000 }
  )
  await waitNotBusy(240000)
  const nPz = await countPieces()
  check('puzzle generates multiple pieces', nPz > 1, `${nPz} pieces`)

  // --- reload, draft mode: plan two plane cuts, disable one, build ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()

  // enter draft mode from the header toggle
  await page.locator('header .draft-toggle').click()
  const draftPanel = page.locator('.draft-panel')
  check('draft panel opens', (await draftPanel.count()) === 1)

  // plan cut #1: plane (default position, through the middle)
  await page.locator('.viewport-toolbar button').first().click() // plane tool
  await page.locator('.cut-btn-execute').click()
  await page.waitForTimeout(200)
  check('pieces untouched while drafting', (await countPieces()) === 1)

  // plan cut #2: freehand curved cut
  await page.locator('.viewport-toolbar button[title="Taglio curvo a mano libera"]').click()
  const cbox2 = await canvas.boundingBox()
  for (const [fx, fy] of [
    [0.48, 0.42],
    [0.52, 0.48],
    [0.47, 0.55],
    [0.52, 0.62]
  ]) {
    await page.mouse.click(cbox2.x + cbox2.width * fx, cbox2.y + cbox2.height * fy)
    await page.waitForTimeout(120)
  }
  await page.locator('button.primary', { hasText: 'Aggiungi al piano' }).click()
  await page.waitForTimeout(300)
  const entries = await page.locator('.draft-entry').count()
  check('draft collects 2 planned cuts', entries === 2, `${entries} entries`)

  // disable the curved entry, build: expect 2 pieces from the plane cut only
  await page.locator('.draft-entry').nth(1).locator('input[type="checkbox"]').click()
  await page.locator('.draft-panel button.primary').click()
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 2,
    null,
    { timeout: 180000 }
  )
  await waitNotBusy(180000)
  const nDraft = await countPieces()
  check('draft build applies enabled cuts only', nDraft === 2, `${nDraft} pieces`)
  check('draft mode exits after build', (await draftPanel.count()) === 0)

  // --- reload, smart cut: analyze the model, plan, build ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()

  await page.locator('.viewport-toolbar button[title="Taglio intelligente"]').click()
  await page.locator('button.primary', { hasText: 'Analizza' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.smart-entry').length >= 1,
    null,
    { timeout: 240000 }
  )
  await waitNotBusy(240000)
  const nSmart = await page.locator('.smart-entry').count()
  check('smart cut finds natural parting lines', nSmart >= 1, `${nSmart} candidates`)

  await page.locator('button.primary', { hasText: 'tagli al piano' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.draft-entry').length >= 1,
    null,
    { timeout: 30000 }
  )
  const nPlan = await page.locator('.draft-entry').count()
  check('smart cuts land in the draft plan', nPlan === nSmart, `${nPlan} entries`)

  await page.locator('.draft-panel button.primary').click()
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length >= 3,
    null,
    { timeout: 300000 }
  )
  await waitNotBusy(300000)
  check('smart draft build splits the model', (await countPieces()) >= 3)

  // --- reload, shape brush: paint-on-drag, sticky selection, Alt orbit ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()

  await page.locator('.viewport-toolbar button[title="Taglio per Forma"]').click()
  const cnv = page.locator('canvas')
  const cb = await cnv.boundingBox()
  const selCount = async () => {
    const txt = await page
      .locator('.dims', { hasText: 'triangoli selezionati' })
      .first()
      .textContent()
      .catch(() => '')
    return parseInt(txt.replace(/\D+/g, ''), 10) || 0
  }

  // 1. just MOVING over the model must not paint anything
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(
      cb.x + cb.width * (0.45 + 0.02 * i),
      cb.y + cb.height * (0.45 + 0.015 * i)
    )
    await page.waitForTimeout(60)
  }
  check('shape: hover does not paint', (await selCount()) === 0)

  // 2. dragging over the model paints, and the selection survives release
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.45)
  await page.mouse.down()
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(
      cb.x + cb.width * (0.46 + 0.018 * i),
      cb.y + cb.height * (0.46 + 0.015 * i),
      { steps: 2 }
    )
    await page.waitForTimeout(80)
  }
  await page.mouse.up()
  await page.waitForTimeout(300)
  const painted = await selCount()
  check('shape: drag paints a selection', painted > 0, `${painted} triangles`)
  check('shape: selection stays after release', (await selCount()) === painted)

  // 3. Alt+drag orbits without adding anything
  await page.keyboard.down('Alt')
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.5)
  await page.mouse.down()
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(cb.x + cb.width * (0.4 + 0.04 * i), cb.y + cb.height * 0.5, { steps: 2 })
    await page.waitForTimeout(60)
  }
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.waitForTimeout(300)
  check('shape: Alt-drag does not paint', (await selCount()) === painted)

  // 4. subtract mode erases from the selection
  await page.locator('button', { hasText: '− Sottrai' }).click()
  await page.mouse.move(cb.x + cb.width * 0.5, cb.y + cb.height * 0.48)
  await page.mouse.down()
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(
      cb.x + cb.width * (0.47 + 0.02 * i),
      cb.y + cb.height * (0.47 + 0.015 * i),
      { steps: 2 }
    )
    await page.waitForTimeout(80)
  }
  await page.mouse.up()
  await page.waitForTimeout(300)
  const afterSub = await selCount()
  check('shape: subtract erases the over-paint', afterSub < painted, `${painted} -> ${afterSub}`)

  // --- multi-object 3MF imports as separate pieces (split3mf-style) ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()
  await page.setInputFiles('input[type="file"]', 'scripts/fixtures/two-parts.3mf')
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 2,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()
  check('multi-object 3MF imports as 2 pieces', (await countPieces()) === 2)

  // --- 2-body STL + "Separa in pezzi" (split3mf equivalent for STLs) ---
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()
  await page.setInputFiles('input[type="file"]', 'scripts/fixtures/two-shells.stl')
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 1,
    null,
    { timeout: 60000 }
  )
  await waitNotBusy()
  await page.locator('button', { hasText: 'Separa in pezzi' }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('.piece-item').length === 2,
    null,
    { timeout: 120000 }
  )
  await waitNotBusy()
  check('split separates a 2-body STL into pieces', (await countPieces()) === 2)

  // no runtime errors anywhere
  const errorBox = await page.locator('.error').count()
  check('no in-app error banner', errorBox === 0)
  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ').slice(0, 200)
  )
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 200))
} catch (e) {
  check('E2E flow completed', false, String(e).slice(0, 300))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} FAILURE(S)` : '\nE2E OK — all green')
process.exit(failed ? 1 : 0)
