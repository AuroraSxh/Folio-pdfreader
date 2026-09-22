type DesktopPlatform = 'darwin' | 'win32' | 'linux';

const browserPlatform = typeof navigator === 'undefined' ? '' : navigator.platform;
// Native preload is authoritative. The fallback keeps browser development readable.
export const PLATFORM: DesktopPlatform = (typeof window === 'undefined' ? undefined : window.folio?.platform)
  ?? (/Mac|iPhone|iPad/.test(browserPlatform) ? 'darwin' : /Win/i.test(browserPlatform) ? 'win32' : 'linux');
export const PLATFORM_LABEL = PLATFORM === 'darwin' ? 'macOS' : PLATFORM === 'win32' ? 'Windows' : 'Linux';
export const FILE_MANAGER = PLATFORM === 'darwin' ? 'Finder' : PLATFORM === 'win32' ? '文件资源管理器' : '文件管理器';
export const TRASH_NAME = PLATFORM === 'darwin' ? '废纸篓' : '回收站';

export function shortcutLabel(key: string, platform: DesktopPlatform = PLATFORM): string {
  return platform === 'darwin' ? `⌘ ${key}` : `Ctrl+${key}`;
}

export function hasPrimaryModifier(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>, platform: DesktopPlatform = PLATFORM): boolean {
  return platform === 'darwin' ? event.metaKey : event.ctrlKey;
}
