"use client";

import { useEffect, useMemo, useState } from "react";
import type { FinanceOverviewResponse } from "@/lib/finance/api-contract";
import MoneyInWorkspace from "./MoneyInWorkspace";
import MoneyOutWorkspace from "./MoneyOutWorkspace";
import AllocationsWorkspace from "./AllocationsWorkspace";
import AccountsWorkspace from "./AccountsWorkspace";
import CardsWorkspace from "./CardsWorkspace";
import HistoryWorkspace from "./HistoryWorkspace";
import FinanceNotificationBell from "./FinanceNotificationBell";
import { CardBrand, MarketplaceBrand, cardBrandKey } from "./FinanceBrand";
import type { FinanceRangePreset } from "@/lib/finance/range";
import { summariseAllMarketplacePending } from "@/lib/finance/pending-sales";
import styles from "./finance-hub.module.css";
import "./finance-fixes.css";

const tabs = ["Overview", "Money In", "Money Out", "Allocations", "Credit Cards", "Accounts", "History"] as const;
type Tab = typeof tabs[number];

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const exactMoney = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const accountColour=(name:string)=>{const key=name.toLowerCase();if(key.includes("starling"))return"#42eadf";if(key.includes("monzo"))return"#ff5b61";if(key.includes("revolut"))return"#f4f6f8";return"#ddecff"};

const metrics = [
  { label: "Tracked cash", value: 1842000, note: "Available after reservations", tone: "blue", icon: "▣" },
  { label: "Pending incoming", value: 350000, note: "Across 95 sales", tone: "green", icon: "↓" },
  { label: "Reserved", value: 480000, note: "Allocations & commitments", tone: "purple", icon: "♙" },
  { label: "Due out", value: 624000, note: "Upcoming outgoings", tone: "orange", icon: "↑" },
  { label: "Card debt", value: 761500, note: "Across 3 cards", tone: "red", icon: "▰" },
  { label: "Projected position", value: 773250, note: "At 31 May 2026", tone: "cyan", icon: "⌁" },
] as const;

type RangeChoice={preset:FinanceRangePreset;start:string;end:string};

