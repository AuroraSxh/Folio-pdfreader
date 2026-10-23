import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { atomicWrite } from './store';
import type { Settings, ProviderId, ProviderConfig } from '../shared/types';
import { normalizeLanguage, translate, type Language } from '../shared/i18n';
import { DEFAULT_UI_FONT_SCALE, normalizeUIFontScale } from '../shared/uiFont';
import { requiresReplacementKey } from '../shared/provider-presets';
import { normalizeUpdateSourcePreference } from '../shared/updates';
import { QODER_BASE_URL, getQoderModel, isQoderEndpoint, qoderEndpoint, qoderReasoningFields } from '../shared/qoder';

export function defaultSettings(libraryPath:string):Settings {
  return {language:'zh-CN',autoCheckUpdates:true,updateSource:'auto',activeProvider:'deepseek',providers:{
    deepseek:{id:'deepseek',baseURL:'https://api.deepseek.com',model:'deepseek-flash',maxTokens:16384,thinking:true,reasoningEffort:'high',vision:'auto'},
    openai:{id:'openai',baseURL:'https://api.openai.com/v1',model:'',maxTokens:8192,vision:'auto'},
    anthropic:{id:'anthropic',baseURL:'https://api.anthropic.com',model:'',maxTokens:8192,vision:'auto'},
    custom:{id:'custom',baseURL:'http://127.0.0.1:11434/v1',model:'',maxTokens:8192,vision:'auto'},
    qoder:{id:'qoder',baseURL:QODER_BASE_URL,model:'kmodel_latest',maxTokens:8192,reasoningEffort:'max',vision:'auto'}
  },libraryPath,vaultPath:'',obsidianSubfolder:'Papers',autoSummary:false,autoMemory:true,contextMaxChars:180000,theme:'light',readingTheme:'white',annotationToolbar:'floating',uiFontScale:DEFAULT_UI_FONT_SCALE};
}

