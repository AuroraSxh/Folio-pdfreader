import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, Download, LoaderCircle, PackageCheck, RefreshCw, X } from 'lucide-react';
import { UPDATE_RELEASES_URL, type UpdateErrorCode, type UpdateStatus } from '../../shared/updates';
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
    network: ['无法连接 GitHub，请检查网络后重试。', 'Could not connect to GitHub. Check your connection and try again.'],
    timeout: ['更新请求超时，请稍后重试。', 'The update request timed out. Try again later.'],
    'rate-limit': ['GitHub 请求次数暂时达到上限，请稍后重试。', 'GitHub’s request limit was reached. Try again later.'],
    'no-release': ['暂时没有可用的正式版本。', 'No stable release is available yet.'],
    'invalid-release': ['版本信息不完整，暂时无法更新。可以查看 GitHub 发布页面。', 'The release information is incomplete. Check the GitHub release page.'],
    'invalid-url': ['更新链接未通过验证，请使用项目的 GitHub 发布页面。', 'The update link could not be verified. Use the project’s GitHub release page.'],
    'unsupported-platform': ['当前平台没有可用的安装包，请查看版本说明。', 'No installer is available for this platform. See the release notes.'],
    'missing-asset': ['此版本缺少适合当前系统的安装包，请查看版本说明。', 'This release has no installer for your system. See the release notes.'],
    'missing-digest': ['此安装包缺少校验信息，无法在应用内下载，请查看发布页面。', 'This installer has no checksum information, so in-app download is unavailable. See the release page.'],
    'size-limit': ['安装包超过允许的下载大小，请查看发布页面。', 'The installer exceeds the download size limit. See the release page.'],
    'length-mismatch': ['安装包下载不完整，请重新下载。', 'The installer download is incomplete. Download it again.'],
    'checksum-mismatch': ['安装包校验失败，请重新下载。', 'Installer verification failed. Download it again.'],
    'disk-error': ['无法保存安装包，请检查磁盘剩余空间和文件权限。', 'Could not save the installer. Check free disk space and file permissions.'],
    'not-ready': ['安装包尚未准备好，请先完成下载。', 'The installer is not ready. Complete the download first.'],
    'installer-missing': ['已下载的安装包不存在，请重新下载。', 'The downloaded installer is missing. Download it again.'],
    'open-failed': ['无法打开安装包，请重试或从 GitHub 下载。', 'Could not open the installer. Try again or download it from GitHub.'],
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
    default: return t('检查 Folio 新版本', 'Check for a newer Folio');
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
    ? t('打开 DMG 后，将 Folio 拖入「应用程序」并替换旧版；如系统要求，请先退出 Folio。', 'Open the DMG, drag Folio into Applications, and replace the previous version. Quit Folio first if prompted.')
    : isPortable(status) ? t('显示下载文件后，请先退出当前 Folio，再运行新版免安装程序。', 'Reveal the downloaded file, quit the current Folio, then run the new portable version.')
    : t('打开安装程序后，当前 Folio 将退出。请按安装向导完成更新。', 'Opening the installer will quit the current Folio. Follow the setup steps to finish updating.')}</p>;
}
function installLabel(t: Translator, status: UpdateStatus | null) { return PLATFORM === 'darwin' ? t('打开 DMG 安装', 'Open DMG') : isPortable(status) ? t('显示下载文件', 'Reveal download') : t('打开安装程序', 'Open installer'); }
function Actions({ status, pending, run, openRelease, compact = false }: ReturnType<typeof useUpdates> & { compact?: boolean }) {
  const { t } = useI18n();
  const phase = status?.phase;
  const busy = !!pending || phase === 'checking' || phase === 'downloading' || phase === 'opening';
  const hasInstaller = phase === 'downloaded' || phase === 'opening';
  return <div className="fl-update-actions">
    {phase === 'downloading' ? <button type="button" className="fl-button fl-secondary" disabled={pending === 'cancel'} onClick={() => void run('cancel')}><X size={14} />{t('取消下载', 'Cancel download')}</button>
      : hasInstaller ? <button type="button" className="fl-button fl-primary" disabled={busy} onClick={() => void run('install')}>{phase === 'opening' ? <LoaderCircle size={14} className="fl-spin" /> : <PackageCheck size={14} />}{installLabel(t, status)}</button>
      : status?.release?.downloadable && (phase === 'available' || phase === 'error') && <button type="button" className="fl-button fl-primary" disabled={busy} onClick={() => void run('download')}><Download size={14} />{t('下载安装包', 'Download installer')}</button>}
    {!compact && <button type="button" className="fl-button fl-secondary" disabled={busy} onClick={() => void run('check')}>{phase === 'checking' || pending === 'check' ? <LoaderCircle size={14} className="fl-spin" /> : <RefreshCw size={14} />}{t('检查更新', 'Check for updates')}</button>}
    <button type="button" className="fl-text-link" onClick={() => void openRelease(status?.release?.url ?? UPDATE_RELEASES_URL)}>{t('版本说明', 'Release notes')}<ArrowUpRight size={13} /></button>
  </div>;
}

