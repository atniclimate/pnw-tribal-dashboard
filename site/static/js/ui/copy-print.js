// @ts-check
/**
 * Copy List and Print with the active filter note (blueprint 7.4). DOM module.
 *
 * Both outputs state the active filter, so a copied or printed list is never mistaken for the whole
 * directory. Copy uses the Clipboard API; when it is unavailable or refused, a read-only text area with
 * the list selected takes its place (never prompt()). Print writes the note into the page, then opens the
 * print dialog; print.css keeps the note and the list and drops the controls.
 */

/**
 * The text Copy List puts on the clipboard: the filter note, a blank line, then one line per item.
 * @param {string[]} lines
 * @param {string} filterNote
 * @returns {string}
 */
export function listText(lines, filterNote) {
  return [filterNote, '', ...lines].join('\n');
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function showFallback(text) {
  const host = document.querySelector('[data-copy-fallback]') ?? (() => {
    const section = document.createElement('section');
    section.setAttribute('data-copy-fallback', '');
    section.setAttribute('aria-label', 'Copy List');
    (document.querySelector('main') ?? document.body).append(section);
    return section;
  })();
  host.replaceChildren();
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = 'This browser did not allow copying. Select the text below and copy it.';
  const area = document.createElement('textarea');
  area.readOnly = true;
  area.rows = 8;
  area.value = text;
  area.setAttribute('aria-label', 'List to copy');
  area.className = 'copy-fallback__text';
  host.append(note, area);
  area.focus();
  area.select();
  return /** @type {HTMLElement} */ (area);
}

/**
 * Clipboard API with a selectable-text fallback; never prompt().
 * @param {string[]} lines
 * @param {string} filterNote
 * @returns {Promise<boolean>} true when the list is on the clipboard, false when the fallback text is shown
 */
export async function copyList(lines, filterNote) {
  const text = listText(lines, filterNote);
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      document.querySelector('[data-copy-fallback]')?.replaceChildren();
      return true;
    }
  } catch { /* refused: fall through to the selectable text */ }
  showFallback(text);
  return false;
}

/**
 * Writes the filter note where print.css keeps it, then opens the print dialog.
 * @param {string} filterNote
 * @returns {void}
 */
export function printWithNote(filterNote) {
  const el = document.querySelector('[data-filter-note]');
  if (el) el.textContent = filterNote;
  else {
    const p = document.createElement('p');
    p.className = 'callout callout--quiet';
    p.setAttribute('data-filter-note', '');
    p.textContent = filterNote;
    const title = document.querySelector('main .page-title');
    if (title) title.after(p);
    else document.querySelector('main')?.prepend(p);
  }
  globalThis.print();
}
