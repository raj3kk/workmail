import PostalMime from "postal-mime";
export default {async email(message,env){
 try{const raw=await new Response(message.raw).arrayBuffer(),mail=await new PostalMime().parse(raw);
 const r=await fetch(env.WORKMAIL_API_URL+"/api/inbound",{method:"POST",headers:{"Content-Type":"application/json","X-Inbound-Token":env.INBOUND_WEBHOOK_TOKEN},body:JSON.stringify({from:message.from,to:message.to,subject:mail.subject||"(No Subject)",text:mail.text||"",html:mail.html||"",messageId:mail.messageId||undefined,receivedAt:new Date().toISOString()})});
 if(!r.ok)throw Error("Inbound API "+r.status);
 }catch(e){message.setReject("WorkMail inbound error: "+String(e.message||e))}
}};
