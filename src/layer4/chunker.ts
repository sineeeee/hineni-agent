/** Emit complete sentences in order; keep fenced code intact until message end. */
export class Chunker {
  private buffer = "";
  constructor(private emit: (text: string) => void) {}
  push(delta: string) {
    this.buffer += delta;
    this.drain(false);
  }
  flush() {
    this.drain(true);
  }
  discard() {
    this.buffer = "";
  }
  private drain(final: boolean) {
    if (final) {
      if (this.buffer.trim()) this.emit(this.buffer.trim());
      this.buffer = "";
      return;
    }
    let fence = false,
      cut = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer.slice(i, i + 3) === "```") {
        fence = !fence;
        i += 2;
        continue;
      }
      if (
        !fence &&
        (/[。！？\n]/.test(this.buffer[i]) ||
          (/[.!?]/.test(this.buffer[i]) && /\s/.test(this.buffer[i + 1] ?? "")))
      ) {
        let end = i + 1;
        // A closing quote/bracket may arrive in the next streamed delta.
        // Keep punctuation pending until the following character or message end.
        while (end < this.buffer.length && /[”’」』）》〉】〕〗〙〛"')\]]/.test(this.buffer[end]))
          end++;
        if (this.buffer[i] !== "\n" && end === this.buffer.length) continue;
        cut = end;
        i = end - 1;
      }
    }
    if (cut) {
      const text = this.buffer.slice(0, cut).trim();
      // Markdown numbering/markers are prefixes, not stand-alone sentences.
      if (/^(?:\d+[.)、]|[-*+]|#{1,6})\s*$/.test(text)) return;
      this.buffer = this.buffer.slice(cut);
      if (text) this.emit(text);
    }
  }
}
