/**
 * What a form that adds someone says about linking them when they sign up
 * (identity-and-invites.md#adding-someone-to-a-group). Someone new keeps one key, the email if
 * both are given, so with both it says the email comes first. It goes by what was typed only,
 * never by whether anyone was found, so it shows nobody who uses Ledgerly.
 */
export function linkHint(email: string, phone: string, place: { linked: string; seen: string }) {
  const hasEmail = email.trim() !== ''
  const hasPhone = phone.trim() !== ''
  if (!hasEmail && !hasPhone) {
    return `Without an email or mobile number, they can’t be linked to ${place.linked} if they sign up later.`
  }
  if (!hasPhone) return `Once they join with this email, they’ll see ${place.seen}.`
  if (!hasEmail) return `Once they join with this number, they’ll see ${place.seen}.`
  return `Once they join, they’ll see ${place.seen}. The email comes first: the number only finds someone it already belongs to, and isn’t saved.`
}
