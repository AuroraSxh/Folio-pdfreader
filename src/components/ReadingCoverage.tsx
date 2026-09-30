import { memo, useMemo } from 'react';
import { BookOpen, Search } from 'lucide-react';
import type { ChatEvent } from '../../shared/types';
import type { ReadingReport } from '../../shared/reading';
import { useI18n } from '../i18n';
import { compactPageRanges, safeReadingReport } from './readingPageRanges';
import './reading-coverage.css';

export const ReadingCoverage = memo(function ReadingCoverage({ report: input }: { report?: ReadingReport }) {
  const { t } = useI18n();
  const report = useMemo(() => safeReadingReport(input), [input]);
  if (!report) return null;
  const included = report.documents.reduce((count, document) => count + new Set(document.includedPages).size, 0);
  const total = report.documents.reduce((count, document) => count + document.totalPages, 0);
  const unknownTotal = report.documents.some(document => document.totalPages === 0);
  const unavailable = report.documents.reduce((count, document) => count + document.unavailablePages.length, 0);
  const deep = report.mode === 'deep';
  return <details className="fl-reading-coverage" data-reading-mode={report.mode} data-reading-complete={report.complete}>
    <summary>{deep ? <BookOpen size={12} /> : <Search size={12} />}<span>{unknownTotal
      ? deep ? t('已读文字涉及 {included} 页（总页数未知）', 'Text read from {included} pages (total unknown)', { included }) : t('片段涉及 {included} 页（总页数未知）', 'Excerpts span {included} pages (total unknown)', { included })
      : deep
      ? t('已读文字覆盖 {included}/{total} 页', 'Text read from {included}/{total} pages', { included, total })
      : report.complete ? t('已提供 {included}/{total} 页文字', 'Text provided from {included}/{total} pages', { included, total }) : t('引用片段涉及 {included}/{total} 页', 'Source excerpts span {included}/{total} pages', { included, total })}</span></summary>
    <div className="fl-reading-coverage-detail">
      <p>{deep ? report.complete
        ? t('已完成所选文档中可提取文字的分段阅读。', 'Finished reading the extractable text in the selected documents.')
        : t('本次精读尚未完成，请勿将部分结果视作完整总结。', 'This reading is unfinished. Partial results are not a complete paper summary.')
        : unknownTotal ? t('总页数暂未知，以下列出本次可用的文字片段，不代表全文覆盖。', 'The total page count is not yet known. These available text excerpts do not represent full-paper coverage.') : report.complete ? t('所选文档的全部可提取文字均已提供给本次回答。', 'All extractable text from the selected documents was provided for this answer.') : t('先在全文中寻找相关片段，再据此回答；未将每一页全文发送给 AI。', 'Relevant excerpts were retrieved from the full text for this answer; complete text from every page was not sent to the AI.')}</p>
      {report.documents.map(document => <div className="fl-reading-document" key={document.documentId}>
        <strong title={document.name}>{document.name}</strong>
        <span>{deep ? t('已读页码：{pages}', 'Pages read: {pages}', { pages: compactPageRanges(document.includedPages) || '—' }) : report.complete ? t('提供页码：{pages}', 'Provided pages: {pages}', { pages: compactPageRanges(document.includedPages) || '—' }) : t('片段页码：{pages}', 'Excerpt pages: {pages}', { pages: compactPageRanges(document.includedPages) || '—' })}</span>
        {!!document.unavailablePages.length && <span className="fl-reading-unavailable">{t('无可提取文字：{pages}', 'No extractable text: {pages}', { pages: compactPageRanges(document.unavailablePages) })}</span>}
      </div>)}
      {!!unavailable && <p>{t('{count} 页没有可提取文字；扫描图像和图片细节未被阅读。', '{count} pages have no extractable text. Scanned images and image details were not read.', { count: unavailable })}</p>}
      {!!report.cachedBatches && <small>{t('复用了 {count} 段已读内容。', 'Reused {count} previously read sections.', { count: report.cachedBatches })}</small>}
    </div>
  </details>;
});

export function ReadingProgress({ progress }: { progress?: ChatEvent['progress'] }) {
  const { t } = useI18n();
  if (!progress) return null;
  const label = progress.phase === 'searching' ? t('正在全文中寻找相关片段', 'Finding relevant excerpts across the paper')
    : progress.phase === 'synthesizing' ? t('正在综合已读内容', 'Combining the reading results')
      : t('正在逐段精读 · {completed}/{total}', 'Reading sections · {completed}/{total}', { completed: progress.completed, total: progress.total });
  return <div className="fl-reading-progress" role="status" aria-live="polite"><span>{label}</span>
    {progress.phase === 'reading' && progress.total > 0 && <progress aria-label={t('整篇精读进度', 'Full-paper reading progress')} max={progress.total} value={Math.min(progress.total, Math.max(0, progress.completed))} />}
    {!!progress.cached && <small>{t('其中 {count} 段来自已保存的阅读结果', '{count} sections reused from saved reading results', { count: progress.cached })}</small>}
  </div>;
}
