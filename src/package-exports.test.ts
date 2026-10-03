import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

const packageExportsPath = fileURLToPath(
  new URL("../tools/check-package-exports.mjs", import.meta.url)
)

interface PackageExportsModule {
  validatePackagePaths(pkg: Record<string, unknown>, packedFiles: string[]): string[]
}

async function loadPackageExportsModule(): Promise<PackageExportsModule> {
  return (await import(pathToFileURL(packageExportsPath).href)) as PackageExportsModule
}

const pkg = {
  bin: { kennen: "./dist/cli.js" },
  exports: {
    ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
    "./mcp": { import: "./dist/mcp.js", types: "./dist/mcp.d.ts" },
  },
}

describe("check-package-exports", () => {
  it("accepts a tarball that ships every referenced file", async () => {
    const { validatePackagePaths } = await loadPackageExportsModule()

    expect(
      validatePackagePaths(pkg, [
        "package.json",
        "dist/cli.js",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/mcp.js",
        "dist/mcp.d.ts",
      ])
    ).toEqual([])
  })

  it("reports an exports condition whose file the tarball lacks", async () => {
    const { validatePackagePaths } = await loadPackageExportsModule()

    expect(
      validatePackagePaths(pkg, [
        "dist/cli.js",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/mcp.js",
      ])
    ).toEqual(['exports["./mcp"]["types"]: dist/mcp.d.ts is not in the packed tarball'])
  })

  it("checks a string bin and skips subpath patterns", async () => {
    const { validatePackagePaths } = await loadPackageExportsModule()

    expect(
      validatePackagePaths(
        { bin: "./dist/cli.js", exports: { "./*": "./dist/*.js" } },
        []
      )
    ).toEqual(["bin: dist/cli.js is not in the packed tarball"])
  })
})
