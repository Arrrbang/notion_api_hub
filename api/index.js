// api/index.js
// 메인 엔트리: Express 앱 생성 + SOS 라우트 등록 (+ Notion 연결 헬스체크)

const express = require("express");
const cors    = require("cors");
const axios   = require("axios");

const registerDestinationRoutes = require("./destination");
const registerOutboundSosRoutes = require("./outboundsos");
const registerInboundSosRoutes  = require("./inboundsos");

const app = express();
app.use(cors());
app.use(express.json());

/* ─────────────────────────────────────────────────────────
   Notion 기본 설정 (SOS 모듈과 같은 ENV를 사용)
────────────────────────────────────────────────────────── */

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  }
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

/* ─────────────────────────────────────────────────────────
   Health / Notion 연결 체크
   - 프론트에서 백엔드/노션 연결 상태 확인용
────────────────────────────────────────────────────────── */

app.get(["/", "/api/health"], async (req, res) => {
  const tokenPresent = Boolean(NOTION_TOKEN);

  if (!tokenPresent) {
    return res.status(500).json({
      ok: false,
      notion: { tokenPresent: false },
      error: "NOTION_API_KEY (또는 NOTION_TOKEN)이 설정되어 있지 않습니다."
    });
  }

  try {
    await axios.get("https://api.notion.com/v1/users/me", {
      headers: notionHeaders()
    });

    res.json({
      ok: true,
      notion: { tokenPresent: true, reachable: true },
      time: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      notion: { tokenPresent: true, reachable: false },
      error: "Notion API 연결에 실패했습니다.",
      details: e.response?.data || e.message || String(e)
    });
  }
});

/* ─────────────────────────────────────────────────────────
   라우트 등록
   - /api/outboundsos
   - /api/inboundsos
   - /api/destination
────────────────────────────────────────────────────────── */

// 도착지(DESTINATION) 관련 라우트 등록
registerDestinationRoutes(app);

// SOS (기존) 라우트 등록
registerOutboundSosRoutes(app);
registerInboundSosRoutes(app);


/* ─────────────────────────────────────────────────────────
   Export (Vercel @vercel/node)
────────────────────────────────────────────────────────── */

module.exports = app;
