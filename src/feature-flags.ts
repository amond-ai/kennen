import type { KennenFeatureConfig } from "./types.js"
import {
  isRunToolAggregateEnabled,
  isRunToolBlockEditEnabled,
  isRunToolEnabled,
  isRunToolFilterSqlEnabled,
  isRunToolSearchEnabled,
} from "./notion/runtool/index.js"

export interface KennenFeatureFlags {
  nearDuplicateProbe: boolean
  autosaveLearningDedup: boolean
  autoMentions: boolean
  taskReuse: boolean
  taskCrossref: boolean
  learningExtraction: boolean
  queryPlanning: boolean
  forceSemanticSearch: boolean
  runTool: {
    enabled: boolean
    blockEdit: boolean
    filterSql: boolean
    search: boolean
    aggregate: boolean
    batchCreates: boolean
  }
}

export const KENNEN_FEATURE_FLAG_TAXONOMY = {
  killSwitches: [
    "KENNEN_DISABLE_NEAR_DUPLICATE_PROBE",
    "KENNEN_DISABLE_AUTOSAVE_LEARNING_DEDUP",
    "KENNEN_DISABLE_AUTO_MENTIONS",
    "KENNEN_DISABLE_TASK_REUSE",
    "KENNEN_DISABLE_TASK_CROSSREF",
    "KENNEN_DISABLE_LEARNING_EXTRACTION",
  ],
  forceSwitches: ["KENNEN_FORCE_SEMANTIC_SEARCH"],
  runTool: [
    "KENNEN_USE_RUNTOOL",
    "KENNEN_USE_RUNTOOL_BLOCK_EDIT",
    "KENNEN_USE_RUNTOOL_FILTER_SQL",
    "KENNEN_USE_RUNTOOL_SEARCH",
    "KENNEN_USE_RUNTOOL_AGGREGATE",
    "KENNEN_USE_RUNTOOL_BATCH_CREATES",
  ],
} as const

const DEFAULT_FLAGS: KennenFeatureFlags = {
  nearDuplicateProbe: true,
  autosaveLearningDedup: true,
  autoMentions: true,
  taskReuse: true,
  taskCrossref: true,
  learningExtraction: true,
  queryPlanning: true,
  forceSemanticSearch: false,
  runTool: {
    enabled: true,
    blockEdit: true,
    filterSql: true,
    search: true,
    aggregate: true,
    batchCreates: false,
  },
}

function cloneDefaultFlags(): KennenFeatureFlags {
  return {
    ...DEFAULT_FLAGS,
    runTool: { ...DEFAULT_FLAGS.runTool },
  }
}

function disabledByEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === "1"
}

function configThenDisableEnv(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv,
  envName: string,
  defaultValue = true
): boolean {
  if (disabledByEnv(env, envName)) return false
  return configured ?? defaultValue
}

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined
}

function resolveRunToolParent(
  env: NodeJS.ProcessEnv,
  config: KennenFeatureConfig["runTool"] | undefined
): boolean {
  if (hasEnvFlag(env, "KENNEN_USE_RUNTOOL")) return isRunToolEnabled(env)
  return config?.enabled ?? DEFAULT_FLAGS.runTool.enabled
}

function resolveRunToolInheritedSubFlag(
  env: NodeJS.ProcessEnv,
  envName: string,
  readEnvFlag: (env: NodeJS.ProcessEnv) => boolean,
  configured: boolean | undefined,
  parent: boolean
): boolean {
  if (hasEnvFlag(env, envName)) return readEnvFlag(env)
  if (hasEnvFlag(env, "KENNEN_USE_RUNTOOL")) return parent
  return configured ?? parent
}

function resolveRunToolBatchCreates(
  env: NodeJS.ProcessEnv,
  config: KennenFeatureConfig["runTool"] | undefined
): boolean {
  const raw = env["KENNEN_USE_RUNTOOL_BATCH_CREATES"]
  if (raw !== undefined) return raw === "1"
  return config?.batchCreates ?? DEFAULT_FLAGS.runTool.batchCreates
}

export function resolveFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
  config?: { features?: KennenFeatureConfig } | null
): KennenFeatureFlags {
  const featureConfig = config?.features
  const runToolConfig = featureConfig?.runTool
  const runToolParent = resolveRunToolParent(env, runToolConfig)

  return {
    nearDuplicateProbe: configThenDisableEnv(
      featureConfig?.nearDuplicateProbe,
      env,
      "KENNEN_DISABLE_NEAR_DUPLICATE_PROBE"
    ),
    autosaveLearningDedup: configThenDisableEnv(
      featureConfig?.autosaveLearningDedup,
      env,
      "KENNEN_DISABLE_AUTOSAVE_LEARNING_DEDUP"
    ),
    autoMentions: configThenDisableEnv(
      featureConfig?.autoMentions,
      env,
      "KENNEN_DISABLE_AUTO_MENTIONS"
    ),
    taskReuse: configThenDisableEnv(
      featureConfig?.taskReuse,
      env,
      "KENNEN_DISABLE_TASK_REUSE"
    ),
    taskCrossref: configThenDisableEnv(
      featureConfig?.taskCrossref,
      env,
      "KENNEN_DISABLE_TASK_CROSSREF"
    ),
    learningExtraction: configThenDisableEnv(
      featureConfig?.learningExtraction,
      env,
      "KENNEN_DISABLE_LEARNING_EXTRACTION"
    ),
    queryPlanning: featureConfig?.queryPlanning ?? DEFAULT_FLAGS.queryPlanning,
    forceSemanticSearch:
      featureConfig?.forceSemanticSearch === true ||
      env["KENNEN_FORCE_SEMANTIC_SEARCH"] === "1",
    runTool: {
      enabled: runToolParent,
      blockEdit: resolveRunToolInheritedSubFlag(
        env,
        "KENNEN_USE_RUNTOOL_BLOCK_EDIT",
        isRunToolBlockEditEnabled,
        runToolConfig?.blockEdit,
        runToolParent
      ),
      filterSql: resolveRunToolInheritedSubFlag(
        env,
        "KENNEN_USE_RUNTOOL_FILTER_SQL",
        isRunToolFilterSqlEnabled,
        runToolConfig?.filterSql,
        runToolParent
      ),
      search: resolveRunToolInheritedSubFlag(
        env,
        "KENNEN_USE_RUNTOOL_SEARCH",
        isRunToolSearchEnabled,
        runToolConfig?.search,
        runToolParent
      ),
      aggregate: resolveRunToolInheritedSubFlag(
        env,
        "KENNEN_USE_RUNTOOL_AGGREGATE",
        isRunToolAggregateEnabled,
        runToolConfig?.aggregate,
        runToolParent
      ),
      batchCreates: resolveRunToolBatchCreates(env, runToolConfig),
    },
  }
}

export function defaultFeatureFlags(): KennenFeatureFlags {
  return cloneDefaultFlags()
}
