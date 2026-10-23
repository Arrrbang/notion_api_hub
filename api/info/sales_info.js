/** 기존 sales-info 조회/Profit 수정 API 유지. DB 접근은 공통 user_service만 사용. */
const users=require('./user_service');
module.exports=app=>{
 app.get('/api/sales-info',async(req,res)=>{try{
  res.set('Cache-Control','no-store');let data;
  if(req.query.pass_id!==undefined){try{data=await users.getUser(req.query.pass_id);}catch(e){if(e.status!==404)throw e;return res.json({ok:true,count:0,data:null});}return res.json({ok:true,count:1,data});}
  data=await users.listUsers();return res.json({ok:true,count:data.length,data});
 }catch(e){users.handleError(res,e,'sales-info');}});
 app.post('/api/sales-info/profit',async(req,res)=>{try{await users.updateProfit(req.body?.pass_id,req.body?.profit);res.json({ok:true,message:'수익률이 노션 DB에 저장되었습니다.'});}catch(e){users.handleError(res,e,'sales-info/profit');}});
};
