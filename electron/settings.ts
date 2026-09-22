import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { atomicWrite } from './store';
import type { Settings, ProviderId } from '../shared/types';
import { normalizeLanguage, translate, type Language } from '../shared/i18n';

export function defaultSettings(libraryPath:string):Settings {
  return {language:'zh-CN',autoCheckUpdates:true,activeProvider:'deepseek',providers:{
    deepseek:{id:'deepseek',baseURL:'https://api.deepseek.com',model:'deepseek-flash',maxTokens:16384,thinking:true,reasoningEffort:'high'},
    openai:{id:'openai',baseURL:'https://api.openai.com/v1',model:'',maxTokens:8192},
    anthropic:{id:'anthropic',baseURL:'https://api.anthropic.com',model:'',maxTokens:8192},
    custom:{id:'custom',baseURL:'http://127.0.0.1:11434/v1',model:'',maxTokens:8192}
  },libraryPath,vaultPath:'',obsidianSubfolder:'Papers',autoSummary:false,autoMemory:true,contextMaxChars:180000,theme:'light',readingTheme:'white',annotationToolbar:'floating'};
}

export class SettingsStore {
  private config:Settings;
  private writes:Promise<unknown>=Promise.resolve();
  private encryptedKeys=new Map<ProviderId,{key:string;encrypted:string}>();
  constructor(private directory:string,libraryPath:string,private secureStorage:Pick<typeof safeStorage,'encryptString'|'decryptString'|'isEncryptionAvailable'>=safeStorage) {this.config=defaultSettings(libraryPath);}
  async init(){
    let stored:Record<string,unknown>;
    try{stored=JSON.parse(await fs.readFile(path.join(this.directory,'settings.json'),'utf8'));}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error(translate(this.getLanguage(),'设置文件损坏；请保留该文件并从备份恢复','The settings file is damaged. Keep it and restore from a backup.'));}
    const defaults=this.config;
    this.config={...defaults,...stored,libraryPath:defaults.libraryPath,providers:{...defaults.providers}} as Settings;
    this.config.language=normalizeLanguage(stored.language);
    this.config.autoCheckUpdates=stored.autoCheckUpdates!==false;
    if(!['floating','fixed','selection'].includes(this.config.annotationToolbar))this.config.annotationToolbar='floating';
    for(const id of Object.keys(defaults.providers) as ProviderId[]){
      const raw=((stored.providers as Record<string,unknown>)?.[id]??{}) as Record<string,unknown>;
      this.config.providers[id]={...defaults.providers[id],...raw,id,apiKey:undefined};
      if(typeof raw.encryptedKey==='string'){
        try{const key=this.secureStorage.decryptString(Buffer.from(raw.encryptedKey,'base64'));this.config.providers[id].apiKey=key;this.encryptedKeys.set(id,{key,encrypted:raw.encryptedKey});}
        catch{throw new Error(translate(this.getLanguage(),'无法解密已保存的 API Key，请检查系统安全存储访问权限；密钥只能由原设备上的原用户解密','The saved API key could not be decrypted. Check system secure-storage access; only the original user on the original device can decrypt it.'));}
      }
    }
  }
  get(){return structuredClone(this.config);}
  getLanguage():Language{return normalizeLanguage(this.config.language);}
  public(){const c=this.get();for(const p of Object.values(c.providers)){p.hasKey=!!p.apiKey;delete p.apiKey;delete (p as unknown as Record<string,unknown>).encryptedKey;}return c;}
  async save(input:Settings){
    const next=this.writes.then(()=>this.saveNext(input));this.writes=next.catch(()=>{});return next;
  }
  private async saveNext(input:Settings){
    const language=normalizeLanguage(input.language),t=(zh:string,en:string)=>translate(language,zh,en);
    if(!['deepseek','openai','anthropic','custom'].includes(input.activeProvider))throw new Error(t('无效的 AI 服务商','Invalid AI provider.'));
    const next=this.get();
    next.language=language;
    next.autoCheckUpdates=input.autoCheckUpdates!==false;
    next.activeProvider=input.activeProvider;
    for(const id of Object.keys(next.providers) as ProviderId[]){
      const p=input.providers[id];if(!p)continue;
      const baseURL=p.baseURL.trim().replace(/\/+$/,'');
      if(baseURL){let u:URL;try{u=new URL(baseURL);}catch{throw new Error(t('API 地址格式不正确','The API URL is invalid.'));}
        if(u.protocol!=='https:' && !(u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw new Error(t('API 地址须使用 HTTPS；本机服务可使用 HTTP','The API URL must use HTTPS; local services may use HTTP.'));
        if(u.username||u.password)throw new Error(t('请在 API Key 输入框填写凭证','Enter credentials in the API Key field.'));
      }
      next.providers[id]={id,baseURL,model:p.model.trim(),maxTokens:Math.max(256,Math.min(393216,Number(p.maxTokens)||8192)),thinking:p.thinking!==false,reasoningEffort:['low','high','max'].includes(p.reasoningEffort??'')?p.reasoningEffort:'high',apiKey:p.apiKey?.trim()||next.providers[id].apiKey};
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
    await atomicWrite(path.join(this.directory,'settings.json'),JSON.stringify(stored,null,2));this.config=next;this.encryptedKeys=encryptedKeys;return this.public();
  }
}
