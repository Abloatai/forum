// Adapted from Coding composer/matching.ts and references/matching.ts at
// e8dad3f9f0b8f2ae5247a266ba78dfd8ce7467dc; slash tokens share the caret boundary.
export function composerToken(text: string, cursor: number) {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const model=/(?:^|\s)(\/model [^\n#@/]*)$/.exec(text.slice(0,cursor));
  if(model)return {trigger:'/',query:model[1]!.slice(1),start:cursor-model[1]!.length,end:cursor};
  const match = /(?:^|\s)([#@/])([^\s#@/]*)$/.exec(text.slice(0, cursor));
  return match ? {trigger: match[1]!, query: match[2]!, start: cursor - match[2]!.length - 1, end: cursor} : null;
}

export function insertReference(text: string, token: {start: number; end: number}, value: string) {
  return text.slice(0, token.start) + value + ' ' + text.slice(token.end);
}

export function referenceRanges(text: string, references: readonly string[]) {
  const candidates = [...new Set(references)].sort((a, b) => b.length - a.length);
  const ranges: {start: number; end: number}[] = [];
  for (const match of text.matchAll(/(?:^|\s)[@#]/g)) {
    const start = match.index + match[0].length - 1;
    if (start < (ranges.at(-1)?.end ?? 0)) continue;
    const reference = candidates.find(value => text.startsWith(value, start) && (start + value.length === text.length || /[\s.,!?;:)\]}]/.test(text[start + value.length]!)));
    if (reference) ranges.push({start, end: start + reference.length});
  }
  return ranges;
}
