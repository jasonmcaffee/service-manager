import { test } from '@playwright/test'

test('snapshot of UI state', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('h3', { timeout: 15000 })

  const cards = await page.locator('.card').all()
  for (const card of cards) {
    const name = (await card.locator('h3').first().textContent())?.trim()
    const status = (await card.locator('[class*="text-"]').first().textContent())?.trim()
    const classes = await card.getAttribute('class')
    const hasGlowSuccess = classes?.includes('glow-success') ? 'running' : ''
    const hasGlowError = classes?.includes('glow-error') ? 'error' : ''
    console.log(`[CARD] ${name} | glow=${hasGlowSuccess || hasGlowError || 'none'}`)
  }
  await page.screenshot({ path: 'e2e-diagnose-state.png', fullPage: true })
})
