const express = require("express");
const axios = require("axios");
const router = express.Router();

// Notion 설정
const NOTION_DATABASE_ID = "2760b10191ce80799f5fe13cd365ddad"; // 업무 대시보드 DB
const SALES_INFO_DB_ID = "3a50b10191ce80c8b560f043f9565688"; // 💡 [추가] 영업/직원 정보 DB
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 💡 [삭제] 하드코딩된 USER_MAPPING 삭제 완료

function formatNotionPage(page) {
  const props = page.properties;
  
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  
  const countryRaw = props["국가"]?.select?.name || "";
  const country = countryRaw.match(/[가-힣]+/g)?.join(" ") || countryRaw;
  
  const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";
  
  const deadline = (props["서류마감"]?.date?.start || "").split("T")[0];
  const packingDate = (props["포장일"]?.date?.start || "").split("T")[0];
  const eta = (props["ETA"]?.date?.start || "").split("T")[0];

  const poeRaw = props["POE"]?.select?.name || props["POE"]?.rich_text?.[0]?.plain_text || "";
  const poe = poeRaw.replace(/\[[a-zA-Z]{5}\]\s*/, "");
  
  const salesRep = props["영업담당"]?.select?.name || "";
  const cbm = props["CBM"]?.number || 0; 

  return {
    id: page.id,
    clientName,
    country,
    assignees,
    deadline,
    packingDate,
    eta,
    poe,
    salesRep,
    cbm
  };
}

router.get("/", async (req, res) => {
  try {
    const { username } = req.query;
    const headers = notionHeaders();

    // ─────────────────────────────────────────────────────────────
    // 💡 [NEW] Query 0: 노션 영업/직원 DB에서 username(PASS_ID)로 한글명 찾기
    // ─────────────────────────────────────────────────────────────
    const userQuery = await axios.post(
      `https://api.notion.com/v1/databases/${SALES_INFO_DB_ID}/query`,
      {
        filter: {
          property: "PASS_ID",
          title: { equals: username }
        }
      },
      { headers }
    );

    const userPages = userQuery.data.results;
    if (!userPages || userPages.length === 0) {
      return res.status(400).json({ ok: false, error: "직원 정보 DB에 매칭되는 아이디가 없습니다." });
    }

    // "한글명" rich_text 속성에서 이름 텍스트 추출
    const koreanNameProp = userPages[0].properties["한글명"]?.rich_text;
    const salesRepName = koreanNameProp?.map(t => t.plain_text).join("") || "";

    if (!salesRepName) {
      return res.status(400).json({ ok: false, error: "해당 계정의 한글 이름이 노션에 등록되어 있지 않습니다." });
    }

    // ─────────────────────────────────────────────────────────────
    
    const today = new Date();
    const nextPassportLimitDate = new Date();
    nextPassportLimitDate.setDate(today.getDate() + 14);
    
    const todayStr = today.toISOString().split('T')[0];
    const nextPassportLimitDateStr = nextPassportLimitDate.toISOString().split('T')[0];

    // ─────────────────────────────────────────────────────────────
    // Query 1: 급한 건 (기존)
    // ─────────────────────────────────────────────────────────────
    const urgentQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      { 
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "여권수취여부", select: { does_not_equal: "수취" } },
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: nextPassportLimitDateStr } }
          ]
        },
        sorts: [{ property: "서류마감", direction: "ascending" }]
      }, 
      { headers }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 2: 보관 건 (기존)
    // ─────────────────────────────────────────────────────────────
    const storageQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      { 
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "보관유무", status: { equals: "보관" } } 
          ]
        },
        sorts: [{ property: "포장일", direction: "ascending" }]
      }, 
      { headers }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 3: 보험 요청 건 (기존)
    // ─────────────────────────────────────────────────────────────
    const insuranceQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      { 
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "보험가입", select: { equals: "보험요청" } } 
          ]
        },
        sorts: [{ property: "ETA", direction: "ascending" }]
      }, 
      { headers }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 4: 콘솔 대기 건 
    // ─────────────────────────────────────────────────────────────
    const consoleQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "영업담당", select: { equals: salesRepName } },
            { property: "컨테이너/콘솔", select: { equals: "콘솔대기" } }
          ]
        },
        sorts: [
          { property: "POE", direction: "ascending" },
          { property: "포장일", direction: "ascending" }
        ]
      },
      { headers }
    );

    // 모든 쿼리 병렬 실행
    const [urgentRes, storageRes, insuranceRes, consoleRes] = await Promise.all([
      urgentQuery, 
      storageQuery, 
      insuranceQuery,
      consoleQuery
    ]);

    res.json({ 
      ok: true, 
      targetName: salesRepName,
      data: {
        urgent: urgentRes.data.results.map(formatNotionPage),
        storage: storageRes.data.results.map(formatNotionPage),
        insurance: insuranceRes.data.results.map(formatNotionPage),
        console: consoleRes.data.results.map(formatNotionPage)
      }
    });

  } catch (error) {
    console.error("Notion API Error:", error.response?.data || error.message);
    res.status(500).json({ 
      ok: false, 
      error: "서버 내부 오류가 발생했습니다.", 
      details: error.response?.data || error.message 
    });
  }
});

module.exports = (app) => {
  app.use("/api/home/home-sales", router);
};
