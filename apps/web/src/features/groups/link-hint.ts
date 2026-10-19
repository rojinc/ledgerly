/**
 * What a form that adds someone says about linking them when they sign up
 * (identity-and-invites.md#adding-someone-to-a-group). Only one key is used: the email, unless
 * only the number finds someone, and the other isn't saved. It goes by what was typed only,
 * never by whether anyone was found, so it shows nobody who uses Ledgerly.
 */
export function linkHint(
  email: string,
  phone: string,
  place: { linked: string; seen: string },
): string {
  const hasEmail = email.trim() !== ''
  const hasPhone = phone.trim() !== ''
  if (!hasEmail && !hasPhone) {
    return `Without an email or mobile number, they can’t be linked to ${place.linked} if they sign up later.`
  }
  if (!hasPhone) return `Once they join with this email, they’ll see ${place.seen}.`
  if (!hasEmail) return `Once they join with this number, they’ll see ${place.seen}.`
  return `Once they join, they’ll see ${place.seen}. Only one of them is used: the email, unless only the number already belongs to someone. The other isn’t saved.`
}
