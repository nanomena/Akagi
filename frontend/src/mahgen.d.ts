// mahgen ships its typings outside the package's `exports` map, where bundler
// resolution will not look. Only the one entry point the monitor calls is
// declared; the `<mah-gen>` element needs no types of its own.
declare module 'mahgen' {
  export class Mahgen {
    /** Draw `seq` and resolve to a PNG data URL. Rejects on a malformed sequence. */
    static render(seq: string, river: boolean): Promise<string>
  }
}
