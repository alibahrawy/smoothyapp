// Small text-only formatter: provider output never becomes HTML, URLs or images.
export function renderChatReply(target, text) {
  const doc = target.ownerDocument;
  const inline = (parent, value) => {
    let position = 0;
    for (const match of value.matchAll(/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g)) {
      parent.append(doc.createTextNode(value.slice(position, match.index)));
      const node = doc.createElement(match[1] ? 'strong' : 'code');
      node.textContent = match[1] || match[2]; parent.append(node);
      position = match.index + match[0].length;
    }
    parent.append(doc.createTextNode(value.slice(position)));
  };
  let paragraph = [], list = null, code = null, codeLines = [];
  const flush = () => { if (paragraph.length) { const p = doc.createElement('p'); inline(p, paragraph.join('\n')); target.append(p); paragraph = []; } };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush(); list = null;
      if (code) { code.textContent = codeLines.join('\n'); target.append(code); code = null; }
      else { code = doc.createElement('pre'); codeLines = []; }
      continue;
    }
    if (code) { codeLines.push(line); continue; }
    if (!line.trim()) { flush(); list = null; continue; }
    const numbered = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numbered) {
      flush(); if (!list) { list = doc.createElement('ol'); list.start = Number(numbered[1]); target.append(list); }
      const item = doc.createElement('li'); inline(item, numbered[2]); list.append(item); continue;
    }
    list = null;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { flush(); const title = doc.createElement('h4'); inline(title, heading[1]); target.append(title); }
    else paragraph.push(line);
  }
  flush(); if (code) { code.textContent = codeLines.join('\n'); target.append(code); }
}
