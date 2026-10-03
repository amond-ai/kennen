#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

function messageFor(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalize(path) {
  return path.replace(/^\.\//, "")
}

function collectExportTargets(value, label, out) {
  if (typeof value === "string") {
    // Subpath patterns (`./*`) map a family of files, not one file to look up.
    if (!value.includes("*")) out.push({ label, path: normalize(value) })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectExportTargets(item, `${label}[${index}]`, out))
    return
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectExportTargets(nested, `${label}["${key}"]`, out)
    }
  }
}

export function collectPackagePaths(pkg) {
  const paths = []

  if (typeof pkg.bin === "string") {
    paths.push({ label: "bin", path: normalize(pkg.bin) })
  } else if (pkg.bin && typeof pkg.bin === "object") {
    for (const [name, path] of Object.entries(pkg.bin)) {
      paths.push({ label: `bin["${name}"]`, path: normalize(path) })
    }
  }

  for (const field of ["main", "types", "typings"]) {
    if (typeof pkg[field] === "string") {
      paths.push({ label: field, path: normalize(pkg[field]) })
    }
  }

  if (pkg.exports !== undefined) collectExportTargets(pkg.exports, "exports", paths)

  return paths
}

export function validatePackagePaths(pkg, packedFiles) {
  const packed = new Set(packedFiles.map(normalize))
  return collectPackagePaths(pkg)
    .filter((entry) => !packed.has(entry.path))
    .map((entry) => `${entry.label}: ${entry.path} is not in the packed tarball`)
}

function listPackedFiles(cwd) {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // npm is a `.cmd` shim on Windows, which only a shell can launch.
    shell: process.platform === "win32",
  })
  const [result] = JSON.parse(raw)
  if (!Array.isArray(result?.files)) {
    throw new Error("npm pack --dry-run --json returned no file list")
  }
  return result.files.map((file) => file.path)
}

export function main(cwd = process.cwd()) {
  let errors
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
    errors = validatePackagePaths(pkg, listPackedFiles(cwd))
  } catch (error) {
    process.stderr.write(
      `[kennen] package exports check could not run: ${messageFor(error)}\n`
    )
    process.exit(1)
  }

  if (errors.length > 0) {
    process.stderr.write(
      "[kennen] package.json points at files the tarball does not ship:\n"
    )
    for (const error of errors) process.stderr.write(`- ${error}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
