export function distributePence(totalPence:number,quantity:number):number[]{
  if(!Number.isSafeInteger(totalPence)||totalPence<0||!Number.isSafeInteger(quantity)||quantity<1)throw new Error("Invalid purchase distribution.");
  const base=Math.floor(totalPence/quantity),remainder=totalPence%quantity;
  return Array.from({length:quantity},(_,index)=>base+(index<remainder?1:0));
}