interface Props { autoCheckUpdates: boolean; onAutoCheckUpdatesChange: (enabled: boolean) => void; disabled?: boolean }
export default function UpdatePanel({ autoCheckUpdates, onAutoCheckUpdatesChange, disabled }: Props) {
  const state = useUpdates();
  const { status, localError } = state;
  const { t, locale } = useI18n();
  const issue = localError ?? status?.error;
  const releaseDate = status?.release?.publishedAt ? new Date(status.release.publishedAt) : null;
  return <section className="fl-update-panel" aria-label={t('应用更新', 'App updates')}>
    <div className="fl-section-heading"><span className="fl-eyebrow">FOLIO UPDATES</span><h3>{t('让阅读体验，继续变好。', 'Keep your reader up to date.')}</h3><p>{t('从 Folio 的 GitHub 正式发布版本获取更新。', 'Get updates from Folio’s official GitHub releases.')}</p></div>
    <div className="fl-update-card">
      <div className="fl-update-card-heading"><span className="fl-update-icon"><ArrowDownToLine size={22} /></span><div><strong>Folio</strong><span>{t('当前版本 {version}', 'Current version {version}', { version: status?.currentVersion ?? '—' })}</span></div>{status?.phase === 'up-to-date' && <Check size={20} />}</div>
      <div className="fl-update-status" role="status"><strong>{statusTitle(status, t)}</strong>{status?.release && <span>{status.release.version}{releaseDate && Number.isFinite(releaseDate.getTime()) && ` · ${releaseDate.toLocaleDateString(locale)}`}{status.release.size !== undefined && ` · ${bytes(status.release.size, locale)}`}</span>}</div>
      {status?.phase === 'downloading' && <Progress status={status} />}
      {issue && <p className={`fl-update-error ${issue === 'cancelled' ? 'is-cancelled' : ''}`} role={issue === 'cancelled' ? 'status' : 'alert'}><CircleAlert size={15} /><span>{updateError(issue, t)}</span></p>}
      <Actions {...state} />
      {(status?.phase === 'downloaded' || status?.phase === 'opening') && <InstallHelp status={status} />}
      {!!status?.lastCheckedAt && <p className="fl-update-last-checked">{t('上次检查：{time}', 'Last checked: {time}', { time: new Date(status.lastCheckedAt).toLocaleString(locale) })}</p>}
    </div>
    <label className="fl-update-auto"><input type="checkbox" aria-label={t('自动检查更新', 'Automatically check for updates')} checked={autoCheckUpdates} disabled={disabled} onChange={event => onAutoCheckUpdatesChange(event.target.checked)} /><span><strong>{t('自动检查更新', 'Automatically check for updates')}</strong><small>{t('启动时检查 GitHub，6 小时内不重复自动检查。不会自动下载或运行安装程序。此偏好在保存设置后生效。', 'Check GitHub on startup, with no repeat automatic check within 6 hours. Installers are never downloaded or opened automatically. Save settings to apply this preference.')}</small></span></label>
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
  return <aside className="fl-update-notice" aria-label={t('Folio 更新提示', 'Folio update notice')}>
    <div className="fl-update-notice-heading"><span className="fl-update-icon"><Download size={17} /></span><strong role="status">{statusTitle(status, t)}</strong><button type="button" className="fl-icon-button" aria-label={t('关闭更新提示', 'Dismiss update notice')} onClick={dismiss}><X size={15} /></button></div>
    {status.phase === 'available' && <p>{t('准备好时再更新，继续当前阅读。', 'Update whenever you’re ready. Your reading can continue.')}</p>}
    {status.phase === 'downloading' && <Progress status={status} />}
    {(status.phase === 'downloaded' || status.phase === 'opening') && <InstallHelp status={status} />}
    <Actions {...state} compact />
    <button type="button" className="fl-update-later" onClick={dismiss}>{t('稍后再说', 'Later')}</button>
  </aside>;
}
