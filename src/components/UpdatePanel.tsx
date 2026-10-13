import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, Download, LoaderCircle, PackageCheck, RefreshCw, X } from 'lucide-react';
import { UPDATE_RELEASES_URLS, normalizeUpdateSourcePreference, type UpdateErrorCode, type UpdateSource, type UpdateSourcePreference, type UpdateStatus } from '../../shared/updates';
import type { Translator } from '../../shared/i18n';
import { useI18n } from '../i18n';
import { PLATFORM } from '../platform';
import './ui-components.css';
import './update-panel.css';

type UpdateAction = 'check' | 'download' | 'cancel' | 'install';
type LocalError = 'service-unavailable' | 'external-link';
const ACTIONS = { check: 'checkForUpdates', download: 'downloadUpdate', cancel: 'cancelUpdate', install: 'installUpdate' } as const;

/** IPC events own the state. A late initial fetch or action result must not
 * overwrite a more recent progress event. No timers or polling are needed. */
function useUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [pending, setPending] = useState<UpdateAction | null>(null);
  const [localError, setLocalError] = useState<LocalError | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const operation = useRef(0);
  const pendingRef = useRef<UpdateAction | null>(null);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const before = revision.current;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.folio.onUpdate(next => {
        if (!active) return;
        revision.current++;
        setStatus(next); setLocalError(null);
      });
      void window.folio.getUpdateStatus().then(next => {
        if (active && revision.current === before) setStatus(next);
      }).catch(() => { if (active && revision.current === before) setLocalError('service-unavailable'); });
    } catch { setLocalError('service-unavailable'); }
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  }, []);
  const run = useCallback(async (action: UpdateAction) => {
    if (pendingRef.current && !(action === 'cancel' && pendingRef.current === 'download')) return;
    const token = ++operation.current;
    const before = revision.current;
    pendingRef.current = action; setPending(action); setLocalError(null);
    try {
      const next = await window.folio[ACTIONS[action]]();
      if (mounted.current && token === operation.current && revision.current === before && next) setStatus(next);
    } catch {
      if (mounted.current && token === operation.current) setLocalError('service-unavailable');
    } finally {
      if (token === operation.current) {
        pendingRef.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }, []);
  const openRelease = useCallback(async (url: string) => {
    try { await window.folio.openExternal(url); }
    catch { if (mounted.current) setLocalError('external-link'); }
  }, []);
  return { status, pending, localError, run, openRelease };
}

function updateError(code: UpdateErrorCode | LocalError, t: Translator): string {
  const messages: Record<UpdateErrorCode | LocalError, [string, string]> = {
    network: ['无法连接更新来源，请检查网络后重试。', 'Could not connect to the update source. Check your connection and try again.'],
    timeout: ['更新请求超时，请稍后重试。', 'The update request timed out. Try again later.'],
    'rate-limit': ['更新来源的请求次数暂时达到上限，请稍后重试。', 'The update source’s request limit was reached. Try again later.'],
    'no-release': ['暂时没有可用的正式版本。', 'No stable release is available yet.'],
    'invalid-release': ['版本信息不完整，暂时无法更新。可以查看官方发布页面。', 'The release information is incomplete. Check the official release page.'],
    'invalid-url': ['更新链接未通过验证，请使用项目的官方发布页面。', 'The update link could not be verified. Use the project’s official release page.'],
    'unsupported-platform': ['当前平台没有可用的安装包，请查看版本说明。', 'No installer is available for this platform. See the release notes.'],
    'missing-asset': ['此版本缺少适合当前系统的安装包，请查看版本说明。', 'This release has no installer for your system. See the release notes.'],
    'missing-digest': ['此安装包缺少校验信息，无法在应用内下载，请查看发布页面。', 'This installer has no checksum information, so in-app download is unavailable. See the release page.'],
    'size-limit': ['安装包超过允许的下载大小，请查看发布页面。', 'The installer exceeds the download size limit. See the release page.'],
    'length-mismatch': ['安装包下载不完整，请重新下载。', 'The installer download is incomplete. Download it again.'],
    'checksum-mismatch': ['安装包校验失败，请重新下载。', 'Installer verification failed. Download it again.'],
    'disk-error': ['无法保存安装包，请检查磁盘剩余空间和文件权限。', 'Could not save the installer. Check free disk space and file permissions.'],
    'not-ready': ['安装包尚未准备好，请先完成下载。', 'The installer is not ready. Complete the download first.'],
    'installer-missing': ['已下载的安装包不存在，请重新下载。', 'The downloaded installer is missing. Download it again.'],
    'open-failed': ['无法打开安装包，请重试或从官方发布页面下载。', 'Could not open the installer. Try again or download it from the official release page.'],
    'save-failed': ['未能保存当前工作，更新暂未继续。请先保存后重试。', 'Could not save your work. Save it before trying the update again.'],
    cancelled: ['下载已取消，可以随时重新下载。', 'Download cancelled. You can download it again at any time.'],
    disposed: ['更新服务已停止，请重新打开应用后再试。', 'The update service stopped. Reopen the app and try again.'],
    'service-unavailable': ['暂时无法获取更新状态，请重新检查；阅读功能仍可使用。', 'Update status is unavailable. Check again; you can continue reading.'],
    'external-link': ['无法打开版本页面，请稍后重试。', 'Could not open the release page. Try again later.'],
  };
  return t(...(messages[code] ?? messages['service-unavailable']));
}
function statusTitle(status: UpdateStatus | null, t: Translator) {
  if (!status) return t('正在读取更新状态…', 'Loading update status…');
  switch (status.phase) {
    case 'checking': return t('正在检查新版本…', 'Checking for updates…');
    case 'available': return t('发现新版本 {version}', 'Version {version} is available', { version: status.release?.version ?? '' });
    case 'up-to-date': return t('当前已是最新版本', 'You’re up to date');
    case 'downloading': return t('正在下载安装包…', 'Downloading the installer…');
    case 'downloaded': return t('安装包已下载并完成校验', 'Installer downloaded and verified');
    case 'opening': return t('正在打开安装包…', 'Opening the installer…');
    case 'error': return t('更新未完成', 'Update not completed');
    default: return t('检查 Pairleaf 新版本', 'Check for a newer Pairleaf');
  }
}
function bytes(value: number, locale: string) {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const divisor = safe >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(safe / divisor)} ${divisor === 1024 ** 3 ? 'GiB' : 'MiB'}`;
}
function Progress({ status }: { status: UpdateStatus }) {
  const { locale, t } = useI18n();
  const downloaded = status.downloadedBytes ?? 0;
  const total = status.totalBytes ?? status.release?.size ?? 0;
  const percent = total > 0 ? Math.max(0, Math.min(100, downloaded / total * 100)) : null;
  return <div className="fl-update-progress">
    <div><span>{bytes(downloaded, locale)}{total > 0 && ` / ${bytes(total, locale)}`}</span><span>{percent === null ? t('正在接收…', 'Receiving…') : `${Math.floor(percent)}%`}</span></div>
    <progress aria-label={t('安装包下载进度', 'Installer download progress')} max={100} value={percent ?? undefined} />
  </div>;
}
function isPortable(status: UpdateStatus | null) { return status?.release?.assetName?.toLowerCase().endsWith('-portable.exe') ?? false; }
function InstallHelp({ status }: { status: UpdateStatus }) {
  const { t } = useI18n();
  return <p className="fl-update-install-help">{PLATFORM === 'darwin'
    ? t('首次从 Folio 更新：先退出 Folio，将 Pairleaf 拖入「应用程序」。确认原论文与设置后，可移除旧 Folio.app；请保留数据目录。已有 Pairleaf 时，退出后选择替换即可。', 'Updating from Folio for the first time: quit Folio and drag Pairleaf into Applications. After checking your papers and settings, you can remove Folio.app; keep the data folder. For later Pairleaf updates, quit and replace the existing app.')
    : isPortable(status) ? t('显示下载文件后，请先退出当前 Pairleaf，再运行新版免安装程序。', 'Reveal the downloaded file, quit the current Pairleaf, then run the new portable version.')
    : t('打开安装程序后，当前 Pairleaf 将退出。请按安装向导完成更新。', 'Opening the installer will quit the current Pairleaf. Follow the setup steps to finish updating.')}</p>;
}
function installLabel(t: Translator, status: UpdateStatus | null) { return PLATFORM === 'darwin' ? t('打开 DMG 安装', 'Open DMG') : isPortable(status) ? t('显示下载文件', 'Reveal download') : t('打开安装程序', 'Open installer'); }
const sourceName = (source: UpdateSource) => source === 'gitee' ? 'Gitee' : 'GitHub';

export function updateReleasePage(status: UpdateStatus | null, fallbackSource?: UpdateSourcePreference): string {
  const source = status?.release?.source ?? status?.source ?? status?.preferredSource;
  const saved = normalizeUpdateSourcePreference(fallbackSource ?? status?.sourcePreference);
  return status?.release?.url ?? UPDATE_RELEASES_URLS[source ?? (saved === 'auto' ? 'github' : saved)];
}

export function UpdateSourceDetails({ status }: { status: UpdateStatus | null }) {
  const { t } = useI18n();
  if (!status) return null;
  const actual = status.release?.source ?? status.source;
  const source = actual ? sourceName(actual) : t('可用的官方来源', 'an available official source');
  const preferred = status.preferredSource ? sourceName(status.preferredSource) : t('首选来源', 'the preferred source');
  const reason = status.sourceReason === 'source-fallback'
    ? t('{preferred} 未返回可用更新，本次改用 {source}。', '{preferred} did not return an available update; this check uses {source}.', { preferred, source })
    : status.sourceReason === 'newer-on-other-source'
      ? t('另一来源发布了更新版本，本次使用 {source}。', 'A newer version is available on the other source; this check uses {source}.', { source })
      : status.sourceReason === 'region-unavailable'
        ? t('无法判断网络出口地区，本次使用 {source}；也可手动指定来源。', 'The network exit region could not be determined. This check uses {source}; you can also choose a source manually.', { source })
        : '';
  if (!actual && !reason && !status.region) return null;
  return <div className="fl-update-source-details" aria-label={t('本次更新来源', 'Source for this update')}>
    {actual && <strong>{t('实际来源：{source}', 'Actual source: {source}', { source })}</strong>}
    {status.sourcePreference === 'auto' && status.region && status.region !== 'unknown' && <span>{status.region === 'CN' ? t('网络出口：中国大陆', 'Network exit: mainland China') : t('网络出口：中国大陆以外', 'Network exit: outside mainland China')}</span>}
    {reason && <p>{reason}</p>}
  </div>;
}

export function UpdateSourceSettings({ value, saved, onChange, disabled }: {
  value?: UpdateSourcePreference; saved?: UpdateSourcePreference; onChange: (source: UpdateSourcePreference) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const preference = normalizeUpdateSourcePreference(value);
  const changed = preference !== normalizeUpdateSourcePreference(saved);
  return <div className="fl-update-source-settings">
    <label className="fl-field"><span>{t('更新来源', 'Update source')}</span><select aria-label={t('更新来源', 'Update source')} aria-describedby="fl-update-source-help" value={preference} disabled={disabled} onChange={event => onChange(normalizeUpdateSourcePreference(event.target.value))}><option value="auto">{t('自动（按网络出口）', 'Automatic (network exit region)')}</option><option value="gitee">Gitee</option><option value="github">GitHub</option></select><small id="fl-update-source-help">{t('自动模式：中国大陆网络出口优先 Gitee，其它地区优先 GitHub；使用代理时以代理出口为准。手动指定可覆盖自动选择。保存设置后生效。', 'Automatic mode prefers Gitee for mainland China network exits and GitHub elsewhere. A proxy’s exit region is used when present. A manual choice overrides this preference. Save settings to apply.')}</small></label>
    {changed && <p className="fl-update-source-pending" role="status">{t('更新来源尚未保存。请先点击「保存设置」，再检查或下载更新。下方仍显示上次实际使用的来源；已开始的下载不受影响。', 'The update source has not been saved. Click “Save settings” before checking or downloading. The card below still shows the last source used; a download already in progress continues.')}</p>}
  </div>;
}

export function UpdateActions({ status, pending, run, openRelease, compact = false, sourcePending = false, disabled = false, fallbackSource }: ReturnType<typeof useUpdates> & { compact?: boolean; sourcePending?: boolean; disabled?: boolean; fallbackSource?: UpdateSourcePreference }) {
  const { t } = useI18n();
  const phase = status?.phase;
  const busy = !!pending || phase === 'checking' || phase === 'downloading' || phase === 'opening';
  const hasInstaller = phase === 'downloaded' || phase === 'opening';
  return <div className="fl-update-actions">
    {phase === 'downloading' ? <button type="button" className="fl-button fl-secondary" disabled={pending === 'cancel'} onClick={() => void run('cancel')}><X size={14} />{t('取消下载', 'Cancel download')}</button>
      : hasInstaller ? <button type="button" className="fl-button fl-primary" disabled={busy || disabled} onClick={() => void run('install')}>{phase === 'opening' ? <LoaderCircle size={14} className="fl-spin" /> : <PackageCheck size={14} />}{installLabel(t, status)}</button>
      : status?.release?.downloadable && (phase === 'available' || phase === 'error') && <button type="button" className="fl-button fl-primary" disabled={busy || disabled || sourcePending} onClick={() => void run('download')}><Download size={14} />{t('下载安装包', 'Download installer')}</button>}
    {!compact && <button type="button" className="fl-button fl-secondary" disabled={busy || disabled || sourcePending} onClick={() => void run('check')}>{phase === 'checking' || pending === 'check' ? <LoaderCircle size={14} className="fl-spin" /> : <RefreshCw size={14} />}{t('检查更新', 'Check for updates')}</button>}
    <button type="button" className="fl-text-link" onClick={() => void openRelease(updateReleasePage(status, fallbackSource))}>{t('版本说明', 'Release notes')}<ArrowUpRight size={13} /></button>
  </div>;
}

interface Props { autoCheckUpdates: boolean; onAutoCheckUpdatesChange: (enabled: boolean) => void; updateSource?: UpdateSourcePreference; savedUpdateSource?: UpdateSourcePreference; onUpdateSourceChange: (source: UpdateSourcePreference) => void; disabled?: boolean }
export default function UpdatePanel({ autoCheckUpdates, onAutoCheckUpdatesChange, updateSource, savedUpdateSource, onUpdateSourceChange, disabled }: Props) {
  const state = useUpdates();
  const { status, localError } = state;
  const { t, locale } = useI18n();
  const issue = localError ?? status?.error;
  const releaseDate = status?.release?.publishedAt ? new Date(status.release.publishedAt) : null;
  return <section className="fl-update-panel" aria-label={t('应用更新', 'App updates')}>
    <div className="fl-section-heading"><span className="fl-eyebrow">PAIRLEAF UPDATES</span><h3>{t('让阅读体验，继续变好。', 'Keep your reader up to date.')}</h3><p>{t('从 Pairleaf 官方 GitHub / Gitee 发布获取更新。', 'Get updates from Pairleaf’s official GitHub / Gitee releases.')}</p></div>
    <UpdateSourceSettings value={updateSource} saved={savedUpdateSource} onChange={onUpdateSourceChange} disabled={disabled} />
    <div className="fl-update-card">
      <div className="fl-update-card-heading"><span className="fl-update-icon"><ArrowDownToLine size={22} /></span><div><strong>Pairleaf</strong><span>{t('当前版本 {version}', 'Current version {version}', { version: status?.currentVersion ?? '—' })}</span></div>{status?.phase === 'up-to-date' && <Check size={20} />}</div>
      <div className="fl-update-status" role="status"><strong>{statusTitle(status, t)}</strong>{status?.release && <span>{status.release.version}{releaseDate && Number.isFinite(releaseDate.getTime()) && ` · ${releaseDate.toLocaleDateString(locale)}`}{status.release.size !== undefined && ` · ${bytes(status.release.size, locale)}`}</span>}</div>
      <UpdateSourceDetails status={status} />
      {status?.phase === 'downloading' && <Progress status={status} />}
      {issue && <p className={`fl-update-error ${issue === 'cancelled' ? 'is-cancelled' : ''}`} role={issue === 'cancelled' ? 'status' : 'alert'}><CircleAlert size={15} /><span>{updateError(issue, t)}</span></p>}
      <UpdateActions {...state} sourcePending={normalizeUpdateSourcePreference(updateSource) !== normalizeUpdateSourcePreference(savedUpdateSource)} disabled={disabled} fallbackSource={savedUpdateSource} />
      {(status?.phase === 'downloaded' || status?.phase === 'opening') && <InstallHelp status={status} />}
      {!!status?.lastCheckedAt && <p className="fl-update-last-checked">{t('上次检查：{time}', 'Last checked: {time}', { time: new Date(status.lastCheckedAt).toLocaleString(locale) })}</p>}
    </div>
    <label className="fl-update-auto"><input type="checkbox" aria-label={t('自动检查更新', 'Automatically check for updates')} checked={autoCheckUpdates} disabled={disabled} onChange={event => onAutoCheckUpdatesChange(event.target.checked)} /><span><strong>{t('自动检查更新', 'Automatically check for updates')}</strong><small>{t('启动时检查已保存的更新来源，6 小时内不重复自动检查。不会自动下载或运行安装程序。此偏好在保存设置后生效。', 'Check the saved update source on startup, with no repeat automatic check within 6 hours. Installers are never downloaded or opened automatically. Save settings to apply this preference.')}</small></span></label>
    <p className="fl-update-footnote">{t('检查更新不需要 API Key。关闭提示或设置不会取消下载；退出应用会中止下载。', 'Update checks need no API key. Dismissing a notice or closing settings does not cancel a download; quitting the app stops it.')}</p>
  </section>;
}

/** A quiet, dismissible overlay. Automatic network failures are shown only in Settings. */
export function UpdateNotice() {
  const state = useUpdates();
  const { status } = state;
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  if (!status?.release || status.error || !['available', 'downloading', 'downloaded', 'opening'].includes(status.phase)) return null;
  const key = `${status.release.version}:${status.phase}`;
  if (dismissed.has(key)) return null;
  const dismiss = () => setDismissed(previous => new Set(previous).add(key));
  return <aside className="fl-update-notice" aria-label={t('Pairleaf 更新提示', 'Pairleaf update notice')}>
    <div className="fl-update-notice-heading"><span className="fl-update-icon"><Download size={17} /></span><strong role="status">{statusTitle(status, t)}</strong><button type="button" className="fl-icon-button" aria-label={t('关闭更新提示', 'Dismiss update notice')} onClick={dismiss}><X size={15} /></button></div>
    {status.phase === 'available' && <p>{t('准备好时再更新，继续当前阅读。', 'Update whenever you’re ready. Your reading can continue.')}</p>}
    <UpdateSourceDetails status={status} />
    {status.phase === 'downloading' && <Progress status={status} />}
    {(status.phase === 'downloaded' || status.phase === 'opening') && <InstallHelp status={status} />}
    <UpdateActions {...state} compact />
    <button type="button" className="fl-update-later" onClick={dismiss}>{t('稍后再说', 'Later')}</button>
  </aside>;
}
