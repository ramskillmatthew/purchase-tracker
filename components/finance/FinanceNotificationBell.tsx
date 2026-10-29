"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./finance-notifications.module.css";

type Notice={id:string;title:string;body:string;dueDate:string|null;kind:string;importance:"important"|"standard"};

export default function FinanceNotificationBell(){
  const [notices,setNotices]=useState<Notice[]>([]);
  const [open,setOpen]=useState(false);
  const [message,setMessage]=useState("");
  const [windowMode,setWindowMode]=useState<"3"|"7"|"custom">("3");
  const [customEnd,setCustomEnd]=useState("");

  const load=useCallback(async()=>{
    const query=windowMode==="custom"&&customEnd?`end=${customEnd}`:`days=${windowMode==="custom"?3:windowMode}`;
    const response=await fetch(`/api/finance/notifications?${query}`,{cache:"no-store"});
    if(response.ok)setNotices((await response.json()).notifications);
  },[customEnd,windowMode]);
  useEffect(()=>{load().catch(()=>undefined)},[load]);

  async function task(notice:Notice){
    if(notice.importance!=="important")return;
    setMessage("");
    const response=await fetch("/api/finance/notifications",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:notice.title,notes:notice.body,dueDate:notice.dueDate})});
    setMessage(response.ok?"Finance task created.":"Could not create task.");
    if(response.ok)window.dispatchEvent(new Event("tasks-changed"));
  }

  return <div className={styles.wrap}>
    <button className={styles.bell} aria-label={`Finance notifications (${notices.length})`} aria-expanded={open} onClick={()=>setOpen(value=>!value)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>{notices.length>0&&<b>{notices.length>9?"9+":notices.length}</b>}</button>
    {open&&<section className={styles.feed}>
      <header><div><h3>Finance alerts</h3><p>Upcoming money, warnings and deadlines</p></div><button onClick={()=>setOpen(false)}>×</button></header>
      <nav className={styles.range}><button className={windowMode==="3"?styles.active:""} onClick={()=>setWindowMode("3")}>3 days</button><button className={windowMode==="7"?styles.active:""} onClick={()=>setWindowMode("7")}>7 days</button><button className={windowMode==="custom"?styles.active:""} onClick={()=>setWindowMode("custom")}>Custom</button>{windowMode==="custom"&&<input aria-label="Show alerts through" type="date" value={customEnd} onChange={event=>setCustomEnd(event.target.value)}/>}</nav>
      {!notices.length&&<div className={styles.empty}>No Finance alerts in this period.</div>}
      {notices.map(notice=><article key={notice.id}><i className={styles[notice.kind]}>!</i><div><b>{notice.title}</b><p>{notice.body}</p>{notice.dueDate&&<time>Due {notice.dueDate}</time>}</div>{notice.importance==="important"&&<button onClick={()=>task(notice)}>Create task</button>}</article>)}
      {message&&<footer>{message}</footer>}
    </section>}
  </div>;
}