function Overview({ navigate,range }: { navigate: (tab: Tab) => void;range:RangeChoice }) {
  const [live,setLive]=useState<FinanceOverviewResponse|null>(null);
  const rangeQuery=range.preset==="custom"?`preset=custom&start=${range.start}&end=${range.end}`:`preset=${range.preset}`;
  useEffect(()=>{if(range.preset==="custom"&&(!range.start||!range.end||range.start>range.end))return;fetch(`/api/finance/overview?${rangeQuery}`,{cache:"no-store"}).then(async response=>{if(response.ok)setLive(await response.json())}).catch(()=>undefined)},[range.end,range.preset,range.start,rangeQuery]);
  useEffect(()=>{if(!live)return;document.querySelectorAll(`.${styles.accounts}>p`).forEach((node,index)=>{const row=live.accounts[index];if(row)(node as HTMLElement).style.color=accountColour(row.name)})},[live]);
  const displayMetrics=live?[
    {...metrics[0],value:live.position.trackedCashPence,note:"Available after reservations"},
    {...metrics[1],value:live.position.pendingIncomingPence,note:`Across ${live.pendingSales.filter(row=>row.includedInPendingTotal).length+live.manualIncoming.length} payments`},
    {...metrics[2],value:live.position.reservedPence},
    {...metrics[3],value:live.position.dueOutInRangePence},
    {...metrics[4],value:live.position.cardDebtPence,note:`Across ${live.cards.length} cards`},
    {...metrics[5],value:live.position.projectedPositionPence,note:`At ${live.range.end}`},
  ]:metrics;
  const completeMarketplacePending=live?summariseAllMarketplacePending(live.pendingSales,live.manualIncoming.map(row=>({marketplace:row.marketplace,remainingPence:row.remainingPence}))):null;
  const marketplaceCards=(["vinted","ebay","other"] as const).map(key=>completeMarketplacePending?{key,label:key==="ebay"?"eBay":key[0].toUpperCase()+key.slice(1),amount:completeMarketplacePending[key].pendingRevenuePence,count:completeMarketplacePending[key].saleCount}:{key,label:key==="vinted"?"Vinted":key==="ebay"?"eBay":"Other",amount:key==="vinted"?124500:key==="ebay"?48750:10000,count:key==="vinted"?83:key==="ebay"?12:6});
  const overviewCards=live?live.cards.map(card=>[card.name,money.format((card.statementBalancePence||card.currentBalancePence)/100),money.format(card.creditLimitPence/100),money.format(card.availableCreditPence/100),card.paymentDueDate?`Due ${card.paymentDueDate}`:"No due date",cardBrandKey(card.provider),card.creditLimitPence>0?Math.min(100,Math.max(0,card.currentBalancePence/card.creditLimitPence*100)):0]):[["Amex","£1,950.00","£10,000","£8,050","Due 9 May","amex",19.5],["Barclays","£4,285.00","£15,000","£10,715","Due 22 May","barclays",28.57],["Capital on Tap","£1,380.00","£7,500","£6,120","Due 6 May","capital",18.4]];
  const overviewAccounts=live?live.accounts.map(account=>[account.name,money.format(account.balancePence/100)]):[["Business Current","£12,620.00"],["Business Reserve","£4,800.00"],["PayPal Balance","£1,000.00"]];
  const eventRows=live?live.events.slice(0,5).map(event=>{
    const date=new Date(`${event.date}T12:00:00`);
    return [date.toLocaleDateString("en-GB",{weekday:"short"}).toUpperCase(),String(date.getDate()),date.toLocaleDateString("en-GB",{month:"short"}).toUpperCase(),event.title,event.detail,`${event.amountPence>=0?"+":"−"}${money.format(Math.abs(event.amountPence)/100)}`,event.overdue?"Overdue":event.rangeEnd?`By ${event.rangeEnd}`:event.kind==="incoming"?"Est. payment":"Due",event.amountPence>=0?"positive":"negative"];
  }):[
    ["FRI","2","MAY","Vinted payout","83 sales","+£1,245.00","Est. payment","positive"],
    ["MON","5","MAY","eBay payout","12 sales","+£487.50","Est. payment","positive"],
    ["TUE","6","MAY","Capital on Tap payment","Card payment","−£1,308.00","Due","negative"],
    ["FRI","9","MAY","Amex payment","Card payment","−£1,950.00","Due","negative"],
    ["WED","14","MAY","Pokémon Centre preorder","Order #PC-88451","−£4,000.00","Due","negative"],
  ];
  const commitments=live?live.events.filter(event=>event.kind==="outgoing").slice(0,4).map(event=>[event.title,event.detail,money.format(Math.abs(event.amountPence)/100),event.overdue?`Was due ${event.date}`:`Due ${event.date}`,event.overdue?"overdue":""]):[["Pokémon Centre preorder","Order #PC-88451","£4,000.00","Was due 28 Apr","overdue"],["Nike Q2 Stock Drop","PO #NK-6732","£1,250.00","Due 7 May",""],["StockX payout","Order #SX-22011","£750.00","Due 12 May",""],["Boxing equipment","PO #BE-4412","£240.00","Due 18 May",""]];
  const allocationRows=live?live.allocations.slice(0,3).map(row=>{const progress=row.targetPence?Math.min(100,Math.round(row.balancePence/row.targetPence*100)):0;return[row.name,`${money.format(row.balancePence/100)} / ${row.targetPence?money.format(row.targetPence/100):"No target"}`,`${progress}%`]}):[["Tax","£2,250 / £5,000","45%"],["Stock","£1,800 / £5,000","36%"],["Emergency Buffer","£750 / £2,000","38%"]];
  return <div className={styles.overview}>
    <section className={styles.metrics} aria-label="Financial position">
      {displayMetrics.map(metric => <article key={metric.label} className={`${styles.metric} ${styles[metric.tone]}`}>
        <span className={styles.metricIcon}>{metric.icon}</span>
        <div><small>{metric.label}</small><strong>{money.format(metric.value / 100)}</strong><p>{metric.note}</p></div>
      </article>)}
    </section>

    <section className={styles.marketplaces}>
      <header><b>Marketplace pending</b><span>(not in tracked cash)</span><i>ⓘ</i></header>
      <div className={styles.marketplaceRow}>
        {marketplaceCards.map(card=><article key={card.key} className={card.key==="vinted"?styles.vinted:card.key==="ebay"?styles.ebay:""}><strong>{card.key==="other"?"Other":<MarketplaceBrand marketplace={card.key}/>}</strong><b>{exactMoney.format(card.amount/100)}<small>{card.count} sales</small></b><span>Est. payout<small>Set in Money In</small></span></article>)}
        <button type="button" onClick={() => navigate("Money In")}>View all pending <span>›</span></button>
      </div>
    </section>

    <div className={styles.mainGrid}>
      <QuickResolve reminders={live?.overdueReminders??[]} navigate={navigate}/>

      <section className={`${styles.panel} ${styles.events}`}>
        <header><b>Upcoming events</b><button type="button" onClick={() => navigate("History")}>View calendar</button></header>
        {eventRows.map(row => <article key={`${row[3]}-${row[1]}`}><time><small>{row[0]}</small><b>{row[1]}</b><small>{row[2]}</small></time><div><b>{row[3]}</b><small>{row[4]}</small></div><strong className={row[7] === "positive" ? styles.positive : styles.negative}>{row[5]}</strong><span>{row[6]}</span></article>)}
        <footer><button type="button" onClick={() => navigate("History")}>View full calendar ›</button></footer>
      </section>

      <div className={styles.rightStack}>
        <section className={`${styles.panel} ${styles.commitments}`}><header><b>Upcoming commitments</b><button type="button" onClick={() => navigate("Money Out")}>View all</button></header>{commitments.map(row => <article key={row[0]}><i>◇</i><div><b>{row[0]}</b><small>{row[1]}</small></div><span><strong className={row[4] ? styles.negative : ""}>{row[2]}</strong><small>{row[3]}</small></span></article>)}{live&&!commitments.length&&<p className={styles.emptyPanel}>No commitments in this range.</p>}<footer><button type="button" onClick={() => navigate("Money Out")}>View all commitments ›</button></footer></section>
        <section className={`${styles.panel} ${styles.allocations}`}><header><b>Allocation pots</b><button type="button" onClick={() => navigate("Allocations")}>Manage</button></header>{allocationRows.map((row,index) => <article key={row[0]}><i>{index === 0 ? "♜" : index === 1 ? "▣" : "◐"}</i><div><span><b>{row[0]}</b><small>{row[1]}</small><em>{row[2]}</em></span><progress value={Number(row[2].slice(0,-1))} max="100" /></div></article>)}{live&&!allocationRows.length&&<p className={styles.emptyPanel}>No allocation pots yet.</p>}</section>
      </div>
    </div>

    <div className={styles.bottomGrid}>
      <section className={`${styles.panel} ${styles.cards}`}><header><b>Credit cards</b></header><div>{overviewCards.map(card => <article key={card[0]} className={styles[card[5]]}><CardBrand provider={String(card[0])}/><small>{card[0]} · Statement balance</small><strong>{card[1]}</strong><em>{card[4]}</em><div><span>Credit limit<b>{card[2]}</b></span><span>Available<b>{card[3]}</b></span></div><footer><progress value={Number(card[6])} max="100"/><button type="button" onClick={()=>navigate("Credit Cards")}>Update balance</button></footer></article>)}</div></section>
      <section className={`${styles.panel} ${styles.accounts}`}><header><b>Accounts</b><button type="button" onClick={() => navigate("Accounts")}>View all</button></header>{overviewAccounts.map(row => <p key={row[0]}><span>{row[0]}</span><b>{row[1]}</b></p>)}<footer><b>Total</b><strong>{live?money.format(live.position.trackedCashPence/100):"£18,420.00"}</strong></footer></section>
    </div>
  </div>;
}

