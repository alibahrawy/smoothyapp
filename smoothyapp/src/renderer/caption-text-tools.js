/** Literal subtitle search with Unicode-aware whole-word boundaries. */
export function findCaptionMatches(captions, query, { matchCase = false, wholeWords = false } = {}) {
  if (!query) return [];
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(pattern, matchCase ? 'gu' : 'giu');
  const wordCharacter = /[\p{L}\p{N}\p{M}_]/u;
  const matches = [];
  captions.forEach((caption, captionIndex) => {
    for (const match of caption.text.matchAll(expression)) {
      const start = match.index, end = start + match[0].length;
      if (wholeWords) {
        const before = Array.from(caption.text.slice(0, start)).at(-1) || '';
        const after = Array.from(caption.text.slice(end))[0] || '';
        if (wordCharacter.test(before) || wordCharacter.test(after)) continue;
      }
      matches.push({ captionIndex, start, end });
    }
  });
  return matches;
}

/** Replace only the supplied matches; preserve caption timing and literal replacement text. */
export function replaceCaptionMatches(captions, matches, replacement) {
  const byCaption = new Map();
  for (const match of matches) {
    if (!byCaption.has(match.captionIndex)) byCaption.set(match.captionIndex, []);
    byCaption.get(match.captionIndex).push(match);
  }
  return captions.map((caption, index) => {
    let text = caption.text;
    const occurrences = (byCaption.get(index) || []).toSorted((a, b) => b.start - a.start);
    for (const { start, end } of occurrences) text = text.slice(0, start) + replacement + text.slice(end);
    return { ...caption, text };
  });
}
