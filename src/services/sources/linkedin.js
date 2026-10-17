// Mirror the configured public search; at most two listing pages, no detail crawl.
import * as cheerio from 'cheerio';
import { guardedFetch } from '../http/guardedFetch.js';
import { parseJobs, classifyResponse } from '../linkedin/parse.js';
import { findGeo } from '../linkedin/geoIds.js';
import { observer } from './observe.js';
import * as CrawlLog from '../../models/crawlLog.js';
import { randomUUID } from 'node:crypto';
import { qualify } from './index.js';
import { matchesAny } from '../../utils/match.js';

export const id = 'linkedin';
export const label = 'LinkedIn';
export const hosts = ['linkedin.com'];
export const perCountry = true;
export const note = 'Public search, past 24 hours; at most two pages per check';
export const pageSize = 25;
export const maxPages = 1; // internal pagination only
export const timePrecision = 'minute';

export function pageUrlFor({ geoId, keywords, page = 0 }) {
  const geo = findGeo(geoId);
  if (!geo) throw new Error(`Unknown geoId: ${geoId}`);
  const params = new URLSearchParams({ keywords: keywords || '', location: geo.name,
    geoId: geo.geoId, f_TPR: 'r86400', activeFilter: 'f_TPR', position: '1', pageNum: String(page) });
  if (page) params.set('start', String(page * pageSize));
  const host = String(geoId) === '100446352' ? 'lk.linkedin.com' : 'www.linkedin.com';
  return `https://${host}/jobs/search?${params}`;
}
// Compatibility for diagnostics: they must use the same listing URL as production.
export const urlFor = pageUrlFor;

export function searchComplete(html, count) {
  const $ = cheerio.load(html);
  const raw = $('.results-context-header__job-count').first().text().trim().replace(/,/g, '');
  if (/^\d+$/.test(raw) && count >= Number(raw)) return true;
  const end = $('.see-more-jobs__viewed-all').filter((_, node) => {
    const el = $(node);
    return !el.is('[hidden], [aria-hidden="true"], .hidden') &&
      !/display\s*:\s*none/i.test(el.attr('style') || '');
  });
  return end.length > 0;
}

export async function fetchJobs({ keywords, geoId, page = 0, matchAll = false, trace = null }) {
  const obs = observer(id);
  if (page > 0) return obs.done([]);
  const query = matchAll ? '' : (Array.isArray(keywords) ? keywords : [keywords]).filter(Boolean).join(' ');
  const sweepId = trace?.sweepId || randomUUID().slice(0, 8);
  const found = new Map();
  let succeeded = false;
  for (let index = 0; index < 2; index++) {
    const startedAt = Date.now();
    try {
      const html = await guardedFetch(pageUrlFor({geoId, keywords:query, page:index}), hosts,
        {jitter:true, discovery:true});
      const shape = classifyResponse(html);
      // Public search HTML must contain cards or an explicit zero-result indication.
      // A tiny login/challenge response must never look like an empty job board.
      const $ = cheerio.load(html);
      const zero = $('.results-context-header__job-count').first().text().trim() === '0';
      if (shape !== 'jobs' && !zero) throw new Error('LinkedIn public search returned no recognised result list');
      const jobs = parseJobs(html, new Date());
      if (shape === 'jobs' && !jobs.length) throw new Error('LinkedIn job cards could not be parsed');
      const before = found.size;
      jobs.forEach(j => found.set(j.jobId,j));
      succeeded = true;
      const complete = searchComplete(html, found.size);
      const repeated = index > 0 && found.size === before && jobs.length > 0;
      obs.surface(`publicSearch:${index}`, {ok:true,requests:1,pages:1,parsedCount:jobs.length});
      await trace?.onProgress?.({source:id,surface:'publicSearch',page:index});
      await CrawlLog.record({sweepId,queryId:trace?.queryId ?? null,source:id,surface:'publicSearch',geoId,
        scheduledFor:trace?.scheduledFor ?? null,startedAt,finishedAt:Date.now(),
        pages:[{page:index,returned:jobs.length,fresh:found.size-before,jobIds:jobs.map(j=>j.jobId)}],
        stopReason: repeated ? 'repeated-page' : complete ? 'complete' : index === 1 ? 'two-page-cap' : 'next-page',ok:true});
      if (repeated) obs.warn('Second page repeated the first; coverage is incomplete');
      if (index === 1 && !complete && !repeated) obs.note('Two-page limit reached; additional results may exist');
      if (complete || repeated || zero) break;
    } catch (err) {
      obs.surface(`publicSearch:${index}`, {ok:false,requests:err.deferred && !err.status ? 0 : 1,error:err.message});
      if (!succeeded) throw err;
      break; // retain a successful first page
    }
  }
  obs.note('Mirrors public search results, including related titles; email packs narrow delivery only');
  return obs.done([...found.values()].map(j=>({...j,jobId:qualify(id,j.jobId),
    sourceSearch:true,matchKind:'search',matchedBy:'LinkedIn search',_surfaces:'J'})));
}

// No network calls for criteria or closure. Search membership is the user's rule.
export async function refine(jobs, {keywords,matchAll=false} = {}) {
  const words=(Array.isArray(keywords)?keywords:[keywords]).filter(Boolean);
  return jobs.filter(j=>j.sourceSearch || matchAll || matchesAny(j.title,words)).map(j=>({
    ...j,matchKind:j.sourceSearch?'search':'title',matchedBy:j.sourceSearch?'LinkedIn search':'title'
  }));
}
export function clearDetailCache() {}
export async function isClosed() { return null; }
