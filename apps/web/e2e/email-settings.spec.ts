import { expect, test } from '@playwright/test'
import { testName } from './dev-project'
import { logIn, setupUser } from './users'

// Email settings on Profile (#431, F-06): ticked means on, and what's saved stays after a reload.
// So do the profile's own fields (F-03) and the summary email's frequency (F-80, #555).

test('an email turned off stays off after a reload, and turned on again stays on', async ({
  page,
}) => {
  await logIn(page, setupUser('eve'))
  await page.goto('/profile')
  // Profile links both legal pages too (#566).
  await expect(page.getByRole('link', { name: 'Privacy policy', exact: true })).toHaveAttribute(
    'href',
    '/privacy',
  )
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

test('the profile’s name, region, currency and summary email stay as saved after a reload', async ({
  page,
}) => {
  await logIn(page, setupUser('eve'))
  await page.goto('/profile')
  const form = page.locator('form').filter({ has: page.getByLabel('Summary email') })
  // The name is her person's, which the profile writes too (PATCH /profile).
  const name = testName('Evie')
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Public holiday region').fill('AU-VIC')
  await form.getByLabel('Currency').fill('nzd')
  await form.getByLabel('Summary email').selectOption('Weekly')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form.getByText('Saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name)
  await expect(page.getByLabel('Public holiday region')).toHaveValue('AU-VIC')
  await expect(page.getByLabel('Currency')).toHaveValue('NZD')
  await expect(page.getByLabel('Summary email')).toHaveValue('weekly')
})
