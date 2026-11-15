// Clean for ESLint: @fx/types is an allowed workspace. dependency-cruiser reports it,
// because @fx/types/runtime imports db-client, which @fx/rules denies.
import { connectNow } from "@fx/types/runtime"

export const reached = connectNow
