import { defineArchitecture } from "ts-builds/architecture"

export default defineArchitecture({
  rootDir: import.meta.dirname,
  workspaces: {
    "@fx/types": { dir: "packages/types", type: "pure" },
    "@fx/rules": { dir: "packages/rules", type: "pure", allow: ["@fx/types"], deny: ["db-client", "@ai/*", "fs"] },
    "@fx/db": { dir: "packages/db", type: "infra" },
    "@fx/shared": { dir: "packages/shared", type: "lib", allow: ["@fx/db"] },
    "@fx/api": { dir: "apps/api", type: "app", allow: ["@fx/*"] },
  },
  testPolicy: { allowExternals: ["test-runner"] },
})
