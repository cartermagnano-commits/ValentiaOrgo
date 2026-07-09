// Clipboard image extraction shared by every image-upload surface, so a
// screen snip can be pasted (Ctrl+V) anywhere an upload is accepted.

/** Return the first image File in a paste event's clipboard, or null. */
export function imageFileFromClipboard(event) {
  const items = event.clipboardData?.items
  if (!items) return null
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      return item.getAsFile()
    }
  }
  return null
}

/** Read an image straight from the system clipboard (for one-click "Paste"
 *  buttons — no Ctrl+V needed). Returns a File, or null when the clipboard
 *  holds no image. Throws when the browser blocks or lacks clipboard access;
 *  the message is user-facing. */
export async function readImageFromClipboard() {
  if (!navigator.clipboard?.read) {
    throw new Error('This browser does not allow clipboard reading — use Ctrl+V instead.')
  }
  let items
  try {
    items = await navigator.clipboard.read()
  } catch {
    throw new Error('Clipboard access was blocked — allow it in the browser prompt, or use Ctrl+V.')
  }
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (type) {
      const blob = await item.getType(type)
      return new File([blob], 'clipboard.png', { type })
    }
  }
  return null
}

/** True when the paste landed in a text field that should keep the event
 *  (chat box, notes, SMILES field) rather than a page-level image handler. */
export function pasteTargetIsEditable(event) {
  const t = event.target
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}
