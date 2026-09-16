/**
 * Verification harness for the tuned compaction-basic policy.
 *
 * Parses the agent presets with the SAME YAML dialect the harness uses
 * (cordis-plugin-include's JSON_SCHEMA + `!!js` type), pulls the compaction-basic
 * row out of the composition, and feeds the config object to the real
 * `@deepseek-ai/dsh-compaction-basic` plugin (its load-time validator rejects
 * unknown keys, out-of-range ratios, duplicate policy targets and
 * retainRatio >= thresholdRatio).
 *
 * Usage: node verify-compaction-policy.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from '/opt/dsh/node_modules/js-yaml/index.js'
import { BasicCompactionEngine } from '/opt/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'

const DSH_HOME = '/data/dsh'
const SHIPPED_PRESETS = '/opt/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets'

// Same `!!js` scalar type cordis-plugin-include registers for entry lists.
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data['__jsExpr'],
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

const ROUTES = [
  { provider: 'rtx', model: 'RadixArk/Qwen3.8-Flash-Next-NVFP4', contextWindow: 524288, output: 65536 },
  { provider: 'gx10', model: 'local-inference-lab/GLM-5.3-Flash-NVFP4', contextWindow: 524288, output: 65536 },
  { provider: 'gx10', model: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1048576, output: 65536 },
]

/** Depth-first search for a loader row by id across groups. */
function findRow(rows, id) {
  for (const row of rows ?? []) {
    if (row?.id === id) return row
    const nested = findRow(Array.isArray(row?.config) ? row.config : [], id)
    if (nested) return nested
  }
}

function compactionConfigOf(file) {
  const doc = yaml.load(readFileSync(file, 'utf8'), { schema })
  if (!Array.isArray(doc)) throw new Error(`${file}: composition is not a list of plugin rows`)
  const row = findRow(doc, 'compaction-basic')
  if (!row) throw new Error(`${file}: no compaction-basic row`)
  if (row.disabled) throw new Error(`${file}: compaction-basic row is disabled`)
  return { row, name: row.name }
}

const targets = [
  { label: 'standard-tuned (new deployment default)', file: `${DSH_HOME}/.agent-presets/standard-tuned/agent.cordis.yml` },
  { label: 'olares (local preset)', file: `${DSH_HOME}/.agent-presets/olares/agent.cordis.yml` },
  { label: 'shipped standard (unmodified baseline)', file: `${SHIPPED_PRESETS}/standard/agent.cordis.yml` },
]

