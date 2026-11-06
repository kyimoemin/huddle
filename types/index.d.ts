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
  /** How full its context window is, 0 to 100; only sessions with huddle loaded report it. */
  context?: number
}

declare module 'claude-code' {
  interface PluginState {
    huddle: {
      feed: Shaped<Feed>
      /** What the post box holds, so it can be cleared after a post. */
      draft: string
      /** One dim line under the feed: what went wrong with the last post or stop. */
      notice: string
      /** The running sessions, this one included. */
      peers: Shaped<Peer[]>
      /** Whether the session list is expanded. */
      showPeers: boolean
    }
  }
}
