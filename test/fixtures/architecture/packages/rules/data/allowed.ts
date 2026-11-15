// Allowed for ownDirs code: an allowed workspace, a declared devDependency, and its own src.
import type { Id } from "@fx/types"
import { expectTrue } from "test-helper"

import { id } from "../src/index.ts"

export const allowed: [Id, unknown] = [id, expectTrue]
