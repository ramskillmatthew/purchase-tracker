"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { FinanceOverviewResponse } from "@/lib/finance/api-contract";
import styles from "./history.module.css";

type AuditEvent = { id:string; event_type:string; source_type:string; source_id:string|null; summary:string; before_state:unknown; after_state:unknown; metadata:Record<string,unknown>; created_at:string };
type LedgerEntry = { id:string; entry_type:string; amount_pence:number; account_id:string|null; card_id:string|null; effective_on:string; reference:string|null; reason:string|null; created_at:string };
type Named = { id:string; name:string };
type HistoryData = { events:AuditEvent[]; ledger:LedgerEntry[]; accounts:Named[]; cards:Named[] };
const gbp = new Intl.NumberFormat("en-GB", { style:"currency", currency:"GBP" });

export default function HistoryWorkspace() {
  const [data,setData] = useState<HistoryData|null>(null);
  const [forecast,setForecast] = useState<FinanceOverviewResponse|null>(null);
  const [error,setError] = useState("");
  const [search,setSearch] = useState("");
  const [type,setType] = useState("all");
  const [account,setAccount] = useState("all");
  const [source,setSource] = useState("all");
  const [actor,setActor] = useState("all");
  const [range,setRange] = useState("30");
  const [expanded,setExpanded] = useState<string|null>(null);

  useEffect(() => {
    fetch("/api/finance/history",{cache:"no-store"})
      .then(async historyResponse => {
        const historyBody = await historyResponse.json();
        if (!historyResponse.ok) throw new Error(historyBody.error);
        setData(historyBody);
      }).catch(cause => setError(cause instanceof Error ? cause.message : "Could not load finance history."));
  },[]);
  useEffect(()=>{fetch(`/api/finance/overview?preset=${range}`,{cache:"no-store"}).then(async response=>{if(response.ok)setForecast(await response.json())}).catch(()=>undefined)},[range]);

  const rows = useMemo(() => (data?.events ?? []).filter(event => {
    const state=`${JSON.stringify(event.before_state)} ${JSON.stringify(event.after_state)} ${JSON.stringify(event.metadata)}`;
    return (type === "all" || event.event_type === type) && (account === "all" || state.includes(account)) && (source === "all" || event.source_type === source) && (actor === "all" || String(event.metadata?.actor??"System") === actor) && (!search || `${event.summary} ${event.event_type} ${event.source_type} ${state}`.toLowerCase().includes(search.toLowerCase()));
  }),[account,actor,data,search,source,type]);
  const types = [...new Set((data?.events ?? []).map(event => event.event_type))];
  const sources = [...new Set((data?.events ?? []).map(event => event.source_type))];
  const actors = [...new Set((data?.events ?? []).map(event => String(event.metadata?.actor??"System")))];
  function exportCsv() {
    if (!data) return;
    const csv = [["Date","Type","Summary","Source"],...rows.map(event => [event.created_at,event.event_type,event.summary,event.source_type])].map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");
    const anchor=document.createElement("a");anchor.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));anchor.download="finance-history.csv";anchor.click();URL.revokeObjectURL(anchor.href);
  }
  return <section className={styles.page}><div className={styles.workspace}>
    <section className={styles.historyColumn}>
      <header><div><h2>History</h2><p>Permanent audit history of all finance events. Transfers are not income or profit.</p></div><button onClick={exportCsv}>↓ Export</button></header>
      <div className={styles.filters}><input placeholder="Search history…" value={search} onChange={event=>setSearch(event.target.value)}/><select value={type} onChange={event=>setType(event.target.value)}><option value="all">All types</option>{types.map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select><select value={account} onChange={event=>setAccount(event.target.value)}><option value="all">All accounts</option>{data?.accounts.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={source} onChange={event=>setSource(event.target.value)}><option value="all">All sources</option>{sources.map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select><select value={actor} onChange={event=>setActor(event.target.value)}><option value="all">All users</option>{actors.map(value=><option key={value}>{value}</option>)}</select></div>
      {error&&<aside>{error}</aside>}
      <div className={styles.table}><table><thead><tr><th>Date & Time</th><th>Type</th><th>Summary</th><th>Source</th><th>User</th></tr></thead><tbody>{!data&&!error&&<tr><td colSpan={5}>Loading permanent history…</td></tr>}{data&&!rows.length&&<tr><td colSpan={5}>No finance history yet.</td></tr>}{rows.map(event=><HistoryRow key={event.id} event={event} open={expanded===event.id} toggle={()=>setExpanded(expanded===event.id?null:event.id)}/>)}</tbody></table></div>
      <section className={styles.ledger}><h3>Transaction ledger</h3>{data?.ledger.slice(0,30).map(entry=><p key={entry.id}><time>{entry.effective_on}</time><b>{entry.entry_type.replaceAll("_"," ")}</b><span>{entry.reason||entry.reference||"Finance transaction"}</span><em>{data.accounts.find(account=>account.id===entry.account_id)?.name||data.cards.find(card=>card.id===entry.card_id)?.name||"—"}</em><strong className={Number(entry.amount_pence)>=0?styles.up:styles.down}>{gbp.format(Number(entry.amount_pence)/100)}</strong></p>)}</section>
    </section>
    <CalendarTimeline forecast={forecast} range={range} setRange={setRange}/>
  </div></section>;
}

function HistoryRow({event,open,toggle}:{event:AuditEvent;open:boolean;toggle:()=>void}) {return <Fragment><tr onClick={toggle}><td>{new Date(event.created_at).toLocaleString("en-GB")}</td><td><b>{event.event_type.replaceAll("_"," ")}</b></td><td>{event.summary}</td><td>{event.source_type}</td><td>{String(event.metadata?.actor??"System")}</td></tr>{open&&<tr className={styles.detail}><td colSpan={5}><div><section><b>Before</b><pre>{JSON.stringify(event.before_state,null,2)||"No earlier state"}</pre></section><section><b>After</b><pre>{JSON.stringify(event.after_state,null,2)||"No later state"}</pre></section></div></td></tr>}</Fragment>}

function CalendarTimeline({forecast,range,setRange}:{forecast:FinanceOverviewResponse|null;range:string;setRange:(value:string)=>void}) {
  const [selectedDate,setSelectedDate]=useState<string|null>(null);
  const events=forecast?.events??[];
  const start=forecast?new Date(`${forecast.range.start}T12:00:00`):new Date();
  const calendarStart=new Date(start);calendarStart.setDate(start.getDate()-((start.getDay()+6)%7));
  const days=Array.from({length:35},(_,index)=>{const date=new Date(calendarStart);date.setDate(calendarStart.getDate()+index);return date});
  const eventsByDate=new Map<string,FinanceOverviewResponse["events"]>();for(const event of events)eventsByDate.set(event.date,[...(eventsByDate.get(event.date)??[]),event]);
  const selectedEvents=selectedDate?eventsByDate.get(selectedDate)??[]:[];
  return <aside className={styles.calendarPanel}><header><div><h2>Calendar & Timeline</h2><p>Next {range} days</p></div><select aria-label="Calendar range" value={range} onChange={event=>setRange(event.target.value)}><option value="7">Next 7 days</option><option value="30">Next 30 days</option><option value="90">Next 90 days</option></select></header>
    <section className={styles.calendar}><h3>{start.toLocaleDateString("en-GB",{month:"long",year:"numeric"})}</h3><div className={styles.weekdays}>{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day=><b key={day}>{day}</b>)}</div><div className={styles.days}>{days.map(date=>{const key=date.toISOString().slice(0,10),daily=eventsByDate.get(key)??[];return <button type="button" key={key} onClick={()=>daily.length&&setSelectedDate(key)} disabled={!daily.length} className={`${date.getMonth()!==start.getMonth()?styles.outside:""} ${selectedDate===key?styles.selectedDay:""}`}><span>{date.getDate()}</span><div>{daily.slice(0,3).map(event=><i key={event.id} className={styles[event.kind]} title={`${event.title}: ${gbp.format(event.amountPence/100)}`}/>)}</div></button>})}</div>{selectedDate&&<div className={styles.dayDetails}><header><b>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</b><button type="button" onClick={()=>setSelectedDate(null)}>×</button></header>{selectedEvents.map(event=><article key={event.id}><i className={styles[event.kind]}/><span><b>{event.title}</b><small>{event.detail}</small></span><strong>{event.amountPence>=0?"+":"−"}{gbp.format(Math.abs(event.amountPence)/100)}</strong></article>)}</div>}<footer><span><i className={styles.incoming}/>Incoming</span><span><i className={styles.outgoing}/>Outgoing</span><span><i className={styles.card_due}/>Card due</span><span><i className={styles.allocation_deadline}/>Allocation</span></footer></section>
    <section className={styles.timeline}><h3>Timeline (chronological)</h3>{!forecast&&<p>Loading upcoming events…</p>}{forecast&&!events.length&&<p>No dated finance events in this range.</p>}{events.map(event=><article key={event.id} className={styles[event.kind]}><div><b>{event.title}</b><small>{event.detail}</small></div><span className={event.overdue?styles.overdue:""}><strong>{event.amountPence>=0?"+":"−"}{gbp.format(Math.abs(event.amountPence)/100)}</strong><time>{new Date(`${event.date}T12:00:00`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</time></span></article>)}</section>
  </aside>;
}
