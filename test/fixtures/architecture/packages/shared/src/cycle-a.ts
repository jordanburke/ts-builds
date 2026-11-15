import { b } from "./cycle-b.ts"

export const a = (): unknown => b
