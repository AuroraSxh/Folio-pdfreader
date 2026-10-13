import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UPDATE_RELEASES_URL, UPDATE_RELEASES_URLS, type UpdateSourcePreference, type UpdateStatus } from '../shared/updates';

type ActionsProps = React.ComponentProps<typeof import('../src/components/UpdatePanel').UpdateActions>;
type UI = {
  UpdateSourceSettings: ComponentType<{ value?: UpdateSourcePreference; saved?: UpdateSourcePreference; onChange: (source: UpdateSourcePreference) => void; disabled?: boolean }>;
  UpdateSourceDetails: ComponentType<{ status: UpdateStatus | null }>;
  UpdateActions: ComponentType<ActionsProps>;
  updateReleasePage: (status: UpdateStatus | null, fallback?: UpdateSourcePreference) => string;
  I18nProvider: ComponentType<{ language: 'en' | 'zh-CN'; children?: ReactNode }>;
};
let ui: UI;
before(async () => {
  const result = await build({ stdin: { contents: "export { UpdateSourceSettings, UpdateSourceDetails, UpdateActions, updateReleasePage } from './src/components/UpdatePanel'; export { I18nProvider } from './src/i18n';", resolveDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), loader: 'tsx' }, bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  ui = module.exports as UI;
});
const render = (element: ReactNode, language: 'en' | 'zh-CN' = 'en') => renderToStaticMarkup(createElement(ui.I18nProvider, { language }, element));
const available: UpdateStatus = { phase: 'available', currentVersion: '0.6.0', source: 'github', preferredSource: 'gitee', sourcePreference: 'auto', region: 'CN', sourceReason: 'source-fallback', release: { version: '0.7.0', url: `${UPDATE_RELEASES_URL}/tag/v0.7.0`, publishedAt: '2026-10-13', notes: '', downloadable: true, source: 'github' } };

test('source controls provide auto and both official mirrors with an explicit unsaved warning in each language', () => {
  const props = { value: 'gitee' as const, saved: 'auto' as const, onChange: () => {} };
  const english = render(createElement(ui.UpdateSourceSettings, props));
  assert.match(english, /aria-label="Update source"/);
  assert.match(english, /value="auto"/); assert.match(english, /value="gitee" selected/); assert.match(english, /value="github"/);
  assert.match(english, /source has not been saved/); assert.match(english, /Save settings/);
  assert.match(english, /proxy’s exit region/);
  const chinese = render(createElement(ui.UpdateSourceSettings, props), 'zh-CN');
  assert.match(chinese, /更新来源尚未保存/); assert.match(chinese, /中国大陆网络出口优先 Gitee/);
  assert.doesNotMatch(render(createElement(ui.UpdateSourceSettings, { ...props, saved: 'gitee' })), /source has not been saved/);
  assert.doesNotMatch(render(createElement(ui.UpdateSourceSettings, { onChange: () => {} })), /source has not been saved/);
});

test('unsaved sources disable checks and downloads while allowing a running download to be cancelled', () => {
  const props: ActionsProps = { status: available, pending: null, localError: null, run: async () => {}, openRelease: async () => {}, sourcePending: true };
  const html = render(createElement(ui.UpdateActions, props));
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  for (const label of ['Download installer', 'Check for updates']) {
    const button = buttons.find(match => match[2].includes(label)); assert.ok(button); assert.match(button[1], /disabled/);
  }
  const enabled = render(createElement(ui.UpdateActions, { ...props, sourcePending: false }));
  assert.doesNotMatch(enabled, /disabled/);
  const downloading = render(createElement(ui.UpdateActions, { ...props, status: { ...available, phase: 'downloading' } }));
  const cancel = [...downloading.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].includes('Cancel download'));
  assert.ok(cancel); assert.doesNotMatch(cancel[1], /disabled/);
});

test('actual release source and fallback reason are shown, separately from preferred network-region selection', () => {
  const english = render(createElement(ui.UpdateSourceDetails, { status: available }));
  assert.match(english, /Actual source: GitHub/);
  assert.match(english, /Network exit: mainland China/);
  assert.match(english, /Gitee did not return an available update/);
  const chinese = render(createElement(ui.UpdateSourceDetails, { status: available }), 'zh-CN');
  assert.match(chinese, /实际来源：GitHub/); assert.match(chinese, /本次改用 GitHub/);
  const newer = render(createElement(ui.UpdateSourceDetails, { status: { ...available, sourceReason: 'newer-on-other-source' } }));
  assert.match(newer, /newer version is available on the other source/);
  const unknown = render(createElement(ui.UpdateSourceDetails, { status: { ...available, region: 'unknown', sourceReason: 'region-unavailable' } }));
  assert.match(unknown, /region could not be determined/); assert.doesNotMatch(unknown, /Network exit: mainland China/);
  assert.equal(render(createElement(ui.UpdateSourceDetails, { status: null })), '');
});

test('release links follow the actual source or saved choice and retain the legacy GitHub constant', () => {
  assert.equal(UPDATE_RELEASES_URLS.github, UPDATE_RELEASES_URL);
  assert.equal(UPDATE_RELEASES_URLS.gitee, 'https://gitee.com/aurorasxh/pair-leaf/releases');
  assert.equal(ui.updateReleasePage(available, 'gitee'), available.release!.url);
  assert.equal(ui.updateReleasePage({ phase: 'error', currentVersion: '0.6.0', source: 'gitee' }), UPDATE_RELEASES_URLS.gitee);
  assert.equal(ui.updateReleasePage(null, 'gitee'), UPDATE_RELEASES_URLS.gitee);
  assert.equal(ui.updateReleasePage(null, 'github'), UPDATE_RELEASES_URLS.github);
  assert.equal(ui.updateReleasePage(null, 'auto'), UPDATE_RELEASES_URLS.github);
});
