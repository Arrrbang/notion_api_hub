'use strict';
const splitCodes = value => [...new Set(String(value || '').split(',').map(v => v.trim()).filter(Boolean))];
const baseCode = value => String(value || '').trim().replace(/^\((?:BUS|INC)\)\s*/i, '').toUpperCase();
function readPort(properties = {}) {
  const raw = (properties['PORT CODE']?.rich_text || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
  const originalCodes = splitCodes(raw);
  const codes = [...new Set(originalCodes.map(baseCode).filter(Boolean))];
  const polProperty = properties.POL;
  const pols = [...new Set((polProperty?.multi_select || (polProperty?.select ? [polProperty.select] : [])).map(x => String(x.name || '').trim().toUpperCase()).filter(x => ['BUS','INC'].includes(x)))];
  const rateCodes = pols.flatMap(pol => codes.map(code => `(${pol})${code}`));
  return { baseCodes: codes, pols, rateCodes, rawCode: raw };
}
// 타리프의 USATL은 USATL(VIA LA)에도 대응합니다. 원본 코드는 운임 조회에 그대로 사용합니다.
const comparable = value => baseCode(value).replace(/\s+/g, '');
const matchesPoe = (codes, poe) => {
  const target = comparable(poe);
  return !!target && codes.some(code => comparable(code).includes(target));
};
const rootCode = value => comparable(value).replace(/\(VIA[^)]*\)$/, '');
// 체크박스는 같은 항구의 대체 행이 있을 때만 사용합니다. 쉼표로 묶인 코드도 각각 비교합니다.
const destinationOnly = page => page.properties?.['도착지비용']?.checkbox === true;
function ratePorts(pages) {
  const entries = pages.map(page => ({page, codes: readPort(page.properties).baseCodes.map(rootCode).filter(Boolean)}));
  const counts = new Map();
  for (const entry of entries) for (const code of new Set(entry.codes)) counts.set(code, (counts.get(code) || 0) + 1);
  return entries.filter(({page,codes}) => !destinationOnly(page) || !codes.some(code => counts.get(code) > 1)).map(entry => entry.page);
}
module.exports = { splitCodes, baseCode, readPort, matchesPoe, destinationOnly, ratePorts };
