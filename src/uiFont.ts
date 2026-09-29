import { normalizeUIFontScale } from '../shared/uiFont';

/** Apply only typography, including menus rendered outside the app root. */
export function applyUIFontScale(value: unknown): void {
  document.documentElement.style.setProperty('--ui-font-scale', String(normalizeUIFontScale(value)));
}
