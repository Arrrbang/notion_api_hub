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

// ────────────────────────────────
// API 라우터 등록 함수
// ────────────────────────────────
function registerSalesInfoRoutes(app) {
  // 전체 목록 조회 또는 PASS_ID로 특정 직원 조회 API (/api/sales-info)
  app.get('/api/sales-info', async (req, res) => {
    try {
      const { pass_id } = req.query;

      // Notion DB 쿼리 페이로드 구성 (PASS_ID가 있으면 필터링)
      const queryPayload = {
        page_size: 100,
      };

      if (pass_id) {
        queryPayload.filter = {
          property: 'PASS_ID',
          title: {
            equals: pass_id.trim(),
          },
        };
      }

      const response = await axios.post(
        `https://api.notion.com/v1/databases/${SALES_DB_ID}/query`,
        queryPayload,
        { headers: notionHeaders() }
      );

      const pages = response.data.results || [];

      // 요구된 7가지 속성 매핑
      const salesList = pages.map(page => {
        const props = page.properties || {};

        return {
          id: page.id,
          pass_id: getTitle(props, 'PASS_ID'),         // 제목: PASS_ID
          korean_name: getRichText(props, '한글명'),     // 텍스트: 한글명
          english_name: getRichText(props, '영문명'),    // 텍스트: 영문명
          tel: getRichText(props, 'TEL'),                // 텍스트: TEL
          dir: getRichText(props, 'DIR'),                // 텍스트: DIR
          email: getRichText(props, 'E-MAIL'),           // 텍스트: E-MAIL
          position: getSelectName(props, '직책'),        // 선택속성: 직책
        };
      });

      return res.json({
        ok: true,
        count: salesList.length,
        data: pass_id ? (salesList[0] || null) : salesList,
      });

    } catch (e) {
      console.error('Sales Info API Error:', e.response?.data || e.message);
      return res.status(500).json({
        ok: false,
        error: 'sales_info failed',
        details: e.response?.data || e.message,
      });
    }
  });
}

module.exports = registerSalesInfoRoutes;
