/** 기존 oper-info 주소/exports를 유지하는 호환 연결. 실제 직원 조회는 user_service로 통합. */
const users=require('./user_service');
module.exports=app=>app.get('/api/oper-info',async(req,res)=>{try{res.set('Cache-Control','no-store');res.json({ok:true,data:await users.getUser(req.query.pass_id)});}catch(e){users.handleError(res,e,'oper-info');}});
module.exports.lookupOperInfo=users.getUser;
module.exports.requireNotionUser=users.requireNotionUser;
