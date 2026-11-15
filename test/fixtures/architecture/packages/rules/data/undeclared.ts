// test-runner is hoisted but @fx/rules does not declare it (own-dirs-undeclared).
import { test } from "test-runner"

export const undeclared = test
