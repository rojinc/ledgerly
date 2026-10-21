import { expect, type Page, test } from '@playwright/test'
import { createToken, runId } from './dev-project'
import { logInWithToken, setupUser } from './users'

// Deleting an account (identity-and-invites.md#deleting-an-account-m4), then #486 and #503: Fay
// is refused while Gil, who joined her house, is `active` (refusal 6), then deletes hers once he
// has moved out. With no `active` member left to hand over to, the house is archived, and Gil,
// still in its team, deletes it (#525). A house, since a pair's other side is an admin too, and
// the app can't add an employer's email for them to join with. Neither has a password, so
// neither is refused for 24 hours.

/** Opens Delete account, types DELETE and sends it, once the balances are checked. */
async function deleteAccount(page: Page) {
  await page.goto('/account/delete')
  await expect(page.getByRole('link', { name: 'export your data' })).toHaveAttribute(
    'href',
    '/export',
  )
  await expect(page.getByText('Checking your balances…')).toHaveCount(0)
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click()
}

async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible()
}

test('a deleted account is signed out for good, and the one left deletes the archived house', async ({
  page,
}) => {
  test.slow()
  const fay = setupUser('fay')
  const gil = setupUser('gil')
  const name = `House of fay ${runId()}`

  // Fay makes a house and adds Gil by his address.
  await logInWithToken(page, fay)
  await page.goto('/groups/new-house')
  await page.getByLabel('House name').fill(name)
  await page.getByRole('button', { name: 'Create house', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  const house = new URL(page.url()).pathname
  const add = page.getByRole('region', { name: 'Add a housemate' })
  await add.getByLabel('Name', { exact: true }).fill(gil.name)
  await add.getByLabel('Email (optional)', { exact: true }).fill(gil.email)
  await add.getByRole('button', { name: 'Add housemate', exact: true }).click()
  await expect(page.getByRole('listitem').filter({ hasText: gil.name })).toBeVisible()
  await logOut(page)

  // Gil signs in: Fay's placeholder for him is merged into him, and he joins the house.
  await logInWithToken(page, gil)
  await expect(page.getByText('We found 1 group you were added to.')).toBeVisible()
  await page.goto(house)
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await logOut(page)

  // While Gil is `active`, Fay, its only admin, is refused, naming the house: she hands over
  // first (refusal 6), and nothing changes.
  await logInWithToken(page, fay)
  await deleteAccount(page)
  await expect(page.getByRole('alert')).toContainText(name)
  await expect(page.getByRole('heading', { level: 1, name: 'Delete your account' })).toBeVisible()
  // Nothing changed: the house isn't archived, and Fay is still its admin.
  await page.goto(house)
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Archive group', exact: true })).toBeVisible()
  await expect(page.getByText(/^This group is archived\./)).toHaveCount(0)

  // Fay marks Gil as moved out: he keeps seeing the house, as a viewer who isn't `active`.
  await page
    .getByRole('listitem')
    .filter({ hasText: gil.name })
    .getByRole('button', { name: 'Moved out', exact: true })
    .click()
  await page.getByRole('button', { name: 'Mark as moved out', exact: true }).click()
  await expect(
    page.getByRole('listitem').filter({ hasText: gil.name }).getByRole('button', {
      name: 'Moved back in',
    }),
  ).toBeVisible()

  // Now nobody `active` could take over, so Fay's account goes. Its steps must finish in the
  // call: the hourly job can't be waited for.
  await deleteAccount(page)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your account was deleted' }),
  ).toBeVisible()
  await expect(
    page.getByText('Everything listed is gone.'),
    'the deletion finishes in the call, or the rest of this flow waits on the hourly job',
  ).toBeVisible()

  // Signed out for good: the app asks for a sign-in, and there's no user left to sign in as.
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: 'Log in' })).toBeVisible()
  await expect(createToken(fay.id)).rejects.toMatchObject({ status: 404 })

  // Gil finds the house archived, with nobody left as its admin, and deletes it (#486).
  await logInWithToken(page, gil)
  await page.goto(house)
  await expect(page.getByText(/^This group is archived\./)).toBeVisible()
  await expect(
    page.getByText('This group has no admin any more, so you can delete it.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^Unarchive/ })).toHaveCount(0)
  await page.getByRole('link', { name: 'Delete group', exact: true }).click()
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByRole('button', { name: 'Delete group', exact: true }).click()
  await page.waitForURL('/groups')
  await expect(page.getByText(`Deleted ${name}.`)).toBeVisible()
  await expect(page.getByRole('link', { name })).toHaveCount(0)
})