type OverdueReminder=FinanceOverviewResponse["overdueReminders"][number];

function QuickResolve({reminders,navigate}:{reminders:OverdueReminder[];navigate:(tab:Tab)=>void}){
  const [index,setIndex]=useState(0);
  const [snoozed,setSnoozed]=useState<Record<string,string>>({});
  const [delayOpen,setDelayOpen]=useState(false);
  const [delayUntil,setDelayUntil]=useState("");
  useEffect(()=>{try{setSnoozed(JSON.parse(localStorage.getItem("finance-overdue-snoozes")??"{}"))}catch{setSnoozed({})}},[]);
  const visible=useMemo(()=>{const today=new Date().toISOString().slice(0,10);return reminders.filter(reminder=>!snoozed[reminder.id]||snoozed[reminder.id]<=today)},[reminders,snoozed]);
  useEffect(()=>{if(index>=visible.length)setIndex(Math.max(0,visible.length-1))},[index,visible.length]);
  const reminder=visible[index];
  const target=(item:OverdueReminder):Tab=>item.kind==="incoming"?"Money In":item.kind==="card_due"?"Credit Cards":"Money Out";
  const move=(step:number)=>setIndex(current=>(current+step+visible.length)%visible.length);
  const lateDays=reminder?Math.max(1,Math.floor((Date.now()-new Date(`${reminder.date}T00:00:00`).getTime())/86400000)):0;
  const primaryLabel=reminder?.kind==="incoming"?"Confirm":reminder?.kind==="card_due"?"Pay card":"Paid";
  const saveDelay=()=>{if(!reminder||!delayUntil)return;const next={...snoozed,[reminder.id]:delayUntil};setSnoozed(next);localStorage.setItem("finance-overdue-snoozes",JSON.stringify(next));setDelayOpen(false);setIndex(0)};
  return <section className={`${styles.panel} ${styles.quickResolve}`} aria-label="Overdue reminders">
    <header><b>Quick resolve</b>{visible.length>0&&<span>{index+1} of {visible.length}</span>}</header>
    {!reminder?<div className={styles.resolveEmpty}><i>✓</i><b>Nothing overdue</b><span>All expected payments are up to date.</span></div>:<div className={`${styles.resolveStage} ${reminder.kind==="incoming"?styles.resolveIncoming:styles.resolveOutgoing}`}>
      <button type="button" className={`${styles.resolveAction} ${styles.resolveConfirm}`} onClick={()=>navigate(target(reminder))}><i>✓</i><span>{primaryLabel}</span></button>
      <button type="button" className={`${styles.resolveAction} ${styles.resolveEdit}`} onClick={()=>navigate(target(reminder))}><i>✎</i><span>Edit</span></button>
      <button type="button" className={`${styles.resolveAction} ${styles.resolveDelay}`} onClick={()=>{const d=new Date();d.setDate(d.getDate()+1);setDelayUntil(d.toISOString().slice(0,10));setDelayOpen(true)}}><i>◷</i><span>Delay</span></button>
      <button type="button" className={`${styles.resolveAction} ${styles.resolveOpen}`} onClick={()=>navigate(target(reminder))}><i>↗</i><span>Open</span></button>
      <button type="button" aria-label="Previous reminder" className={`${styles.resolveArrow} ${styles.resolvePrevious}`} onClick={()=>move(-1)}>‹</button>
      <article className={styles.resolveCore} onClick={()=>navigate(target(reminder))}>
        <i>{reminder.kind==="incoming"?"↓":reminder.kind==="card_due"?"▰":"↑"}</i>
        <span>{reminder.title.replace(/ payment due$/i,"")}</span>
        <strong>{exactMoney.format(Math.abs(reminder.amountPence)/100)}</strong>
        <em>{lateDays}d late</em>
      </article>
      <button type="button" aria-label="Next reminder" className={`${styles.resolveArrow} ${styles.resolveNext}`} onClick={()=>move(1)}>›</button>
      <div className={styles.resolveDots} aria-hidden="true">{visible.slice(0,8).map((item,dot)=><i key={item.id} className={`${item.kind==="incoming"?styles.dotIncoming:styles.dotOutgoing} ${dot===index?styles.dotActive:""}`}/>)}</div>
    </div>}
    {delayOpen&&reminder&&<div className={styles.resolveBackdrop}><div className={styles.resolveModal} role="dialog" aria-modal="true"><h2>Remind me later</h2><p>The original due date will stay unchanged.</p><label>Show this reminder again<input type="date" min={new Date().toISOString().slice(0,10)} value={delayUntil} onChange={event=>setDelayUntil(event.target.value)}/></label><footer><button type="button" onClick={()=>setDelayOpen(false)}>Cancel</button><button type="button" onClick={saveDelay} disabled={!delayUntil}>Delay reminder</button></footer></div></div>}
  </section>
}

