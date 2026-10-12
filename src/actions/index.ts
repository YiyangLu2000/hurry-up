import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { rateRestroom } from './rate-restroom'

export const actions: Record<string, ActionHandler<Env>> = { rateRestroom }
