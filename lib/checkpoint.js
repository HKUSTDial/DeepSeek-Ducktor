/**
 * Ducktor's edit checkpoint for dsh, the same rule as the PreToolUse hook in Claude Code and Codex
 * (duck/bin/duck.js): with the switch on or quiet, the first edit of a text draft in a turn is
 * refused once and the model gets the reminder from duck/rules/checkpoint.md. Other text-draft
 * edits the model sent in the same step are refused too, so none lands before the reminder is read
 * (Claude Code tells its batches apart by the transcript; dsh by the step number). The decision and
 * the reminder come from duck.js itself, so the two hosts cannot drift apart; only the dsh plumbing
 * (turn and step numbers, the current directory, the deny shape) lives here. Every doubt lets the
 * edit through.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSubagent, projectOf } from './duck.js'

/** This package's root: BUILD and duck.lock.json live here, not in duck/. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The files a dsh edit tool call names, or [] for calls that do not change a file. */
export function editedFiles(name, args) {
  if (args === null || typeof args !== 'object') return []
  if (name === 'write' || name === 'edit') return [args.file_path]
  if (name === 'str_replace_editor' && ['create', 'str_replace', 'insert'].includes(args.command)) return [args.path]
  return []
}

/** Ducktor's source commit recorded in duck.lock.json, for the test log. */
function duckCommit() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'duck.lock.json'), 'utf8')).source?.commit ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** dsh agent ids may hold any character; the record key needs a file-name-safe one. */
function safeId(value) {
  return `a${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`
}

/**
 * Register the checkpoint on a dsh context.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} root - the Ducktor root (duck/ or Config.duckRoot).
 */
export function registerCheckpoint(ctx, root) {
  let duck
  try {
    duck = createRequire(import.meta.url)(join(root, 'bin', 'duck.js'))
  } catch {
    duck = {}
  }
  // A duckRoot that points at a Ducktor older than 0.2.4 has no checkpoint: the commands and the
  // session context still work, and no edit is checked.
  const missing = NEEDED.filter((name) => typeof duck[name] !== 'function')
  if (missing.length > 0) {
    ctx.logger?.warn?.('Ducktor at %s has no edit checkpoint (it needs Ducktor 0.2.4 or newer; missing %s): edits are not checked', root, missing.join(', '))
    return false
  }
  /** agent id -> { turn, step } of the current step, set by pre-step. */
  const turns = new Map()
  /** agent id -> { turn, step } of that agent's first refused edit. A refusal only counts within
   * its turn, so one entry per agent is enough. */
  const refused = new Map()
  // The test log sits in the state folder; dsh sets no CLAUDE_PLUGIN_DATA, and one from the
  // parent environment must not move it.
  const dir = duck.checkpointDir({ XDG_STATE_HOME: process.env.XDG_STATE_HOME, HOME: process.env.HOME })

  ctx.on('agent/pre-step', (payload, next) => {
    if (payload?.agent?.id !== undefined && payload.turn !== undefined) remember(turns, payload.agent.id, { turn: payload.turn, step: payload.step })
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const files = editedFiles(exec.name, exec.arguments)
    if (files.length === 0 || exec.agent === undefined) return next()
    let decision = 'allow'
    let batch = false
    let reminder = ''
    const { turn, step } = turns.get(exec.agent.id) ?? {}
    try {
      const project = projectOf(exec.agent)
      let config = null
      try { config = readFileSync(join(project, '.duck', 'config.md'), 'utf8') } catch { /* no config */ }
      let cwd = ''
      try { cwd = await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal) ?? '' } catch { /* unknown */ }
      // Without the working directory a relative path cannot be placed: let it through (design 0.2.4, step 16).
      if (!cwd && files.some((f) => typeof f !== 'string' || !isAbsolute(f))) return next()
      reminder = duck.checkpointReminder(config, root)
      const facts = {
        mode: duck.modeOf(config).mode,
        isSubagent: isSubagent(exec.agent),
        session: safeId(exec.agent.id),
        turn: turn === undefined ? '' : String(turn),
        cwd,
        project,
        files,
      }
      if (reminder && duck.checkpointDecision(facts) === 'claim') {
        const first = refused.get(exec.agent.id)
        // Checked and set with no await in between, so two calls of one step cannot both be first.
        if (!first || first.turn !== facts.turn) {
          remember(refused, exec.agent.id, { turn: facts.turn, step })
          decision = 'deny'
        } else if (step !== undefined && first.step === step) {
          // Sent in the same step as the first refused edit: the model has not read the reminder yet.
          decision = 'deny'
          batch = true
        }
      }
      duck.writeCheckpointLog(dir, {
        host: 'dsh', session: String(exec.agent.id), turn: facts.turn, tool: exec.name,
        subagent: facts.isSubagent, decision, batch, duck: duckCommit(),
      }, PACKAGE_ROOT)
    } catch {
      decision = 'allow'
    }
    // Refuse before next(): dsh's own approval prompt never shows for a call that is refused anyway.
    if (decision === 'deny') return { kind: 'deny', reason: reminder }
    return next()
  })
  return true
}

/** The bin/duck.js functions the checkpoint calls; Ducktor 0.2.3 and older have none of the checkpoint ones. */
const NEEDED = ['checkpointDecision', 'checkpointDir', 'checkpointReminder', 'writeCheckpointLog', 'modeOf']

/** A long-running dsh web server sees many sessions; the two maps keep the newest few hundred. */
const MAX_AGENTS = 500

function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_AGENTS) map.delete(map.keys().next().value)
}
