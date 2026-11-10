// Tests for lib/checkpoint.js with a stand-in for the dsh context: the two event handlers are
// called the way dsh calls them (pre-step with the turn, pre-execute with the tool call).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { editedFiles, registerCheckpoint } from '../lib/checkpoint.js'
import { resolveDuckRoot } from '../lib/duck.js'

const made = []
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }) })
function temp(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-cp-'))
  made.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

function setup(cwd) {
  const handlers = {}
  const ctx = {
    on: (event, fn) => { handlers[event] = fn },
    get: (name) => (name === 'workingDirectory' ? { ensure: async () => cwd } : undefined),
  }
  registerCheckpoint(ctx, resolveDuckRoot(undefined))
  return handlers
}

function agent(id, project, header = {}) {
  return { id, session: { header: { cwd: project, ...header } } }
}

const ALLOW = { kind: 'allow' }
const next = () => Promise.resolve(ALLOW)

test('editedFiles names the files of write, edit and the changing str_replace_editor commands', () => {
  assert.deepEqual(editedFiles('write', { file_path: 'a.md' }), ['a.md'])
  assert.deepEqual(editedFiles('edit', { file_path: 'a.md' }), ['a.md'])
  assert.deepEqual(editedFiles('str_replace_editor', { command: 'insert', path: 'a.md' }), ['a.md'])
  assert.deepEqual(editedFiles('str_replace_editor', { command: 'view', path: 'a.md' }), [])
  assert.deepEqual(editedFiles('read', { file_path: 'a.md' }), [])
  assert.deepEqual(editedFiles('write', null), [])
})

test('dsh checkpoint refuses the first text-draft edit of a turn and the rest of its step, before next()', async () => {
  const project = temp({ '.duck/config.md': '开关：on\n', 'plan.md': 'a' })
  const state = temp()
  process.env.XDG_STATE_HOME = state
  const h = setup(project)
  const a = agent('agent-1', project)
  await h['agent/pre-step']({ agent: a, turn: 1, step: 1 }, next)
  let called = 0
  const counting = () => { called += 1; return Promise.resolve(ALLOW) }
  const first = await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: 'plan.md' }, agent: a }, counting)
  assert.equal(first.kind, 'deny')
  assert.match(first.reason, /这不是学生的拒绝/)
  assert.equal(called, 0)
  // Another edit sent in the same step: the model has not read the reminder yet, so it is refused too.
  const batch = await h['tools/pre-execute']({ name: 'write', arguments: { file_path: join(project, 'notes.md') }, agent: a }, next)
  assert.equal(batch.kind, 'deny')
  assert.match(batch.reason, /这不是学生的拒绝/)
  // The next step comes after the model read the refusals: its edits go through.
  await h['agent/pre-step']({ agent: a, turn: 1, step: 2 }, next)
  assert.equal(await h['tools/pre-execute']({ name: 'write', arguments: { file_path: join(project, 'plan.md') }, agent: a }, next), ALLOW)
  assert.equal(await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: 'notes.md' }, agent: a }, next), ALLOW)
  await h['agent/pre-step']({ agent: a, turn: 2, step: 1 }, next)
  assert.equal((await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: 'plan.md' }, agent: a }, next)).kind, 'deny')
  // A second session with the same turn number has its own record.
  const b = agent('agent-2', project)
  await h['agent/pre-step']({ agent: b, turn: 2, step: 1 }, next)
  assert.equal((await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: 'plan.md' }, agent: b }, next)).kind, 'deny')
  delete process.env.XDG_STATE_HOME
})

