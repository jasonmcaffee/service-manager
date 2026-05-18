/**
 * Regression test for "page refresh feel" on edit/start.
 * Only the card we click should mutate beyond the steady output stream.
 */
import { test, expect } from '@playwright/test'

test('starting a service should only mutate that service\'s card', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('h3', { timeout: 15000 })
  await page.waitForTimeout(2000)

  await page.evaluate(() => {
    const w = window as any
    w.__mutTally = { byCard: {} as Record<string, number> }
    const ob = new MutationObserver(muts => {
      for (const m of muts) {
        const node = (m.target instanceof Element ? m.target : m.target.parentElement)
        if (!node) continue
        const card = node.closest('.card') as HTMLElement | null
        if (!card) continue
        const term = node.closest('.terminal-output')
        const name = card.querySelector('h3')?.textContent?.trim() ?? '<?>'
        const where = term ? 'terminal' : 'other'
        const key = `${name}/${where}`
        w.__mutTally.byCard[key] = (w.__mutTally.byCard[key] ?? 0) + 1
      }
    })
    ob.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  })

  await page.waitForTimeout(5000)
  const baseline = await page.evaluate(() => ({ ...(window as any).__mutTally.byCard }))
  await page.evaluate(() => { (window as any).__mutTally.byCard = {} })

  // Stop Job Apply first if it's already running, then start
  const targetName = 'Job Apply'
  const card = page.locator('.card', { has: page.locator('h3', { hasText: targetName }) })
  const stopBtn = card.locator('button[title="Stop service"]')
  if (await stopBtn.count() > 0) {
    await stopBtn.click()
    await page.waitForTimeout(2000)
  }
  await card.locator('button[title="Start service"]').click()
  await page.waitForTimeout(5000)
  const after = await page.evaluate(() => ({ ...(window as any).__mutTally.byCard }))

  console.log('[BASELINE 5s]', JSON.stringify(baseline, null, 2))
  console.log('[AFTER START 5s]', JSON.stringify(after, null, 2))

  // Build a set of "noisy" cards from baseline so we exclude cards whose terminals
  // already mutate heavily on their own (e.g. Proxy with HUGE log volume).
  const noisyCards = new Set(
    Object.entries(baseline)
      .filter(([, n]) => (n as number) > 100)
      .map(([k]) => k.split('/')[0])
  )
  noisyCards.add(targetName)

  // Cards that are NOT in the noisy set and NOT the target should have
  // very low mutation counts (some allowance for the surrounding modal/click).
  const churn: Record<string, number> = {}
  for (const [key, n] of Object.entries(after)) {
    const name = key.split('/')[0]
    if (noisyCards.has(name)) continue
    if ((n as number) > 50) churn[key] = n as number
  }
  console.log('[CHURN — unrelated cards mutating heavily]', JSON.stringify(churn, null, 2))
  expect(Object.keys(churn), `Unexpected unrelated card churn: ${JSON.stringify(churn)}`).toHaveLength(0)

  // Cleanup
  await stopBtn.click().catch(() => {})
})
