/** Conservative reading aliases, applied only to the disposable TTS copy.
 * These are common reading conventions, not biological interpretation:
 * never turn +/- into knockout/wild type or expand an arbitrary gene symbol. */
const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', κ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', θ: 'theta', σ: 'sigma', τ: 'tau', ω: 'omega',
  ζ: 'zeta', η: 'eta', Δ: 'delta', Γ: 'gamma', Ω: 'omega',
};
const ASSAYS: Array<[RegExp, string]> = [
  [/\bscRNA[-‐‑–]?seq\b/gi, 'single cell RNA sequencing'],
  [/\bRNA[-‐‑–]?seq\b/gi, 'RNA sequencing'],
  [/\bChIP[-‐‑–]?seq\b/gi, 'ChIP sequencing'],
  [/\bATAC[-‐‑–]?seq\b/gi, 'ATAC sequencing'],
  [/\bRT[-‐‑–]?qPCR\b/g, 'reverse transcription quantitative PCR'],
  [/\bqPCR\b/g, 'quantitative PCR'],
  [/\bRT[-‐‑–]PCR\b/g, 'reverse transcription PCR'],
  [/\bCreERT2\b/g, 'Cre E R T 2'],
  [/\bloxP\b/g, 'lox P'],
];
const MARKER_NAME = 'CD\\d{1,3}(?:RA|RO|L|[a-dαβ])?|PD[-‐‑–]?(?:L[12]|1)|CTLA[-‐‑–]?4|LAG[-‐‑–]?3|TIM[-‐‑–]?3|TIGIT|FOXP3|Ki[-‐‑–]?67|Ly6[CG]';
const NEXT_MARKER = new RegExp(`^(?:${MARKER_NAME})`);
const MARKER = new RegExp(`\\b(${MARKER_NAME})(?:\\^\\{([+⁺⁻−-])\\}|\\^([+⁺⁻−-])|(high|bright|dim|low|hi|lo|[+⁺⁻−-]))?(?=$|(?:${MARKER_NAME})|\\/(?=(?:${MARKER_NAME}))|[^A-Za-z0-9_+⁺⁻−/\\-])`, 'g');

export function pronounceAcademicText(input: string): string {
  let text = input;
  // Known floxed alleles have a distinct convention. Keep non-floxed allele
  // symbols literal; '+' can mean a transgene, so it is not always wild type.
  text = text.replace(/(?<![A-Za-z0-9/])(?:fl|flox)\s*[\/∕]\s*(fl|flox|[+−-])(?![A-Za-z0-9/])/g,
    (_all, second: string) => `flox ${second === 'fl' || second === 'flox' ? 'flox' : second === '+' ? 'plus' : 'minus'}`);
  text = text.replace(/(?<![/+−-])([+−-])\s*[\/∕]\s*([+−-])(?![/+−-])/g,
    (_all, first: string, second: string, offset: number, whole: string) =>
      `${offset && /[A-Za-z0-9]/.test(whole[offset - 1]) ? ' ' : ''}${first === '+' ? 'plus' : 'minus'} slash ${second === '+' ? 'plus' : 'minus'}`);
  text = text.replace(MARKER, (_all, marker: string, latex: string, caret: string, suffix: string, offset: number, whole: string) => {
    const symbol = latex ?? caret ?? suffix;
    const name = marker.replace(/[-‐‑–]/g, ' ').replace(/^CD(\d+)(.*)$/, 'CD $1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2').trim();
    const spokenSuffix = symbol === '+' || symbol === '⁺' ? 'positive'
      : ['-', '−', '⁻'].includes(symbol) ? 'negative'
      : symbol === 'hi' ? 'high' : symbol === 'lo' ? 'low' : symbol;
    const join = NEXT_MARKER.test(whole.slice(offset + _all.length)) ? ' ' : '';
    return `${name}${spokenSuffix ? ` ${spokenSuffix}` : ''}${join}`;
  });
  // Upper-case IL notation, including receptor/subtype suffixes. Do not rewrite
  // lower-case gene symbols (Il6), Latin A as alpha, or NFKB1 as NF-kappa-B.
  text = text.replace(/\bIL[-‐‑–]?(\d{1,2})([A-Z]?)([αβγδ]?)(?![A-Za-z0-9])/g,
    (_all, number: string, subtype: string, greek: string) => `interleukin ${number}${subtype ? ` ${subtype}` : ''}${greek ? ` ${GREEK[greek]}` : ''}`);
  text = text.replace(/\b(TNF|TGF|IFN|NF)[-‐‑–]([αβγδκ])([A-Z]?)(\d*)(?![A-Za-z])/g,
    (_all, family: string, greek: string, subunit: string, number: string) => `${family} ${GREEK[greek]}${subunit ? ` ${subunit}` : ''}${number ? ` ${number}` : ''}`);
  for (const [pattern, alias] of ASSAYS) text = text.replace(pattern, alias);
  // Unit symbols only when attached to a number; no global gene-name rewriting.
  text = text.replace(/(\d(?:[\d.]*)\s*)[μµ](g|L|l|m|M)(?![A-Za-z])/g,
    (_all, number: string, unit: string) => `${number}${({g:'micrograms', L:'microliters', l:'microliters', m:'micrometers', M:'micromolar'} as Record<string,string>)[unit]}`);
  // Isolated scientific Greek characters, not Greek words or prose.
  text = text.replace(/(?<!\p{Script=Greek})[αβγδεκλμνθστωζηΔΓΩ](?!\p{Script=Greek})/gu,
    letter => ` ${GREEK[letter]} `);
  return text;
}
