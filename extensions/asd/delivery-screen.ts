import { randomUUID } from "node:crypto";

const SIGNATURE_CHARS = 24;
const NOISE = /[\s─-╿│█│┃┆┊|>›❯»·]+/g;
const BORDERS = /[─-╿│█│┃┆┊|>›❯»·]+/g;

export function deliveryMarker(): string {
  return `<!-- pi-asd-delivery:${randomUUID()} -->`;
}

export function screenFingerprint(screen: string): string {
  return screen.replace(NOISE, "");
}

export function screenLayout(screen: string): string {
  return screen.replace(BORDERS, "");
}

/** 结构解析失效时的最后防线：唯一 proof 是否还清楚可见在当前屏幕。 */
export function screenHasProof(screen: string, proof: string): boolean {
  const needle = screenFingerprint(proof);
  return needle.length > 0 && screenFingerprint(screen).includes(needle);
}

export function screenHasText(screen: string, text: string): boolean {
  const needle = screenFingerprint(text).slice(0, SIGNATURE_CHARS);
  return needle.length > 0 && screenFingerprint(screen).includes(needle);
}
