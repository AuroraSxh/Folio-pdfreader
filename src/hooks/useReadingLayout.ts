import { useCallback, useEffect, useState } from 'react';
import { clampAssistantHeight, clampAssistantWidth, type AssistantPosition } from './floatingAssistantGeometry';
import { parseReadingLayout, type ReadingLayout } from './readingLayoutPreferences';
export type { AssistantPosition } from './floatingAssistantGeometry';
export type { ReadingLayout } from './readingLayoutPreferences';
const STORAGE_KEY = 'folio.reading-layout.v1';

function readLayout(): ReadingLayout {
  try {
    return parseReadingLayout(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch { return parseReadingLayout(null); }
}

export default function useReadingLayout() {
  const [preferences, setPreferences] = useState(readLayout);
  const [focused, setFocused] = useState(false);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Reading remains usable when storage is unavailable. */ } }, [preferences]);
  const toggleNavigation = useCallback(() => { setFocused(false); setPreferences(value => ({ ...value, navigation: focused || value.navigation === 'rail' ? 'expanded' : 'rail' })); }, [focused]);
  const openAssistant = useCallback(() => { setFocused(false); setPreferences(value => ({ ...value, assistantOpen: true })); }, []);
  const closeAssistant = useCallback(() => setPreferences(value => ({ ...value, assistantOpen: false })), []);
  const toggleAssistant = useCallback(() => { setFocused(false); setPreferences(value => ({ ...value, assistantOpen: focused || !value.assistantOpen })); }, [focused]);
  const toggleDocked = useCallback(() => setPreferences(value => ({ ...value, assistantMode: value.assistantMode === 'overlay' ? 'docked' : 'overlay' })), []);
  const resizeAssistant = useCallback((width: number, position?: AssistantPosition, height?: number) => setPreferences(value => ({ ...value, assistantWidth: clampAssistantWidth(width), ...(position ? { assistantPosition: position } : {}), ...(height !== undefined ? { assistantHeight: clampAssistantHeight(height) } : {}) })), []);
  const moveAssistant = useCallback((position: AssistantPosition | null) => setPreferences(value => ({ ...value, assistantPosition: position })), []);
  const toggleFocus = useCallback(() => setFocused(value => !value), []);
  const exitFocus = useCallback(() => setFocused(false), []);
  return { preferences, focused, navigationExpanded: !focused && preferences.navigation === 'expanded', assistantOpen: !focused && preferences.assistantOpen, toggleNavigation, openAssistant, closeAssistant, toggleAssistant, toggleDocked, resizeAssistant, moveAssistant, toggleFocus, exitFocus };
}
