/* api/quotation/saveload.js */
const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const QUOTATION_DB_ID = '3aa0b10191ce80558a36d58c58c1df53';

function notionHeaders() {
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    };
}

// 청크 분할 및 최대 100개 제한 안전장치 추가
function chunkString(str, length) {
    const chunks = [];
    for (let i = 0; i < str.length; i += length) {
        chunks.push(str.substring(i, i + length));
    }
    // 노션 rich_text 배열 최대 한도(100개) 안전 제어
    return chunks.slice(0, 100);
}

// 노션 전용 YYYY-MM-DD 날짜 추출 함수
function formatIsoDate(dateStr) {
    if (!dateStr) return null;
    // 숫자 4자리-2자리-2자리 추출 시도
    const match = dateStr.match(/(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})/);
    if (match) {
        const yyyy = match[1];
        const mm = match[2].padStart(2, '0');
        const dd = match[3].padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    return null;
}

module.exports = function(app) {

    // [1] 견적서 저장 및 덮어쓰기(PATCH) 결합 API
    app.post('/api/quotation/save', async (req, res) => {
        try {
            const { quoteNo, customer, date, totalAmount, sales, rawData, pageId } = req.body;

            // 💡 1. 날짜 안정성 강화
            let cleanDate = formatIsoDate(date);
            if (!cleanDate) {
                const today = new Date();
                const kstOffset = 9 * 60 * 60 * 1000;
                cleanDate = new Date(today.getTime() + kstOffset).toISOString().split('T')[0];
            }

            // 💡 2. 견적 번호 생성
            let finalQuoteNo = quoteNo;
            if (!finalQuoteNo || finalQuoteNo.trim() === '') {
                const salesPrefix = sales ? sales.split(' ')[0].toUpperCase() : 'UNKNOWN';
                const dateStr = cleanDate.replace(/-/g, ''); 

                const queryResp = await axios.post(`https://api.notion.com/v1/databases/${QUOTATION_DB_ID}/query`, {
                    filter: {
                        and: [
                            { property: "Sales", select: { equals: sales || 'Unassigned' } },
                            { property: "Date", date: { equals: cleanDate } }
                        ]
                    }
                }, { headers: notionHeaders() });

                const count = queryResp.data.results.length;
                const sequence = String(count + 1).padStart(2, '0');
                finalQuoteNo = `${salesPrefix}-${dateStr}-${sequence}`;
            }

            // 💡 3. 데이터 청크 변환 (안전 처리)
            const jsonString = JSON.stringify(rawData || {});
            const chunkedData = chunkString(jsonString, 2000).map(chunk => ({
                text: { content: chunk }
            }));

            const properties = {
                "Quote No": { title: [{ text: { content: finalQuoteNo } }] },
                "Customer": { rich_text: [{ text: { content: customer || 'Unknown' } }] },
                "Date": { date: { start: cleanDate } },
                "Total Amount": { number: Number(totalAmount) || 0 },
                "Sales": { select: { name: sales || 'Unassigned' } },
                "Raw Data": { rich_text: chunkedData }
            };

            // 💡 4. pageId 유무에 따라 PATCH 또는 POST 실행
            if (pageId) {
                const updateResp = await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
                    properties: properties
                }, { headers: notionHeaders() });

                return res.json({ ok: true, quoteNo: finalQuoteNo, pageId: updateResp.data.id });
            } else {
                const createResp = await axios.post('https://api.notion.com/v1/pages', {
                    parent: { database_id: QUOTATION_DB_ID },
                    properties: properties
                }, { headers: notionHeaders() });

                return res.json({ ok: true, quoteNo: finalQuoteNo, pageId: createResp.data.id });
            }

        } catch (error) {
            // 💡 [핵심 해결] 노션 API에서 던진 진짜 에러 메시지를 프론트엔드로 반환하여 원인 파악 가능하게 변경
            const notionErrorDetails = error.response?.data || error.message;
            console.error('❌ 노션 API 저장 에러 상세:', JSON.stringify(notionErrorDetails, null, 2));

            return res.status(500).json({ 
                ok: false, 
                error: '노션 저장 실패',
                details: notionErrorDetails 
            });
        }
    });

    // [2] 특정 영업사원의 견적서 목록 불러오기 API
    app.post('/api/quotation/list', async (req, res) => {
        try {
            const { sales } = req.body;
            const queryResp = await axios.post(`https://api.notion.com/v1/databases/${QUOTATION_DB_ID}/query`, {
                filter: sales ? { property: "Sales", select: { equals: sales } } : undefined,
                sorts: [{ property: "Date", direction: "descending" }]
            }, { headers: notionHeaders() });

            const results = queryResp.data.results.map(page => {
                const props = page.properties;
                const rawDataArray = props["Raw Data"]?.rich_text || [];
                const fullRawDataStr = rawDataArray.map(t => t.plain_text).join('');
                
                let parsedData = {};
                try { parsedData = JSON.parse(fullRawDataStr); } catch(e) {}

                return {
                    id: page.id,
                    quoteNo: props["Quote No"]?.title[0]?.plain_text || '',
                    customer: props["Customer"]?.rich_text[0]?.plain_text || '',
                    date: props["Date"]?.date?.start || '',
                    totalAmount: props["Total Amount"]?.number || 0,
                    sales: props["Sales"]?.select?.name || '',
                    rawData: parsedData
                };
            });

            res.json({ ok: true, list: results });
        } catch (error) {
            console.error('견적 목록 조회 에러:', error.response?.data || error.message);
            res.status(500).json({ ok: false, error: '목록을 불러오지 못했습니다.', details: error.response?.data });
        }
    });

    // [3] 견적서 영구 삭제(아카이브) API
    app.delete('/api/quotation/delete/:id', async (req, res) => {
        try {
            const pageId = req.params.id;
            await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
                archived: true
            }, { headers: notionHeaders() });
            res.json({ ok: true, message: '삭제 완료' });
        } catch (error) {
            console.error('견적 삭제 에러:', error.response?.data || error.message);
            res.status(500).json({ ok: false, error: '견적서를 삭제하지 못했습니다.', details: error.response?.data });
        }
    });
};