let failures = 0
for (const target of targets) {
  console.log(`\n=== ${target.label}\n    ${target.file}`)
  let row
  try {
    ;({ row } = compactionConfigOf(target.file))
    console.log(`    row: ${row.name} (enabled)`)
  } catch (error) {
    console.log(`    YAML/MOUNT FAIL: ${error.message}`)
    failures++
    continue
  }

  const cfg = row.config ?? {}
  console.log(`    config: ${row.config ? JSON.stringify(cfg) : '(none — factory defaults)'}`)

  // 1. Authoritative load-time validation, through the plugin itself.
  //    cordis `Service` only needs ctx.reflect.provide during construction;
  //    `auto: false` keeps the constructor from registering listeners on a stub ctx.
  let engine
  try {
    engine = new BasicCompactionEngine({ reflect: { provide() {} } }, { ...cfg, auto: false })
    console.log(
      '    plugin resolveConfig: PASS\n' +
      `         resolved defaults: thresholdRatio=${engine.config.thresholdRatio} retain=${engine.config.retainRatio ?? engine.config.retainTokens} ` +
      `summaryMaxTokens=${engine.config.maxTokens} compactionRetries=${engine.config.compactionRetries} maxOverflowRetries=${engine.config.maxOverflowRetries}`,
    )
  } catch (error) {
    console.log(`    plugin resolveConfig: FAIL — ${error.message}`)
    failures++
    continue
  }
  try {
    // The schema is a callable schemastery schema (the loader-facing contract), so
    // validation is a plain call; unknown keys are stripped here and rejected for
    // real by resolveConfig above.
    const cast = BasicCompactionEngine.Config(JSON.parse(JSON.stringify(cfg)))
    const shown = (value) => (value === undefined ? '(unset → package default)' : JSON.stringify(value))
    console.log(`    plugin Config schema: PASS — summary maxTokens=${shown(cast.maxTokens)}, compactionRetries=${shown(cast.compactionRetries)}, auto=${shown(cast.auto)}, summarization pair=${shown(cast.summarizationProvider)}/${shown(cast.summarizationModel)}`)
  } catch (error) {
    console.log(`    plugin Config schema: FAIL — ${error.message}`)
    failures++
  }

  // 2. Resolve the same way the service does: exact provider+model override over
  //    defaults, then scale by the adapter-owned capacity (floor, as in lib).
  const resolved = engine.config
  for (const route of ROUTES) {
    const override = (resolved.modelPolicies ?? []).find(
      (p) => p.provider === route.provider && p.model === route.model,
    )
    const thresholdRatio = override?.thresholdRatio ?? resolved.thresholdRatio
    const retainRatio = override?.retainRatio ?? resolved.retainRatio
    const summaryCap = override?.maxTokens ?? resolved.maxTokens
    const thresholdTokens = Math.floor(route.contextWindow * thresholdRatio)
    const retainTokens = Math.floor(route.contextWindow * retainRatio)
    // Worst-case provider admission for a CONVERSATION request = prompt at the
    // threshold + that conversation's output reservation.
    const admit = thresholdTokens + route.output
    // Handbook check #10, worst-case admission for the RECOVERY request: it replays
    // system + tools + the selected prefix behind the compaction instruction, so price
    // the replay at its realistic maximum (a prompt sitting at the threshold) and add
    // the summary output cap. FRAME is the allowance for system prompt + tool schemas +
    // instruction, sized from this deployment's live request header (~12 KB system +
    // ~34 KB tool catalog).
    const FRAME = 10_000
    const recovery = thresholdTokens + summaryCap + FRAME
    const ok = retainTokens < thresholdTokens && admit < route.contextWindow && recovery < route.contextWindow
    if (!ok) failures++
    console.log(
      `    ${ok ? 'OK  ' : 'FAIL'} ${route.provider}/${route.model}\n` +
      `         threshold ${thresholdRatio} → ${thresholdTokens} tok · retain ${retainRatio} → ${retainTokens} tok · summary cap ${summaryCap} tok\n` +
      `         conversation: ${thresholdTokens} prompt + ${route.output} output = ${admit} of ${route.contextWindow} (headroom ${route.contextWindow - admit} tok)\n` +
      `         recovery:     ${thresholdTokens} replay + ${summaryCap} summary + ${FRAME} framing = ${recovery} of ${route.contextWindow} (headroom ${route.contextWindow - recovery} tok)` +
      `${override ? '' : '   [no exact policy — inherited defaults]'}`,
    )
  }

  // 3. Duplicate-target guard (the plugin would have thrown already, assert anyway).
  const keys = (resolved.modelPolicies ?? []).map((p) => `${p.provider}/${p.model}`)
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
  console.log(`    modelPolicies targets: ${keys.length}${dupes.length ? ` — DUPLICATES: ${dupes}` : ' (unique)'}`)
  if (dupes.length) failures++
}

// 4. The default preset id the deployment now names must exist and be loadable.
const settings = yaml.load(readFileSync(`${DSH_HOME}/settings.yaml`, 'utf8'))
const presetId = settings['agent-presets']?.default
const presetMeta = yaml.load(readFileSync(`${DSH_HOME}/.agent-presets/${presetId}/preset.yml`, 'utf8'))
console.log(`\n=== settings.yaml\n    agent-presets.default: ${presetId}`)
console.log(`    preset.yml: name="${presetMeta.name}" order=${presetMeta.order}`)
if (!presetId || !presetMeta?.name) failures++

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
