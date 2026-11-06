/** Emit sentences in order, keeping trailing punctuation and small expressions attached. */
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

  // Wait for following content: a quote, emoji or kaomoji can span streamed deltas.
  private suffixEnd(start: number): number | undefined {
    let end = start;
    const faces = ["ᢉ𐭩", "•ﻌ•", "Ი︵𐑼", "qwq", "QAQ", "T_T", "^_^", ">_<"];
    while (end < this.buffer.length) {
      const rest = this.buffer.slice(end);
      const punctuation = rest.match(
        /^[\s。！？!?…～~”’」』）》〉】〕〗〙〛"')\]]+/u,
      );
      if (punctuation) {
        end += punctuation[0].length;
        continue;
      }
      const face = faces.find((x) => rest.startsWith(x));
      if (face) {
        end += face.length;
        continue;
      }
      if (faces.some((x) => x.startsWith(rest))) return undefined;
      // Parenthesized symbol faces, without consuming ordinary prose in brackets.
      const bracket = rest.match(/^[（(]([^()（）\n]{1,24})[）)]/u);
      if (bracket && !/[\p{Script=Han}A-Za-z0-9]/u.test(bracket[1])) {
        end += bracket[0].length;
        continue;
      }
      if (/^[（(][^()（）\n\p{Script=Han}A-Za-z0-9]{0,24}$/u.test(rest))
        return undefined;
      const emoji = rest.match(
        /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]+/u,
      );
      if (emoji) {
        end += emoji[0].length;
        continue;
      }
      if (rest.length === 1 && /[\uD800-\uDBFF]/.test(rest)) return undefined;
      return end;
    }
    return undefined;
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
        (/[。！？!?…\n]/.test(this.buffer[i]) ||
          (this.buffer[i] === "." && /[\s.]/.test(this.buffer[i + 1] ?? "")))
      ) {
        // Include a run of ASCII dots, while leaving decimal points and URLs alone.
        let start = i + 1;
        if (this.buffer[i] === ".") while (this.buffer[start] === ".") start++;
        const end = this.suffixEnd(start);
        if (end === undefined) break;
        cut = end;
        i = end - 1;
      }
    }
    if (cut) {
      const text = this.buffer.slice(0, cut).trim();
      if (/^(?:\d+[.)、]|[-*+]|#{1,6})\s*$/.test(text)) return;
      this.buffer = this.buffer.slice(cut);
      if (text) this.emit(text);
    }
  }
}
