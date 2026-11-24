/**
 * Copies text to the clipboard. The async Clipboard API exists only in secure contexts, so a
 * phone opening OM by LAN address over plain http has none; a selected textarea still works there.
 * Resolves to whether the copy happened.
 */
export async function copyText(text: string): Promise<boolean> {
  if (hasClipboard(navigator.clipboard)) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permissions, focus): try the fallback below.
    }
  }
  return copyWithTextarea(text);
}

/** Whether the browser exposes the async Clipboard API (absent over plain http). */
function hasClipboard(value: unknown): value is Clipboard {
  return typeof value === 'object' && value !== null && 'writeText' in value;
}

function copyWithTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    // The only copy path that works without the async API; deprecated but still implemented.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
