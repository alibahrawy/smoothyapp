let selected='premiere';
export const editorName=()=>selected==='resolve'?'DaVinci Resolve':'Premiere';
export const editorPool=()=>selected==='resolve'?'Media Pool':'Project panel';
export const editorText=text=>selected==='resolve'?text.replace(/Premiere(?: Pro)?/g,'DaVinci Resolve').replace(/Project panel/g,'Media Pool').replace(/Premiere-ready/g,'editor-ready'):text;
export function setEditorContext(editor){const next=editor==='resolve'?'resolve':'premiere',changed=next!==selected;selected=next;return changed;}
export function updateEditorLabels(){
  for(const el of document.querySelectorAll('[data-editor-copy]'))el.textContent=editorText(el.dataset.editorCopy).replace('send it straight to your DaVinci Resolve timeline','import it into Resolve’s Media Pool');
  for(const el of document.querySelectorAll('[data-editor-send]')){
    const text=[...el.childNodes].findLast(node=>node.nodeType===3 && node.textContent.trim());
    if(text)text.textContent=' Send to '+editorName();else el.append('Send to '+editorName());
    el.title=selected==='resolve'?'Import using Workspace → Scripts → Receive from Smoothy in Resolve':'Send to Premiere';
  }
  const stockNote=document.getElementById('stock-premiere-note');if(stockNote && selected==='resolve')stockNote.textContent='Send the MP4 to Resolve’s Media Pool using Workspace → Scripts → Receive from Smoothy. Then drag it onto your timeline.';
  const captionNote=document.getElementById('captions-action-note');
  if(captionNote)captionNote.textContent=selected==='resolve'?'Imports an SRT into Resolve’s Media Pool using Receive from Smoothy. Drag it onto a subtitle track. Sequence audio uses exported source channels without mixer effects.':captionNote.dataset.editorCopy;
  const source=document.getElementById('captions-source-sequence');if(source)source.textContent=selected==='resolve'?'DaVinci Resolve Timeline':'Premiere Sequence';
  for(const el of document.querySelectorAll('[data-resolve-source]'))el.classList.toggle('hidden',selected!=='resolve');
}
