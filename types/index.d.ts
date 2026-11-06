/** What the panel shows of today's day file. */
export type Feed = {
  /** The local day the lines are from, `YYYY-MM-DD`; empty before the first read. */
  day: string
  /** The newest lines of that day's file, oldest first. */
  lines: string[]
  /** The file's mtime when the lines were read; 0 when the file did not exist. */
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    huddle: {
      feed: Shaped<Feed>
      /** What the post box holds, so it can be cleared after a post. */
      draft: string
      /** One dim line under the feed: what went wrong with the last post. */
      notice: string
    }
  }
}
