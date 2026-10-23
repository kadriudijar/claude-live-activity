# Live activity for Claude Code

Watch what Claude does while it works, live, in a pane beside the chat: the folder and file it opens, the lines it reads, the commands it runs with their output, and the edits it makes. While the pane is on screen, the chat keeps only Claude's replies.

```
chat (2/3)                          │ Opening README.md
                                    │ code › todo-app › README.md
> explain this repo                 │   3 ## What it does
                                    │ ▌ 5 A small todo app with a REST API
This is a small todo app with a     │ ▌ 6 and a React front end. Tasks are
REST API and a React front end…     │   7 stored in SQLite.
                                    │ Claude read lines 1–42 of 42
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install live-activity --marketplace kadriudijar/claude-live-activity
```

Answer `y` to add the marketplace, then press Enter to install it for your user. It is active right away.

From a shell:

```
claude plugin install live-activity --marketplace kadriudijar/claude-live-activity
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `kadriudijar/claude-live-activity`, then Add plugin.

## Use

- `/activity` opens the pane. It docks beside the chat, a third of the window wide, once the terminal is at least 110 columns wide and in Claude Code's fullscreen layout; narrower, it sits above the prompt. From 144 columns it opens by itself when a session starts.
- What it shows for each tool call:
  - **Reading a file:** the file's folder with the file picked (`▶`), then the lines read as syntax-highlighted code with line numbers, a yellow bar sweeping down beside the lines being read.
  - **Running a command:** `$ command` typed out, `running…`, then the output (red when it failed).
  - **Editing a file:** a highlighted diff of the change, and a `+n −m` count.
  - **Web fetches:** the URL and the page text.
  - **Subagents:** their steps are marked `helper ·`.
- While the pane is on screen, tool rows leave the chat. `ctrl+o` still shows every call in full, and the rows come back when the pane is closed or too narrow to show.
- Dragging the pane's divider sets your own width, which Claude Code keeps.

It uses no tokens: everything runs inside Claude Code on your machine and nothing is sent to the model. Terminal escape codes are removed from file contents and command output before they are drawn.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
