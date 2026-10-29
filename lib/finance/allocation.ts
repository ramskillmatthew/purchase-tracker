export type AllocationBalance={id:string;accountId:string;balancePence:number};
export function accountReservedPence(rows:AllocationBalance[],accountId:string){return rows.filter(row=>row.accountId===accountId).reduce((sum,row)=>sum+row.balancePence,0)}
export function allocationWouldExceedAccount(rows:AllocationBalance[],accountId:string,accountBalancePence:number,additionalPence:number){return accountReservedPence(rows,accountId)+additionalPence>accountBalancePence}
export function allocationProgress(balancePence:number,targetPence:number|null){if(!targetPence)return null;return Math.max(0,Math.round(balancePence/targetPence*100))}
