/** What the panel shows of today's day file. */
export type Feed = {
  /** The local day the lines are from, `YYYY-MM-DD`; empty before the first read. */
  day: string
  /** The newest lines of that day's file, oldest first. */
  lines: string[]
  /** The file's mtime when the lines were read; 0 when the file did not exist. */
  mtimeMs: number
}

/** A running local session as the panel lists it. */
export type Peer = {
  sessionId: string
  name: string
  kind?: string
  status?: string
  /** The short id `claude stop` takes; background sessions only. */
  id?: string
  startedAt?: number
  /** The name of its working folder. */
  project?: string
  /** Its working folder and process id, to bring its window forward. */
  cwd?: string
  pid?: number
  /**
   * How full its context window is. `estimated` when read off its transcript
   * (no huddle loaded there); no `percent` when its window is unknown.
   */
  context?: { percent?: number; tokens?: number; estimated?: true }
  /** The effort level it last ran at (`high`); absent on a model without effort. */
  effort?: string
  /** Its last post through huddle, and the names it mentioned. */
  post?: { at: number; to: string[] }
}

declare module 'claude-code' {
  interface PluginState {
    huddle: {
      feed: Shaped<Feed>
      /**
       * What the pane last put in the post box (cleared after a post, a
       * mention added); drawn as its `value`, so it changes only then.
       */
      draft: string
      /** What the post box holds as typed; nothing drawn reads it. */
      typing: string
      /** How many lines tall the post box is drawn, 1 to 3. */
      postRows: number
      /** One dim line under the feed: what went wrong with the last post or stop. */
      notice: string
      /** The running sessions, this one included. */
      peers: Shaped<Peer[]>
      /** The long posts opened past their first rows, by their line. */
      expanded: string[]
      /** Whether the session list is expanded. */
      showPeers: boolean
    }
  }
}
