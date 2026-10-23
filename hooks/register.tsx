import { atom, read, update } from 'claude-code'
import type { BuiltinToolResults, EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Frame, Part, Scene } from '../types'

// Each tool call becomes a few animation steps (open the folder, sweep down the file, type the
// command, ...). A clock tick plays one step at a time into the pane beside the chat.
const PANE = 'live-activity'
const TICK_MS = 100
const SWEEP = 20
const BAND = 4
const MAX_LINES = 400
const MAX_TEXT = 20_000

const scene = atom(
  { plugin: 'live-activity', key: 'scene' } as const,
  null,
  { shape: 'scene-2' })
const frame = atom(
  { plugin: 'live-activity', key: 'frame' } as const,
  { phase: 'show', at: 0 })

type Step = { scene: Scene; frame: Frame; ticks: number }
const queue: Step[][] = []
let playing: Step[] = []
let wait = 0
let shown: Scene | undefined
let isBusy = false

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirOf = (path: string) =>
  path.slice(
    0,
    path.lastIndexOf('/')) || '/'
// File contents, command output and paths can carry terminal escape codes; the pane draws plain text only.
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
const clean = (text: string) => text.replace(
  CONTROL,
  '')
const clip = (text: string) => (text.length > MAX_TEXT ? `${clean(text.slice(0, MAX_TEXT))}\n…` : clean(text))
const str = (value: unknown, key: string) => {
  const field = (value as Record<string, unknown> | null)?.[key]

  return typeof field === 'string' ? clean(field) : ''
}

const captionOf = (e: { tool: string }) => {
  switch (e.tool) {
    case 'Read': return `Opening ${nameOf(str(e, 'file_path'))}`
    case 'Edit': return `Editing ${nameOf(str(e, 'file_path'))}`
    case 'Write': return `Writing ${nameOf(str(e, 'file_path'))}`
    case 'Bash':
      return str(
        e,
        'description') || `Running ${str(e, 'command')}`
    case 'WebFetch': return `Opening ${str(e, 'url')}`
    case 'WebSearch': return `Searching the web for "${str(e, 'query')}"`
    case 'Agent': return `Starting a helper: ${str(e, 'description')}`
    case 'Skill': return `Using the ${str(e, 'skill')} skill`
    default: return `Using ${e.tool}`
  }
}

