# Live activity

## Purpose

A Claude Code mod that shows, live, what Claude does in a pane docked beside the chat, as if watching someone use the computer, so the chat itself keeps only Claude's replies.

## Architecture

One function-hooks plugin, `live-activity`, whose repository is also its own marketplace (`.claude-plugin/marketplace.json`, source `./`).

- `hooks/register.tsx` is the hooks module. A `tool.call` hook turns each tool call (Claude's and its subagents') into a short list of animation steps, built from the call's input and result. A 100 ms `clock.every` tick plays one step at a time into two state atoms (`scene`: the call and what it saw; `frame`: how far its animation is), and the `ui.render` hook for the pane draws them.
- `types/index.d.ts` is the state contract (`Scene`, `Frame`) that `claude plugin validate` holds the module to.
- `tests/activity.test.tsx` runs under `claude plugin test`, with a mock clock moved by hand.

## Features

- **Live pane.** A read shows the file's folder with the file picked, then the lines read as syntax-highlighted code (the engine's `Code` element, its language taken from the file name, with a line-number gutter) and a yellow bar beside the lines being read, sweeping down them; a command types itself after `$ `, shows `running…`, then its output (red when it failed); an edit shows a highlighted unified diff (`Code` with `format: 'diff'`, each hunk numbered from the file's old and new lines) with a `+n −m` count; a web fetch shows the URL and page text. Subagent steps are labelled `helper ·`. Falling behind halves each step's time, and far behind only each call's last step shows. Text wraps to the pane's width instead of being cut off, and what fits is counted in wrapped rows, so the reading band stays mid-pane and the newest output and diff lines stay in view. Text uses the theme's bright colours (`text`, `suggestion`, `warning`, `success`, `error`), with no dim text.
- **Placement.** The pane requests a third of the terminal's width when opened and again after each resize (a width the person drags to wins). It docks beside the chat in the fullscreen layout from 110 columns and sits above the prompt otherwise; it opens on the person's first typed prompt of each session, which Claude Code counts as the person's own action and so places at any width (opened unasked at session start it would wait for 144 columns), and `/activity` reopens it at any width and says where it went and why (the window's width, the fullscreen layout).
- **Chat without tool rows.** While the pane is placed and shown, `ui.render` hooks on `ToolUse`, `ToolResult` and `ToolGroup` draw those rows as nothing; ctrl+o (an expanded row) still draws every call, and the rows come back when the pane is closed or waits unplaced.
- **Plain text only.** Terminal escape sequences and control characters are stripped from everything the pane draws: paths, folder names, file lines, diff lines, commands, output, URLs and captions.
- **Display only.** A failure in the mod never blocks a tool call, and nothing reaches the model, so it uses no tokens.

**Key files:** `hooks/register.tsx`, `types/index.d.ts`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `tests/activity.test.tsx`

## Integrations

- Claude Code's function-hooks plugin API (`tool.call`, `ui.render`, `ui.open`, `ui.panes`, `clock.every`, `fs.list`, `command.register`). No network calls and no model calls.

## Key Decisions

- One pane, one scene at a time (folder, then file, then terminal) rather than several windows, because the dock is narrow.
- Steps are played from an in-memory queue by a clock tick instead of drawing each call at once, so fast bursts of calls stay watchable; the queue is not kept across a reload.
- Tool rows are hidden only while the pane is actually on screen, so a closed or unplaced pane never leaves the chat without a record of what ran.
