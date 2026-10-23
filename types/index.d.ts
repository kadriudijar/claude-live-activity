export type Entry = { name: string; isDir: boolean }
export type Hunk = { oldStart: number; start: number; lines: string[] }
export type Part =
  | { kind: 'read'; path: string; folder: Entry[]; startLine: number; totalLines: number; lines: string[] }
  | { kind: 'diff'; path: string; hunks: Hunk[] }
  | { kind: 'bash'; command: string; output: string }
  | { kind: 'web'; url: string; text: string }
  | { kind: 'note' }

// What the pane shows: one tool call, and how far its animation has got.
export type Scene = { agent: string | null; caption: string; isError: boolean; isRunning: boolean } & Part
export type Frame = { phase: 'folder' | 'read' | 'type' | 'show'; at: number }

declare module 'claude-code' {
  interface PluginState {
    'live-activity': { scene: Shaped<Scene | null>; frame: Frame }
  }
}
