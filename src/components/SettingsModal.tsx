import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Check, ChevronRight, Database, Download, Eye, EyeOff, FolderOpen, KeyRound, LoaderCircle, ShieldCheck, SlidersHorizontal, Sparkles, Upload, X, Zap } from 'lucide-react';
import type { ProviderConfig, ProviderId, Settings } from '../../shared/types';
import './ui-components.css';

interface Props { settings: Settings; onClose: () => void; onSaved: (settings: Settings) => void; onRefresh: () => void; onError: (message: string) => void }
const PROVIDERS: { id: ProviderId; title: string; subtitle: string }[] = [{ id: 'deepseek', title: 'DeepSeek', subtitle: 'Flash / Pro' }, { id: 'openai', title: 'OpenAI', subtitle: 'GPT 系列' }, { id: 'anthropic', title: 'Anthropic', subtitle: 'Claude 系列' }, { id: 'custom', title: '自定义', subtitle: '兼容 OpenAI' }];
const SECTIONS = [{ id: 'ai', label: 'AI 阅读助手', icon: Sparkles }, { id: 'reading', label: '阅读偏好', icon: BookOpen }, { id: 'obsidian', label: 'Obsidian', icon: FolderOpen }, { id: 'data', label: '数据与备份', icon: Database }] as const;
function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description: string }) {
  return <div className="fl-toggle-row"><div><strong>{label}</strong><p>{description}</p></div><button type="button" className={`fl-toggle ${checked ? 'checked' : ''}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button></div>;
}

export default function SettingsModal({ settings, onClose, onSaved, onRefresh, onError }: Props) {
  const [draft, setDraft] = useState<Settings>(() => ({ ...settings, annotationToolbar: settings.annotationToolbar ?? 'floating', providers: Object.fromEntries(Object.entries(settings.providers).map(([key, config]) => [key, { ...config, apiKey: undefined }])) as Settings['providers'] }));
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('ai');
  const [provider, setProvider] = useState<ProviderId>(settings.activeProvider);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);
  const providerConfig = draft.providers[provider];
  const patchProvider = (patch: Partial<ProviderConfig>) => setDraft(previous => ({ ...previous, providers: { ...previous.providers, [provider]: { ...previous.providers[provider], ...patch } } }));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    modalRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const nodes = modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
      if (!nodes?.length) return;
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => { document.removeEventListener('keydown', handler, true); previous?.focus(); };
  }, [onClose, busy]);

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name); setError(''); setNotice('');
    try { await action(); } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); onError(message); }
    finally { setBusy(''); }
  };
  const save = () => run('save', async () => {
    for (const config of Object.values(draft.providers)) {
      if (!config.baseURL.trim()) throw new Error('请填写 API Base URL。');
      let url: URL; try { url = new URL(config.baseURL); } catch { throw new Error('API Base URL 需要是完整的网址。'); }
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS。');
      if (config.id === draft.activeProvider && !config.model.trim()) throw new Error('请填写当前服务商的模型 ID。');
      if (!Number.isFinite(config.maxTokens) || config.maxTokens < 256 || config.maxTokens > 393216) throw new Error('最大输出长度应在 256 到 393216 tokens 之间。');
    }
    if (!Number.isFinite(draft.contextMaxChars) || draft.contextMaxChars < 10000 || draft.contextMaxChars > 1500000) throw new Error('上下文长度应在 10000 到 1500000 字符之间。');
    const next = await window.folio.saveSettings(draft);
    setDraft(next); onSaved(next); setNotice('偏好设置已保存');
  });

  return <div className="fl-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="fl-settings-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="fl-settings-title" tabIndex={-1}>
      <header className="fl-settings-header"><div className="fl-settings-title-icon"><SlidersHorizontal size={19} /></div><div><h2 id="fl-settings-title">把 Folio 调成你的样子</h2><p>一点偏好，更好的阅读体验。</p></div><button className="fl-icon-button" onClick={onClose} aria-label="关闭设置" disabled={!!busy}><X size={19} /></button></header>
      <div className="fl-settings-body"><nav className="fl-settings-nav" aria-label="设置分类">{SECTIONS.map(item => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><item.icon size={16} />{item.label}{section === item.id && <ChevronRight size={13} />}</button>)}<div className="fl-settings-local"><ShieldCheck size={19} /><span>属于你的研究空间</span><p>论文和笔记保存在本机。<br />API 密钥由系统加密保存。</p></div></nav>
        <div className="fl-settings-content">
          {section === 'ai' && <>
            <div className="fl-section-heading"><span className="fl-eyebrow">YOUR READING COMPANION</span><h3>让好问题，有更深的回答。</h3><p>连接你自己的模型账号，阅读时随时展开讨论。</p></div>
            <div className="fl-provider-grid">{PROVIDERS.map(item => <button className={provider === item.id ? 'active' : ''} key={item.id} onClick={() => { setProvider(item.id); setShowKey(false); }}><span>{item.id === 'deepseek' ? <Zap size={16} /> : <Sparkles size={15} />}{draft.activeProvider === item.id && <Check size={12} />}</span><strong>{item.title}</strong><small>{item.subtitle}</small></button>)}</div>
            <div className="fl-provider-active"><span>{draft.activeProvider === provider ? <><span className="fl-small-dot" /> 当前使用的服务商</> : '此服务商有独立的密钥和模型配置'}</span>{draft.activeProvider !== provider && <button onClick={() => setDraft(previous => ({ ...previous, activeProvider: provider }))}>设为默认</button>}</div>
            <label className="fl-field"><span>API Key <span className="fl-field-badge"><KeyRound size={10} /> 仅在本机保存</span></span><div className="fl-key-input"><input aria-label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={providerConfig.apiKey ?? ''} onChange={event => patchProvider({ apiKey: event.target.value || undefined })} placeholder={providerConfig.hasKey ? '已保存密钥 · 留空保留现有密钥' : '粘贴你的 API Key'} /><button className="fl-icon-button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏输入的密钥' : '显示输入的密钥'}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><small>密钥不会写入笔记或备份。{providerConfig.hasKey ? '输入新密钥后保存，即可替换。' : '你可以从服务商的开发者平台创建密钥。'}</small></label>
            <label className="fl-field"><span>API Base URL</span><input aria-label="API Base URL" type="url" value={providerConfig.baseURL} onChange={event => patchProvider({ baseURL: event.target.value })} spellCheck={false} /></label>
            {provider === 'deepseek' && <><label className="fl-field"><span>DeepSeek 模型</span><div className="fl-model-options">{[{ model: 'deepseek-flash', title: 'Flash', subtitle: '日常问答，快速理解' }, { model: 'deepseek-v4-pro', title: 'Pro', subtitle: '复杂推理，深入分析' }].map(item => <button key={item.model} className={providerConfig.model === item.model ? 'active' : ''} onClick={() => patchProvider({ model: item.model })}><span><strong>{item.title}</strong>{providerConfig.model === item.model && <Check size={14} />}</span><small>{item.subtitle}</small></button>)}</div></label><Toggle checked={providerConfig.thinking !== false} onChange={checked => patchProvider({ thinking: checked })} label="深度思考" description="启用模型思考模式，更仔细地分析论文与问题。" />{providerConfig.thinking !== false && <label className="fl-field"><span>思考深度</span><select aria-label="思考深度" value={providerConfig.reasoningEffort ?? 'high'} onChange={event => patchProvider({ reasoningEffort: event.target.value as 'low' | 'high' | 'max' })}><option value="low">低 · Low</option><option value="high">高 · High（默认）</option><option value="max">最高 · Max</option></select><small>更高的深度可能需要更多响应时间与 tokens。</small></label>}<button className="fl-text-link" onClick={() => void window.folio.openExternal('https://api-docs.deepseek.com/guides/thinking_mode/').catch(error => onError(String(error)))}>查看 DeepSeek 官方思考模式文档 <ArrowUpRight size={12} /></button></>}
            <div className="fl-field-pair"><label className="fl-field"><span>模型 ID</span><input aria-label="模型 ID" value={providerConfig.model} onChange={event => patchProvider({ model: event.target.value })} spellCheck={false} /><small>可直接填写服务商支持的模型名称。</small></label><label className="fl-field"><span>最大输出 tokens</span><input aria-label="最大输出 tokens" type="number" min={256} max={393216} step={256} value={providerConfig.maxTokens} onChange={event => patchProvider({ maxTokens: Number(event.target.value) })} /></label></div>
            <div className="fl-settings-divider" />
            <Toggle label="自动生成论文摘要" description="首次打开已完成文本索引的论文时，自动请求 AI 摘要，会产生 API 费用。" checked={draft.autoSummary} onChange={checked => setDraft(previous => ({ ...previous, autoSummary: checked }))} />
            <Toggle label="自动积累阅读记忆" description="从对话中提炼发现与问题，供后续阅读调用；会产生额外 API 请求。" checked={draft.autoMemory} onChange={checked => setDraft(previous => ({ ...previous, autoMemory: checked }))} />
            <label className="fl-field"><span>单次论文上下文上限（字符）</span><input aria-label="单次论文上下文上限（字符）" type="number" min={10000} max={1500000} step={10000} value={draft.contextMaxChars} onChange={event => setDraft(previous => ({ ...previous, contextMaxChars: Number(event.target.value) }))} /><small>更长的上下文可容纳更多正文与补充材料，也会增加 token 用量。</small></label>
          </>}
          {section === 'reading' && <><div className="fl-section-heading"><span className="fl-eyebrow">MAKE ROOM FOR FOCUS</span><h3>舒适一点，读得久一点。</h3><p>选择舒适的界面配色与常用批注工具的位置。</p></div><label className="fl-field"><span>应用外观</span><div className="fl-theme-options">{[{ value: 'light', title: '浅色', className: 'light' }, { value: 'dark', title: '深色', className: 'dark' }].map(item => <button key={item.value} className={`${item.className} ${draft.theme === item.value ? 'active' : ''}`} onClick={() => setDraft(previous => ({ ...previous, theme: item.value as Settings['theme'] }))}><i><span /><span /></i><strong>{item.title}</strong>{draft.theme === item.value && <Check size={14} />}</button>)}</div></label><label className="fl-field"><span>PDF 纸张</span><div className="fl-paper-themes">{[{ value: 'white', title: '原纸', color: '#ffffff' }, { value: 'sepia', title: '暖纸', color: '#f4e6cb' }, { value: 'dark', title: '夜读', color: '#25282b' }].map(item => <button key={item.value} className={draft.readingTheme === item.value ? 'active' : ''} onClick={() => setDraft(previous => ({ ...previous, readingTheme: item.value as Settings['readingTheme'] }))}><i style={{ background: item.color }} /><span>{item.title}</span>{draft.readingTheme === item.value && <Check size={13} />}</button>)}</div><small>阅读配色只影响显示，导出 PDF 保持原始颜色。</small></label>
            <label className="fl-field"><span>批注工具栏</span><select aria-label="批注工具栏位置" aria-describedby="fl-annotation-toolbar-help" value={draft.annotationToolbar ?? 'floating'} onChange={event => setDraft(previous => ({ ...previous, annotationToolbar: event.target.value as Settings['annotationToolbar'] }))}><option value="floating">底部悬浮（常驻）</option><option value="fixed">顶部固定（常驻）</option><option value="selection">仅选中文字时显示</option></select><small id="fl-annotation-toolbar-help">所有阅读区共用一个工具栏，操作作用于当前阅读区。常驻模式下，可先选择荧光笔与颜色；复制等操作需要先选中文字。</small></label>
          </>}
          {section === 'obsidian' && <><div className="fl-section-heading"><span className="fl-eyebrow">CONNECT YOUR KNOWLEDGE</span><h3>让笔记，回到你的知识库。</h3><p>摘要、个人笔记、阅读记忆与对话，整理成 Markdown。</p></div><div className="fl-obsidian-card"><div className="fl-obsidian-gem">◇</div><div><strong>Folio → Obsidian</strong><p>在阅读助手中一键导出，保留论文来源。</p></div></div><label className="fl-field"><span>Obsidian Vault 文件夹</span><div className="fl-folder-picker"><input aria-label="Obsidian Vault 文件夹" readOnly value={draft.vaultPath} placeholder="选择现有的 Obsidian 知识库" /><button className="fl-button fl-secondary" disabled={!!busy} onClick={() => void run('folder', async () => { const path = await window.folio.pickFolder('vault'); if (path) setDraft(previous => ({ ...previous, vaultPath: path })); })}><FolderOpen size={15} /> 选择</button></div></label><label className="fl-field"><span>笔记保存到子文件夹</span><input aria-label="笔记保存到子文件夹" value={draft.obsidianSubfolder} onChange={event => setDraft(previous => ({ ...previous, obsidianSubfolder: event.target.value }))} placeholder="Papers" /><small>可填写 Papers/阅读笔记；导出时会自动创建。</small></label><div className="fl-info-note"><FileIcon /><p>导出使用论文标题命名。再次导出只更新 Folio 生成区域，保留你在该区域之外添加的内容。</p></div>{draft.vaultPath && <button className="fl-button fl-quiet" onClick={() => setDraft(previous => ({ ...previous, vaultPath: '' }))}>取消关联此知识库</button>}</>}
          {section === 'data' && <><div className="fl-section-heading"><span className="fl-eyebrow">LOCAL FIRST, ALWAYS YOURS</span><h3>你的论文，由你保管。</h3><p>打包工作区，或把原来阅读助手中的记录带过来。</p></div><label className="fl-field"><span>文献库位置</span><input aria-label="文献库位置" readOnly value={draft.libraryPath} /><small>每篇论文拥有独立文件夹，正文与补充材料保存在一起。</small></label><div className="fl-data-action"><span className="fl-data-icon"><Download size={20} /></span><div><strong>导出文献库备份</strong><p>包含 PDF、笔记、对话和阅读进度，不包含 API 密钥。</p></div><button className="fl-button fl-secondary" disabled={!!busy} onClick={() => void run('backup', async () => { const result = await window.folio.backup(); if (result) setNotice(`备份已保存：${result.path}`); })}>{busy === 'backup' ? <LoaderCircle size={15} className="fl-spin" /> : '导出'}</button></div><div className="fl-data-action"><span className="fl-data-icon"><Upload size={20} /></span><div><strong>从备份恢复</strong><p>选择 Folio 备份文件，将工作区导入到文献库。</p></div><button className="fl-button fl-secondary" disabled={!!busy} onClick={() => void run('restore', async () => { const result = await window.folio.restore(); if (result) { setNotice(`已恢复 ${result.count} 个工作区`); onRefresh(); } })}>{busy === 'restore' ? <LoaderCircle size={15} className="fl-spin" /> : '恢复'}</button></div><div className="fl-data-action"><span className="fl-data-icon lavender"><Sparkles size={20} /></span><div><strong>导入原阅读助手数据</strong><p>选择 Paper Reading Assistant 导出的 JSON 备份。</p></div><button className="fl-button fl-secondary" disabled={!!busy} onClick={() => void run('legacy', async () => { const result = await window.folio.importLegacy(); if (result) { setNotice(`已导入 ${result.count} 篇论文的阅读记录`); onRefresh(); } })}>{busy === 'legacy' ? <LoaderCircle size={15} className="fl-spin" /> : '导入'}</button></div></>}
        </div>
      </div>
      <footer className="fl-settings-footer"><div role="status" className={error ? 'fl-error-text' : 'fl-save-notice'}>{error || (notice ? <><Check size={14} />{notice}</> : <><ShieldCheck size={14} /> 偏好设置仅保存在本机</>)}</div><button className="fl-button fl-secondary" onClick={onClose} disabled={!!busy}>关闭</button><button className="fl-button fl-primary" disabled={!!busy} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={15} className="fl-spin" /> : <Check size={15} />} 保存设置</button></footer>
    </div>
  </div>;
}
function FileIcon() { return <BookOpen size={18} />; }
