/**
 * DEST_RATE 결과표 전용 백엔드 — dest_table.js
 * 대표 DB에서 국가의 타리프 DB를 찾고 도착항구 PORT CODE와 원래 POE를 연결합니다.
 * 선택 조건 모두가 일치하는 행 + 지역 다중선택이 비어 있는 모든 행을 반환합니다.
 * 지역이 빈 행은 지역 조건만 면제하며 나머지 선택 조건은 반드시 일치해야 합니다.
 * 기존 costs.js의 직접금액/CBM/최소요금/LOOP/지역·타입·구간 수식 계산을 사용합니다.
 * 참고사항 서식, CDS/ADD/TAX/OTC 구분, 순서, 통화를 반환합니다.
 * 실제 환율 변환 및 추가항목 선택 합계는 프론트 공통 CurrencyConverter/BottomBar가 담당합니다.
 */
const axios = require('axios');

// ────────────────────────────────
// 환경변수 & 노션 공통 설정
// ────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 속성명 설정 (기본/추가, 표시타입 제거 및 '타입'으로 통합)
const REGION_PROP       = process.env.REGION_PROP       || '지역';       
const COMPANY_PROP      = process.env.COMPANY_PROP      || '업체';       
const POE_PROP          = process.env.POE_PROP          || 'POE';        
const CARGO_PROP        = process.env.CARGO_PROP        || '화물타입';   
const ROW_TYPE_PROP     = process.env.ROW_TYPE_PROP     || '타입';       // ✨ 통합된 속성
const ITEM_PROP         = process.env.ITEM_PROP         || '항목';       
const EXTRA_PROP        = process.env.EXTRA_PROP        || '참고사항';   
const FORMULA_PROP      = process.env.FORMULA_PROP      || '계산식';     
const CURRENCY_PROP     = '통화';
const CONTAINER_TYPE_PROP = process.env.CONTAINER_TYPE_PROP || '컨테이너 타입';

// 1~28 CBM 직접 입력 속성명 배열 생성
const CBM_DIRECT_PROPS = Array.from({ length: 28 }, (_, i) => (i + 1).toString());

// CONSOLE 및 순서 정렬용
const MIN_COST_PROP     = process.env.MIN_COST_PROP    || 'MIN COST';
const MIN_CBM_PROP      = process.env.MIN_CBM_PROP     || 'MIN CBM';
const PER_COST_PROP     = process.env.PER_COST_PROP    || 'PER CBM';
const ORDER_PROP        = process.env.ORDER_PROP       || '순서';

// ────────────────────────────────
// Notion 및 DB 유틸리티
// ────────────────────────────────
function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN이 없습니다.');
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };
}

// ────────────────────────────────
// Notion 속성 파싱 헬퍼
// ────────────────────────────────
function getTextFromRich(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => t?.plain_text || '').join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m] || m));
}

