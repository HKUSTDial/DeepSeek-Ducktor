/**
 * Ducktor's edit checkpoint for dsh, the same rule as the PreToolUse hook in Claude Code and Codex
 * (duck/bin/duck.js): with the switch on or quiet, the first edit of a text draft in a turn is
 * refused once and the model gets the reminder from duck/rules/checkpoint.md. The decision and the
 * reminder come from duck.js itself, so the two hosts cannot drift apart; only the dsh plumbing
 * (turn numbers, the current directory, the deny shape) lives here. Every doubt lets the edit through.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
  const duck = createRequire(import.meta.url)(join(root, 'bin', 'duck.js'))
  /** agent id -> current turn number, set by pre-step. */
  const turns = new Map()
  /** Turns that were already refused once, keyed by agent and turn. */
  const refused = new Set()
  // The test log sits in the state folder; dsh sets no CLAUDE_PLUGIN_DATA, and one from the
  // parent environment must not move it.
  const dir = duck.checkpointDir({ XDG_STATE_HOME: process.env.XDG_STATE_HOME, HOME: process.env.HOME })

  ctx.on('agent/pre-step', (payload, next) => {
    if (payload?.agent?.id !== undefined && payload.turn !== undefined) turns.set(payload.agent.id, payload.turn)
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const files = editedFiles(exec.name, exec.arguments)
    if (files.length === 0 || exec.agent === undefined) return next()
    let decision = 'allow'
    let reminder = ''
    const turn = turns.get(exec.agent.id)
    try {
      const project = projectOf(exec.agent)
      let config = null
      try { config = readFileSync(join(project, '.duck', 'config.md'), 'utf8') } catch { /* no config */ }
      let cwd = ''
      try { cwd = await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal) ?? '' } catch { /* unknown */ }
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
        const key = `${facts.session}--${facts.turn}`
        // Checked and added with no await in between, so two calls of one step cannot both win.
        if (!refused.has(key)) {
          refused.add(key)
          decision = 'deny'
        }
      }
      duck.writeCheckpointLog(dir, {
        host: 'dsh', session: String(exec.agent.id), turn: facts.turn, tool: exec.name,
        subagent: facts.isSubagent, decision, duck: duckCommit(),
      }, PACKAGE_ROOT)
    } catch {
      decision = 'allow'
    }
    // Refuse before next(): dsh's own approval prompt never shows for a call that is refused anyway.
    if (decision === 'deny') return { kind: 'deny', reason: reminder }
    return next()
  })
}
