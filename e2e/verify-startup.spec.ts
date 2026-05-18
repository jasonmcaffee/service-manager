/**
 * Post-restart verification: open the UI cold, wait for it to settle, then
 * dump per-service status. Used to confirm that vllm shows running after a
 * service-manager restart (its WSL process survives the restart).
 */
import { test } from '@playwright/test'

test('snapshot UI after restart', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('h3', { timeout: 30000 })
  // Wait a bit for autostart + adoption to finish
  await page.waitForTimeout(8000)

  const cards = await page.locator('.card').all()
  for (const card of cards) {
    const name = (await card.locator('h3').first().textContent())?.trim()
    const classes = await card.getAttribute('class') ?? ''
    const status = classes.includes('glow-success') ? 'running'
      : classes.includes('glow-error') ? 'error'
      : 'stopped/other'
    // try to read terminal first-line / "No output" indicator
    const term = await card.locator('.terminal-output').first().textContent()
    const termPreview = (term ?? '').trim().slice(0, 60)
    console.log(`[CARD] ${name?.padEnd(28)} | ${status.padEnd(12)} | term=${JSON.stringify(termPreview)}`)
  }
})
