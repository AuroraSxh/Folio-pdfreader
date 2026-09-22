import { useCallback, useEffect, useState } from 'react';

export interface AssistantPosition { x: number; y: number }
export interface ReadingLayout {
  navigation: 'rail' | 'expanded';
  assistantOpen: boolean;
  assistantMode: 'overlay' | 'docked';
  assistantWidth: number;
  assistantPosition: AssistantPosition | null;
}
const STORAGE_KEY = 'folio.reading-layout.v1';
const DEFAULT_LAYOUT: ReadingLayout = { navigation: 'rail', assistantOpen: false, assistantMode: 'overlay', assistantWidth: 360, assistantPosition: null };
const clampWidth = (width: number) => Math.max(320, Math.min(600, Math.round(width)));

function readLayout(): ReadingLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      navigation: saved.navigation === 'expanded' ? 'expanded' : 'rail',
      assistantOpen: saved.assistantOpen === true,
      assistantMode: saved.assistantMode === 'docked' ? 'docked' : 'overlay',
      assistantWidth: typeof saved.assistantWidth === 'number' && Number.isFinite(saved.assistantWidth) ? clampWidth(saved.assistantWidth) : 360,
      assistantPosition: saved.assistantPosition && Number.isFinite(saved.assistantPosition.x) && Number.isFinite(saved.assistantPosition.y) ? { x: Math.max(0, saved.assistantPosition.x), y: Math.max(0, saved.assistantPosition.y) } : null,
    };
  } catch { return { ...DEFAULT_LAYOUT }; }
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
  const resizeAssistant = useCallback((width: number, position?: AssistantPosition) => setPreferences(value => ({ ...value, assistantWidth: clampWidth(width), ...(position ? { assistantPosition: position } : {}) })), []);
  const moveAssistant = useCallback((position: AssistantPosition | null) => setPreferences(value => ({ ...value, assistantPosition: position })), []);
  const toggleFocus = useCallback(() => setFocused(value => !value), []);
  const exitFocus = useCallback(() => setFocused(false), []);
  return { preferences, focused, navigationExpanded: !focused && preferences.navigation === 'expanded', assistantOpen: !focused && preferences.assistantOpen, toggleNavigation, openAssistant, closeAssistant, toggleAssistant, toggleDocked, resizeAssistant, moveAssistant, toggleFocus, exitFocus };
}
