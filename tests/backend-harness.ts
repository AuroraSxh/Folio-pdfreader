import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
/** Execute actual main-process source with explicitly injected Electron APIs.
 * No Electron process, user settings, keychain, or installer is opened. */
export async function loadBackendModule<T>(relativeFile: string, overrides: Record<string, unknown>, append = '', processOverride: NodeJS.Process = process, globals: Record<string, unknown> = {}): Promise<T> {
  const filename = path.join(root, relativeFile), source = await fs.readFile(filename, 'utf8');
  const { code } = await transform(source + '\n' + append, { loader: 'ts', format: 'cjs', target: 'node22', sourcefile: filename });
  const nodeRequire = createRequire(filename), module = { exports: {} };
  const require = (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : nodeRequire(name);
  new Function('require', 'module', 'exports', '__dirname', 'process', ...Object.keys(globals), code)(require, module, module.exports, path.dirname(filename), processOverride, ...Object.values(globals));
  return module.exports as T;
}
