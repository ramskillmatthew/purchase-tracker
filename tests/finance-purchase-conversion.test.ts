import {describe,expect,it} from "vitest";
import {distributePence} from "@/lib/finance/purchase-conversion";
describe("planned purchase conversion",()=>{
  it("creates one exact unit cost per individual purchase",()=>expect(distributePence(400000,50)).toEqual(Array(50).fill(8000)));
  it("preserves every penny when cost does not divide evenly",()=>{const rows=distributePence(1000,3);expect(rows).toEqual([334,333,333]);expect(rows.reduce((a,b)=>a+b,0)).toBe(1000)});
});
