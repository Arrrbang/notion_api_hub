// api/home/home-ops.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// Notion 설정
const NOTION_DATABASE_ID = "2760b10191ce80799f5fe13cd365ddad";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 1. [매핑] Ops 사용자 -> '업무담당' 이름
const OPS_USER_MAPPING = {
  "admin": "지아름",
  "opere": "지아름",
  "opero": "노해원",
  "operd": "소다미"
};

// 2. [날짜 유틸] 영업일 계산 (주말/공휴일 제외)
// 간단한 하드코딩 공휴일 리스트 (YYYY-MM-DD)
const HOLIDAYS = [
    "2024-01-01", "2024-02-09", "2024-02-10", "2024-02-11", "2024-02-12",
    "2024-03-01", "2024-04-10", "2024-05-05", "2024-05-06", "2024-05-15",
    "2024-06-06", "2024-08-15", "2024-09-16", "2024-09-17", "2024-09-18",
    "2024-10-03", "2024-10-09", "2024-12-25",
    "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30"
];

function getDateString(date) {
    return date.toISOString().split('T')[0];
}

// targetDays(예: 2일) 후의 영업일 날짜 구하기
function addBusinessDays(startDate, daysToAdd) {
    let count = 0;
    let currentDate = new Date(startDate);
    
    while (count < daysToAdd) {
        // 하루 증가
        currentDate.setDate(currentDate.getDate() + 1);
        
        const dayOfWeek = currentDate.getDay(); // 0:일, 6:토
        const dateStr = getDateString(currentDate);

        // 주말이 아니고, 공휴일이 아니면 카운트 증가
        if (dayOfWeek !== 0 && dayOfWeek !== 6 && !HOLIDAYS.includes(dateStr)) {
            count++;
        }
    }
    return currentDate;
}

// 3. 노션 페이지 포맷팅 (Ops 전용)
function formatOpsPage(page) {
  const props = page.properties;
  
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  const salesRep = props["영업담당"]?.select?.name || ""; // 영업담당
  const assignees = props["업무담당"]?.people?.map(p => p.name) || []; // 배열로 반환 (필터링용)
  const deadline = props["서류마감"]?.date?.start || "";
  const containerDate = props["컨작업일정"]?.date?.start || "";

  return {
    id: page.id,
    clientName,
    salesRep,
    assignees, // 나중에 JS에서 필터링
    deadline,
    containerDate
  };
}

router.get("/", async (req, res) => {
  try {
    const { username } = req.query;
    const opsName = OPS_USER_MAPPING[username]; // 예: 홍길동

    if (!opsName) {
      return res.status(400).json({ ok: false, error: "매칭되는 업무담당자가 없습니다." });
    }

    const today = new Date();
    const todayStr = getDateString(today);

    // ─────────────────────────────────────────────────────────────
    // Query 1: 여권 수취 필요 (기존 급한 건 로직 + 업무담당 필터)
    // 조건: 날짜(오늘~1주), 여권 != 수취
    // ─────────────────────────────────────────────────────────────
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    const nextWeekStr = getDateString(nextWeek);

    const passportQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "여권수취여부", select: { does_not_equal: "수취" } },
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: nextWeekStr } }
          ]
        }
      },
      { headers: notionHeaders() }
    );

    // ─────────────────────────────────────────────────────────────
    // Query 2: 2일 이내 마감 (공휴일 제외)
    // ─────────────────────────────────────────────────────────────
    const targetDate = addBusinessDays(today, 2); // 2 영업일 후
    const targetDateStr = getDateString(targetDate);

    const deadlineQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: targetDateStr } }
          ]
        }
      },
      { headers: notionHeaders() }
    );

    // 병렬 실행
    const [passportRes, deadlineRes] = await Promise.all([passportQuery, deadlineQuery]);

    // ─────────────────────────────────────────────────────────────
    // [중요] '업무담당'은 Person 속성이므로 API 필터링이 까다로움.
    // 날짜로 1차 필터링된 데이터를 가져온 후, JS에서 이름으로 2차 필터링 수행.
    // ─────────────────────────────────────────────────────────────
    
    // 1. 여권 수취 필요 데이터 정제 및 필터링
    const passportNeeded = passportRes.data.results
        .map(formatOpsPage)
        .filter(item => item.assignees.includes(opsName)); // 업무담당자에 본인이 포함된 경우만

    // 2. 마감 임박 데이터 정제 및 필터링
    const upcomingDeadline = deadlineRes.data.results
        .map(formatOpsPage)
        .filter(item => item.assignees.includes(opsName));

    res.json({ 
      ok: true, 
      targetName: opsName,
      data: {
        passportNeeded,
        upcomingDeadline
      }
    });

  } catch (error) {
    console.error("Ops API Error:", error.response?.data || error.message);
    res.status(500).json({ ok: false, error: "서버 오류 발생", details: error.message });
  }
});

module.exports = (app) => {
  app.use("/api/home/home-ops", router);
};
