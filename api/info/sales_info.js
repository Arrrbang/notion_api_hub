// api/sales_info.js - 영업/직원 정보 노션 DB 연동 라우트
const axios = require('axios');

// 환경변수 및 노션 공통 설정
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const SALES_DB_ID = '3a50b10191ce80c8b560f043f9565688';

function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN이 없습니다.');
  }
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28',
  };
}

// Notion 속성 파싱 헬퍼 함수들
function getTextFromRich(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.map(t => t?.plain_text || '').join('');
}
function getTitle(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'title') return getTextFromRich(col.title);
  if (col.type === 'rich_text') return getTextFromRich(col.rich_text);
  return '';
}
function getRichText(props, key) {
  const col = props?.[key];
  if (!col) return '';
  if (col.type === 'rich_text') return getTextFromRich(col.rich_text);
  if (col.type === 'title') return getTextFromRich(col.title);
  return '';
}
function getSelectName(prop) {
  return prop?.select?.name || '';
}
// 💡 [추가] 숫자 타입 가져오는 헬퍼 함수
function getNumber(props, key) {
  const col = props?.[key];
  if (!col || col.type !== 'number') return 0;
  return col.number || 0;
}

function registerSalesInfoRoutes(app) {
  // =========================================================================
  // 1. 전체/특정 직원 조회 API
  // =========================================================================
  app.get('/api/sales-info', async (req, res) => {
    try {
      const { pass_id } = req.query;
      const queryPayload = { page_size: 100 };

      if (pass_id) {
        queryPayload.filter = {
          property: 'PASS_ID',
          title: { equals: pass_id.trim() },
        };
      }

      const response = await axios.post(
        `https://api.notion.com/v1/databases/${SALES_DB_ID}/query`,
        queryPayload,
        { headers: notionHeaders() }
      );

      const pages = response.data.results || [];

      const salesList = pages.map(page => {
        const props = page.properties || {};
        return {
          id: page.id,
          pass_id: getTitle(props, 'PASS_ID'),
          korean_name: getRichText(props, '한글명'),
          english_name: getRichText(props, '영문명'),
          tel: getRichText(props, 'TEL'),
          dir: getRichText(props, 'DIR'),
          email: getRichText(props, 'E-MAIL'),
          position: getSelectName(props, '직책'),
          // 💡 [추가] DB에 생성한 profit(숫자) 속성 읽어오기
          profit: getNumber(props, 'profit'), 
        };
      });

      return res.json({
        ok: true,
        count: salesList.length,
        data: pass_id ? (salesList[0] || null) : salesList,
      });

    } catch (e) {
      console.error('Sales Info API Error:', e.response?.data || e.message);
      return res.status(500).json({ ok: false, error: 'sales_info failed' });
    }
  });

  // =========================================================================
  // 2. 💡 [추가] 직원 수익률(Profit) 업데이트 API
  // =========================================================================
  app.post('/api/sales-info/profit', async (req, res) => {
    try {
      const { pass_id, profit } = req.body;
      if (!pass_id) return res.status(400).json({ ok: false, error: 'pass_id가 필요합니다.' });

      // ① 해당 직원의 페이지 ID 먼저 찾기
      const queryPayload = { filter: { property: 'PASS_ID', title: { equals: pass_id.trim() } } };
      const queryRes = await axios.post(`https://api.notion.com/v1/databases/${SALES_DB_ID}/query`, queryPayload, { headers: notionHeaders() });
      
      if (!queryRes.data.results || queryRes.data.results.length === 0) {
        return res.status(404).json({ ok: false, error: '해당 직원을 찾을 수 없습니다.' });
      }
      const pageId = queryRes.data.results[0].id;

      // ② 노션 페이지의 'profit' 숫자 속성 덮어쓰기
      await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
        properties: {
          'profit': { number: Number(profit) }
        }
      }, { headers: notionHeaders() });

      return res.json({ ok: true, message: '수익률이 노션 DB에 안전하게 저장되었습니다.' });

    } catch (e) {
      console.error('Profit Update Error:', e.response?.data || e.message);
      return res.status(500).json({ ok: false, error: 'Update failed' });
    }
  });
}

module.exports = registerSalesInfoRoutes;
