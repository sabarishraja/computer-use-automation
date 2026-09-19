/**
 * The legacy-affordance extractor.
 *
 * This function is serialised into the page and run inside each frame. It is the
 * answer to "the surface has no clean DOM": rather than asking the model to
 * invent a selector from raw HTML, we inventory every interactive control and,
 * for each one, work out the best handles available — accessible name, the
 * visual label recovered from adjacent static text, the form-control name, and
 * a canonical XPath as a last resort.
 *
 * Nothing is written to the page. Controls are addressed back by the canonical
 * XPath computed here, so observing a screen never mutates it — which matters
 * when the screen belongs to somebody's core banking system.
 */
export type RawControl = {
  xpath: string;
  role: string;
  tag: string;
  inputType?: string;
  name?: string;
  visualLabel?: string;
  labelFor?: string;
  fieldName?: string;
  value?: string;
  enabled: boolean;
  visible: boolean;
  rowKey?: string;
  columnIndex?: number;
  /** Header text of this cell's column, when the table has a header row. */
  columnHeader?: string;
  /**
   * 'interactive' controls can be acted on; 'value' cells can only be read.
   * Read-only cells must be inventoried too, or a capability could never
   * extract anything — the balance on a detail screen is plain table text.
   */
  kind: 'interactive' | 'value';
};

export function inventoryScript(): RawControl[] {
  const INTERACTIVE = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';

  function canonicalXPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}[${idx}]` : tag);
      node = parent;
    }
    return '/html/body/' + parts.slice(parts.indexOf('body') + 1).join('/');
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'hidden') return 'none';
      return 'textbox';
    }
    return 'generic';
  }

  function accessibleName(el: Element): string | undefined {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      // <input type="submit" value="Search"> — the value IS the accessible name.
      if (t === 'submit' || t === 'button' || t === 'reset') {
        const v = (el as HTMLInputElement).value;
        if (v && v.trim()) return v.trim();
      }
    }
    if (tag === 'a' || tag === 'button') {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const t = (lab?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = (wrapping.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const ph = el.getAttribute('placeholder');
    if (ph && ph.trim()) return ph.trim();
    return undefined;
  }

  /**
   * Recover the visual label. Table-layout apps put the label in the previous
   * <td> of the same <tr>; older forms put it in the preceding text node. Both
   * are tried, nearest first, and the result is trimmed of the trailing colon
   * that enterprise forms almost always carry.
   */
  function visualLabelOf(el: Element): string | undefined {
    const clean = (s: string | null | undefined): string | undefined => {
      const t = (s ?? '').replace(/\s+/g, ' ').trim().replace(/[:：]\s*$/, '');
      return t.length > 0 && t.length <= 60 ? t : undefined;
    };

    const cell = el.closest('td,th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        const t = clean(prev.textContent);
        if (t && !prev.querySelector(INTERACTIVE)) return t;
        prev = prev.previousElementSibling;
      }
    }

    // Preceding sibling text within the same container.
    let n: Node | null = el.previousSibling;
    while (n) {
      if (n.nodeType === 3) {
        const t = clean(n.textContent);
        if (t) return t;
      } else if (n.nodeType === 1 && !(n as Element).querySelector?.(INTERACTIVE)) {
        const t = clean((n as Element).textContent);
        if (t) return t;
      }
      n = n.previousSibling;
    }
    return undefined;
  }

  /** For table cells: the first cell of the row, which is what a human reads off. */
  function rowContext(el: Element): { rowKey?: string; columnIndex?: number } {
    const cell = el.closest('td,th');
    const row = cell?.closest('tr');
    if (!cell || !row) return {};
    const cells = Array.from(row.children);
    const columnIndex = cells.indexOf(cell);
    const first = cells[0];
    const rowKey = first && first !== cell ? (first.textContent ?? '').replace(/\s+/g, ' ').trim() : undefined;
    return { rowKey: rowKey || undefined, columnIndex };
  }

  function isVisible(el: Element): boolean {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el as HTMLElement);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /**
   * The row's most identifying cell: the longest text that reads like a label
   * rather than a value. Using the first cell would key the accounts grid on
   * the account number, which is data that changes per member; keying on
   * "SHARE SAVINGS" gives a row reference that holds for every member.
   */
  function bestRowKey(row: Element, self: Element): string | undefined {
    let best: string | undefined;
    for (const c of Array.from(row.children)) {
      if (c === self) continue;
      const t = (c.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length < 3 || t.length > 40) continue;
      const letters = (t.match(/[A-Za-z]/g) ?? []).length;
      if (letters < t.length * 0.5) continue; // mostly digits: a value, not a key
      if (!best || t.length > best.length) best = t;
    }
    return best;
  }

  function headerFor(table: Element, columnIndex: number): string | undefined {
    const firstRow = table.querySelector('tr');
    if (!firstRow) return undefined;
    const ths = Array.from(firstRow.children).filter((c) => c.tagName === 'TH');
    if (ths.length === 0) return undefined;
    const t = (ths[columnIndex]?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return t || undefined;
  }

  const out: RawControl[] = [];
  const seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
    if (seen.has(el)) continue;
    seen.add(el);
    const role = roleOf(el);
    if (role === 'none' || role === 'generic') continue;
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : undefined;
    const fieldName = (el as HTMLInputElement).name || undefined;
    const ctx = rowContext(el);
    const isSecretish = inputType === 'password';
    out.push({
      xpath: canonicalXPath(el),
      role,
      tag,
      inputType,
      name: accessibleName(el),
      visualLabel: visualLabelOf(el),
      labelFor: el.getAttribute('id') ? document.querySelector(`label[for="${CSS.escape(el.getAttribute('id')!)}"]`)?.textContent?.trim() : undefined,
      fieldName,
      // Never lift the contents of a password field out of the page.
      value: isSecretish ? undefined : (el as HTMLInputElement).value || undefined,
      enabled: !(el as HTMLInputElement).disabled,
      visible: isVisible(el),
      rowKey: ctx.rowKey,
      columnIndex: ctx.columnIndex,
      kind: 'interactive',
    });
  }

  /* --- second pass: readable value cells --- */
  let cells = 0;
  for (const cell of Array.from(document.querySelectorAll('td,th'))) {
    if (cells >= 80) break;
    if (cell.querySelector(INTERACTIVE)) continue; // it is a control container, not a value
    const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length === 0 || text.length > 80) continue;
    if (!isVisible(cell)) continue;

    const row = cell.closest('tr');
    const siblings = row ? Array.from(row.children) : [];
    const columnIndex = siblings.indexOf(cell);
    const prev = cell.previousElementSibling;
    const prevText = (prev?.textContent ?? '').replace(/\s+/g, ' ').trim();
    // A cell whose previous sibling ends in a colon is a labelled value.
    const labelCell = /[:：]$/.test(prevText) ? prevText.replace(/[:：]\s*$/, '') : undefined;
    const table = cell.closest('table');

    cells++;
    out.push({
      xpath: canonicalXPath(cell),
      role: 'cell',
      tag: cell.tagName.toLowerCase(),
      visualLabel: labelCell,
      value: text,
      enabled: true,
      visible: true,
      rowKey: row ? bestRowKey(row, cell) : undefined,
      columnIndex: columnIndex >= 0 ? columnIndex : undefined,
      columnHeader: table && columnIndex >= 0 ? headerFor(table, columnIndex) : undefined,
      kind: 'value',
    });
  }

  return out;
}
