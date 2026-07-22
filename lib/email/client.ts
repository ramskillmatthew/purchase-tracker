import "server-only";
import type { EmailSearch } from "@/lib/validation/email";
import type { EmailType } from "./classify";
import { searchYahoo,countYahoo,getYahooEmail,getYahooEmails } from "@/lib/yahoo/client";
import { searchGmail,countGmail,getGmailEmail,getGmailEmails } from "@/lib/gmail/client";
import { verifyEmailId } from "@/lib/yahoo/tokens";
import { gmailAccounts } from "@/lib/gmail/oauth";

export async function searchMail(ownerId:string,criteria:EmailSearch,providers:Array<"yahoo"|"gmail">=["yahoo","gmail"]){const jobs=[] as Array<Promise<{results:any[];nextCursor:string|null}>>;if(providers.includes("yahoo")&&process.env.YAHOO_EMAIL)jobs.push(searchYahoo(criteria));if(providers.includes("gmail")&&(await gmailAccounts(ownerId)).length)jobs.push(searchGmail(ownerId,criteria));const settled=await Promise.allSettled(jobs);const results=settled.flatMap(item=>item.status==="fulfilled"?item.value.results:[]).sort((a,b)=>Date.parse(b.date||"")-Date.parse(a.date||"")).slice(0,criteria.maxResults);return{results,nextCursor:null};}
export async function countMail(ownerId:string,criteria:EmailSearch,expectedType?:EmailType){const jobs=[] as Array<Promise<{count:number;foldersSearched:number}>>;if(process.env.YAHOO_EMAIL)jobs.push(countYahoo(criteria,expectedType));if((await gmailAccounts(ownerId)).length)jobs.push(countGmail(ownerId,criteria,expectedType));const settled=await Promise.allSettled(jobs);return settled.reduce((total,item)=>item.status==="fulfilled"?{count:total.count+item.value.count,foldersSearched:total.foldersSearched+item.value.foldersSearched}:total,{count:0,foldersSearched:0});}
export async function getMail(ownerId:string,id:string){const payload=await verifyEmailId(id);return payload.provider==="gmail"?getGmailEmail(ownerId,id):getYahooEmail(id);}
export async function getMails(ownerId:string,ids:string[]){const gmail:string[]=[];const yahoo:string[]=[];for(const id of ids){const payload=await verifyEmailId(id);(payload.provider==="gmail"?gmail:yahoo).push(id);}return[...await getYahooEmails(yahoo),...await getGmailEmails(ownerId,gmail)];}