export class SettingsStore {
  private config:Settings;
  private writes:Promise<unknown>=Promise.resolve();
  private encryptedKeys=new Map<ProviderId,{key:string;encrypted:string}>();
  private qoderKeys=new Map<string,{key:string;encrypted:string;origin:string}>();
  constructor(private directory:string,libraryPath:string,private secureStorage:Pick<typeof safeStorage,'encryptString'|'decryptString'|'isEncryptionAvailable'>=safeStorage) {this.config=defaultSettings(libraryPath);}
  async init(){
    let stored:Record<string,unknown>;
    try{stored=JSON.parse(await fs.readFile(path.join(this.directory,'settings.json'),'utf8'));}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error(translate(this.getLanguage(),'设置文件损坏；请保留该文件并从备份恢复','The settings file is damaged. Keep it and restore from a backup.'));}
    const defaults=this.config;
    this.config={...defaults,...stored,libraryPath:defaults.libraryPath,providers:{...defaults.providers}} as Settings;
    this.config.language=normalizeLanguage(stored.language);
    this.config.autoCheckUpdates=stored.autoCheckUpdates!==false;
    this.config.updateSource=normalizeUpdateSourcePreference(stored.updateSource);
    this.config.uiFontScale=normalizeUIFontScale(stored.uiFontScale);
    if(!['floating','fixed','selection'].includes(this.config.annotationToolbar))this.config.annotationToolbar='floating';
    for(const id of Object.keys(defaults.providers) as ProviderId[]){
      const raw=((stored.providers as Record<string,unknown>)?.[id]??{}) as Record<string,unknown>;
      this.config.providers[id]={...defaults.providers[id],...raw,id,apiKey:undefined};
      this.config.providers[id].vision = ['auto', 'enabled', 'disabled'].includes(String(raw.vision)) ? raw.vision as 'auto'|'enabled'|'disabled' : 'auto';
      if(id==='qoder'){
        // Qoder credentials are scoped to BOTH proxy origin and model. Never
        // read local proxy key files or import another provider's saved key.
        const config=this.config.providers.qoder;
        delete (config as unknown as Record<string,unknown>).modelKeys;delete config.modelKeyStatus;
        const model=getQoderModel(config.model);
        // Undefined fields are omitted in JSON. A different selected model
        // must not inherit the default Kimi model's max effort on restart.
        config.reasoningEffort=model?.efforts.includes(raw.reasoningEffort as NonNullable<ProviderConfig['reasoningEffort']>)
          ? raw.reasoningEffort as ProviderConfig['reasoningEffort'] : model?.defaultEffort;
        if(isQoderEndpoint(config.baseURL)){
          const origin=new URL(config.baseURL).origin;
          const records=raw.modelKeys && typeof raw.modelKeys==='object' && !Array.isArray(raw.modelKeys) ? raw.modelKeys as Record<string,unknown> : {};
          for(const [model,value] of Object.entries(records)){
            const item=value as {origin?:unknown;encryptedKey?:unknown};
            if(!getQoderModel(model)||!item||item.origin!==origin||typeof item.encryptedKey!=='string')continue;
            try{const key=this.secureStorage.decryptString(Buffer.from(item.encryptedKey,'base64'));this.qoderKeys.set(model,{key,encrypted:item.encryptedKey,origin});}
            catch{throw new Error(translate(this.getLanguage(),'无法解密已保存的 API Key，请检查系统安全存储访问权限；密钥只能由原设备上的原用户解密','The saved API key could not be decrypted. Check system secure-storage access; only the original user on the original device can decrypt it.'));}
          }
          config.apiKey=this.qoderKeys.get(config.model)?.key;
        }
        delete (config as unknown as Record<string,unknown>).encryptedKey;
        continue;
      }
      if(typeof raw.encryptedKey==='string'){
        try{const key=this.secureStorage.decryptString(Buffer.from(raw.encryptedKey,'base64'));this.config.providers[id].apiKey=key;this.encryptedKeys.set(id,{key,encrypted:raw.encryptedKey});}
        catch{throw new Error(translate(this.getLanguage(),'无法解密已保存的 API Key，请检查系统安全存储访问权限；密钥只能由原设备上的原用户解密','The saved API key could not be decrypted. Check system secure-storage access; only the original user on the original device can decrypt it.'));}
      }
    }
  }
  get(){return structuredClone(this.config);}
  getLanguage():Language{return normalizeLanguage(this.config.language);}
  public(){const c=this.get();for(const p of Object.values(c.providers)){p.hasKey=!!p.apiKey;delete p.apiKey;delete (p as unknown as Record<string,unknown>).encryptedKey;delete (p as unknown as Record<string,unknown>).modelKeys;delete p.modelKeyStatus;}
    const qoder=c.providers.qoder;if(isQoderEndpoint(qoder.baseURL)){const origin=new URL(qoder.baseURL).origin;qoder.modelKeyStatus=Object.fromEntries([...this.qoderKeys].filter(([,value])=>value.origin===origin).map(([model,value])=>[model,!!value.key]));}return c;}
  async save(input:Settings){
    const next=this.writes.then(()=>this.saveNext(input));this.writes=next.catch(()=>{});return next;
  }
  private async saveNext(input:Settings){
    const language=normalizeLanguage(input.language),t=(zh:string,en:string)=>translate(language,zh,en);
    if(!['deepseek','openai','anthropic','custom','qoder'].includes(input.activeProvider))throw new Error(t('无效的 AI 服务商','Invalid AI provider.'));
    const next=this.get();
    const qoderKeys=new Map(this.qoderKeys);
    next.language=language;
    next.autoCheckUpdates=input.autoCheckUpdates!==false;
    next.updateSource=normalizeUpdateSourcePreference(input.updateSource);
    next.uiFontScale=normalizeUIFontScale(input.uiFontScale);
    next.activeProvider=input.activeProvider;
    for(const id of Object.keys(next.providers) as ProviderId[]){
      const p=input.providers[id];if(!p)continue;
      const baseURL=p.baseURL.trim().replace(/\/+$/,'');
      if(baseURL){let u:URL;try{u=new URL(baseURL);}catch{throw new Error(t('API 地址格式不正确','The API URL is invalid.'));}
        if(u.protocol!=='https:' && !(u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new Error(t('API 地址须使用 HTTPS；本机服务可使用 HTTP','The API URL must use HTTPS; local services may use HTTP.'));
        if(u.username||u.password)throw new Error(t('请在 API Key 输入框填写凭证','Enter credentials in the API Key field.'));
      }
      if(requiresReplacementKey(next.providers[id],{...p,baseURL}))throw new Error(t('API 地址已更换服务商或区域。请重新填写对应平台的 API Key 后保存。','The API address now points to another provider or region. Enter its API key before saving.'));
      if (p.vision !== undefined && !['auto', 'enabled', 'disabled'].includes(p.vision)) throw new Error(t('图片能力设置无效', 'Invalid image capability setting.'));
      if(id==='qoder'){
        qoderEndpoint(baseURL,language);
        const model=getQoderModel(p.model.trim());
        if(!model)throw new Error(t('未知 Qoder 模型，请选择目录中的型号。','Unknown Qoder model. Choose a model from the catalog.'));
        const candidate:ProviderConfig={id,baseURL,model:model.id,maxTokens:Math.max(256,Math.min(32000,Number(p.maxTokens)||8192)),thinking:p.thinking!==false,reasoningEffort:p.reasoningEffort??model.defaultEffort,vision:p.vision??'auto'};
        qoderReasoningFields(candidate,language);
        const origin=new URL(baseURL).origin;
        const replacement=p.apiKey?.trim();
        const originChanged=baseURL!==next.providers.qoder.baseURL&&new URL(next.providers.qoder.baseURL).origin!==origin;
        if(originChanged&&qoderKeys.size&&!replacement)throw new Error(t('API 地址已更换服务商或区域。请重新填写对应平台的 API Key 后保存。','The API address now points to another provider or region. Enter its API key before saving.'));
        if(originChanged)qoderKeys.clear();
        const saved=qoderKeys.get(model.id);
        candidate.apiKey=replacement||(saved?.origin===origin?saved.key:undefined);
        next.providers.qoder=candidate;
        continue;
      }
      next.providers[id]={id,baseURL,model:p.model.trim(),maxTokens:Math.max(256,Math.min(393216,Number(p.maxTokens)||8192)),thinking:p.thinking!==false,reasoningEffort:['low','high','max'].includes(p.reasoningEffort??'')?p.reasoningEffort:'high',vision:p.vision ?? 'auto',apiKey:p.apiKey?.trim()||next.providers[id].apiKey};
    }
    next.vaultPath=typeof input.vaultPath==='string'?input.vaultPath:next.vaultPath;
    if(next.vaultPath){
      const directory=await fs.stat(next.vaultPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!directory?.isDirectory())throw new Error(t('Obsidian 仓库目录不存在','The Obsidian vault folder does not exist.'));
    }
    const subfolder=input.obsidianSubfolder.replace(/\\/g,'/');
    if(path.isAbsolute(subfolder)||subfolder.split('/').some(p=>p==='..')||subfolder.includes('\0'))throw new Error(t('Obsidian 子目录必须在仓库内部','The Obsidian subfolder must stay inside the vault.'));
    next.obsidianSubfolder=subfolder;next.autoSummary=!!input.autoSummary;next.autoMemory=!!input.autoMemory;
    next.contextMaxChars=Math.max(10000,Math.min(1500000,Number(input.contextMaxChars)||180000));
    next.theme=input.theme==='dark'?'dark':'light';next.readingTheme=['white','sepia','dark'].includes(input.readingTheme)?input.readingTheme:'white';
    next.annotationToolbar=['floating','fixed','selection'].includes(input.annotationToolbar)?input.annotationToolbar:'floating';
    const stored=structuredClone(next) as unknown as Record<string,unknown>;
    const encryptedKeys=new Map(this.encryptedKeys);
    for(const [id,p] of Object.entries(stored.providers as Record<ProviderId,Record<string,unknown>>)){
      if(id==='qoder'){
        const selected=next.providers.qoder;
        if(selected.apiKey){
          const origin=new URL(selected.baseURL).origin,cached=qoderKeys.get(selected.model);
          if(cached?.key!==selected.apiKey||cached.origin!==origin){
            if(!this.secureStorage.isEncryptionAvailable())throw new Error(t('系统安全存储不可用，无法加密保存 API Key','System secure storage is unavailable; the API key could not be encrypted.'));
            qoderKeys.set(selected.model,{key:selected.apiKey,encrypted:this.secureStorage.encryptString(selected.apiKey).toString('base64'),origin});
          }
        }
        p.modelKeys=Object.fromEntries([...qoderKeys].map(([model,value])=>[model,{origin:value.origin,encryptedKey:value.encrypted}]));
        delete p.apiKey;delete p.hasKey;delete p.modelKeyStatus;delete p.encryptedKey;
        continue;
      }
      if(p.apiKey){
        const cached=encryptedKeys.get(id as ProviderId);
        if(cached?.key===p.apiKey)p.encryptedKey=cached.encrypted;
        else{
          if(!this.secureStorage.isEncryptionAvailable())throw new Error(t('系统安全存储不可用，无法加密保存 API Key','System secure storage is unavailable; the API key could not be encrypted.'));
          p.encryptedKey=this.secureStorage.encryptString(String(p.apiKey)).toString('base64');
          encryptedKeys.set(id as ProviderId,{key:String(p.apiKey),encrypted:String(p.encryptedKey)});
        }
      }
      delete p.apiKey;delete p.hasKey;
    }
    await atomicWrite(path.join(this.directory,'settings.json'),JSON.stringify(stored,null,2));this.config=next;this.encryptedKeys=encryptedKeys;this.qoderKeys=qoderKeys;return this.public();
  }
}