export default function FinanceHubWorkspace() {
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [range,setRange]=useState<RangeChoice>({preset:"30",start:"",end:""});
  return <main className={styles.page}>
    <div className={styles.titleRow}>
      <div><h1>Finance Hub</h1><p>Exact position. Upcoming commitments. Money under control.</p></div>
      <div className={styles.actions}><RangePicker value={range} change={setRange}/><button type="button" onClick={() => setActiveTab("Money In")}>↓ Add incoming</button><button type="button" className={styles.plan} onClick={() => setActiveTab("Money Out")}>↑ Plan outgoing</button><button type="button" className={styles.allocate} onClick={() => setActiveTab("Allocations")}>◔ Create allocation</button><button type="button" onClick={() => setActiveTab("Credit Cards")}>▰ Update card balance</button><FinanceNotificationBell/></div>
    </div>
    <nav className={styles.tabs} aria-label="Finance Hub sections">{tabs.map(tab => <button key={tab} type="button" className={activeTab === tab ? styles.activeTab : ""} onClick={() => setActiveTab(tab)}>{tab}</button>)}</nav>
    {activeTab === "Overview" ? <Overview navigate={setActiveTab} range={range} /> : activeTab === "Money In" ? <MoneyInWorkspace /> : activeTab === "Money Out" ? <MoneyOutWorkspace /> : activeTab === "Allocations" ? <AllocationsWorkspace /> : activeTab === "Credit Cards" ? <CardsWorkspace /> : activeTab === "Accounts" ? <AccountsWorkspace /> : <HistoryWorkspace />}
  </main>;
}

function RangePicker({value,change}:{value:RangeChoice;change:(value:RangeChoice)=>void}){return <div className={styles.rangePicker}><select aria-label="Finance date range" value={value.preset} onChange={event=>change({...value,preset:event.target.value as FinanceRangePreset})}><option value="7">Next 7 days</option><option value="30">Next 30 days</option><option value="90">Next 90 days</option><option value="custom">Custom range</option></select>{value.preset==="custom"&&<div className={styles.customRange}><input aria-label="Custom range start" type="date" value={value.start} onChange={event=>change({...value,start:event.target.value})}/><span>→</span><input aria-label="Custom range end" type="date" value={value.end} onChange={event=>change({...value,end:event.target.value})}/></div>}</div>}
