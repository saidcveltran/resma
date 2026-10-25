// C9 download: result bytes -> typed Blob -> object URL -> a visible <a download> link.
// The Blob is always application/pdf (CS-4). The file name goes only into the download attribute.
import { t } from './strings.es.js';

const UNITS = ['B', 'KB', 'MB', 'GB'];

// 1536 -> "1,5 KB", 1468006 -> "1,4 MB" (Spanish decimal comma, at most one decimal).
export function formatSize(bytes) {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat('es', { maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}

// createDownload(slot, labelKey): offer(bytes, name) puts the link in `slot`; revoke() removes it
// and frees the object URL. Offering again revokes the previous one first.
export function createDownload(slot, labelKey) {
  let url = null;
  let link = null;

  function revoke() {
    if (link) link.remove();
    if (url) URL.revokeObjectURL(url);
    link = null;
    url = null;
  }

  return {
    revoke,
    offer(bytes, name) {
      revoke();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      url = URL.createObjectURL(blob);
      link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', name);
      link.textContent = t(labelKey, { size: formatSize(blob.size) });
      slot.appendChild(link);
      return link;
    },
  };
}