const folderOf = async ($: EngineInterface, path: string) => {
  const entries = await $.fs
    .list(dirOf(path))
    .catch(() => [])

  return entries
    .filter(entry => entry.name !== '.DS_Store')
    .map(entry => ({ name: clean(entry.name), isDir: entry.kind === 'dir' }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || (a.name < b.name ? -1 : 1))
    .slice(0, 200)
}

const partOf = async ($: EngineInterface, e: { tool: string }, ran: ToolCallResult): Promise<Part> => {
  if (ran.deny !== undefined) return { kind: 'note' }
  if (e.tool === 'Bash') {
    const output = typeof ran.result === 'string'
      ? ran.result
      : [
          str(
            ran.result,
            'stdout'),
          str(
            ran.result,
            'stderr'),
        ]
          .filter(Boolean)
          .join('\n')

    return {
      kind: 'bash',
      command: str(
        e,
        'command'),
      output: clip(output),
    }
  }
  if (ran.isError === true) return { kind: 'note' }
  if (e.tool === 'Read') {
    const result = ran.result as BuiltinToolResults['Read']
    if (result.type !== 'text') return { kind: 'note' }
    const { filePath, content, startLine, totalLines } = result.file

    return {
      kind: 'read',
      path: clean(filePath),
      folder: await folderOf(
        $,
        filePath),
      startLine,
      totalLines,
      lines: clean(content)
        .split('\n')
        .slice(0, MAX_LINES),
    }
  }
  if (e.tool === 'Edit' || e.tool === 'Write') {
    // Edit and Write both answer filePath and structuredPatch; a new file has no patch.
    const result = ran.result as BuiltinToolResults['Write']
    const hunks = result.structuredPatch.length > 0
      ? result.structuredPatch.map(hunk => ({
          oldStart: hunk.oldStart,
          start: hunk.newStart,
          lines: hunk.lines
            .slice(0, MAX_LINES)
            .map(clean),
        }))
      : [{
          oldStart: 0,
          start: 1,
          lines: str(
            e,
            'content')
            .split('\n')
            .slice(0, MAX_LINES)
            .map(line => `+${line}`),
        }]

    return { kind: 'diff', path: clean(result.filePath), hunks }
  }
  if (e.tool === 'WebFetch') {
    const result = ran.result as BuiltinToolResults['WebFetch']

    return { kind: 'web', url: clean(result.url), text: clip(result.result) }
  }
  if (e.tool === 'WebSearch') return { kind: 'web', url: `Search: ${str(e, 'query')}`, text: '' }

  return { kind: 'note' }
}

const range = (count: number) =>
  Array.from(
    { length: count + 1 },
    (_, i) => i / count)

const stepsOf = (shown: Scene): Step[] => {
  const step = (phase: Frame['phase'], at: number, ticks = 1) => ({ scene: shown, frame: { phase, at }, ticks })
  switch (shown.kind) {
    case 'read':
      return [
        step(
          'folder',
          0,
          8),
        ...range(SWEEP)
          .map(part => step(
            'read',
            Math.round((shown.lines.length - 1) * part))),
        step(
          'read',
          -1,
          0),
      ]
    case 'diff': {
      const total = shown.hunks.reduce(
        (sum, hunk) => sum + hunk.lines.length,
        0)

      return range(10)
        .map(part => step(
          'type',
          Math.round(total * part),
          part === 1 ? 5 : 1))
    }
    case 'bash':
      return shown.isRunning
        ? range(6)
          .map(part => step(
            'type',
            Math.round(shown.command.length * part)))
        : [step(
            'show',
            0,
            5)]
    default:
      return [step(
        'show',
        0,
        5)]
  }
}

// One step per tick. Falling behind halves each step's time; far behind, only each call's last step shows.
const tick = async ($: EngineInterface) => {
  if (isBusy) return
  if (wait > 0) return void wait--
  if (playing.length === 0) playing = queue.shift() ?? []
  const step = queue.length > 3
    ? playing
      .splice(0)
      .at(-1)
    : playing.shift()
  if (step === undefined) return
  isBusy = true
  try {
    wait = queue.length > 0 ? Math.floor(step.ticks / 2) : step.ticks
    if (step.scene !== shown) {
      shown = step.scene
      await update(
        $,
        scene,
        () => step.scene)
    }
    await update(
      $,
      frame,
      () => step.frame)
  } finally {
    isBusy = false
  }
}

// The dock takes a third of the terminal (its frame's two columns come off the body).
// A width the person drags the dock to wins over this.
let sizedFor = 0
const open = ($: EngineInterface, terminalColumns?: number) => {
  if (terminalColumns === undefined) return $.ui.open({ id: PANE, title: 'Live' })
  sizedFor = terminalColumns

  return $.ui.open({
    id: PANE,
    title: 'Live',
    columns: Math.max(
      24,
      Math.floor(terminalColumns / 3) - 2),
  })
}

// While the pane is on screen the chat keeps only the replies: the tool rows draw nothing.
// ctrl+o (an expanded row) still draws every call, and a closed or unplaced pane gives the rows back.
const isLive = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane =>
    pane.id === PANE &&
    pane.isPlaced &&
    pane.isShown)

