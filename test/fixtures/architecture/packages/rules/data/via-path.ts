// A relative path into node_modules is a local import that skips the package check (own-dirs-boundary).
import { test } from "../../../node_modules/test-runner/index.js"

export const viaPath = test