function richTextToHtml(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => {
    if (!t) return '';
    const ann = t.annotations || {};
    let txt = escapeHtml(t.plain_text || '');
    txt = txt.replace(/\n/g, '<br>');
    if (ann.bold) txt = `<strong>${txt}</strong>`;
    if (ann.italic) txt = `<em>${txt}</em>`;
    if (ann.underline) txt = `<u>${txt}</u>`;
    if (ann.strikethrough) txt = `<s>${txt}</s>`;
    if (ann.code) txt = `<code>${txt}</code>`;
    const href = t.href || t.text?.link?.url;
    if (href) txt = `<a href="${String(href).replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    return txt;
  }).join('');
}

function getRichTextHtml(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'rich_text') return richTextToHtml(col.rich_text);
  if (col.type === 'title') return richTextToHtml(col.title);
  return '';
}

function getTitle(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'title') return getTextFromRich(col.title);
  if (col.type === 'rich_text') return getTextFromRich(col.rich_text);
  return '';
}

function getSelectName(prop) { return prop?.select?.name || ''; }
function getMultiSelectNames(prop) { return (prop?.multi_select || []).map(o => o?.name).filter(Boolean); }

function getNumberFromProp(prop) {
  if (!prop) return undefined;
  if (typeof prop === 'number') return prop;
  if (typeof prop.number === 'number') return prop.number;
  if (typeof prop.value === 'number') return prop.value;
  return undefined;
}

function getDynamicCbmAmount(props, cbm, rawFormula = '') {
  if (!Number.isFinite(cbm)) return undefined;

  const perCost = getNumberFromProp(props[PER_COST_PROP]);

  // 전체 열(1~28) 중에서 '가장 높게 채워진 CBM'과 '그 금액' 찾기
  let maxOverallCbm = 0;
  let maxOverallCost = 0;
  for (let i = 28; i >= 1; i--) {
    const val = getNumberFromProp(props[i.toString()]);
    if (Number.isFinite(val)) {
      maxOverallCbm = i;
      maxOverallCost = val;
      break;
    }
  }

  // 1. ✨ LOOP_숫자 감지 (대소문자 무시, 28 열이 비어있어도 작동)
  const loopMatch = rawFormula.match(/LOOP_(\d+)/i);

  if (loopMatch && maxOverallCbm > 0 && Number.isFinite(perCost)) {
    const threshold = parseInt(loopMatch[1], 10); // 예: 35

    // 설정한 기준점이 실제로 최대 입력된 CBM보다 클 때만 유효하게 작동
    if (threshold >= maxOverallCbm) {
      
      // 임계점(예: 35 CBM)에 도달했을 때 꽉 찬 최대 요금 계산
      // = 가장 큰 입력값 + (임계점까지 남은 CBM * PER CBM)
      const maxCostAtThreshold = maxOverallCost + ((threshold - maxOverallCbm) * perCost);

      // 임계점 초과 구간 (예: 36 CBM 이상) -> 초과분 순환 계산
      if (cbm > threshold) {
        const remainder = cbm - threshold;
        const remainderVal = getDynamicCbmAmount(props, remainder, rawFormula);
        
        if (Number.isFinite(remainderVal)) {
          return maxCostAtThreshold + remainderVal;
        }
      }

      // 기준점 이하이면서 노션에 입력된 최고 CBM보다 큰 구간 (예: 15까지 입력되어 있고 CBM이 30일 때)
      if (cbm > maxOverallCbm && cbm <= threshold) {
        return maxOverallCost + ((cbm - maxOverallCbm) * perCost);
      }
    }
  }

  // 2. 1 ~ 28 CBM 직접 입력 매칭 (LOOP 여부 무관하게 우선 적용)
  if (cbm >= 1 && cbm <= 28) {
    const exactVal = getNumberFromProp(props[Math.floor(cbm).toString()]);
    if (Number.isFinite(exactVal)) return exactVal;
  }

  // 3. 위 조건에 해당하지 않는 나머지 CBM 처리 (기존 PER CBM 가산 로직)
  let highestFilledCbmForTarget = 0;
  let highestFilledCostForTarget = 0;
  const maxCheck = Math.min(Math.floor(cbm), 28);
  
  for (let i = maxCheck; i >= 1; i--) {
    const val = getNumberFromProp(props[i.toString()]);
    if (Number.isFinite(val)) {
      highestFilledCbmForTarget = i;
      highestFilledCostForTarget = val;
      break;
    }
  }

  if (highestFilledCbmForTarget > 0 && Number.isFinite(perCost)) {
    return highestFilledCostForTarget + ((cbm - highestFilledCbmForTarget) * perCost);
  }

  return undefined;
}

function calcConsoleAmount(props, cbm) {
  const minCost = getNumberFromProp(props[MIN_COST_PROP]);
  const minCbm  = getNumberFromProp(props[MIN_CBM_PROP]);
  const perCost = getNumberFromProp(props[PER_COST_PROP]);
  if (!Number.isFinite(cbm) || !Number.isFinite(minCost) || !Number.isFinite(minCbm) || !Number.isFinite(perCost)) return undefined;
  if (cbm <= minCbm) return minCost;
  return minCost + (cbm - minCbm) * perCost;
}

function computeAmount(props, type, cbm, selectedRegion) {
  // 1. ✨ 가장 먼저 요청된 타입(20FT 또는 40HC) 자체의 속성값이 있는지 확인하고, 있으면 즉시 최우선 반환합니다.
  if (type === '20FT' || type === '40HC') {
    const directVal = getNumberFromProp(props[type]);
    if (Number.isFinite(directVal)) {
      return directVal;
    }
  }

  // 2. 20FT/40HC 직접 값이 없을 경우, 기존의 CBM 직접 입력(1~28) 또는 동적 CBM 계산을 수행합니다.
  const rawFormula = getTitle(props, FORMULA_PROP);
  const dynamicAmount = getDynamicCbmAmount(props, cbm, rawFormula);
  if (dynamicAmount !== undefined) return dynamicAmount;

  // 3. 기존 베이스 코스트 및 콘솔 계산 로직
  const val20 = getNumberFromProp(props['20FT']);
  const val40 = getNumberFromProp(props['40HC']);
  const consoleAmt = calcConsoleAmount(props, cbm);
  const hasBaseCost = Number.isFinite(val20) || Number.isFinite(val40) || Number.isFinite(consoleAmt);

  let amount;
  if (type === '20FT') amount = val20 ?? consoleAmt;
  else if (type === '40HC') amount = val40 ?? consoleAmt;
  else amount = consoleAmt;

  const shouldUseFormula = rawFormula && (!hasBaseCost || /REGION\b|DEFAULT\b|TYPE\b/i.test(rawFormula));

  if (shouldUseFormula) {
    let code = applyRegionFormula(rawFormula, selectedRegion || '', amount, cbm);
    code = applyTypeFormula(code, type);
    let v = evalRangeFormula(code, cbm);
    if (!Number.isFinite(v)) v = evalFormula(code, { cbm });
    if (Number.isFinite(v)) amount = v;
  }
  return amount;
}

// ────────────────────────────────
// 수식 처리 엔진
// ────────────────────────────────
function evalFormula(code, context) {
  if (!code) return undefined;
  let expr = String(code).trim();
  const safe = /^[0-9+\-*/().\sCBMcbmMAXMIN,<>?=:]+$/i;
  if (!safe.test(expr.replace(/Math\.(max|min)/g, ''))) return undefined;
  expr = expr.replace(/CBM/gi, String(Number(context?.cbm ?? 0))).replace(/MAX/gi, 'Math.max').replace(/MIN/gi, 'Math.min');
  try { return new Function('"use strict"; return (' + expr + ');')(); } catch (e) { return undefined; }
}

function evalRangeFormula(code, cbm) {
  if (!code) return undefined;
  let clean = code.trim();
  while (clean.startsWith('(') && clean.endsWith(')')) {
    let depth = 0, isPair = true;
    for (let i = 0; i < clean.length - 1; i++) {
      if (clean[i] === '(') depth++; else if (clean[i] === ')') depth--;
      if (depth === 0) { isPair = false; break; }
    }
    if (isPair) clean = clean.slice(1, -1).trim(); else break;
  }
  const lines = clean.split(/[\n,]+/).map(s => s.trim().replace(/^\(+|\)+$/g, '')).filter(Boolean);
  for (const line of lines) {
  
    // 20<CBM≤30 = 3000 같은 형식 처리
    let m = line.match(/^(\d+(?:\.\d+)?)\s*(<=|<|≤)\s*CBM\s*(<=|<|≤)\s*(\d+(?:\.\d+)?)\s*=\s*(.+)$/i);
    if (m) {
      const left = Number(m[1]);
      const leftOp = m[2];
      const rightOp = m[3];
      const right = Number(m[4]);
  
      const okLeft = leftOp === '<' ? cbm > left : cbm >= left;
      const okRight = rightOp === '<' ? cbm < right : cbm <= right;
  
      if (okLeft && okRight) return evalFormula(m[5], { cbm });
    }
  
    // 25<CBM = 3000 같은 형식 처리
    m = line.match(/^(\d+(?:\.\d+)?)\s*(<=|<|≤)\s*CBM\s*=\s*(.+)$/i);
    if (m) {
      const left = Number(m[1]);
      const op = m[2];
  
      if ((op === '<' && cbm > left) || ((op === '<=' || op === '≤') && cbm >= left)) {
        return evalFormula(m[3], { cbm });
      }
    }
  
    m = line.match(/^(\d+)\s*(?:<=|≤|<)\s*CBM\s*(?:<=|≤|<)\s*(\d+)\s*=\s*(.+)$/i);
    if (m && cbm >= Number(m[1]) && cbm <= Number(m[2])) return evalFormula(m[3], { cbm });
    m = line.match(/^CBM\s*(<=|>=|≤|≥|[<>]=?)\s*(\d+)\s*=\s*(.+)$/i);
    if (m) {
      const op = m[1], num = Number(m[2]);
      if ((op === '<' && cbm < num) || (op === '>' && cbm > num) || ((op === '<=' || op === '≤') && cbm <= num) || ((op === '>=' || op === '≥') && cbm >= num)) return evalFormula(m[3], { cbm });
    }
    m = line.match(/^ELSE\s+(\d+)/i); if (m) return Number(m[1]);
  }
  return undefined;
}

function applyRegionFormula(code, region, base, cbm) {
  let expr = String(code).replace(/\bDEFAULT\b/gi, String(base || 0));
  const ifRegex = /IF\(\s*REGION\s*=\s*["']([^"']*)["']\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;
  while (ifRegex.test(expr)) {
    expr = expr.replace(ifRegex, (m, target, thenP, elseP) => (region === target ? thenP : elseP));
  }
  return expr;
}

function applyTypeFormula(code, type) {
  let expr = String(code || '').trim();

  function parseIfType(s) {
    const start = s.toUpperCase().indexOf('IF(');
    if (start < 0) return s;

    let i = start + 3;
    let depth = 0;
    let parts = [''];
    let quote = null;

    for (; i < s.length; i++) {
      const ch = s[i];

      if (quote) {
        parts[parts.length - 1] += ch;
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        parts[parts.length - 1] += ch;
        continue;
      }

      if (ch === '(') {
        depth++;
        parts[parts.length - 1] += ch;
        continue;
      }

      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        parts[parts.length - 1] += ch;
        continue;
      }

      if (ch === ',' && depth === 0) {
        parts.push('');
        continue;
      }

      parts[parts.length - 1] += ch;
    }

    if (parts.length < 3) return s;

    const condition = parts[0].trim();
    const thenP = parts[1].trim();
    const elseP = parts.slice(2).join(',').trim();

    const m = condition.match(/^TYPE\s*=\s*["']([^"']+)["']$/i);
    if (!m) return s;

    return type.toUpperCase() === m[1].toUpperCase()
      ? thenP
      : parseIfType(elseP);
  }

  return parseIfType(expr);
}

const MASTER_ID = '4000b10191ce801c8ed9e2df011bf664';
const PORT_ID = '36e0b10191ce804492fce82a1d2719c3';
// 타입 속성은 선택/다중선택/텍스트/상태 형식에서 CDS·ADD·OTC·TAX를 읽습니다.
function getRowType(prop) {
  const candidates = prop?.select ? [prop.select.name]
    : prop?.multi_select ? prop.multi_select.map(v => v.name)
    : prop?.status ? [prop.status.name]
    : [getTextFromRich(prop?.rich_text || prop?.title || [])];
  const types = candidates.map(v => String(v || '').trim().toUpperCase()).filter(Boolean);
  const known = [...new Set(types.filter(v => ['CDS','ADD','OTC','TAX'].includes(v)))];
  if (known.length > 1) throw new Error('한 비용 행에 타입이 여러 개 지정되어 있습니다.');
  if (!known.length && types.length) throw new Error('지원하지 않는 비용 타입: ' + types.join(', '));
  return known[0] || 'CDS';
}
function normalizeId(v) {
  const s = String(v || '').trim();
  return /^[0-9a-f]{32}$/i.test(s) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) ? s.replace(/-/g,'').toLowerCase() : null;
}
async function queryAll(id) {
  const pages=[];let cursor;
  do {
    const {data}=await axios.post(`https://api.notion.com/v1/databases/${id}/query`,{
      page_size:100,...(cursor?{start_cursor:cursor}:{})
    },{headers:notionHeaders(),timeout:20000});
    pages.push(...(data.results || []));cursor=data.has_more?data.next_cursor:null;
  } while(cursor);
  return pages;
}
module.exports = function registerDestTableRoutes(app) {
  app.get('/api/dest-rate/table', async (req,res) => {
    try {
      res.set('Cache-Control','no-store');
      const params={};
      for(const key of ['countryId','region','company','cargo','portId','type','cbm']) {
        if(typeof req.query[key]!=='string'||!req.query[key].trim()) return res.status(400).json({ok:false,error:`${key} 선택값이 필요합니다.`});
        params[key]=req.query[key].trim();
      }
      const {countryId,region,company,cargo,portId,type}=params;
      const cbm=Number(params.cbm);
      if(!normalizeId(countryId)||!normalizeId(portId)||!Number.isInteger(cbm)||cbm<1||cbm>68)
        return res.status(400).json({ok:false,error:'국가·항구 ID 또는 CBM(1~68)이 올바르지 않습니다.'});
      const master=(await queryAll(MASTER_ID)).find(p=>normalizeId(p.id)===normalizeId(countryId));
      if(!master) return res.status(404).json({ok:false,error:'대표 DB에서 국가를 찾지 못했습니다.'});
      const tariffId=normalizeId(getTitle(master.properties,'타리프 DB ID'));
      if(!tariffId) return res.status(422).json({ok:false,error:'타리프 DB ID를 확인해 주세요.'});
      const port=(await queryAll(PORT_ID)).find(p=>normalizeId(p.id)===normalizeId(portId));
      if(!port) return res.status(404).json({ok:false,error:'도착항구를 찾지 못했습니다.'});
      const portCode=getTitle(port.properties,'PORT CODE');
      const pages=await queryAll(tariffId);
      const matched=pages.filter(page=>{
        const p=page.properties || {}, regions=getMultiSelectNames(p[REGION_PROP]);
        return (!regions.length || regions.includes(region)) && getSelectName(p[COMPANY_PROP])===company
          && getMultiSelectNames(p[CARGO_PROP]).includes(cargo)
          && getMultiSelectNames(p[POE_PROP]).some(value=>portCode.includes(value))
          && getMultiSelectNames(p[CONTAINER_TYPE_PROP]).includes(type);
      });
      const rows=matched.map(page=>{
        const p=page.properties || {};
        return {id:page.id,item:getTitle(p,ITEM_PROP)||getTitle(p,'Name'),
          rowType:getRowType(p[ROW_TYPE_PROP]),order:getNumberFromProp(p[ORDER_PROP])??9999,
          [type]:computeAmount(p,type,cbm,region)??null,extra:getRichTextHtml(p,EXTRA_PROP),
          currency:getTitle(p,CURRENCY_PROP).trim().toUpperCase(),isCommon:!getMultiSelectNames(p[REGION_PROP]).length};
      }).sort((a,b)=>a.order-b.order);
      const currencies=[...new Set(rows.filter(r=>Number.isFinite(r[type])&&!['TAX','OTC'].includes(r.rowType.toUpperCase())).map(r=>r.currency).filter(Boolean))];
      if(currencies.length>1) return res.status(422).json({ok:false,error:`서로 다른 통화(${currencies.join(', ')})의 비용이 포함되어 있습니다. 타리프 통화를 통일해 주세요.`});
      const currency=currencies[0] || rows.find(r=>r.currency)?.currency || 'USD';
      res.json({ok:true,country:getTitle(master.properties,'나라명'),region,company,cargo,
        poe:getTitle(port.properties,'PORT NAME'),portCode,type,cbm,rows,currency});
    } catch(e) {
      console.error('[dest_table]',e.response?.status||e.code||e.message);
      res.status(500).json({ok:false,error:'비용 조회에 실패했습니다. DB 권한과 속성 및 계산식을 확인해 주세요.'});
    }
  });
};
