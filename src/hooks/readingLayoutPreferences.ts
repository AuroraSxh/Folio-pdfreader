import { ASSISTANT_LIMITS, clampAssistantHeight, clampAssistantWidth, type AssistantPosition } from './floatingAssistantGeometry';

export interface ReadingLayout {
  navigation: 'rail' | 'expanded';
  assistantOpen: boolean;
  assistantMode: 'overlay' | 'docked';
  assistantWidth: number;
  assistantHeight: number | null;
  assistantPosition: AssistantPosition | null;
}

/** Older v1 preferences deliberately retain automatic height. */
export function parseReadingLayout(input: unknown): ReadingLayout {
  const saved = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const position = saved.assistantPosition as Partial<AssistantPosition> | null;
  return {
    navigation: saved.navigation === 'expanded' ? 'expanded' : 'rail',
    assistantOpen: saved.assistantOpen === true,
    assistantMode: saved.assistantMode === 'docked' ? 'docked' : 'overlay',
    assistantWidth: typeof saved.assistantWidth === 'number' && Number.isFinite(saved.assistantWidth) ? clampAssistantWidth(saved.assistantWidth) : ASSISTANT_LIMITS.width,
    assistantHeight: typeof saved.assistantHeight === 'number' && Number.isFinite(saved.assistantHeight) ? clampAssistantHeight(saved.assistantHeight) : null,
    assistantPosition: position && typeof position.x === 'number' && Number.isFinite(position.x) && typeof position.y === 'number' && Number.isFinite(position.y) ? { x: Math.max(0, position.x), y: Math.max(0, position.y) } : null,
  };
}
