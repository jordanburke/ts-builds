// Clean for ESLint; depcruise reports what the data/hop-*.ts files import.
import { coreOk } from "../data/core-ok.ts"
import { hopLocal } from "../data/hop-local.ts"
import { hopRoot } from "../data/hop-root.ts"
import { hopSrcTest } from "../data/hop-src-test.ts"
import { hopTest } from "../data/hop-test.ts"

export const hops = [coreOk, hopLocal, hopRoot, hopSrcTest, hopTest]
