// C3 file list: ordered list model plus rendering into an <ol>. Every file name is rendered as a
// text node inside <bdi translate="no"> (the raw name may hold bidi controls); no HTML is built from
// a name (T6, CS-7). The only other places a name appears are sentences made from string keys, with the name isolated.
import { t } from './strings.es.js';
import { formatSize } from './download.js';
import { isolate } from './status.js';
import { icon } from './icons.js';

// createFileList(listEl, onAction): onAction(action, id) is called for 'up' | 'down' | 'remove'.
export function createFileList(listEl, onAction) {
  const items = [];
  let nextId = 1;

  function fileName(entry) {
    const bdi = document.createElement('bdi');
    bdi.setAttribute('translate', 'no');
    bdi.className = 'file-name';
    bdi.textContent = entry.name;
    return bdi;
  }

  // A row button: a decorative icon and the verb. The accessible name is the aria-label (verb + file name).
  function button(entry, action, iconName, labelKey, ariaKey) {
    const b = document.createElement('button');
    b.type = 'button';
    b.classList.add('btn', 'btn-secondary', 'btn-small');
    b.dataset.id = String(entry.id);
    b.dataset.act = action;
    const label = document.createElement('span');
    label.textContent = t(labelKey);
    b.append(icon(iconName), label);
    b.setAttribute('aria-label', t(ariaKey, { name: isolate(entry.name) }));
    return b;
  }

  function row(entry, index) {
    const li = document.createElement('li');
    li.className = 'file-row';
    li.dataset.id = String(entry.id);
    li.dataset.state = entry.status;
    const mark = document.createElement('span');
    mark.className = 'file-icon';
    mark.appendChild(icon(entry.status === 'error' ? 'alert' : 'file-pdf'));
    li.appendChild(mark);
    const body = document.createElement('div');
    body.className = 'file-body';
    li.appendChild(body);
    const head = document.createElement('p');
    head.className = 'file-head';
    head.appendChild(fileName(entry));
    body.appendChild(head);

    const info = document.createElement('p');
    info.className = 'file-info';
    const parts = [
      t('common.rowPosition', { position: index + 1, total: items.length }),
      t('common.fileSize', { size: formatSize(entry.size) }),
    ];
    if (entry.status === 'ready' && Number.isInteger(entry.pages)) parts.push(t('common.pages', { count: entry.pages }));
    if (entry.status === 'checking') {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      spin.setAttribute('aria-hidden', 'true');
      info.appendChild(spin);
    }
    info.appendChild(document.createTextNode(parts.join(' · ')));
    body.appendChild(info);

    let errorId = null;
    if (entry.status === 'error') {
      errorId = `file-error-${entry.id}`;
      const err = document.createElement('p');
      err.id = errorId;
      err.className = 'file-error';
      err.setAttribute('translate', 'no'); // the message holds the file name
      // The text stays a direct text node of the paragraph; the icon is decorative.
      err.append(icon('alert'), document.createTextNode(t(`errors.${entry.errorCode}`, { name: isolate(entry.name) })));
      li.appendChild(err);
    }

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    actions.setAttribute('translate', 'no'); // the buttons' aria-labels hold the file name
    // First row: no "Subir"; last row: no "Bajar" (left out, not disabled).
    if (index > 0) actions.appendChild(button(entry, 'up', 'arrow-up', 'common.moveUp', 'common.moveUpAria'));
    if (index < items.length - 1) actions.appendChild(button(entry, 'down', 'arrow-down', 'common.moveDown', 'common.moveDownAria'));
    const remove = button(entry, 'remove', 'x', 'common.remove', 'common.removeAria');
    if (errorId) remove.setAttribute('aria-describedby', errorId);
    actions.appendChild(remove);
    li.appendChild(actions);
    return li;
  }

  function render() {
    listEl.replaceChildren(...items.map(row));
    listEl.hidden = items.length === 0;
  }

  listEl.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest('button[data-act]') : null;
    if (!target || !listEl.contains(target)) return;
    onAction(target.dataset.act, Number(target.dataset.id));
  });
  render();

  return {
    entries() { return items.slice(); },
    get(id) { return items.find((e) => e.id === id); },
    // files: File[] -> new entries (status 'checking'); the File is kept by reference.
    add(files) {
      const added = files.map((file) => ({
        id: nextId++, file, name: file.name, size: file.size, status: 'checking', kind: null,
      }));
      items.push(...added);
      render();
      return added;
    },
    // Changes fields of one entry (kind, status, errorCode, pages) and redraws; a removed id is ignored.
    update(id, patch) {
      const entry = items.find((e) => e.id === id);
      if (!entry) return;
      Object.assign(entry, patch);
      render();
    },
    // Returns { entry, index } or null.
    remove(id) {
      const index = items.findIndex((e) => e.id === id);
      if (index < 0) return null;
      const [entry] = items.splice(index, 1);
      render();
      return { entry, index };
    },
    // delta -1 (up) or +1 (down); returns the new index, or -1 when it cannot move.
    move(id, delta) {
      const from = items.findIndex((e) => e.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= items.length) return -1;
      const [entry] = items.splice(from, 1);
      items.splice(to, 0, entry);
      render();
      return to;
    },
    clear() {
      items.length = 0;
      render();
    },
    // Focuses the `action` button of a row; when that row has none (an edge), its sibling move button.
    focusButton(id, action) {
      const order = action === 'up' ? ['up', 'down', 'remove'] : action === 'down' ? ['down', 'up', 'remove'] : [action];
      for (const act of order) {
        const b = listEl.querySelector(`button[data-id="${id}"][data-act="${act}"]`);
        if (b) { b.focus(); return true; }
      }
      return false;
    },
  };
}
