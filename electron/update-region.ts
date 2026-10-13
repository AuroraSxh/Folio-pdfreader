/** Only the country classification survives this request; trace/IP data are never persisted. */
export type UpdateRegion = 'CN' | 'other' | 'unknown';
export const UPDATE_REGION_URL = 'https://cloudflare.com/cdn-cgi/trace';
const COUNTRIES = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

export function parseUpdateRegion(trace: string): UpdateRegion {
  const lines = trace.split(/\r?\n/).filter(line => line.startsWith('loc='));
  if (lines.length !== 1) return 'unknown';
  const country = lines[0].slice(4);
  return !COUNTRIES.has(country) ? 'unknown' : country === 'CN' ? 'CN' : 'other';
}

export async function detectUpdateRegion(fetcher: typeof fetch, signal: AbortSignal): Promise<UpdateRegion> {
  if (signal.aborted) return 'unknown';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 4000);
  // A mocked or malfunctioning fetch/body must not defeat the deadline.
  const race = <T>(promise: Promise<T>) => new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new Error('Region check cancelled')); };
    const cleanup = () => controller.signal.removeEventListener('abort', aborted);
    if (controller.signal.aborted) { aborted(); return; }
    controller.signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await race(fetcher(UPDATE_REGION_URL, { method: 'GET', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal, headers: { Accept: 'text/plain' } }));
    if (response.status !== 200 || response.url !== UPDATE_REGION_URL || !response.body) { void response.body?.cancel().catch(() => {}); return 'unknown'; }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 8192)) { void response.body.cancel().catch(() => {}); return 'unknown'; }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await race(reader.read());
      if (done) break;
      length += value.byteLength;
      if (length > 8192) return 'unknown';
      chunks.push(value);
    }
    return parseUpdateRegion(Buffer.concat(chunks).toString('utf8'));
  } catch { return 'unknown'; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); void reader?.cancel().catch(() => {}); }
}
