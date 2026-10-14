import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as storeModule from '../electron/store';
import { loadBackendModule } from './backend-harness';
import type { ProviderConfig } from '../shared/types';
const {SettingsStore}=await loadBackendModule<typeof import('../electron/settings')>('electron/settings.ts',{electron:{safeStorage:undefined},'./store':storeModule});
test('vision preferences default/migrate to auto, persist explicit modes, and reject invalid saves without keychain use',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pairleaf-image-settings-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const secure={isEncryptionAvailable:()=>{throw Error('keychain must not be called');},encryptString:()=>{throw Error('keychain must not be called');},decryptString:()=>{throw Error('keychain must not be called');}};
  let settings=new SettingsStore(directory,'/synthetic-library',secure);await settings.init();assert.equal(settings.public().providers.custom.vision,'auto');
  for(const vision of ['enabled','disabled','auto'] as const){const input=settings.public();input.providers.custom.vision=vision;await settings.save(input);settings=new SettingsStore(directory,'/synthetic-library',secure);await settings.init();assert.equal(settings.public().providers.custom.vision,vision);}
  const before=await fs.readFile(path.join(directory,'settings.json'),'utf8');const bad=settings.public();bad.providers.custom.vision='force' as ProviderConfig['vision'];await assert.rejects(settings.save(bad),/图片能力设置无效/);assert.equal(await fs.readFile(path.join(directory,'settings.json'),'utf8'),before);
  for(const vision of [undefined,null,'invalid',42]){await fs.writeFile(path.join(directory,'settings.json'),JSON.stringify({providers:{custom:{vision}}}));settings=new SettingsStore(directory,'/synthetic-library',secure);await settings.init();assert.equal(settings.public().providers.custom.vision,'auto');}
});
