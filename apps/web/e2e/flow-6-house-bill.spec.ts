import { expect, test } from '@playwright/test'
import { testName } from './dev-project'
import { archiveGroup } from './groups'
import { addHouse, addHousemate, changeMyMoveIn, expectLines } from './house'
import { logIn, setupUser } from './users'

// User flow 6 (docs/product/user-flows.md#6-house-bill): a $270 electricity bill split by the
// days each housemate lived there. The doc's example: Cara moved in a month into the 92-day
// period, so Cara pays for 61 days, and the cents never depend on random IDs (core's
// examples.test.ts pins the same split). The dates are fixed, so every run splits it alike.

// The house this test adds, archived after it even when it fails.
let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveGroup(page, `/groups/${groupId}`)
})

test('splits a bill by days present, then marks it paid', async ({ page }) => {
  const ida = setupUser('ida')
  const [bob, cara] = [testName('Bob'), testName('Cara')]
  await logIn(page, ida)
  groupId = await addHouse(page, testName('Elm Street'), 'By days each person lived here')

  await test.step('Ida and Bob from June, Cara from August', async () => {
    // The house was made today, so Ida's own move-in is today until it's changed.
    await changeMyMoveIn(page, '2026-06-01')
    await addHousemate(page, bob, '2026-06-01')
    await addHousemate(page, cara, '2026-08-01')
  })

  const billId = await test.step('a $270 bill for July to September', async () => {
    await page.goto(`/bills/new?groupId=${groupId}`)
    await page.getByLabel('Description', { exact: true }).fill('Electricity')
    await page.getByLabel('Amount (AUD)').fill('270')
    await page.getByLabel('Period starts').fill('2026-07-01')
    await page.getByLabel('Period ends').fill('2026-09-30')
    await page.getByLabel('Due date').fill('2026-10-15')
    await expect(page.getByRole('radio', { name: 'Everyone, by days present' })).toBeChecked()
    // 92, 92 and 61 days of 245: $101.39, $101.39 and $67.22, which make $270.00.
    await expectLines(page.getByRole('region', { name: 'Each person’s part', exact: true }), [
      `${ida.name}: 92 days, $101.39`,
      `${bob}: 92 days, $101.39`,
      `${cara}: 61 days, $67.22`,
    ])
    await page.getByRole('button', { name: 'Add bill', exact: true }).click()
    await page.waitForURL(/\/bills\/[^/]+$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Electricity' })).toBeVisible()
    return new URL(page.url()).pathname.split('/').at(-1) as string
  })

  await test.step('Ida pays it on 10 October', async () => {
    await page.getByLabel('Paid on').fill('2026-10-10')
    await page.getByLabel('Paid by').selectOption({ label: ida.name })
    await page.getByRole('button', { name: 'Mark paid', exact: true }).click()
    await expect(page.getByText('Marked paid.', { exact: true })).toBeVisible()
    await expect(page.getByText('Paid 10 Oct 2026.', { exact: true })).toBeVisible()
  })

  await test.step('the shares are the same three parts', async () => {
    await page.goto(`/transactions/${billId}`)
    await expectLines(
      page.getByRole('region', { name: 'Who paid, and who it was for', exact: true }),
      [
        `${ida.name}: paid $270.00, for them $101.39`,
        `${bob}: for them $101.39`,
        `${cara}: for them $67.22`,
      ],
    )
  })
})
