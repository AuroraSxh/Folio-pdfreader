import type { ProviderConfig, ReasoningEffort } from './types';
import { translate, type Language } from './i18n';

export interface QoderModel {
  id: string;
  name: string;
  vision: boolean;
  efforts: readonly ReasoningEffort[];
  canEnable: boolean;
  canDisable: boolean;
  defaultEffort?: ReasoningEffort;
}

/** Local Qoder catalog snapshot checked 2026-10-23 against exploration.json,
 * src/reasoning.mjs and src/bridge.mjs in qoder_fandai. No credentials are
 * imported. These are proxy aliases/capabilities, not the vendors' direct APIs.
 * Highest advertised effort is this app's default; unspecified controls stay
 * unspecified, and Auto remains an explicit user choice. */
export const QODER_MODELS: readonly QoderModel[] = [
  { id:'dmodel',name:'DeepSeek-V4-Pro',vision:true,efforts:['high','max'],canEnable:true,canDisable:true,defaultEffort:'max' },
  { id:'dfmodel',name:'DeepSeek-Flash',vision:true,efforts:['low','high','max'],canEnable:true,canDisable:true,defaultEffort:'max' },
  { id:'gmodel',name:'GLM-5.3',vision:true,efforts:['low','high','max'],canEnable:true,canDisable:false,defaultEffort:'max' },
  { id:'gfmodel',name:'GLM-5.3-Flash',vision:true,efforts:['high','max'],canEnable:true,canDisable:false,defaultEffort:'max' },
  { id:'gm51model',name:'GLM-5.2',vision:true,efforts:['high','max'],canEnable:true,canDisable:true,defaultEffort:'max' },
  { id:'kmodel_latest',name:'Kimi-K3',vision:true,efforts:['low','high','max'],canEnable:true,canDisable:false,defaultEffort:'max' },
  { id:'kmodel',name:'Kimi-K2.8-Preview',vision:true,efforts:['low','high','max'],canEnable:true,canDisable:false,defaultEffort:'max' },
  { id:'mmodel',name:'MiniMax-M2.7',vision:false,efforts:[],canEnable:false,canDisable:false },
  { id:'qmodel_38max',name:'Qwen3.8-Max',vision:true,efforts:['low','medium','xhigh'],canEnable:true,canDisable:true,defaultEffort:'xhigh' },
  { id:'qfmodel',name:'Qwen3.8-Flash',vision:true,efforts:['low','medium','xhigh'],canEnable:true,canDisable:true,defaultEffort:'xhigh' },
  { id:'qmodel_latest',name:'Qwen3.7-Max',vision:true,efforts:[],canEnable:true,canDisable:true },
  { id:'qmodel',name:'Qwen3.7-Plus',vision:true,efforts:[],canEnable:true,canDisable:true },
  { id:'q37fmodel',name:'Qwen3.7-Flash',vision:true,efforts:[],canEnable:false,canDisable:false },
  { id:'auto',name:'Qoder Auto',vision:true,efforts:[],canEnable:false,canDisable:false },
];
export const QODER_BASE_URL = 'http://127.0.0.1:8788/v1';
export function getQoderModel(model: string | undefined): QoderModel | undefined {
  return QODER_MODELS.find(item => item.id === model);
}

/** Require a literal loopback address and exact protocol route. URL parsers can
 * normalize decimal/hex IP aliases, so validate the raw authority as well. */
export function isQoderEndpoint(baseURL: string | undefined): boolean {
  if (typeof baseURL !== 'string') return false;
  const match = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?\/v1(?:\/chat\/completions)?\/?$/i.exec(baseURL.trim());
  return !!match && (!match[2] || Number(match[2]) <= 65535);
}
export function qoderEndpoint(baseURL: string, language: Language = 'zh-CN'): string {
  if (!isQoderEndpoint(baseURL)) throw new Error(translate(language,'Qoder 地址须为本机 HTTP 回环地址的 /v1 接口。','Qoder requires a local HTTP loopback endpoint at /v1.'));
  const url = new URL(baseURL.trim()); url.pathname = '/v1/chat/completions'; return url.href;
}

export function qoderReasoningFields(config: Pick<ProviderConfig,'model'|'thinking'|'reasoningEffort'>, language: Language = 'zh-CN'): { reasoning_effort?: ReasoningEffort | 'none'; thinking?: { type: 'enabled' | 'disabled' } } {
  const model = getQoderModel(config.model);
  if (!model) throw new Error(translate(language,'未知 Qoder 模型，请选择目录中的型号。','Unknown Qoder model. Choose a model from the catalog.'));
  if (config.thinking === false) {
    if (!model.canDisable) throw new Error(translate(language,'此 Qoder 模型未公开支持关闭思考。','This Qoder model does not advertise support for disabling thinking.'));
    return model.efforts.length ? { reasoning_effort: 'none' } : { thinking: { type:'disabled' } };
  }
  if (config.reasoningEffort !== undefined && !model.efforts.includes(config.reasoningEffort)) throw new Error(translate(language,'此 Qoder 模型不支持所选思考档位，请重新选择。','This Qoder model does not support the selected thinking level. Choose a supported level.'));
  if (model.defaultEffort) return { reasoning_effort: config.reasoningEffort ?? model.defaultEffort };
  if (model.canEnable) return { thinking: { type:'enabled' } };
  return {};
}
