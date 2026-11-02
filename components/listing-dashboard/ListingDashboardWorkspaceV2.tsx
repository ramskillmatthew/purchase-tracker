"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DASHBOARD_SCENE_EVENT, DASHBOARD_SCENE_STORAGE_KEY, isDashboardSceneMode, resolveDashboardScene, type DashboardSceneMode } from "@/lib/dashboard-scene";
import styles from "./listing-dashboard.module.css";

type AccountSlot = 1 | 2 | 3;
type Platform = { marketplace:"vinted"|"ebay"; live:boolean; pricePence:number|null; itemId?:string|null; url?:string|null };
type Listing = { id:string; title:string; sku:string|null; ukSize:string|null; imageUrl:string|null; askingPricePence:number|null; costPence:number|null; profitPence:number|null; status:"listed"|"ready"|"needs_review"|"draft"; statusDetail:string|null; platforms:Platform[]; sourceUrl:string|null; updatedAt:string; vintedAccountNumber:number|null; vintedAccountSlot:AccountSlot|null; vintedProfileId:string|null; favouriteCount:number|null };
type ResponseData = { listings:Listing[]; refreshedAt:string };
type SavedAccount = { slot:AccountSlot; number:number; profileUrl:string; profileId:string; username:string|null };
type Assignments = Record<string,number>;
type RefreshResult = { ok:boolean; found:number; added:number; updated:number; noLongerFound:number; accounts:Array<{accountNumber:number;error?:string}>; error?:string };

const STORE = "listing-dashboard-vinted-accounts-v1";
const accountSlots: AccountSlot[] = [1,2,3];
const money = new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"});
const labels = {listed:"Listed",ready:"Ready",needs_review:"Needs review",draft:"Draft"} as const;

