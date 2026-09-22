import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OpenDialogOptions } from 'electron';

/** Native Windows dialogs cannot combine openFile and openDirectory.
 * https://www.electronjs.org/docs/latest/api/dialog
 */
export function pdfDialogOptions(mode: 'files' | 'folder' | 'mixed' = 'mixed', platform: NodeJS.Platform = process.platform): OpenDialogOptions {
  if (mode === 'folder') return { title: '选择文章文件夹', properties: ['openDirectory'] };
  return {
    title: platform === 'darwin' && mode === 'mixed' ? '选择正文 PDF 和补充材料，或一个文章文件夹' : '选择正文 PDF 和补充材料',
    properties: platform === 'darwin' && mode === 'mixed' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  };
}

export function localFileURL(filename: string, platform: NodeJS.Platform = process.platform): string {
  return pathToFileURL(filename, { windows: platform === 'win32' }).href;
}

export function sameLocalPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const fsPath = platform === 'win32' ? path.win32 : path.posix;
  const a = fsPath.resolve(left), b = fsPath.resolve(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isApplicationURL(candidate: string, appFile: string, devURL?: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const url = new URL(candidate);
    if (devURL) {
      const dev = new URL(devURL), prefix = dev.pathname.replace(/\/$/, '');
      return url.origin === dev.origin && (url.pathname === prefix || url.pathname.startsWith(prefix + '/'));
    }
    if (url.protocol !== 'file:') return false;
    return sameLocalPath(fileURLToPath(url, { windows: platform === 'win32' }), fileURLToPath(localFileURL(appFile, platform), { windows: platform === 'win32' }), platform);
  } catch { return false; }
}

/** Windows Explorer sends associated PDFs as command-line arguments, not open-file events. */
export function pdfPathsFromArguments(argv: string[], cwd: string, platform: NodeJS.Platform = process.platform): string[] {
  const fsPath = platform === 'win32' ? path.win32 : path.posix;
  return [...new Set(argv.flatMap(value => {
    const arg = value.replace(/^"(.*)"$/, '$1');
    if (!arg || arg.startsWith('-')) return [];
    try {
      const filename = /^file:/i.test(arg) ? fileURLToPath(arg, { windows: platform === 'win32' }) : arg;
      if (/^https?:/i.test(filename) || !/\.pdf$/i.test(filename)) return [];
      return [fsPath.resolve(cwd, filename)];
    } catch { return []; }
  }))];
}
