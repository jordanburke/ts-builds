import type { A } from "./type-cycle-a.ts"

export type B = { a?: A }
