import { expect, type Page, test } from '@playwright/test'
import { testName } from './dev-project'
import { archiveGroup } from './groups'
import { addHouse, addHousemate, expectLines } from './house'
import { logIn, setupUser } from './users'

// User flow 7 (docs/product/user-flows.md#7-itemised-grocery-receipt): an itemised receipt with
// one item for Bob only and a discount, its photo, and an edit. The amounts aren't the doc's:
// each shared item here splits three ways to the cent, since a leftover cent goes by person ID
// (ledger.md#allocation-and-rounding), which is random in a run.
// A 1×1 PNG, made here rather than committed: the app scales and re-encodes it before upload.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Fills item `number` of the open form, for everyone ticked unless `onlyFor` names one. */
async function fillItem(
  page: Page,
  number: number,
  item: { name: string; amount: string; discount?: boolean; onlyFor?: string },
): Promise<void> {
  await page.getByLabel(`Item ${number} name`).fill(item.name)
  await page.getByLabel(`Item ${number} amount (AUD)`).fill(item.amount)
  if (item.discount) await page.getByLabel(`Item ${number} is a discount`).check()
  if (item.onlyFor) {
    const who = page.getByRole('group', { name: `Who item ${number} is for`, exact: true })
    for (const box of await who.getByRole('checkbox').all()) await box.uncheck()
    await who.getByRole('checkbox', { name: item.onlyFor, exact: true }).check()
  }
}

/**
 * The transaction's four items, with the beer at `beer` and for Bob only. The shared items' "for
 * …" lists names in person-ID order, which is random in a run, so those aren't read.
 */
async function expectItems(page: Page, beer: string): Promise<void> {
  const items = page.getByRole('region', { name: 'Items', exact: true }).getByRole('listitem')
  await expect(items).toHaveCount(4)
  await expect(items.filter({ hasText: 'Beer' })).toHaveText(
    `Beer: ${beer}, for ${testName('Bob')}`,
  )
  await expect(items.filter({ hasText: 'Member discount' })).toContainText('$0.60')
}

// The house this test adds, archived after it even when it fails. Its receipt file goes when
// the run's users are deleted: nobody else is in its team, so Gus's deletion purges the house,
// receipts included (identity-and-invites.md#purging-a-group).
let groupId: string | undefined
test.afterEach(async ({ page }) => {
  if (groupId) await archiveGroup(page, `/groups/${groupId}`)
})

test('adds an itemised receipt with a photo, then changes an item', async ({ page }) => {
  const gus = setupUser('gus')
  const [bob, cara] = [testName('Bob'), testName('Cara')]
  await logIn(page, gus)
  groupId = await addHouse(page, testName('Birch Road'), 'Equally')
  await addHousemate(page, bob)
  await addHousemate(page, cara)

  const expenseId = await test.step('four items, one for Bob only', async () => {
    await page.goto(`/transactions/new?groupId=${groupId}`)
    await page.getByLabel('Itemise this receipt').check()
    await page.getByLabel('Description', { exact: true }).fill('Groceries')
    await fillItem(page, 1, { name: 'Milk', amount: '4.50' })
    for (const [number, item] of [
      [2, { name: 'Bread', amount: '5.10' }],
      [3, { name: 'Beer', amount: '20.00', onlyFor: bob }],
      [4, { name: 'Member discount', amount: '0.60', discount: true }],
    ] as const) {
      await page.getByRole('button', { name: 'Add item', exact: true }).click()
      await fillItem(page, number, item)
    }
    await expect(page.getByText('Total: $29.00', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: 'Groceries', exact: true }),
    ).toBeVisible()
    return new URL(page.url()).pathname.split('/').at(-1) as string
  })

  await test.step('Bob pays for the beer, and a third of the rest', async () => {
    // Milk $1.50, bread $1.70 and the discount −$0.20 each: $3.00 a head, and Bob's $20 beer.
    await expectLines(
      page.getByRole('region', { name: 'Who paid, and who it was for', exact: true }),
      [
        `${gus.name}: paid $29.00, for them $3.00`,
        `${bob}: for them $23.00`,
        `${cara}: for them $3.00`,
      ],
    )
    await expectItems(page, '$20.00')
  })

  await test.step('attaches a photo of the receipt', async () => {
    await page
      .getByLabel('Add a receipt (photo or PDF)')
      .setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG })
    await expect(page.getByRole('img', { name: 'Receipt 1 of 1', exact: true })).toBeVisible()
  })

  await test.step('the beer was $26', async () => {
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Item 3 amount (AUD)').fill('26.00')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expectLines(
      page.getByRole('region', { name: 'Who paid, and who it was for', exact: true }),
      [
        `${gus.name}: paid $35.00, for them $3.00`,
        `${bob}: for them $29.00`,
        `${cara}: for them $3.00`,
      ],
    )
    // Still itemised, with the new beer.
    await expectItems(page, '$26.00')
    // The photo stays with it.
    await page.goto(`/transactions/${expenseId}`)
    await expect(page.getByRole('img', { name: 'Receipt 1 of 1', exact: true })).toBeVisible()
  })
})
