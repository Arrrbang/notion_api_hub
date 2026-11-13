'use strict';
const splitCodes = value => [...new Set(String(value || '').split(',').map(v => v.trim()).filter(Boolean))];
const baseCode = value => String(value || '').trim().replace(/^\((?:BUS|INC)\)\s*/i, '').replace(/\s+/g, '').toUpperCase();
function readPort(properties = {}) {
  const raw = (properties['PORT CODE']?.rich_text || []).map(x => x.plain_text ?? x.text?.content ?? '').join('');
  const originalCodes = splitCodes(raw);
  const codes = [...new Set(originalCodes.map(baseCode).filter(Boolean))];
  const polProperty = properties.POL;
  const pols = [...new Set((polProperty?.multi_select || (polProperty?.select ? [polProperty.select] : [])).map(x => String(x.name || '').trim().toUpperCase()).filter(x => ['BUS','INC'].includes(x)))];
  const rateCodes = pols.flatMap(pol => codes.map(code => `(${pol})${code}`));
  return { baseCodes: codes, pols, rateCodes, rawCode: raw };
}
const matchesPoe = (codes, poe) => codes.some(code => baseCode(code) === baseCode(poe));
module.exports = { splitCodes, baseCode, readPort, matchesPoe };
