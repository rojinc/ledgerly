// identity-and-invites.md#first-login-bootstrap: a new profile's holiday region and currency
// come from the browser's time zone. Australian zones map to their state; any other zone gets
// AU-NSW and AUD, which the user can change in their profile.
const REGIONS: Record<string, string> = {
  'Australia/Sydney': 'AU-NSW',
  'Australia/Broken_Hill': 'AU-NSW', // in NSW, on South Australian time
  'Australia/Lord_Howe': 'AU-NSW',
  'Australia/Canberra': 'AU-ACT',
  'Australia/Melbourne': 'AU-VIC',
  'Australia/Brisbane': 'AU-QLD',
  'Australia/Lindeman': 'AU-QLD',
  'Australia/Adelaide': 'AU-SA',
  'Australia/Perth': 'AU-WA',
  'Australia/Eucla': 'AU-WA',
  'Australia/Hobart': 'AU-TAS',
  'Australia/Darwin': 'AU-NT',
}

/** The holiday region and currency a new profile starts with. */
export function profileDefaults(timeZone: string): { region: string; currency: string } {
  const region = Object.hasOwn(REGIONS, timeZone) ? REGIONS[timeZone] : undefined
  return { region: region ?? 'AU-NSW', currency: 'AUD' }
}
