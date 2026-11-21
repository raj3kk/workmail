"use client";
import {useState} from "react";
export default function MfaRequiredPage(){
 const [secret,setSecret]=useState(""),[url,setUrl]=useState(""),[code,setCode]=useState(""),[notice,setNotice]=useState("");
 const [recoveryCodes,setRecoveryCodes]=useState<string[]>([]),[recoveryWarning,setRecoveryWarning]=useState(""),[copied,setCopied]=useState(false);
 async function setup(){const r=await fetch("/api/auth/mfa/setup",{method:"POST"});const d=await r.json();if(!r.ok){setNotice(d.error||"Could not start MFA setup");return;}setSecret(d.secret||"");setUrl(d.otpauth_url||"");setNotice("Scan the authenticator link below (or enter the secret manually), then enter the 6-digit code.");}
 async function verify(e:any){e.preventDefault();const r=await fetch("/api/auth/mfa/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});const d=await r.json();if(!r.ok){setNotice(d.error||"Verification failed");return;}
  // Enrolment just completed: the API returns the 10 recovery codes ONCE,
  // in this response only. Show them now and do NOT redirect yet — the user
  // must have a chance to save them first.
  if(d.enrolled&&Array.isArray(d.recovery_codes)&&d.recovery_codes.length>0){
   setRecoveryCodes(d.recovery_codes);
   setRecoveryWarning(d.recovery_codes_warning||"Store these recovery codes somewhere safe NOW. Each code works once. They are shown only here and cannot be retrieved again.");
   setNotice("MFA enrolled. Save your recovery codes below before continuing.");
   return;
  }
  setNotice(d.recovery_code_used?"MFA verified with a recovery code. You can now use WorkMail.":"MFA verified. You can now use WorkMail.");location.href="/";}
 async function copyAll(){
  const text=recoveryCodes.join("\n");
  try{await navigator.clipboard.writeText(text);setCopied(true);}
  catch{
   // Clipboard API unavailable (e.g. non-secure context): fall back to a
   // selectable textarea so the user can still copy the codes manually.
   const ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();try{document.execCommand("copy");setCopied(true);}catch{/* manual selection still works */}document.body.removeChild(ta);
  }
 }
 return <main style={{maxWidth:640,margin:'12vh auto',padding:24,fontFamily:'system-ui'}}><h1>Multi-factor authentication required</h1><p>Your WorkMail organization requires a second authentication factor. Enroll a TOTP authenticator (any authenticator app), then verify the 6-digit code.</p>
 {recoveryCodes.length>0?<section aria-label="Recovery codes" style={{border:'2px solid #b45309',borderRadius:8,padding:16,margin:'16px 0',background:'#fffbeb'}}>
  <h2 style={{marginTop:0}}>Save your recovery codes — now</h2>
  <p style={{margin:'8px 0'}}><b>{recoveryWarning}</b></p>
  <p style={{margin:'8px 0'}}>If you lose access to your authenticator app, one of these codes lets you sign in instead. Each code works <b>once</b>. After you leave this page they are <b>gone forever</b> — WorkMail cannot show them again.</p>
  <ol style={{fontFamily:'ui-monospace,monospace',fontSize:15,lineHeight:1.9,margin:'12px 0',paddingLeft:24}}>{recoveryCodes.map(c=><li key={c}><code style={{wordBreak:'break-all'}}>{c}</code></li>)}</ol>
  <button onClick={copyAll}>{copied?"Copied — all 10 codes are on your clipboard":"Copy all 10 codes"}</button>
  {copied&&<p style={{color:'#166534'}}>Copied. Paste them into a password manager or a safe offline note, then continue.</p>}
  <p style={{marginTop:16}}><button onClick={()=>{location.href="/";}}>I have saved my recovery codes — continue to WorkMail</button></p>
 </section>:<>
 {!url&&<button onClick={setup}>Set up authenticator</button>}{url&&<><p><b>Secret (shown once — store it safely):</b></p><code style={{wordBreak:'break-all'}}>{secret}</code><p><a href={url}>Open authenticator link</a> (or enter the secret manually in your authenticator app).</p><form onSubmit={verify}><input required value={code} onChange={e=>setCode(e.target.value)} placeholder="123456" inputMode="numeric"/><button>Verify code</button></form></>}
 </>}
 {notice&&<p>{notice}</p>}<p>If you are locked out, contact your platform administrator through the verified support channel. Do not share recovery codes or passwords.</p><a href="/">Return to WorkMail</a></main>
}
