import PostalMime from "postal-mime";

// Inbound Email Worker (G-10/G-11): parse MIME with postal-mime and POST
// the message to the Vercel app's /api/inbound, which resolves the
// recipient mailbox and stores the message.
//
// Attachments (G-10): every attachment part is forwarded as base64 in the
// JSON payload so /api/inbound can store the bytes in KV
// (workmail-attachments namespace) and record a message_attachments row.
// Limits, enforced here so the payload stays inside the Vercel request
// size budget (~4.5 MB) and the 25 MB KV value cap:
//   - one attachment larger than 25 MB is never forwarded (KV cannot
//     store it) — it is listed in attachmentsSkipped instead;
//   - attachments are included only while the running base64 total stays
//     under MAX_FORWARD_BYTES; the rest go to attachmentsSkipped;
//   - at most MAX_ATTACHMENTS parts per message.
// Skipped attachments are NOT silently lost: /api/inbound records the
// skip in the stored message so the recipient can see what was omitted
// and why. No attachment content is ever logged.
//
// Threading (G-11): In-Reply-To / References headers are forwarded so
// /api/inbound can set thread_id + in_reply_to on the stored message.
//
// NOTE: no Node.js APIs (no Buffer) — this runs on the Workers runtime.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // KV 25 MB value cap
const MAX_FORWARD_BYTES = 3 * 1024 * 1024; // base64 budget inside the POST
const MAX_ATTACHMENTS = 20;

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function contentToBytes(content) {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return content;
}

export default {async email(message,env){
 try{const raw=await new Response(message.raw).arrayBuffer(),mail=await new PostalMime().parse(raw);
 const attachments=[],skipped=[];
 let forwardedBytes=0;
 for(const att of mail.attachments||[]){
   const bytes=contentToBytes(att.content||new Uint8Array(0));
   const size=bytes.byteLength;
   const name=att.filename||"attachment";
   if(size<1||size>MAX_ATTACHMENT_BYTES){skipped.push({fileName:name,sizeBytes:size,reason:size>MAX_ATTACHMENT_BYTES?"exceeds-25mb-kv-limit":"empty-attachment"});continue;}
   if(attachments.length>=MAX_ATTACHMENTS){skipped.push({fileName:name,sizeBytes:size,reason:"too-many-attachments"});continue;}
   const b64=bytesToBase64(bytes);
   if(forwardedBytes+b64.length>MAX_FORWARD_BYTES){skipped.push({fileName:name,sizeBytes:size,reason:"exceeds-inbound-transfer-budget"});continue;}
   forwardedBytes+=b64.length;
   attachments.push({fileName:name,contentType:att.mimeType||"application/octet-stream",sizeBytes:size,contentBase64:b64,contentId:att.contentId||undefined,disposition:att.disposition||undefined});
 }
 const r=await fetch(env.WORKMAIL_API_URL+"/api/inbound",{method:"POST",headers:{"Content-Type":"application/json","X-Inbound-Token":env.INBOUND_WEBHOOK_TOKEN},body:JSON.stringify({from:message.from,to:message.to,subject:mail.subject||"(No Subject)",text:mail.text||"",html:mail.html||"",messageId:mail.messageId||undefined,inReplyTo:mail.inReplyTo||undefined,references:mail.references||undefined,attachments,attachmentsSkipped:skipped,receivedAt:new Date().toISOString()})});
 if(!r.ok)throw Error("Inbound API "+r.status);
 }catch(e){message.setReject("WorkMail inbound error: "+String(e.message||e))}
}};
