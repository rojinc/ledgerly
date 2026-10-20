import { z } from 'zod'
import { MAX_PEOPLE_PER_TRANSACTION } from '../constants/limits'
import { checkPersonIdOrder, idSchema } from './common'

// A net is given − received over a person's shares (`netsFromShares`). An adjustment's shares can
// mix signs, so only a safe integer bounds it, as in `balancesPeopleSchema`.
const netsSchema = z
  .array(z.strictObject({ personId: idSchema, netCents: z.int() }))
  .max(MAX_PEOPLE_PER_TRANSACTION)
  .superRefine(checkPersonIdOrder)

/**
 * `changesJson.nets` on the activity row `PATCH` or `/void` writes for a posted transaction:
 * everyone's net in it before and after the change (data-model.md#activity). Scheduler step 3b
 * reads it to email the people whose part changed.
 */
export const changeNetsSchema = z.strictObject({ before: netsSchema, after: netsSchema })

export type ChangeNets = z.infer<typeof changeNetsSchema>
