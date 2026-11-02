import { getEncoding } from "js-tiktoken";
const enc = getEncoding("o200k_base");
export const tokens = (s: string) => enc.encode(s).length;
export const cut = (s: string, max: number) =>
  enc.decode(enc.encode(s).slice(0, Math.max(0, max)));
export const tail = (s: string, max: number) =>
  enc.decode(enc.encode(s).slice(-max));
export function chunks(s: string, size: number, overlap: number) {
  const a = enc.encode(s),
    out: string[] = [];
  for (let i = 0; i < a.length; i += size - overlap)
    out.push(enc.decode(a.slice(i, i + size)));
  return out;
}
