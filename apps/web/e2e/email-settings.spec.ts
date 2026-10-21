import { expect, test } from '@playwright/test'
import { logIn, setupUser } from './users'

// Email settings on Profile (#431, F-06): ticked means on, and what's saved stays after a reload.

test('an email turned off stays off after a reload, and turned on again stays on', async ({
  page,
}) => {
  await logIn(page, setupUser('eve'))
  await page.goto('/profile')
  const ready = page.getByRole('checkbox', { name: /^Statement ready/ })
  await expect(ready).toBeChecked()
  for (const on of [false, true]) {
    await ready.setChecked(on)
    await page.getByRole('button', { name: 'Save email settings', exact: true }).click()
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('checkbox', { name: /^Statement ready/ })).toBeChecked({
      checked: on,
    })
  }
})
