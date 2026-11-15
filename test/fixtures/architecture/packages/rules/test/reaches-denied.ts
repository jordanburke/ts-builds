// Clean for ESLint: a test file may import the allowed @fx/types. dependency-cruiser reports
// it, because test files are checked too and @fx/types/runtime reaches db-client.
import { connectNow } from "@fx/types/runtime"

export const reachedFromTest = connectNow
