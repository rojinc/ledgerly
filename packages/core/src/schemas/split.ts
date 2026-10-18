import { z } from 'zod'
import { MAX_WEIGHT } from '../constants/limits'
import { centsSchema, idSchema, peopleList } from './common'

const FULL_BASIS_POINTS = 10_000

// ledger.md#splits. Whether `exact` amounts add up to the amount being split is
// checked by buildShares(), which knows that amount.
export const splitSpecSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('equal'), personIds: peopleList(idSchema, (id) => id) }),
  z.strictObject({
    mode: z.literal('exact'),
    amounts: peopleList(
      z.strictObject({ personId: idSchema, cents: centsSchema }),
      (entry) => entry.personId,
    ),
  }),
  z.strictObject({
    mode: z.literal('percent'),
    percents: peopleList(
      z.strictObject({ personId: idSchema, basisPoints: z.int().min(0).max(FULL_BASIS_POINTS) }),
      (entry) => entry.personId,
    ).refine(
      (percents) =>
        percents.reduce((sum, entry) => sum + entry.basisPoints, 0) === FULL_BASIS_POINTS,
      'Percentages must add up to 100% (10000 basis points)',
    ),
  }),
  z.strictObject({
    mode: z.literal('weights'),
    weights: peopleList(
      z.strictObject({ personId: idSchema, weight: z.int().min(1).max(MAX_WEIGHT) }),
      (entry) => entry.personId,
    ),
  }),
  // Bills only; without personIds, everyone present in the bill's period.
  z.strictObject({
    mode: z.literal('days'),
    personIds: peopleList(idSchema, (id) => id).optional(),
  }),
])

export type SplitSpec = z.infer<typeof splitSpecSchema>

/** Everyone a split names explicitly. */
export function splitPersonIds(split: SplitSpec): string[] {
  switch (split.mode) {
    case 'equal':
    case 'days':
      return split.personIds ?? []
    case 'exact':
      return split.amounts.map((entry) => entry.personId)
    case 'percent':
      return split.percents.map((entry) => entry.personId)
    case 'weights':
      return split.weights.map((entry) => entry.personId)
  }
}
