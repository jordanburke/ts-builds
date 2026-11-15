// Runs dependency-cruiser on the fixture through the built package and prints the report
// as JSON. test/depcruise.spec.ts spawns it with different working directories.
import { runDepcruise } from "ts-builds/depcruise"

import architecture from "./architecture.mjs"

const report = await runDepcruise(architecture)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
