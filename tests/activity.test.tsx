import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'live-activity',
  component: 'Pane',
  requestId: 'live-activity',
  surface: 'terminal',
  props: {
    title: 'Live',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const ROW = {
  plugin: 'live-activity',
  component: 'ToolUse',
  requestId: 't1',
  surface: 'terminal',
  props: {
    tool_use_id: 't1',
    tool: 'Bash',
    input: { command: 'ls' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  },
} as const

const SESSION = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })

// What sits beneath the plugin: a clock the test moves, and the engine's answers.
const world = (on: On) => {
  on(
    'command.register',
    () => ({ value: { command: 'activity' } }))
  on(
    'ui.open',
    () => ({ value: { isPlaced: true } }))
  on(
    'session.start',
    (_, e) => ({ cwd: e.cwd }))
  return mock.clock(on)
}

// Stands for the engine's own tool row, and says whether the live pane is on screen.
const transcript = (on: On, isPaneOnScreen: boolean) => {
  on(
    'ui.panes',
    () => ({
      value: isPaneOnScreen
        ? [{ id: 'live-activity', title: 'Live', isShown: true, isFocused: false, isPlaced: true }]
        : [],
    }))
  on(
    'ui.render',
    { component: 'ToolUse' },
    ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>Bash(ls)</Text>
    })
}

test('a read opens its folder with the file picked, then shows the lines it read', async ($, on) => {
  const clock = world(on)
  on(
    'fs.list',
    () => ({ value: [entry('b.cs', 'file'), entry('.DS_Store', 'file'), entry('sub', 'dir'), entry('a.cs', 'file')] }))
  on(
    'tool.call',
    () => ({
      result: { type: 'text', file: { filePath: '/repo/src/a.cs', content: 'one\ntwo', numLines: 2, startLine: 1, totalLines: 9 } },
    }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.cs' })
  await clock.advance(300)

  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Opening/ }))?.text).toBe('Opening a.cs')
  expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('▶ a.cs')
  expect((await ui.find({ type: 'Text', text: /sub/ }))?.text).toBe('  sub/')
  expect(await ui.find({ type: 'Text', text: /DS_Store/ })).toBeUndefined()
  await ui.unmount()

  // Mid-read: the lines being read are highlighted code with a yellow bar beside them.
  await clock.advance(900)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /▌/ }))?.text).toMatch(/^▌/)
  expect((await ui.findAll({ type: 'Code' })).map(found => found.props.path)).toContain('/repo/src/a.cs')
  await ui.unmount()

  await clock.advance(5000)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({ source: 'one\ntwo', path: '/repo/src/a.cs', startLine: 1 })
  expect((await ui.find({ type: 'Text', text: /read lines/ }))?.text).toBe('Claude read lines 1–2 of 9')
  await ui.unmount()
})

test('a failing command shows the command, its output and that it failed', async ($, on) => {
  const clock = world(on)
  on(
    'tool.call',
    () => ({ result: 'Exit code 1\nboom', isError: true }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build it' })
  await clock.advance(5000)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Build it/ }))?.text).toBe('Build it')
  expect((await ui.find({ type: 'Text', text: /\$ / }))?.text).toBe('$ make')
  expect((await ui.find({ type: 'Text', text: /boom/ }))?.text).toBe('boom')
  expect((await ui.find({ type: 'Text', text: /failed/ }))?.text).toBe('failed')
  await ui.unmount()
})

test('long lines wrap whole, and only the newest ones that fit once wrapped are shown', async ($, on) => {
  const clock = world(on)
  // 30 lines of 120 characters: 3 rows each in a 50-column pane.
  const lines = Array.from(
    { length: 30 },
    (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(117)}`)
  on(
    'tool.call',
    () => ({ result: { stdout: lines.join('\n'), stderr: '' } }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'cat big.log', description: 'Show the log' })
  await clock.advance(5000)

  // 20 rows less the caption, "Terminal", the command and "done" leave 16: five 3-row lines.
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^29 / }))?.text).toBe(lines[29])
  expect((await ui.find({ type: 'Text', text: /^25 / }))?.text).toBe(lines[25])
  expect(await ui.find({ type: 'Text', text: /^24 / })).toBeUndefined()
  await ui.unmount()
})

test('terminal escape codes in a command and its output never reach the pane', async ($, on) => {
  const clock = world(on)
  on(
    'tool.call',
    () => ({ result: { stdout: '\x1b[31mred\x1b[0m\r', stderr: '\x1b]0;spoofed title\x07' } }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'echo \x1b[2Jhi', description: 'Print' })
  await clock.advance(5000)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /\$ / }))?.text).toBe('$ echo hi')
  expect((await ui.find({ type: 'Text', text: /red/ }))?.text).toBe('red')
  expect(await ui.find({ type: 'Text', text: /spoofed|\x1b/ })).toBeUndefined()
  await ui.unmount()
})

test('an edit shows the removed and the added lines', async ($, on) => {
  const clock = world(on)
  on(
    'tool.call',
    () => ({
      result: {
        filePath: '/repo/a.cs', oldString: 'x', newString: 'y', originalFile: 'x', userModified: false, replaceAll: false,
        structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: [' keep', '-x', '+y'] }],
      },
    }))

  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.cs', old_string: 'x', new_string: 'y' })
  await clock.advance(5000)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Code' }))?.props).toMatchObject({
    source: '@@ -3,2 +3,2 @@\n keep\n-x\n+y',
    path: '/repo/a.cs',
    format: 'diff',
  })
  expect((await ui.find({ type: 'Text', text: /changed/ }))?.text).toBe('Claude changed this file: +1 −1')
  await ui.unmount()
})

test('without the pane on screen the chat keeps its tool rows', async ($, on) => {
  transcript(
    on,
    false)

  const ui = await $.ui.mount(ROW)
  expect((await ui.find({ type: 'Text', text: /Bash/ }))?.text).toBe('Bash(ls)')
  await ui.unmount()
})

test('with the pane on screen a tool row draws nothing in the chat, and ctrl+o still draws it', async ($, on) => {
  transcript(
    on,
    true)

  let ui = await $.ui.mount(ROW)
  expect(await ui.find({ type: 'Text', text: /Bash/ })).toBeUndefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...ROW, props: { ...ROW.props, isExpanded: true } })
  expect((await ui.find({ type: 'Text', text: /Bash/ }))?.text).toBe('Bash(ls)')
  await ui.unmount()
})

test('/activity says why the pane sits above the prompt', async ($, on) => {
  on(
    'ui.open',
    () => ({ value: { isPlaced: true } }))

  const narrow = await $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 90 } })
  const mainScreen = await $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 200 } })

  expect(narrow).toMatchObject({ text: 'Live view opened above the prompt: the window is 90 columns wide, and the pane docks beside the chat from 110.' })
  expect(mainScreen).toMatchObject({ text: expect.stringContaining('fullscreen layout') })
})

test('/activity opens the pane at a third of the terminal, and a resize keeps it there', async ($, on) => {
  const opened: { id: string; columns?: number }[] = []
  on(
    'ui.open',
    (_, e) => (opened.push({ id: e.id, columns: e.columns }), { value: { isPlaced: true } }))

  const reply = await $.command.run({ command: 'activity', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 150 } })
  const ui = await $.ui.mount({ ...PANE, viewport: { columns: 210, rows: 50, isFullscreen: true } })
  expect(reply).toMatchObject({ text: 'Live view opened beside the chat, a third of the window wide.' })
  await ui.unmount()

  expect(opened).toEqual([{ id: 'live-activity', columns: 48 }, { id: 'live-activity', columns: 68 }])
})
