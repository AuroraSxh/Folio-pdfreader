import type { ChatMessage } from '../shared/types';
import { sanitizeData } from '../shared/prompts';
import { translate, type Language } from '../shared/i18n';

interface WebQueryOptions {
  prompt: string; selectionText?: string; articleTitle: string;
  /** Only the active conversation, excluding the current question. */
  previousMessages: ChatMessage[]; language: Language;
}

const clip = (value: string, limit: number) => value.slice(0, limit > 0 && limit < value.length && /[\uD800-\uDBFF]/.test(value[limit - 1]) ? limit - 1 : limit);
const excerpt = (value: string, limit: number) => clip(sanitizeData(value).replace(/\s+/g, ' ').trim(), limit);

/** Conservative, local detection: self-contained questions must not inherit an
 * unrelated topic just because they start with "why" or "what about". */
function needsPriorTopic(value: string): boolean {
  const question = value.trim();
  if (question.length > 320 || /\b(?:new topic|unrelated question|switch(?:ing)? topics)\b|换个话题|另一个问题|不相关的问题/i.test(question)) return false;
  if (/\b(?:it|its|they|their|them|these|those)\b|\b(?:this|that)\s+(?:treatment|drug|therapy|study|paper|trial|result|method|finding|claim|approach|effect|evidence|one)\b/i.test(question)) return true;
  if (/^(?:what|how) about\s+(?:more|newer|older|later|earlier|recent|larger|smaller|other|additional|further|better|long[- ]term|short[- ]term|efficacy|safety|adverse|side effects?|trials?|studies|evidence|limitations?|mechanisms?|results?|follow[- ]up|replication|risks?|benefits?|dosing|dose|cost|outcomes?)\b/i.test(question)) return true;
  if (/^(?:and\s+(?:what|how) about\b|and\s+(?:the\s+)?(?:safety|efficacy|side effects?|limitations?|risks?|benefits?|trials?|studies|evidence)\b|(?:tell me|explain) more\b)/i.test(question)) return true;
  if (/^(?:(?:can you |please )?(?:find|look for|show me)\s+|any\s+)?(?:more|newer|later|further|additional|recent|latest|larger)\s+(?:(?:recent|clinical|randomized|controlled)\s+)*(?:trials?|studies|evidence|research|results?|data|updates?)(?:\s+(?:available|yet))?[?.!\s]*$/i.test(question)) return true;
  if (/^(?:那么|那|还有|另外还有|继续|进一步|再(?:找|查|看看)|它|他们|它们|上述|刚才|前面)|这(?:种|个|项|些|篇|段|类)(?:治疗|药物|疗法|研究|试验|结果|方法|发现|结论|证据)?/.test(question)) return true;
  return /^(?:有(?:没有)?|有没有|是否有|能否(?:找|查)(?:到)?|可以(?:找|查)(?:一下)?|请(?:找|查)(?:一下)?)?(?:更(?:新|近|大|多)|最近|最新|后续|近期)(?:的)?(?:临床)?(?:试验|研究|证据|结果|进展|数据|文献|论文)(?:吗|呢|[？?。！!\s])*$/.test(question);
}

function recentTopic(messages: ChatMessage[]): ChatMessage[] {
  const interruptedTurns = new Set(messages.filter(message => message.interrupted && message.turnId).map(message => message.turnId));
  const usable = messages.filter((message, index) => !message.interrupted && !(message.turnId && interruptedTurns.has(message.turnId))
    // Legacy conversations may predate turnId. Do not recycle the question
    // immediately preceding an interrupted answer as a completed topic.
    && !(message.role === 'user' && !message.turnId && messages[index + 1]?.role === 'assistant' && messages[index + 1].interrupted)).slice(-8);
  const questions = usable.filter(message => message.role === 'user');
  const latest = questions.at(-1);
  const anchor = [...questions].reverse().find(message => !needsPriorTopic(message.content));
  const chosen = anchor && anchor !== latest ? [anchor, latest!] : latest ? [latest] : [];
  const answer = [...usable].reverse().find(message => message.role === 'assistant');
  return [...chosen, ...(answer ? [answer] : [])];
}

/** A single native search request; never sends the full conversation or calls
 * a second model to rewrite a question. Current question/selection take priority. */
export function buildWebSearchQuery(options: WebQueryOptions): string {
  const t = (zh: string, en: string) => translate(options.language, zh, en);
  const question = clip(options.prompt.trim(), 1200), parts = [question];
  const selection = excerpt(options.selectionText ?? '', 500);
  if (selection) {
    parts.push(t('当前选文背景（仅用于确定检索主题，并非经网络核实的事实）：', 'Current selected passage (topic context, not web-verified facts): ') + selection);
  } else if (needsPriorTopic(question)) {
    const clues = recentTopic(options.previousMessages).map(message => `${message.role === 'user' ? t('此前问题', 'Earlier question') : t('此前回答', 'Earlier answer')}: ${excerpt(message.content, message.role === 'user' ? 180 : 200)}`);
    if (clues.length) parts.push(t('追问主题线索（仅消解当前问题的指代，并非已验证事实；以当前问题为准）：', 'Follow-up topic clues (resolve references only, not verified facts; prioritize the current question): ') + '\n' + clip(clues.join('\n'), 650));
  }
  if (parts.length === 1 && /本文|这篇|这段|这项|this (?:paper|study|passage)/i.test(question)) {
    const title = excerpt(options.articleTitle, 240);
    if (title) parts.push(t('当前论文标题（仅用于确定主题）：', 'Current paper title (topic context only): ') + title);
  }
  return clip(parts.join('\n'), 2000);
}