test('dsh checkpoint lets through: off, subagents, code files, .duck/, no turn yet; a step without a number refuses only once', async () => {
  const on = temp({ '.duck/config.md': '开关：on\n', 'run.py': 'a', '.duck/notebook.md': '- x\n' })
  const off = temp({ '.duck/config.md': '开关：off\n', 'plan.md': 'a' })
  process.env.XDG_STATE_HOME = temp()
  const call = async (h, a, file) => h['tools/pre-execute']({ name: 'edit', arguments: { file_path: file }, agent: a }, next)
  const hOff = setup(off)
  const aOff = agent('x', off)
  await hOff['agent/pre-step']({ agent: aOff, turn: 1 }, next)
  assert.equal(await call(hOff, aOff, 'plan.md'), ALLOW)
  const h = setup(on)
  const sub = agent('s', on, { origin: 'subagent' })
  await h['agent/pre-step']({ agent: sub, turn: 1 }, next)
  assert.equal(await call(h, sub, 'notes.md'), ALLOW)
  const a = agent('m', on)
  assert.equal(await call(h, a, 'notes.md'), ALLOW)
  await h['agent/pre-step']({ agent: a, turn: 1 }, next)
  assert.equal(await call(h, a, 'run.py'), ALLOW)
  assert.equal(await call(h, a, '.duck/notebook.md'), ALLOW)
  assert.equal((await call(h, a, 'notes.md')).kind, 'deny')
  // A host that sends no step number: only the first edit of the turn is refused.
  const b = agent('n', on)
  await h['agent/pre-step']({ agent: b, turn: 1 }, next)
  assert.equal((await call(h, b, 'notes.md')).kind, 'deny')
  assert.equal(await call(h, b, 'notes.md'), ALLOW)
  delete process.env.XDG_STATE_HOME
})

test('dsh checkpoint writes the test log with the Ducktor commit when LOG exists', async () => {
  const project = temp({ '.duck/config.md': 'Switch: quiet\n', 'plan.md': 'a' })
  const state = temp()
  const cp = join(state, 'ducktor', 'checkpoint')
  mkdirSync(cp, { recursive: true, mode: 0o700 })
  writeFileSync(join(cp, 'LOG'), '')
  process.env.XDG_STATE_HOME = state
  const h = setup(project)
  const a = agent('agent-9', project)
  await h['agent/pre-step']({ agent: a, turn: 3 }, next)
  const out = await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: 'plan.md' }, agent: a }, next)
  assert.match(out.reason, /This is not the student refusing/)
  const line = JSON.parse(readFileSync(join(cp, 'log.txt'), 'utf8').trim())
  assert.equal(line.batch, false)
  assert.equal(line.host, 'dsh')
  assert.equal(line.session, 'agent-9')
  assert.equal(line.turn, '3')
  assert.equal(line.decision, 'deny')
  assert.equal(line.duck, JSON.parse(readFileSync(new URL('../duck.lock.json', import.meta.url), 'utf8')).source.commit)
  delete process.env.XDG_STATE_HOME
})

test('a duckRoot older than 0.2.4 (no checkpoint functions) or a broken bin/duck.js: no handlers, a warning, no throw', () => {
  const old = temp({
    'bin/duck.js': "'use strict';\nmodule.exports = { main() {}, modeOf() { return { mode: 'on' } }, buildContext() { return '' }, insideRoot() { return false }, ROOT: __dirname };\n",
  })
  const broken = temp({ 'bin/duck.js': 'this is not javascript (\n' })
  for (const root of [old, broken]) {
    const handlers = {}
    const warnings = []
    const ctx = { on: (event, fn) => { handlers[event] = fn }, get: () => undefined, logger: { warn: (...args) => warnings.push(args) } }
    assert.equal(registerCheckpoint(ctx, root), false)
    assert.deepEqual(Object.keys(handlers), [])
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /no edit checkpoint/)
  }
})

test('dsh checkpoint lets a relative path through when the working directory is unknown (design 0.2.4, step 16)', async () => {
  const project = temp({ '.duck/config.md': '开关：on\n', 'plan.md': 'a' })
  process.env.XDG_STATE_HOME = temp()
  const h = setup('')
  const a = agent('agent-cwd', project)
  await h['agent/pre-step']({ agent: a, turn: 1, step: 1 }, next)
  assert.equal(await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: 'plan.md' }, agent: a }, next), ALLOW)
  // An absolute path is still checked.
  assert.equal((await h['tools/pre-execute']({ name: 'edit', arguments: { file_path: join(project, 'plan.md') }, agent: a }, next)).kind, 'deny')
  delete process.env.XDG_STATE_HOME
})
