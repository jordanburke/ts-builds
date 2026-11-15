// A cycle through type-only imports is erased at runtime, so it is not reported.
import type { B } from "./type-cycle-b.ts"

export type A = { b?: B }