export const register: Register = on => {
  on(
    'session.start',
    async ($, e, next) => {
      const started = await next(e)
      await $.command.register({
        name: 'activity',
        description: 'Show what Claude opens, reads and runs, live, beside the chat',
      })
      $.clock.every(
        TICK_MS,
        () => void tick($))
      void open($)

      return started
    })

  on(
    'command.run',
    { command: 'activity' },
    async ($, e) => {
      const { isFullscreen, columns } = e.presentation
      await open(
        $,
        columns)
      // The dock beside the chat needs the fullscreen layout and 110 columns; else the pane sits above the prompt.
      const place = !isFullscreen
        ? 'above the prompt: docking it beside the chat needs Claude Code\'s fullscreen renderer. Run /tui fullscreen to switch for good (it is saved, and restarts and resumes this session)'
        : columns < 110
          ? `above the prompt: the window is ${columns} columns wide, and the pane docks beside the chat from 110`
          : 'beside the chat, a third of the window wide'

      return { text: `Live view opened ${place}.` }
    })

  on(
    'tool.call',
    async ($, e, next) => {
      const base = { agent: e.agentId ?? null, caption: captionOf(e), isError: false }
      if (e.tool === 'Bash')
        queue.push(stepsOf({
          ...base,
          isRunning: true,
          kind: 'bash',
          command: str(
            e,
            'command'),
          output: '',
        }))
      if (e.tool === 'Agent')
        queue.push(stepsOf({ ...base, isRunning: true, kind: 'note' }))

      const ran = await next(e)
      const isError =
        ran.deny !== undefined ||
        ran.isError === true
      queue.push(stepsOf({
        ...base,
        isRunning: false,
        isError,
        ...(await partOf(
          $,
          e,
          ran)),
      }))

      return ran
    })
    // Display only: a failure here never blocks the tool. In .catch, next is replay-safe:
    // once called it answers the settled result, so the tool never runs twice.
    .catch(($, e, next) => next(e))

  on(
    'ui.render',
    { component: 'ToolUse' },
    async ($, e, next) => {
      if (e.props.isExpanded === true || !(await isLive($))) return next(e)
      const { Box } = $.ui.resolve(e)

      return <Box />
    })

  on(
    'ui.render',
    { component: 'ToolResult' },
    async ($, e, next) => {
      if (e.props.isExpanded === true || !(await isLive($))) return next(e)
      const { Box } = $.ui.resolve(e)

      return <Box />
    })

  on(
    'ui.render',
    { component: 'ToolGroup' },
    async ($, e, next) => {
      if (e.props.isExpanded || !(await isLive($))) return next(e)
      const { Box } = $.ui.resolve(e)

      return <Box />
    })

  on(
    'ui.render',
    { component: 'Pane', requestId: PANE },
    async ($, e) => {
      const { Box, Code, Text } = $.ui.resolve(e)
      // A resize redraws the pane: keep the dock at a third of the new width.
      const terminalColumns = e.viewport?.columns
      if (terminalColumns !== undefined &&
        terminalColumns !== sizedFor)
        void open(
          $,
          terminalColumns)
      const now = await read(
        $,
        scene)
      const { phase, at } = await read(
        $,
        frame)
      // Text wraps to the pane's width, so the room is counted in wrapped rows, not lines.
      const columns = Math.max(
        1,
        e.props.bodyColumns)
      const heightOf = (text = '', width = columns) =>
        Math.max(
          1,
          Math.ceil(text.length / Math.max(1, width)))
      // The rows left for the content once the caption and the pane's other lines have wrapped.
      const roomFor = (...fixed: string[]) =>
        Math.max(
          3,
          e.props.scroll.bodyRows - fixed.reduce(
            (sum, text) => sum + heightOf(text),
            0))
      // The helpers below take each line's wrapped height. The first line to show so that `focus` sits mid-pane:
      const startAround = (heights: number[], focus: number, room: number) => {
        let start = Math.max(
          0,
          focus)
        for (let used = heights[start] ?? 1; start > 0 && used + (heights[start - 1] ?? 1) <= room / 2; start--)
          used += heights[start - 1] ?? 1
        return start
      }
      // The end of the lines from `start` on that fit in `room` (at least one).
      const endFrom = (heights: number[], start: number, room: number) => {
        let end = start
        for (let used = 0; end < heights.length && used + (heights[end] ?? 1) <= room; end++)
          used += heights[end] ?? 1
        return Math.max(
          end,
          start + 1)
      }
      // The start of the last lines that fit in `room` (at least one).
      const startOfLast = (heights: number[], room: number) => {
        let start = heights.length
        for (let used = 0; start > 0 && used + (heights[start - 1] ?? 1) <= room; start--)
          used += heights[start - 1] ?? 1
        return Math.min(
          start,
          Math.max(
            0,
            heights.length - 1))
      }

      if (now === null) return <Text color="suggestion" wrap="wrap">Waiting for Claude to open, read or run something…</Text>

      const caption = `${now.agent === null ? '' : 'helper · '}${now.caption}`
      const head = <Text color={now.isError ? 'error' : 'warning'} bold wrap="wrap">{caption}</Text>
      const where = (text: string) => <Text color="suggestion" wrap="wrap">{text}</Text>
      const crumbs = (path: string) => path
        .split('/')
        .filter(Boolean)
        .slice(-4)
        .join(' › ')

      if (now.kind === 'read' &&
        phase === 'folder') {
        const target = now.folder.findIndex(entry => entry.name === nameOf(now.path))
        const path = crumbs(dirOf(now.path))
        const status = `${now.folder.length} items`
        const names = now.folder.map((entry, i) => (i === target ? `▶ ${entry.name}` : `  ${entry.name}${entry.isDir ? '/' : ''}`))
        const room = roomFor(
          caption,
          path,
          status)
        const heights = names.map(name => heightOf(name))
        const from = startAround(
          heights,
          target,
          room)
        const to = endFrom(
          heights,
          from,
          room)

        return (
          <Box flexDirection="column">
            {head}
            {where(path)}
            {now.folder
              .slice(from, to)
              .map((entry, i) => (
                from + i === target
                  ? <Text color="warning" inverse bold wrap="wrap">{names[from + i]}</Text>
                  : <Text bold={entry.isDir} color={entry.isDir ? 'claude' : 'text'} wrap="wrap">{names[from + i]}</Text>
              ))}
            {where(status)}
          </Box>
        )
      }

      if (now.kind === 'read') {
        // Drawn by the engine's highlighter, language from the file's name. Each wrapped line keeps the
        // reading marker's column and the line-number gutter (the widest number and a space) free.
        const codeColumns = columns - 1 - (String(now.startLine + now.lines.length).length + 1)
        const heights = now.lines.map(text => heightOf(
          text,
          codeColumns))
        const path = crumbs(now.path)
        const status = `Claude read lines ${now.startLine}–${now.startLine + now.lines.length - 1} of ${now.totalLines}`
        const room = roomFor(
          caption,
          path,
          status)
        const from = at < 0
          ? 0
          : startAround(
            heights,
            at,
            room)
        const to = endFrom(
          heights,
          from,
          room)
        // The lines being read right now, marked by a yellow bar beside them.
        const bandStart = at < 0
          ? to
          : Math.min(
            Math.max(at, from),
            to)
        const bandEnd = at < 0
          ? to
          : Math.min(
            at + BAND,
            to)
        const code = (start: number, end: number) => (
          <Code
            source={now.lines.slice(start, end).join('\n')}
            path={now.path}
            startLine={now.startLine + start}
            wrap="wrap" />
        )
        const bar = heights
          .slice(bandStart, bandEnd)
          .reduce(
            (sum, height) => sum + height,
            0)

        return (
          <Box flexDirection="column">
            {head}
            {where(path)}
            {bandStart > from && <Box paddingLeft={1}>{code(from, bandStart)}</Box>}
            {bandEnd > bandStart && (
              <Box flexDirection="row">
                <Text color="warning" bold>{Array.from({ length: bar }, () => '▌').join('\n')}</Text>
                {code(bandStart, bandEnd)}
              </Box>
            )}
            {to > bandEnd && <Box paddingLeft={1}>{code(bandEnd, to)}</Box>}
            {where(status)}
          </Box>
        )
      }

      if (now.kind === 'diff') {
        // Each line with the old and new line numbers it sits at, so any tail of it is a valid diff.
        const numbered = now.hunks.flatMap((hunk, index) => {
          let oldLine = hunk.oldStart
          let newLine = hunk.start
          return hunk.lines.map(line => {
            const row = { hunk: index, sign: line[0] ?? ' ', text: line.slice(1), oldLine, newLine }
            if (row.sign !== '+') oldLine++
            if (row.sign !== '-') newLine++
            return row
          })
        })
        const added = numbered
          .filter(row => row.sign === '+')
          .length
        const removed = numbered
          .filter(row => row.sign === '-')
          .length
        const path = crumbs(now.path)
        const status = `Claude changed this file: +${added} −${removed}`
        // The diff gutter holds an old and a new line number and the +/− marker.
        const diffColumns = columns - (2 * String(numbered.at(-1)?.newLine ?? 1).length + 4)
        const revealed = numbered.slice(0, at)
        const from = startOfLast(
          revealed.map(row => heightOf(
            row.text,
            diffColumns)),
          roomFor(
            caption,
            path,
            status,
            '@@'))
        const source = revealed
          .slice(from)
          .reduce<{ hunk: number; rows: typeof numbered }[]>(
            (groups, row) => {
              const last = groups.at(-1)
              if (last?.hunk === row.hunk) last.rows.push(row)
              else groups.push({ hunk: row.hunk, rows: [row] })
              return groups
            },
            [])
          .map(({ rows }) => {
            const [first] = rows
            const olds = rows.filter(row => row.sign !== '+').length
            const news = rows.filter(row => row.sign !== '-').length
            return [`@@ -${first?.oldLine ?? 0},${olds} +${first?.newLine ?? 0},${news} @@`, ...rows.map(row => `${row.sign}${row.text}`)].join('\n')
          })
          .join('\n')

        return (
          <Box flexDirection="column">
            {head}
            {where(path)}
            {source !== '' && (
              <Code
                source={source}
                path={now.path}
                format="diff"
                wrap="wrap" />
            )}
            {where(status)}
          </Box>
        )
      }

      if (now.kind === 'bash') {
        const output = now.isRunning
          ? []
          : (now.output || '(no output)').split('\n')
        const command = now.isRunning ? now.command.slice(0, at) : now.command
        const status = now.isRunning ? 'running…' : now.isError ? 'failed' : 'done'
        const from = startOfLast(
          output.map(line => heightOf(line)),
          roomFor(
            caption,
            'Terminal',
            `$ ${command}`,
            status))

        return (
          <Box flexDirection="column">
            {head}
            {where('Terminal')}
            <Text bold wrap="wrap"><Text color="bashBorder">$ </Text>{command}</Text>
            {output
              .slice(from)
              .map(line => <Text color={now.isError ? 'error' : 'text'} wrap="wrap">{line}</Text>)}
            {where(status)}
          </Box>
        )
      }

      if (now.kind === 'web') {
        const lines = now.text.split('\n')
        const to = endFrom(
          lines.map(line => heightOf(line)),
          0,
          roomFor(
            caption,
            'Browser',
            now.url))

        return (
          <Box flexDirection="column">
            {head}
            {where('Browser')}
            <Text color="suggestion" underline wrap="wrap">{now.url}</Text>
            {lines
              .slice(0, to)
              .map(line => <Text color="text" wrap="wrap">{line}</Text>)}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          {head}
          {where(now.isRunning ? 'working…' : now.isError ? 'failed' : 'done')}
        </Box>
      )
    })
}
