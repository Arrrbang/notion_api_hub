// api/index.js
// 메인 엔트리: Express 앱 생성 + OUTBOUND SOS 라우트 등록

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
   Notion 기본 설정 (상태 확인용 헬스체크에만 사용)
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
────────────────────────────────────────────────────────── */

app.get(["/", "/api/health"], async (req, res) => {
  const tokenPresent = Boolean(NOTION_TOKEN);

  if (!tokenPresent) {
    // 토큰 없으면 서버는 살아있지만, Notion 연동 안 되는 상태
    return res.status(500).json({
      ok: false,
      notion: { tokenPresent: false },
      error: "NOTION_API_KEY (또는 NOTION_TOKEN)이 설정되어 있지 않습니다."
    });
  }

  try {
    // 가벼운 Notion API 호출로 실제 연결 여부 확인
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
────────────────────────────────────────────────────────── */

registerOutboundSosRoutes(app);
registerInboundSosRoutes(app);
registerDestinationRoutes(app);

/* ─────────────────────────────────────────────────────────
   Export (Vercel @vercel/node)
────────────────────────────────────────────────────────── */

module.exports = app;