function EbayLogo(){return <span className={styles.ebayLogo} aria-label="eBay"><i>e</i><i>B</i><i>a</i><i>y</i></span>}
function VintedLogo({account}:{account:number}){return <span className={styles.vintedLogo} aria-label={`Vinted account ${account}`}><b>vinted</b><i>#{account}</i></span>}
function loadAssignments():Assignments{try{const value=JSON.parse(localStorage.getItem(STORE)??"{}") as Assignments;return Object.fromEntries(Object.entries(value).filter(([,n])=>Number.isInteger(n)&&n>0)) as Assignments}catch{return {}}}

export default function ListingDashboardWorkspaceV2(){
  const [data,setData]=useState<ResponseData|null>(null);
  const [accounts,setAccounts]=useState<SavedAccount[]>([]);
  const [accountLinks,setAccountLinks]=useState<Record<AccountSlot,string>>({1:"",2:"",3:""});
  const [accountNumbers,setAccountNumbers]=useState<Record<AccountSlot,string>>({1:"1",2:"2",3:"3"});
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const [loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[savingAccounts,setSavingAccounts]=useState(false),[accountsOpen,setAccountsOpen]=useState(false);
  const [visibilitySaving,setVisibilitySaving]=useState<string|null>(null),[lastRemoved,setLastRemoved]=useState<Listing|null>(null);
  const [search,setSearch]=useState(""),[platform,setPlatform]=useState("all"),[accountFilter,setAccountFilter]=useState("all"),[status,setStatus]=useState("all");
  const [assignments,setAssignments]=useState<Assignments>({}),[menu,setMenu]=useState<string|null>(null),[sceneMode,setSceneMode]=useState<DashboardSceneMode>("auto"),[now,setNow]=useState(()=>new Date());
  const menuRoot=useRef<HTMLDivElement|null>(null);

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [listingResponse,accountResponse]=await Promise.all([fetch("/api/listing-dashboard",{cache:"no-store"}),fetch("/api/listing-dashboard/vinted-accounts",{cache:"no-store"})]);
      const listingBody=await listingResponse.json() as ResponseData&{error?:string};
      const accountBody=await accountResponse.json() as {accounts?:SavedAccount[];error?:string};
      if(!listingResponse.ok)throw new Error(listingBody.error||"Could not load listings.");
      if(!accountResponse.ok)throw new Error(accountBody.error||"Could not load Vinted accounts.");
      const saved=accountBody.accounts??[];
      setData(listingBody);setAccounts(saved);
      setAccountLinks({1:saved.find(item=>item.slot===1)?.profileUrl??"",2:saved.find(item=>item.slot===2)?.profileUrl??"",3:saved.find(item=>item.slot===3)?.profileUrl??""});
      setAccountNumbers({1:String(saved.find(item=>item.slot===1)?.number??1),2:String(saved.find(item=>item.slot===2)?.number??2),3:String(saved.find(item=>item.slot===3)?.number??3)});
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not load listings.")}finally{setLoading(false)}
  },[]);

  useEffect(()=>{setAssignments(loadAssignments());void load()},[load]);
  useEffect(()=>{const sync=()=>{const saved=localStorage.getItem(DASHBOARD_SCENE_STORAGE_KEY);setSceneMode(isDashboardSceneMode(saved)?saved:"auto")};sync();window.addEventListener(DASHBOARD_SCENE_EVENT,sync);const timer=window.setInterval(()=>setNow(new Date()),60000);return()=>{window.removeEventListener(DASHBOARD_SCENE_EVENT,sync);window.clearInterval(timer)}},[]);
  useEffect(()=>{const close=(event:MouseEvent)=>{if(menuRoot.current&&!menuRoot.current.contains(event.target as Node))setMenu(null)};document.addEventListener("mousedown",close);return()=>document.removeEventListener("mousedown",close)},[]);

  function assign(id:string,n:number){setAssignments(current=>{const next={...current,[id]:n};localStorage.setItem(STORE,JSON.stringify(next));return next});setMenu(null)}

  async function saveAccounts(){
    setSavingAccounts(true);setError("");
    try{
      const response=await fetch("/api/listing-dashboard/vinted-accounts",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({accounts:accountSlots.map(slot=>({slot,number:Number(accountNumbers[slot]),profileUrl:accountLinks[slot]}))})});
      const body=await response.json() as {accounts?:SavedAccount[];error?:string};
      if(!response.ok)throw new Error(body.error||"Could not save the Vinted accounts.");
      setAccounts(body.accounts??[]);setAccountsOpen(false);setNotice("Vinted accounts saved. Refresh listings to bring in their current items.");
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not save the Vinted accounts.")}finally{setSavingAccounts(false)}
  }

  async function refreshListings(){
    if(!accounts.length){setAccountsOpen(true);return}
    setRefreshing(true);setError("");setNotice("");
    try{
      const response=await fetch("/api/listing-dashboard/vinted-refresh",{method:"POST"});
      const body=await response.json() as RefreshResult;
      if(!response.ok)throw new Error(body.error||"Could not refresh Vinted listings.");
      await load();
      const failed=body.accounts.filter(item=>item.error);
      const summary=`Found ${body.found} listing${body.found===1?"":"s"}: ${body.added} new, ${body.updated} updated${body.noLongerFound?`, ${body.noLongerFound} no longer found`:""}.`;
      setNotice(failed.length?`${summary} Vinted ${failed.map(item=>`#${item.accountNumber}`).join(", ")} could not be read.`:summary);
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not refresh Vinted listings.")}finally{setRefreshing(false)}
  }

  async function setListingHidden(listing:Listing,hidden:boolean){
    setVisibilitySaving(listing.id);setError("");setMenu(null);
    try{
      const response=await fetch("/api/listing-dashboard/visibility",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({listingId:listing.id,hidden})});
      const body=await response.json() as {ok?:boolean;error?:string};
      if(!response.ok)throw new Error(body.error||"Could not change this listing's dashboard visibility.");
      if(hidden){
        setData(current=>current?{...current,listings:current.listings.filter(item=>item.id!==listing.id)}:current);
        setLastRemoved(listing);setNotice("Listing removed from the dashboard.");
      }else{
        setLastRemoved(null);setNotice("Listing restored to the dashboard.");await load();
      }
    }catch(reason){setError(reason instanceof Error?reason.message:"Could not change this listing's dashboard visibility.")}finally{setVisibilitySaving(null)}
  }

  const accountChoices=useMemo<SavedAccount[]>(()=>accounts.length?accounts:accountSlots.map(slot=>({slot,number:slot,profileUrl:"",profileId:"",username:null})),[accounts]);
  const visible=useMemo(()=>{
    const query=search.trim().toLowerCase();
    return(data?.listings??[]).filter(item=>{
      const savedAccount=item.vintedProfileId?accounts.find(account=>account.profileId===item.vintedProfileId):null;
      const acct=savedAccount?.number??item.vintedAccountNumber??assignments[item.id]??1;
      const hasVinted=item.platforms.some(entry=>entry.marketplace==="vinted");
      return(!query||`${item.title} ${item.sku??""} ${item.ukSize??""}`.toLowerCase().includes(query))&&(platform==="all"||item.platforms.some(entry=>entry.marketplace===platform))&&(accountFilter==="all"||(hasVinted&&String(acct)===accountFilter))&&(status==="all"||item.status===status);
    })
  },[accountFilter,accounts,assignments,data,platform,search,status]);
  const scene=resolveDashboardScene(sceneMode,now);

  return <section className={`${styles.page} ${styles[scene]}`}><div className={styles.backdrop}/><div className={styles.content}>
    <header className={styles.header}><div><span>Inventory control</span><h1>Listing Dashboard</h1><p>See exactly where every item is listed.</p></div><div className={styles.headerActions}><button type="button" className={styles.accountButton} onClick={()=>setAccountsOpen(true)}>Set Vinted accounts</button><button type="button" className={styles.refreshButton} onClick={()=>void refreshListings()} disabled={refreshing}><b aria-hidden="true">↻</b>{refreshing?"Refreshing Vinted…":"Refresh listings"}</button></div></header>
    <div className={styles.toolbar}><label><span aria-hidden="true">⌕</span><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search title, SKU or size…"/></label><select value={platform} onChange={event=>setPlatform(event.target.value)} aria-label="Platform"><option value="all">All platforms</option><option value="ebay">eBay</option><option value="vinted">Vinted</option></select><select value={accountFilter} onChange={event=>setAccountFilter(event.target.value)} aria-label="Account"><option value="all">All accounts</option>{accountChoices.map(account=><option value={account.number} key={account.slot}>{account.username?`Vinted #${account.number} · ${account.username}`:`Vinted #${account.number}`}</option>)}</select><select value={status} onChange={event=>setStatus(event.target.value)} aria-label="Status"><option value="all">All statuses</option><option value="listed">Listed</option><option value="ready">Ready</option><option value="needs_review">Needs review</option><option value="draft">Draft</option></select><strong>{visible.length} item{visible.length===1?"":"s"}</strong></div>
    {error&&<div className={styles.error}>{error}<button onClick={()=>void load()}>Try again</button></div>}
    {notice&&<div className={styles.notice}><span>{notice}</span><div>{lastRemoved&&<button type="button" className={styles.undoButton} onClick={()=>void setListingHidden(lastRemoved,false)} disabled={visibilitySaving===lastRemoved.id}>Undo</button>}<button type="button" onClick={()=>{setNotice("");setLastRemoved(null)}} aria-label="Dismiss">×</button></div></div>}
    {loading?<div className={styles.state}>Loading your listings…</div>:visible.length===0?<div className={styles.state}>No listings match these filters.</div>:<div className={styles.grid} ref={menuRoot}>{visible.map(item=>{
      const hasVinted=item.platforms.some(entry=>entry.marketplace==="vinted"),hasEbay=item.platforms.some(entry=>entry.marketplace==="ebay");
      const savedAccount=item.vintedProfileId?accounts.find(account=>account.profileId===item.vintedProfileId):null;
      const acct=savedAccount?.number??item.vintedAccountNumber??assignments[item.id]??accountChoices[0]?.number??1;
      const accountSlot=savedAccount?.slot??item.vintedAccountSlot??accountChoices.find(account=>account.number===acct)?.slot??1;
      const tone=item.status==="needs_review"?"danger":hasVinted?`account${accountSlot}`:"ebay";
      const vinted=item.platforms.find(entry=>entry.marketplace==="vinted");
      return <article className={`${styles.card} ${styles[tone]}`} key={item.id}><div className={styles.photo}>{item.imageUrl?<Image src={item.imageUrl} alt="" fill sizes="20vw" unoptimized/>:<div>No photo</div>}<div className={styles.badges}>{hasVinted&&<VintedLogo account={acct}/>} {hasEbay&&<EbayLogo/>}</div><div className={styles.menuWrap}><button className={styles.menuButton} onClick={()=>setMenu(current=>current===item.id?null:item.id)} aria-label={`Actions for ${item.title}`}>•••</button>{menu===item.id&&<div className={styles.menu}><Link href="/listing-studio">Open in Listing Studio</Link><Link href="/listings-review">Open in Listings Review</Link>{item.platforms.find(entry=>entry.marketplace==="ebay")?.itemId&&<a href={`https://www.ebay.co.uk/itm/${item.platforms.find(entry=>entry.marketplace==="ebay")?.itemId}`} target="_blank" rel="noreferrer">Open eBay listing</a>}{vinted?.url&&<a href={vinted.url} target="_blank" rel="noreferrer">Open Vinted listing</a>}{hasVinted&&<div><span>{item.vintedProfileId||item.vintedAccountNumber?`Imported from Vinted #${acct}`:"Vinted account"}</span>{!item.vintedProfileId&&!item.vintedAccountNumber&&<section>{accountChoices.map(account=><button className={acct===account.number?styles.selected:""} key={account.slot} onClick={()=>assign(item.id,account.number)}>#{account.number}</button>)}</section>}</div>}<button type="button" className={styles.removeListing} onClick={()=>void setListingHidden(item,true)} disabled={visibilitySaving===item.id}>{visibilitySaving===item.id?"Removing…":"Remove from dashboard"}</button></div>}</div></div><div className={styles.body}><h2>{item.title}</h2><div className={styles.meta}><span>{item.sku?`SKU ${item.sku}`:"No SKU"}</span><span>{item.favouriteCount!==null?`♥ ${item.favouriteCount}`:item.ukSize?`UK ${item.ukSize}`:"Size not set"}</span></div><strong className={styles.price}>{item.askingPricePence===null?"Price not set":money.format(item.askingPricePence/100)}</strong><footer><span className={`${styles.status} ${styles[item.status]}`} title={item.statusDetail??undefined}><i/>{labels[item.status]}</span><span className={`${styles.profit} ${item.profitPence!==null&&item.profitPence<0?styles.loss:""}`}>{item.profitPence===null?"Profit —":`Profit ${money.format(item.profitPence/100)}`}</span></footer></div></article>
    })}</div>}
    {data&&<p className={styles.refreshed}>Last refreshed {new Date(data.refreshedAt).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})}</p>}
  </div>
  {accountsOpen&&<div className={styles.modalBackdrop} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setAccountsOpen(false)}}><section className={styles.accountModal} role="dialog" aria-modal="true" aria-labelledby="vinted-account-title"><button className={styles.modalClose} onClick={()=>setAccountsOpen(false)} aria-label="Close">×</button><span>Vinted listings</span><h2 id="vinted-account-title">Set Vinted accounts</h2><p>Choose the number you use for each account, then paste its public Vinted profile link. The account keeps the same colour even if you change its number later.</p><div className={styles.accountFields}>{accountSlots.map(slot=><label className={styles[`accountField${slot}`]} key={slot}><strong>Account number</strong><input className={styles.accountNumberInput} type="number" min="1" max="9999" step="1" value={accountNumbers[slot]} onChange={event=>setAccountNumbers(current=>({...current,[slot]:event.target.value}))} aria-label={`Vinted slot ${slot} account number`}/><input value={accountLinks[slot]} onChange={event=>setAccountLinks(current=>({...current,[slot]:event.target.value}))} placeholder="https://www.vinted.co.uk/member/…" inputMode="url" aria-label={`Vinted account ${accountNumbers[slot]||slot} profile link`}/><small>{accounts.find(account=>account.slot===slot)?.username??"No account saved"}</small></label>)}</div><footer><button type="button" onClick={()=>setAccountsOpen(false)}>Cancel</button><button type="button" className={styles.saveAccounts} onClick={()=>void saveAccounts()} disabled={savingAccounts}>{savingAccounts?"Saving…":"Save Vinted accounts"}</button></footer></section></div>}
  </section>
}
