/* ==========================================================================
   one-click-quo/one_click_quo_ofc.js
   해상 운임(OFC) 비용 조회 및 랜더링 로직 (추가 비용 합산 및 환율 적용 기능 포함)
   ========================================================================== */

/**
 * 1. [핵심 모듈] OFC 비용 및 추가 비용 API 호출 함수 
 */
async function fetchOceanFreightData(poe) {
    if (!poe) return null;

    try {
        const response = await fetch(`https://notion-api-hub.vercel.app/api/ofc/ofc-costs?poe=${encodeURIComponent(poe)}`);
        const result = await response.json();

        if (!result.ok || (!result.ofcData?.length && !result.extraCosts?.length)) {
            return null;
        }

        return {
            ofcData: result.ofcData && result.ofcData.length > 0 ? result.ofcData[0] : null,
            extraCosts: result.extraCosts || []
        };
    } catch (error) {
        console.error("OFC 데이터 조회 중 에러 발생:", error);
        return null;
    }
}

/**
 * 2. [UI 로직] 원클릭 견적서 화면에 OFC 비용 적용 및 환율 변환
 */
async function applyOfcCostToQuote() {
    const rawData = sessionStorage.getItem('oneClickQuoteData');
    if (!rawData) return;
    
    const data = JSON.parse(rawData);
    let poe = data.poe || data.location; 
    if (poe && poe.includes('/')) {
        poe = poe.split('/')[1].trim(); 
    }
    const containerType = (data.type || data.cargo || '').toUpperCase(); 

    // ✨ 1. CBM 숫자 추출 (CONSOLE 비례 계산용)
    const cbmString = document.getElementById('sumCbmType') ? document.getElementById('sumCbmType').textContent : '1';
    const cbmMatch = cbmString.match(/(\d+(\.\d+)?)\s*CBM/i);
    const cbm = cbmMatch ? parseFloat(cbmMatch[1]) : 1; 

    const ofcDisplayEl = document.getElementById('q_ocean_ofc');
    const surchargeDisplayEl = document.getElementById('q_ocean_surcharge');
    const oceanTotalEl = document.getElementById('q_ocean_total');
    const ofcCardEl = ofcDisplayEl.parentElement; 
    
    ofcDisplayEl.textContent = "조회 중...";
    if(surchargeDisplayEl) surchargeDisplayEl.textContent = "조회 중...";

    // 1) 부대비용 산출 로직 (20피트: 25만 / 40HC: 30만 / CONSOLE: 40HC기준 비례계산)
    let surchargeKrw = 0;
    if (containerType.includes('20')) {
        surchargeKrw = 250000;
    } else if (containerType.includes('40')) {
        surchargeKrw = 300000;
    } else if (containerType.includes('CONSOLE')) {
        // 👈 요청하신 CONSOLE 부대비용 비례 계산: 30만을 50으로 나눈 뒤 CBM을 곱함
        surchargeKrw = Math.round((300000 / 50) * cbm);
    }

    // 2) OFC 노션 DB와 환율 API 동시 호출!
    const [result, exRes] = await Promise.all([
        fetchOceanFreightData(poe),
        fetch('https://api.exchangerate-api.com/v4/latest/KRW').catch(() => null)
    ]);

    // 환율 파싱 (KRW -> USD) - 실패 시 기본 환율 방어코드
    let krwToUsdRate = 0.00075; 
    if (exRes && exRes.ok) {
        try {
            const exData = await exRes.json();
            if (exData?.rates?.USD) krwToUsdRate = exData.rates.USD;
        } catch(e) {
            console.warn("환율 API 파싱 실패", e);
        }
    }

    let baseCost = 0;       
    let extraTotal = 0;     
    let finalCost = null;   
    let ofcPageId = null;   
    let validityDate = "";  

    if (result) {
        let { ofcData, extraCosts } = result;

        // 메인 운임 및 적용일 추출
        if (ofcData) {
            ofcPageId = ofcData.id;
            if (containerType.includes('20')) {
                baseCost = ofcData.cost20DR || 0;
            } else if (containerType.includes('40')) {
                baseCost = ofcData.cost40HC || 0;
            } else if (containerType.includes('CONSOLE')) { // 👈 여기도 .includes로 수정!
                // ✨ 2. CONSOLE 기본 해상운임 계산: 40HC 운임을 50으로 나눈 뒤 CBM 곱함
                const hcCost = ofcData.cost40HC || 0;
                baseCost = Math.round((hcCost / 50) * cbm); 
            }

            if (ofcData.validity) {
                const rawDate = ofcData.validity.end || ofcData.validity.start;
                if (rawDate) {
                    validityDate = rawDate.replace(/-/g, '/');
                }
            }
        }
        
        // 추가 비용 추출 (컨테이너 타입에 맞게 매핑)
        if (extraCosts && extraCosts.length > 0) {
            extraTotal = extraCosts.reduce((sum, item) => {
                let currentAmt = 0;
                if (containerType.includes('20')) {
                    currentAmt = item.cost20 || 0;
                } else if (containerType.includes('40')) {
                    currentAmt = item.cost40 || 0;
                } else if (containerType.includes('CONSOLE')) { // 👈 여기도 .includes로 수정!
                    // ✨ 3. CONSOLE 추가 운임은 백엔드 값 그대로 가져오기
                    currentAmt = item.costCONSOLE || 0;
                }
                
                item.amount = currentAmt;
                return sum + currentAmt;
            }, 0);
            
            result.extraCosts = extraCosts.filter(item => item.amount > 0);
        }

        if (ofcData || extraCosts.length > 0) {
            finalCost = baseCost + extraTotal;
        }
    }

    // 3) 금액 최종 변환 (합산)
    let ofcUsd = finalCost || 0;
    let surchargeUsd = surchargeKrw * krwToUsdRate; 
    let totalOceanUsd = ofcUsd + surchargeUsd;      

    // UI 업데이트
    if (finalCost !== null && finalCost !== undefined) {
        let validityHtml = "";
        if (validityDate) {
            validityHtml = `<span style="font-size: 0.85rem; color: var(--medium-gray); font-weight: 600; margin-right: 12px; letter-spacing: 0;">적용일 : ~${validityDate} 까지</span>`;
        }

        ofcDisplayEl.innerHTML = `${validityHtml}$${ofcUsd.toLocaleString('en-US')}`;
        ofcDisplayEl.dataset.cost = finalCost; 

        ofcCardEl.style.cursor = 'pointer';
        ofcCardEl.title = "클릭하여 운임 상세 내역 확인";
        ofcCardEl.onmouseenter = () => ofcCardEl.style.opacity = '0.8';
        ofcCardEl.onmouseleave = () => ofcCardEl.style.opacity = '1';

        ofcCardEl.onclick = () => openOfcDetailModal(ofcPageId, result.extraCosts, baseCost, finalCost, validityDate);
    } else {
        ofcDisplayEl.textContent = "별도 문의";
        ofcDisplayEl.dataset.cost = 0;
        ofcCardEl.style.cursor = 'default';
        ofcCardEl.onclick = null; 
    }

    if (surchargeDisplayEl) {
        surchargeDisplayEl.innerHTML = `${surchargeKrw.toLocaleString('ko-KR')}원 <span style="font-size: 0.65em; color: var(--medium-gray); font-weight:600;">($${surchargeUsd.toLocaleString('en-US', {maximumFractionDigits:2})})</span>`;
    }

    if (oceanTotalEl) {
        oceanTotalEl.textContent = `$${totalOceanUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
}

/**
 * 3. [모달 로직] OFC 상세 운임 팝업창 생성
 */
function openOfcDetailModal(pageId, extraCosts = [], baseCost = 0, finalCost = 0, validityDate = "") {
    const existingModal = document.getElementById('ofc-detail-modal');
    if (existingModal) existingModal.remove();

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'ofc-detail-modal';
    modalOverlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center;
        z-index: 9999; backdrop-filter: blur(2px);
    `;

    const notionLink = pageId ? `https://www.notion.so/${pageId.replace(/-/g, '')}` : '#';

    let extraCostRows = extraCosts.map(c => `
        <tr>
            <td style="padding: 10px; border-bottom: 1px solid #eee; color: #555;">${c.name}</td>
            <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right; font-weight: 600;">$${(c.amount || 0).toLocaleString('en-US')}</td>
        </tr>
    `).join('');

    if(extraCosts.length === 0) {
        extraCostRows = `<tr><td colspan="2" style="padding: 15px; text-align:center; color:#999;">해당 타입에 적용된 추가 운임이 없습니다.</td></tr>`;
    }

    let validityTextHtml = validityDate ? `<div style="text-align: center; color: var(--medium-gray); font-size: 0.9rem; font-weight: 600; margin-bottom: 15px;">유효 기간 : ~${validityDate} 까지</div>` : '';

    const modalContent = `
        <div style="background: #fff; padding: 25px; border-radius: 12px; width: 420px; max-width: 90%; box-shadow: 0 10px 25px rgba(0,0,0,0.2); position: relative; animation: fadeIn 0.2s ease-in-out;">
            <button id="closeOfcModalBtn" style="position: absolute; top: 15px; right: 15px; background: none; border: none; font-size: 24px; color: #999; cursor: pointer; line-height: 1;">&times;</button>
            
            <h3 style="margin: 0 0 15px 0; font-size: 18px; color: var(--deep-teal, #0d3b45); border-bottom: 2px solid var(--primary-color, #1A73E8); padding-bottom: 10px;">운임 상세 및 추가 비용</h3>
            
            ${validityTextHtml}

            <div style="margin-bottom: 25px; text-align: center;">
                <a href="${notionLink}" target="_blank" style="display: inline-block; background: var(--primary-color, #1A73E8); color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold; font-size: 15px; width: 90%; box-shadow: 0 3px 6px rgba(26,115,232,0.3); transition: background 0.2s;">
                    🔗 포워딩/선사별 운임 상세 확인
                </a>
                ${!pageId ? '<p style="font-size: 12px; color: red; margin-top: 8px;">상세 페이지 정보를 불러올 수 없습니다.</p>' : ''}
            </div>

            <h4 style="margin: 0 0 10px 0; font-size: 15px; color: #333;">[운임 구성 내역]</h4>
            <div style="border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                    <thead style="background: #f8f9fa;">
                        <tr>
                            <th style="padding: 10px; text-align: left; border-bottom: 1px solid #ddd; color: #555;">항목명</th>
                            <th style="padding: 10px; text-align: right; border-bottom: 1px solid #ddd; color: #555;">금액 (USD)</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; color: #333;">OFC (기본 해상운임)</td>
                            <td style="padding: 10px; border-bottom: 1px solid #ddd; text-align: right; font-weight: 600;">$${baseCost.toLocaleString('en-US')}</td>
                        </tr>
                        ${extraCostRows}
                    </tbody>
                    <tfoot style="background: var(--mint-white, #f0fdfa);">
                        <tr>
                            <td style="padding: 12px 10px; border-top: 2px solid #ddd; font-weight: bold; color: var(--deep-teal, #0d3b45);">총 합산 운임 (OFC)</td>
                            <td style="padding: 12px 10px; border-top: 2px solid #ddd; text-align: right; font-weight: bold; color: var(--deep-teal, #0d3b45); font-size: 16px;">$${finalCost.toLocaleString('en-US')}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    `;

    modalOverlay.innerHTML = modalContent;
    document.body.appendChild(modalOverlay);

    document.getElementById('closeOfcModalBtn').onclick = () => modalOverlay.remove();
    modalOverlay.onclick = (e) => { if(e.target === modalOverlay) modalOverlay.remove(); }
}

document.addEventListener('DOMContentLoaded', applyOfcCostToQuote);
